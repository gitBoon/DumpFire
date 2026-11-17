import { error, json } from '@sveltejs/kit';
import { sessionHashIn, whilePasswordHolds } from '$lib/server/auth';
import { removable, removeFactor } from '$lib/server/account-two-step';
import { addressOf } from '$lib/server/client-address';
import { pathId, readBody } from '$lib/server/request-body';
import { requireUser } from '$lib/server/route-guards';
import { confirmStepUp } from '$lib/server/step-up';
import { writeAs } from '$lib/server/write-as';
import type { RequestHandler } from './$types';

/**
 * DELETE — Remove one of the caller's authenticators (card 2772, D2).
 *
 * Asks for the current password and a code (`currentPassword`,
 * `currentCode`), through the step-up. Refused first, with nothing counted:
 * an authenticator that is not the caller's (404), the only one (409: add the
 * new one first), or one whose every other authenticator cannot be opened on
 * this server (409, S8). The write asks all three again, then, together:
 * the authenticator deleted, every other session of the account ended and
 * this one kept, and every pending sign-in and set-up link ended. A
 * removed phone is often the lost one, and a session made with it would
 * otherwise outlive it. The owner is mailed, with the account's live API keys
 * and webhooks to check. Answers how many other sessions ended.
 */
export const DELETE: RequestHandler = async ({ params, request, locals, cookies, getClientAddress }) => {
	requireUser(locals.user);

	// An id, as every id in a path is read (card 2117).
	const id = pathId(params.id, 'authenticator');
	const body = await readBody(request);

	const { userId, hash } = await confirmStepUp(locals, cookies, body, 'DELETE /api/account/two-step/authenticators/[id]', (caller) => {
		removable(requireUser(caller).id, id);
	});

	// The session the step-up counted on: the one kept.
	const session = sessionHashIn(locals.credential);
	if (!session) error(401, 'Not authenticated');
	const address = addressOf({ getClientAddress })?.slice(0, 100) ?? null;

	const { sessionsEnded } = await whilePasswordHolds(userId, hash, () =>
		writeAs(locals, (caller) => removeFactor(requireUser(caller).id, id, session, address)));

	return json({ success: true, sessionsEnded });
};
