import { json } from '$lib/server/v1-json';
import { keyDecisionSaved } from '$lib/server/decision-authoring';
import { setDecider } from '$lib/server/decisions';
import { pathId, readBody } from '$lib/server/request-body';
import { requireUser } from '$lib/server/route-guards';
import { writeAs } from '$lib/server/write-as';
import type { RequestHandler } from './$types';

/**
 * PUT /api/v1/decisions/:decisionId/decider — name the decider of a decision
 * never opened: `deciderUserId`, an account that can edit its board, and
 * `revision` (card 2682, D4, D12). Choosing the decider chooses who rules:
 * once the decision has been opened it is changed on the decision's page, and
 * `setDecider` refuses a key 403, whatever its status now. A changed decider
 * is flagged `agentDrafted.decider` until a person marks it reviewed on the
 * page (card 2728). `{ decision, revision }`, the decision in the shape every
 * key is given (D9, D10).
 */
export const PUT: RequestHandler = async ({ params, request, locals }) => {
	requireUser(locals.user);
	const id = pathId(params.decisionId, 'decision');
	const body = await readBody(request);

	const answer = writeAs(locals, (caller) => {
		const decision = setDecider(caller, { decisionId: id }, body, { source: 'api' });
		return keyDecisionSaved(decision);
	});
	return json(answer);
};
