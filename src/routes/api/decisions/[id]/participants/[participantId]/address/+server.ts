import { json } from '@sveltejs/kit';
import { whilePasswordHolds } from '$lib/server/auth';
import { isAdmin } from '$lib/server/board-access';
import { participantAnswers, revisionFor } from '$lib/server/decision-authoring';
import { changeParticipantAddress, participantAddressGuard } from '$lib/server/decision-participant-writes';
import { pathId, readBody } from '$lib/server/request-body';
import { requireUser } from '$lib/server/route-guards';
import { confirmStepUp } from '$lib/server/step-up';
import { writeAs } from '$lib/server/write-as';
import type { RequestHandler } from './$types';

/**
 * PUT /api/decisions/:id/participants/:participantId/address — an
 * administrator's "Use the directory's address" (card 2697, Q22): the
 * participant's address on the decision becomes the one the people directory
 * holds for their person now. `changeParticipantAddress` in
 * `$lib/server/decision-participant-writes`, handed no body: the request carries no address,
 * only `currentPassword`, so that no address the directory does not hold can
 * be chosen.
 *
 * It ends the participant's personal link and decides where the next one
 * goes, so it asks for the caller's own password again (Q9; step-up.ts).
 * Every refusal of the write is made first (`participantAddressGuard`), with
 * no password checked or counted. The answer is `{ participant, revision }`,
 * through the one projection (Q18).
 */
export const PUT: RequestHandler = async ({ params, request, locals, cookies }) => {
	requireUser(locals.user);
	const id = pathId(params.id, 'decision');
	const participantId = pathId(params.participantId, 'participant');
	const body = await readBody(request);

	// The caller's password, once every refusal that needs none has been made.
	const { userId, hash } = await confirmStepUp(locals, cookies, body, 'PUT /api/decisions/[id]/participants/[participantId]/address', (caller) =>
		participantAddressGuard(caller, { decisionId: id, participantId })
	);

	// One transaction, run only while the caller's stored hash is the one their
	// password was checked against (card 2253).
	const answer = await whilePasswordHolds(userId, hash, () =>
		writeAs(locals, (caller) => {
			const participant = changeParticipantAddress(caller, { decisionId: id, participantId }, null, { source: 'ui' });
			return { participant: participantAnswers([participant], isAdmin(caller))[0], revision: revisionFor(id) };
		}));
	return json(answer);
};
