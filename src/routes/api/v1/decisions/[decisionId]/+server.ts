import { json } from '$lib/server/v1-json';
import { keyDecisionAnswer, optionAnswers, readDecisionForKey, readinessOf, revisionFor } from '$lib/server/decision-authoring';
import { deleteDecision, updateDraft } from '$lib/server/decisions';
import { pathId, readBody } from '$lib/server/request-body';
import { requireUser } from '$lib/server/route-guards';
import { writeAs } from '$lib/server/write-as';
import type { RequestHandler } from './$types';

/**
 * GET /api/v1/decisions/:decisionId — the editors' read of a decision (card
 * 2682, D11): for a key whose account may edit it (404, then 403, as the edit
 * page). The decision, its live options and every participant in the shape
 * every key is given, an administrator's included (no address, no account
 * id: D9), the revision the next write must send (D28), the readability
 * check, what a key may do now (`actions`), and the picker, with no address.
 * Every holder of people's or agents' words is marked `untrusted` (D10).
 * `readDecisionForKey` in `$lib/server/decision-authoring`.
 */
export const GET: RequestHandler = async ({ params, locals }) => {
	const user = requireUser(locals.user);
	const id = pathId(params.decisionId, 'decision');
	return json(readDecisionForKey(user, id, { source: 'api' }));
};

/**
 * PATCH /api/v1/decisions/:decisionId — save the working copy (card 2682,
 * D12): `revision`, required (409 when stale), and any of `title`,
 * `closesAt`, `voteMode` and `content`. `content`, when sent, is the whole
 * content: a section not sent is emptied. Through a key each section the save
 * changes is flagged as an agent's, cleared only by a person's Mark reviewed
 * on the page (D21). Once opened, the title, closing time and vote mode do
 * not change here, and nobody is told of a content change until a person
 * re-publishes it on the page (D3). The decider is `PUT …/decider`.
 * `updateDraft` in `$lib/server/decisions`; the answer is
 * `{ decision, options, revision, readiness }`.
 */
export const PATCH: RequestHandler = async ({ params, request, locals }) => {
	requireUser(locals.user);
	const id = pathId(params.decisionId, 'decision');
	const body = await readBody(request);

	// The decision, the caller's access to it, the revision and the save, in one transaction (card 2253).
	const answer = writeAs(locals, (caller) => {
		const { decision, options } = updateDraft(caller, { decisionId: id }, body, { source: 'api' });
		return { decision: keyDecisionAnswer(decision), options: optionAnswers(options), revision: revisionFor(decision.id), readiness: readinessOf(decision) };
	});
	return json(answer);
};

/**
 * DELETE /api/v1/decisions/:decisionId — delete a draft, or a draft withdrawn
 * before it was opened, and every row of it (card 2682, D5): its author's or
 * an administrator's. A decision that was ever opened holds a permanent
 * record, whose delete asks for the caller's password on the decision's page;
 * a key cannot give one, so `deleteDecision` refuses it, 403, after every
 * other refusal and before anything is deleted. No body is read: no password
 * is asked for here. `{ success: true }`.
 */
export const DELETE: RequestHandler = async ({ params, locals }) => {
	requireUser(locals.user);
	const id = pathId(params.decisionId, 'decision');

	// The decision read, the caller checked and the delete written in one transaction (card 2253).
	writeAs(locals, (caller) => deleteDecision(caller, { decisionId: id }, null, { source: 'api' }));
	return json({ success: true });
};
