import { json } from '@sveltejs/kit';
import { isAdmin } from '$lib/server/board-access';
import { participantAnswers, revisionFor } from '$lib/server/decision-authoring';
import { resendInvitation } from '$lib/server/decisions';
import { pathId } from '$lib/server/request-body';
import { requireUser } from '$lib/server/route-guards';
import { writeAs } from '$lib/server/write-as';
import type { RequestHandler } from './$types';

/**
 * POST /api/decisions/:id/participants/:participantId/resend — send a
 * participant their invitation again, to the address recorded for them, a
 * link holder with a new link (card 2675, decision 31). It reads no body
 * (card 2697, Q17): the page sends the JSON type and none.
 * `resendInvitation` in `$lib/server/decisions`, the decision's author's, its
 * decider's or an administrator's; the answer is `{ participant, revision }`,
 * through the one projection, with an address to an administrator alone
 * (decision 15, Q18).
 */
export const POST: RequestHandler = async ({ params, locals }) => {
	requireUser(locals.user);
	const id = pathId(params.id, 'decision');
	const participantId = pathId(params.participantId, 'participant');

	const answer = writeAs(locals, (caller) => {
		const participant = resendInvitation(caller, { decisionId: id, participantId }, null, { source: 'ui' });
		return { participant: participantAnswers([participant], isAdmin(caller))[0], revision: revisionFor(id) };
	});
	return json(answer);
};
