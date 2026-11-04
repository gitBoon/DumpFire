import { json } from '$lib/server/v1-json';
import { keyDecisionSaved } from '$lib/server/decision-authoring';
import { extendDecision } from '$lib/server/decisions';
import { pathId, readBody } from '$lib/server/request-body';
import { requireUser } from '$lib/server/route-guards';
import { writeAs } from '$lib/server/write-as';
import type { RequestHandler } from './$types';

/**
 * POST /api/v1/decisions/:decisionId/extend — give an open decision a later
 * closing time: `closesAt`, in the future, at most a year ahead, and later
 * than the one it has (card 2682, D30: Extend never brings it earlier, for
 * anyone). Its decider's. A decision closed for input is reopened on the
 * decision's page: `extendDecision` refuses a key 403 (code review S2).
 * Nobody is mailed. `extendDecision` in `$lib/server/decisions`;
 * `keyDecisionSaved`, `{ decision, revision }` in the shape every key is
 * given (D9, D10).
 *
 * There is no close here (D29): closing a decision before its closing time
 * makes a later ruling early, which is a person's call on the decision's page.
 */
export const POST: RequestHandler = async ({ params, request, locals }) => {
	requireUser(locals.user);
	const id = pathId(params.decisionId, 'decision');
	const body = await readBody(request);

	const answer = writeAs(locals, (caller) => {
		const decision = extendDecision(caller, { decisionId: id }, body, { source: 'api' });
		return keyDecisionSaved(decision);
	});
	return json(answer);
};
