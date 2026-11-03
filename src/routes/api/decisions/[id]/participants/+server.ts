import { json } from '@sveltejs/kit';
import { isAdmin } from '$lib/server/board-access';
import { participantAnswers, revisionFor } from '$lib/server/decision-authoring';
import { setParticipants } from '$lib/server/decisions';
import { pathId, readBody } from '$lib/server/request-body';
import { requireUser } from '$lib/server/route-guards';
import { writeAs } from '$lib/server/write-as';
import type { RequestHandler } from './$types';

/**
 * PUT /api/decisions/:id/participants — set who is consulted on a decision
 * and who is told of it: `participants`, `{ personId, role }` each, and
 * `revision` (card 2675, plan 4.7; card 2676, decisions 10 and 29, R3, R6).
 * Once the decision is open, including people mails them, and is its
 * author's and its decider's alone. `setParticipants` in
 * `$lib/server/decisions`; the answer is `{ participants, revision }`, every
 * row through the one projection (decision 15): an address and an account to
 * an administrator alone.
 */
export const PUT: RequestHandler = async ({ params, request, locals }) => {
	requireUser(locals.user);
	const id = pathId(params.id, 'decision');
	const body = await readBody(request);

	const answer = writeAs(locals, (caller) => {
		const participants = setParticipants(caller, { decisionId: id }, body, { source: 'ui' });
		return { participants: participantAnswers(participants, isAdmin(caller)), revision: revisionFor(id) };
	});
	return json(answer);
};
