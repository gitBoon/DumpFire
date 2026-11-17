import { error, json } from '@sveltejs/kit';
import { sessionHashIn, whilePasswordHolds } from '$lib/server/auth';
import { authenticatorLabel, mayStartAdding, startAdding, LABEL_MISSING } from '$lib/server/account-two-step';
import { readBody, readText } from '$lib/server/request-body';
import { requireUser } from '$lib/server/route-guards';
import { confirmStepUp } from '$lib/server/step-up';
import { writeAs } from '$lib/server/write-as';
import type { RequestHandler } from './$types';

/**
 * POST — Begin adding an authenticator (card 2772, D1).
 *
 * Asks for the current password and a code (`currentPassword`,
 * `currentCode`), through the step-up every listed action asks with: the new
 * authenticator signs in as the account. Refused first, with nothing counted:
 * `label` missing, not text, longer than 40 characters once its white space
 * is collapsed, or holding a control or format character; three
 * authenticators held already (409); no MFA key loaded (503). The count is
 * asked again in the write, held to the password checked and to the session
 * still being open.
 *
 * Only after that write has returned (S7) is the pending add issued, one for
 * the account, replacing any it held, in this process's memory for ten
 * minutes. The answer, which no cache keeps, is what the page shows once: the
 * pending id it sends back with the new phone's code
 * (`POST /api/account/two-step/authenticators/confirm`), the account and
 * issuer the authenticator app files the code under, the secret in groups of
 * four, its QR code, and when it ends. Nothing is written to the database
 * until the new phone's code is right.
 */
export const POST: RequestHandler = async ({ request, locals, cookies }) => {
	requireUser(locals.user);

	const body = await readBody(request);

	const { actor: label, userId, hash } = await confirmStepUp(locals, cookies, body, 'POST /api/account/two-step/authenticators', (caller) => {
		const me = requireUser(caller);
		const label = authenticatorLabel(readText(body, 'label', { required: true, says: { missing: LABEL_MISSING } }));
		mayStartAdding(me.id);
		return label;
	});

	// The session the step-up counted on, which the pending add is kept for.
	const session = sessionHashIn(locals.credential);
	if (!session) error(401, 'Not authenticated');

	// The count asked again, held to the password checked and the session still open.
	const account = await whilePasswordHolds(userId, hash, () =>
		writeAs(locals, (caller) => {
			const me = requireUser(caller);
			mayStartAdding(me.id);
			return me.username;
		}));

	return json(startAdding(userId, account, session, hash, label), { headers: { 'Cache-Control': 'no-store' } });
};
