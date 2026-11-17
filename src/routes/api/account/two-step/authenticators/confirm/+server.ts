import { error, json } from '@sveltejs/kit';
import { sessionHashIn } from '$lib/server/auth';
import { finishAdding, newPhoneCode } from '$lib/server/account-two-step';
import { addressOf } from '$lib/server/client-address';
import { readBody, readText } from '$lib/server/request-body';
import { requireUser } from '$lib/server/route-guards';
import { writeAs } from '$lib/server/write-as';
import type { RequestHandler } from './$types';

/**
 * POST — Finish adding an authenticator with the new phone's first code
 * (card 2772, D1.3). Not a listed action: the step-up was asked at the start,
 * and the new phone's code is the proof of the new device.
 *
 * `pendingId` is the start's, `code` the new phone's, six digits (spaces are
 * dropped); a code in no such form is refused 400 before anything is read or
 * counted. Then, in one write, the session still open: no live set-up of this
 * session is 409 "This set-up has ended…", a pending id that is not the live
 * one 409 "…replaced by a newer one…", a password changed since the start, or
 * a third authenticator added since, 409 with the set-up forgotten; a wrong
 * code 400, the fifth 409 with the set-up forgotten. A right one writes the
 * authenticator with the name the start was given, its code's step spent, and
 * answers 201 with its id, name and when it was added; the owner is mailed.
 */
export const POST: RequestHandler = async ({ request, locals, getClientAddress }) => {
	requireUser(locals.user);

	const body = await readBody(request);
	const pendingId = readText(body, 'pendingId', { required: true, max: 64 });
	const digits = newPhoneCode(readText(body, 'code', { required: true }));

	const session = sessionHashIn(locals.credential);
	if (!session) error(401, 'Not authenticated');
	const address = addressOf({ getClientAddress })?.slice(0, 100) ?? null;

	const added = writeAs(locals, (caller) => finishAdding(requireUser(caller).id, session, pendingId, digits, address));

	return json(added, { status: 201 });
};
