import { json } from '@sveltejs/kit';
import { isAdmin } from '$lib/server/board-access';
import { decisionAnswer, revisionFor } from '$lib/server/decision-authoring';
import { closeDecision } from '$lib/server/decision-lifecycle-writes';
import { pathId } from '$lib/server/request-body';
import { requireUser } from '$lib/server/route-guards';
import { writeAs } from '$lib/server/write-as';
import type { RequestHandler } from './$types';

/**
 * POST /api/decisions/:id/close — close an open decision for input. It reads
 * no body (card 2697, Q17): the page sends the JSON type and none, as every
 * internal write says it is JSON. `closeDecision` in `$lib/server/decision-lifecycle-writes`,
 * its author's or its decider's; the answer is `{ decision, revision }`,
 * through the one projection (decision 15, Q18).
 */
export const POST: RequestHandler = async ({ params, locals }) => {
	requireUser(locals.user);
	const id = pathId(params.id, 'decision');

	const answer = writeAs(locals, (caller) => {
		const decision = closeDecision(caller, { decisionId: id }, null, { source: 'ui' });
		return { decision: decisionAnswer(decision, isAdmin(caller)), revision: revisionFor(decision.id) };
	});
	return json(answer);
};
