import { json } from '@sveltejs/kit';
import { isAdmin } from '$lib/server/board-access';
import { decisionAnswer, revisionFor } from '$lib/server/decision-authoring';
import { supersedeDecision } from '$lib/server/decisions';
import { pathId, readBody } from '$lib/server/request-body';
import { requireUser } from '$lib/server/route-guards';
import { writeAs } from '$lib/server/write-as';
import type { RequestHandler } from './$types';

/**
 * POST /api/decisions/:id/supersede — make a draft that supersedes a ruled
 * decision: `title`, optional, the old title when not sent (card 2679,
 * decision 5). `supersedeDecision` in `$lib/server/decisions`, the decision's
 * decider's, its board's Product Owner's or an administrator's; the answer is
 * `201 { decision, revision }` of the new draft, through the one projection
 * (decision 15 of card 2676), for its editor to open.
 */
export const POST: RequestHandler = async ({ params, request, locals }) => {
	requireUser(locals.user);
	const id = pathId(params.id, 'decision');
	const body = await readBody(request);

	const answer = writeAs(locals, (caller) => {
		const decision = supersedeDecision(caller, { decisionId: id }, body, { source: 'ui' });
		return { decision: decisionAnswer(decision, isAdmin(caller)), revision: revisionFor(decision.id) };
	});
	return json(answer, { status: 201 });
};
