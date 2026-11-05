import { json } from '@sveltejs/kit';
import { whilePasswordHolds } from '$lib/server/auth';
import { isAdmin } from '$lib/server/board-access';
import { decisionAnswer, optionAnswers, readinessOf, revisionFor } from '$lib/server/decision-authoring';
import { decisionDeleteGuard, deleteDecision, updateDraft } from '$lib/server/decisions';
import { pathId, readBody } from '$lib/server/request-body';
import { requireUser } from '$lib/server/route-guards';
import { confirmStepUp } from '$lib/server/step-up';
import { writeAs } from '$lib/server/write-as';
import type { RequestHandler } from './$types';

/**
 * PUT /api/decisions/:id — save a decision's working copy: `revision`, and any
 * of `title`, `closesAt`, `voteMode` and `content` (card 2676, decisions 6 to
 * 10). `updateDraft` in `$lib/server/decisions`; the answer is
 * `{ decision, options, revision, readiness }`, through the one projection
 * (decision 15), with the readability check worked out on the server.
 */
export const PUT: RequestHandler = async ({ params, request, locals }) => {
	requireUser(locals.user);
	const id = pathId(params.id, 'decision');
	const body = await readBody(request);

	// The decision, the caller's access to it, the revision and the save, in
	// one transaction (card 2253); the answer is made from what it wrote.
	const answer = writeAs(locals, (caller) => {
		const { decision, options } = updateDraft(caller, { decisionId: id }, body, { source: 'ui' });
		return { decision: decisionAnswer(decision, isAdmin(caller)), options: optionAnswers(options), revision: revisionFor(decision.id), readiness: readinessOf(decision) };
	});
	return json(answer);
};

/**
 * DELETE /api/decisions/:id — delete a draft or a withdrawn decision, and
 * every row of it (card 2675, plan 4.9): `deleteDecision`, its author's or an
 * administrator's.
 *
 * A decision that was ever opened holds a permanent record (its versions,
 * responses and events), which the cascade destroys for good, so its delete
 * asks for the caller's own password again, in `currentPassword` (card 2697,
 * Q9; step-up.ts). A draft never opened asks for none. Every refusal of the
 * delete is made first (`decisionDeleteGuard`), with no password checked or
 * counted, as the column delete does. The body is JSON always: `{}`, or
 * `{ currentPassword }`.
 */
export const DELETE: RequestHandler = async ({ params, request, locals, cookies }) => {
	requireUser(locals.user);
	const id = pathId(params.id, 'decision');
	const body = await readBody(request);

	// Every refusal of the delete, read only, and whether the decision holds a
	// record: the one thing that decides whether a password is asked for.
	const { holdsRecord } = writeAs(locals, (caller) => decisionDeleteGuard(caller, { decisionId: id }));

	if (!holdsRecord) {
		// One transaction: the decision is read and the caller checked in the
		// same one that deletes it (card 2253). A decision opened since, and so
		// holding a record now, is not deleted without the password: the service
		// refuses it 400 `STEP_UP_MISSING`, nothing written (card 2726).
		writeAs(locals, (caller) => deleteDecision(caller, { decisionId: id }, null, { source: 'ui' }));
		return json({ success: true });
	}

	// The caller's password, once every refusal that needs none has been made.
	const { userId, hash } = await confirmStepUp(locals, cookies, body, 'DELETE /api/decisions/[id]', (caller) =>
		decisionDeleteGuard(caller, { decisionId: id })
	);

	// One transaction, as above, run only while the caller's stored hash is the
	// one their password was checked against.
	await whilePasswordHolds(userId, hash, () => writeAs(locals, (caller) => deleteDecision(caller, { decisionId: id }, null, { source: 'ui' })));
	return json({ success: true });
};
