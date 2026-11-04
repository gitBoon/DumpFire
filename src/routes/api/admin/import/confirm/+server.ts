/**
 * /api/admin/import/confirm — the superadmin's password, before an import
 * (card 2701, decision 8).
 *
 * An import replaces every row and every account with the backup's, so it
 * asks for the superadmin's current password, as the reset does. Its body is
 * the upload, which cannot carry the password, and the password should be
 * proved before the server reads a byte of it. So the page confirms here
 * first, with `{ currentPassword }`, and is answered `{ confirmation,
 * expiresInSeconds }`: good for one import, from this session, for 60
 * seconds. The import takes it from its `X-DumpFire-Confirmation` header
 * before it reads the upload (`takeImportConfirmation`), and once the upload
 * is in, refuses it if the account or the password has changed since.
 *
 * Nothing is written to the database: the confirmation is kept in memory, as
 * its SHA-256 (step-up.ts). A new one replaces the session's last. The answer
 * is never stored by the browser or a proxy.
 */
import { error, json } from '@sveltejs/kit';
import { SESSION_COOKIE_NAME } from '$lib/server/auth';
import { readBody } from '$lib/server/request-body';
import { requireSuperadmin } from '$lib/server/route-guards';
import {
	CONFIRMATION_REFUSED,
	CONFIRMATION_SECONDS,
	confirmStepUp,
	issueImportConfirmation
} from '$lib/server/step-up';
import { writeAs } from '$lib/server/write-as';
import type { RequestHandler } from './$types';

export const POST: RequestHandler = async ({ request, locals, cookies }) => {
	requireSuperadmin(locals.user);
	const body = await readBody(request);

	const { userId, hash } = await confirmStepUp(locals, cookies, body, 'POST /api/admin/import/confirm', requireSuperadmin);

	// Issued as the account is now, asked again after the check was awaited:
	// still the superadmin, and still the account whose password was checked.
	// It writes nothing; the transaction is the question alone.
	const session = cookies.get(SESSION_COOKIE_NAME) ?? '';
	const confirmation = writeAs(locals, (caller) => {
		const superadmin = requireSuperadmin(caller);
		if (superadmin.id !== userId) error(403, { message: CONFIRMATION_REFUSED, stepUp: 'confirmation' });
		return issueImportConfirmation(session, superadmin.id, hash);
	});

	return json(
		{ confirmation, expiresInSeconds: CONFIRMATION_SECONDS },
		{ headers: { 'cache-control': 'no-store' } }
	);
};
