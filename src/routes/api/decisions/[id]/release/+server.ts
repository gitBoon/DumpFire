import { json } from '@sveltejs/kit';
import { whilePasswordHolds } from '$lib/server/auth';
import { isAdmin } from '$lib/server/board-access';
import { decisionAnswer } from '$lib/server/decision-authoring';
import { resultsRevisionFor } from '$lib/server/decision-results';
import { releaseResults, resultsReleaseGuard } from '$lib/server/decision-ruling-writes';
import { pathId, readBody } from '$lib/server/request-body';
import { requireUser } from '$lib/server/route-guards';
import { confirmStepUp } from '$lib/server/step-up';
import { writeAs } from '$lib/server/write-as';
import type { RequestHandler } from './$types';

/**
 * POST /api/decisions/:id/release — the decider releases a ruled decision's
 * totals and comments, without names, to everyone who may view it: `{
 * revision, omit, currentPassword }`, `revision` the results revision and
 * `omit` the keys of the preview's comments left out (card 2679, decisions 2,
 * 10 and 20). `releaseResults` in `$lib/server/decision-ruling-writes`; the answer is
 * `{ decision, revision }`, as the ruling's.
 *
 * A release cannot be undone and shows every released comment to every board
 * reader and link holder, so it asks for the caller's own password again, in
 * `currentPassword` (step-up.ts). Every refusal of the release is made first
 * (`resultsReleaseGuard`), with no password checked or counted.
 */
export const POST: RequestHandler = async ({ params, request, locals, cookies }) => {
	requireUser(locals.user);
	const id = pathId(params.id, 'decision');
	const body = await readBody(request);

	// The caller's password, once every refusal that needs none has been made.
	const { userId, hash } = await confirmStepUp(locals, cookies, body, 'POST /api/decisions/[id]/release', (caller) =>
		resultsReleaseGuard(caller, { decisionId: id }, body, { source: 'ui' })
	);

	// One transaction, run only while the caller's stored hash is the one their
	// password was checked against (card 2253).
	const answer = await whilePasswordHolds(userId, hash, () =>
		writeAs(locals, (caller) => {
			const decision = releaseResults(caller, { decisionId: id }, body, { source: 'ui' });
			return { decision: decisionAnswer(decision, isAdmin(caller)), revision: resultsRevisionFor(decision.id) };
		}));
	return json(answer);
};
