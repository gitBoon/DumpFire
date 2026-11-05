import { json } from '@sveltejs/kit';
import { whilePasswordHolds } from '$lib/server/auth';
import { isAdmin } from '$lib/server/board-access';
import { decisionAnswer } from '$lib/server/decision-authoring';
import { resultsRevisionFor } from '$lib/server/decision-results';
import { decisionRuleGuard, ruleDecision } from '$lib/server/decision-ruling-writes';
import { pathId, readBody } from '$lib/server/request-body';
import { requireUser } from '$lib/server/route-guards';
import { confirmStepUp } from '$lib/server/step-up';
import { writeAs } from '$lib/server/write-as';
import type { RequestHandler } from './$types';

/**
 * POST /api/decisions/:id/rule — the decider rules on an open or closed
 * decision: `{ optionId, reason, conditions, revision, openQuestionsConfirmed,
 * currentPassword }`, `optionId` null for none of these and `revision` the
 * results revision the results page was given (card 2679, decisions 2, 8 and
 * 13). `ruleDecision` in `$lib/server/decision-ruling-writes`; the answer is
 * `{ decision, revision }`, the decision through the one projection and the
 * results revision as it now is.
 *
 * A ruling is permanent and mails every participant the decider's words, so
 * it asks for the caller's own password again, in `currentPassword`
 * (step-up.ts). Every refusal of the ruling is made first
 * (`decisionRuleGuard`), with no password checked or counted.
 */
export const POST: RequestHandler = async ({ params, request, locals, cookies }) => {
	requireUser(locals.user);
	const id = pathId(params.id, 'decision');
	const body = await readBody(request);

	// The caller's password, once every refusal that needs none has been made.
	const { userId, hash } = await confirmStepUp(locals, cookies, body, 'POST /api/decisions/[id]/rule', (caller) =>
		decisionRuleGuard(caller, { decisionId: id }, body, { source: 'ui' })
	);

	// One transaction, run only while the caller's stored hash is the one their
	// password was checked against: the decision read, the caller asked again
	// and the ruling written in it (card 2253).
	const answer = await whilePasswordHolds(userId, hash, () =>
		writeAs(locals, (caller) => {
			const decision = ruleDecision(caller, { decisionId: id }, body, { source: 'ui' });
			return { decision: decisionAnswer(decision, isAdmin(caller)), revision: resultsRevisionFor(decision.id) };
		}));
	return json(answer);
};
