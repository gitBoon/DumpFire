import { json } from '@sveltejs/kit';
import { whilePasswordHolds } from '$lib/server/auth';
import { isAdmin } from '$lib/server/board-access';
import { participantAnswers, revisionFor } from '$lib/server/decision-authoring';
import { participantAccountGuard, setParticipantAccount } from '$lib/server/decisions';
import { pathId, readBody } from '$lib/server/request-body';
import { requireUser } from '$lib/server/route-guards';
import { confirmStepUp } from '$lib/server/step-up';
import { writeAs } from '$lib/server/write-as';
import type { RequestHandler } from './$types';

/**
 * PUT /api/decisions/:id/participants/:participantId/account — an
 * administrator attaches the account the people directory holds for a
 * participant's person (`{ account: 'person' }`), or clears the row's account
 * (`{ account: 'none' }`) (card 2675, decision 14): `setParticipantAccount`
 * in `$lib/server/decisions`.
 *
 * It changes which credential answers for the participant on the record, an
 * account or a personal link mailed in its place, so it asks for the
 * caller's own password again, in `currentPassword` (card 2697, Q9;
 * step-up.ts). Every refusal of the write is made first
 * (`participantAccountGuard`), with no password checked or counted. The
 * answer is `{ participant, revision }`, through the one projection (Q18).
 */
export const PUT: RequestHandler = async ({ params, request, locals, cookies }) => {
	requireUser(locals.user);
	const id = pathId(params.id, 'decision');
	const participantId = pathId(params.participantId, 'participant');
	const body = await readBody(request);

	// The caller's password, once every refusal that needs none has been made.
	const { userId, hash } = await confirmStepUp(locals, cookies, body, 'PUT /api/decisions/[id]/participants/[participantId]/account', (caller) =>
		participantAccountGuard(caller, { decisionId: id, participantId }, body)
	);

	// One transaction, run only while the caller's stored hash is the one their
	// password was checked against: the decision read, the caller asked again
	// and the change written in it (card 2253).
	const answer = await whilePasswordHolds(userId, hash, () =>
		writeAs(locals, (caller) => {
			const participant = setParticipantAccount(caller, { decisionId: id, participantId }, body, { source: 'ui' });
			return { participant: participantAnswers([participant], isAdmin(caller))[0], revision: revisionFor(id) };
		}));
	return json(answer);
};
