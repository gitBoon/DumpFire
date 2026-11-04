import { error, json } from '@sveltejs/kit';
import { whilePasswordHolds } from '$lib/server/auth';
import { isAdmin } from '$lib/server/board-access';
import { decisionAnswer, revisionFor } from '$lib/server/decision-authoring';
import { decisionWithdrawGuard, withdrawDecision } from '$lib/server/decisions';
import { pathId, readBody } from '$lib/server/request-body';
import { requireUser } from '$lib/server/route-guards';
import { STEP_UP_MISSING, confirmStepUp } from '$lib/server/step-up';
import { writeAs } from '$lib/server/write-as';
import type { RequestHandler } from './$types';

/**
 * POST /api/decisions/:id/withdraw — withdraw a draft, an open or a closed
 * decision: `reason`, required. Once opened, its participants are mailed the
 * reason. `withdrawDecision` in `$lib/server/decisions`, its author's, its
 * decider's or an administrator's; the answer is `{ decision, revision }`,
 * through the one projection (decision 15, Q18).
 *
 * Withdrawing a decision that was ever opened ends it for good and mails
 * every participant the caller's words, so it asks for the caller's own
 * password again, in `currentPassword` (card 2697, Q29; step-up.ts). A draft
 * tells nobody and asks for none. Every refusal of the withdrawal is made
 * first (`decisionWithdrawGuard`), with no password checked or counted, as the
 * decision's delete does.
 */
export const POST: RequestHandler = async ({ params, request, locals, cookies }) => {
	requireUser(locals.user);
	const id = pathId(params.id, 'decision');
	const body = await readBody(request);

	// Every refusal of the withdrawal, read only, and whether the decision was
	// ever opened: the one thing that decides whether a password is asked for.
	const { wasOpened } = writeAs(locals, (caller) => decisionWithdrawGuard(caller, { decisionId: id }, body));

	if (!wasOpened) {
		// One transaction: the decision is read and the caller checked in the
		// same one that withdraws it (card 2253). A draft opened since is not
		// withdrawn without the password: refused, and nothing written.
		const answer = writeAs(locals, (caller) => {
			if (decisionWithdrawGuard(caller, { decisionId: id }, body).wasOpened) error(400, { message: STEP_UP_MISSING, stepUp: 'missing' });
			const decision = withdrawDecision(caller, { decisionId: id }, body, { source: 'ui' });
			return { decision: decisionAnswer(decision, isAdmin(caller)), revision: revisionFor(decision.id) };
		});
		return json(answer);
	}

	// The caller's password, once every refusal that needs none has been made.
	const { userId, hash } = await confirmStepUp(locals, cookies, body, 'POST /api/decisions/[id]/withdraw', (caller) =>
		decisionWithdrawGuard(caller, { decisionId: id }, body)
	);

	// One transaction, as above, run only while the caller's stored hash is the
	// one their password was checked against.
	const answer = await whilePasswordHolds(userId, hash, () =>
		writeAs(locals, (caller) => {
			const decision = withdrawDecision(caller, { decisionId: id }, body, { source: 'ui' });
			return { decision: decisionAnswer(decision, isAdmin(caller)), revision: revisionFor(decision.id) };
		}));
	return json(answer);
};
