import { json } from '@sveltejs/kit';
import { isAdmin } from '$lib/server/board-access';
import { decisionAnswer, revisionFor } from '$lib/server/decision-authoring';
import { setDecider } from '$lib/server/decision-authoring-writes';
import { pathId, readBody } from '$lib/server/request-body';
import { requireUser } from '$lib/server/route-guards';
import { writeAs } from '$lib/server/write-as';
import type { RequestHandler } from './$types';

/**
 * PUT /api/decisions/:id/decider — name a decision's decider:
 * `deciderUserId`, an account that can edit its board, and `revision` (card
 * 2675, decision 6; card 2676, decision 10). `setDecider` in
 * `$lib/server/decision-authoring-writes`; the answer is `{ decision, revision }`, through the
 * one projection (decision 15).
 */
export const PUT: RequestHandler = async ({ params, request, locals }) => {
	requireUser(locals.user);
	const id = pathId(params.id, 'decision');
	const body = await readBody(request);

	const answer = writeAs(locals, (caller) => {
		const decision = setDecider(caller, { decisionId: id }, body, { source: 'ui' });
		return { decision: decisionAnswer(decision, isAdmin(caller)), revision: revisionFor(decision.id) };
	});
	return json(answer);
};
