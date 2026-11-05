import { json } from '$lib/server/v1-json';
import { keyParticipantAnswers, revisionFor } from '$lib/server/decision-authoring';
import { setParticipants } from '$lib/server/decisions';
import { pathId, readBody } from '$lib/server/request-body';
import { requireUser } from '$lib/server/route-guards';
import { writeAs } from '$lib/server/write-as';
import type { RequestHandler } from './$types';

/**
 * PUT /api/v1/decisions/:decisionId/participants — set who is consulted on a
 * decision never opened, and who is told of it: `participants`, a list of
 * `{ personId, role }`, and `revision` (card 2682, D4). On a draft nobody is
 * mailed: the set is saved for the person who opens it on the page, who sees
 * it by name and role, flagged `agentDrafted.participants` when the save
 * changed anyone until they mark it reviewed (card 2728). Once opened,
 * saving the set mails whoever it includes
 * a personal link at once, so `setParticipants` refuses a key 403 before the
 * body is read, whatever the status now.
 *
 * `{ participants, revision }`: each participant with no address, no account
 * id and nobody's account id, an administrator's key included, marked
 * `untrusted` (D9, D10).
 */
export const PUT: RequestHandler = async ({ params, request, locals }) => {
	requireUser(locals.user);
	const id = pathId(params.decisionId, 'decision');
	const body = await readBody(request);

	const answer = writeAs(locals, (caller) => {
		const participants = setParticipants(caller, { decisionId: id }, body, { source: 'api' });
		return { participants: keyParticipantAnswers(participants), revision: revisionFor(id) };
	});
	return json(answer);
};
