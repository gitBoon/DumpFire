import { json } from '@sveltejs/kit';
import { isAdmin } from '$lib/server/board-access';
import { decisionAnswer, revisionFor } from '$lib/server/decision-authoring';
import { republishDecision } from '$lib/server/decision-lifecycle-writes';
import { pathId, readBody } from '$lib/server/request-body';
import { requireUser } from '$lib/server/route-guards';
import { writeAs } from '$lib/server/write-as';
import type { RequestHandler } from './$types';

/**
 * POST /api/decisions/:id/republish — publish the working copy again as the
 * next version: `changeNote`, `askAgain` and `revision`, required (card 2697,
 * Q1). `republishDecision` in `$lib/server/decision-lifecycle-writes`, its author's or its
 * decider's; the answer is `{ decision, revision }`, through the one
 * projection (decision 15, Q18).
 */
export const POST: RequestHandler = async ({ params, request, locals }) => {
	requireUser(locals.user);
	const id = pathId(params.id, 'decision');
	const body = await readBody(request);

	const answer = writeAs(locals, (caller) => {
		const decision = republishDecision(caller, { decisionId: id }, body, { source: 'ui' });
		return { decision: decisionAnswer(decision, isAdmin(caller)), revision: revisionFor(decision.id) };
	});
	return json(answer);
};
