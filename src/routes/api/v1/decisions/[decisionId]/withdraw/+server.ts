import { json } from '$lib/server/v1-json';
import { keyDecisionSaved } from '$lib/server/decision-authoring';
import { withdrawDecision } from '$lib/server/decisions';
import { pathId, readBody } from '$lib/server/request-body';
import { requireUser } from '$lib/server/route-guards';
import { writeAs } from '$lib/server/write-as';
import type { RequestHandler } from './$types';

/**
 * POST /api/v1/decisions/:decisionId/withdraw — withdraw a draft that was
 * never opened: `reason` (card 2682, D5). It tells nobody, and keeps the
 * draft with its reason on the register and the board's list, where a delete
 * would remove it. A decision that was ever opened is withdrawn on the
 * decision's page, which asks for the caller's password and mails every
 * participant the reason: `withdrawDecision` refuses a key 403 after every
 * other refusal. A `currentPassword` sent is not read, and no password is
 * compared. `{ decision, revision }` in the shape every key is given.
 */
export const POST: RequestHandler = async ({ params, request, locals }) => {
	requireUser(locals.user);
	const id = pathId(params.decisionId, 'decision');
	const body = await readBody(request);

	const answer = writeAs(locals, (caller) => {
		const decision = withdrawDecision(caller, { decisionId: id }, body, { source: 'api' });
		return keyDecisionSaved(decision);
	});
	return json(answer);
};
