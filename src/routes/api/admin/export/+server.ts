/**
 * /api/admin/export — Download a complete SQLite database backup.
 *
 * The superadmin's alone: the file holds every user's password hash and email,
 * and every webhook's address.
 *
 * It is the copy a scheduled backup uploads, made by the same function
 * (`generateBackupData`): VACUUM INTO, which captures everything, WAL
 * included, with no need to list tables, and then cleared of every session
 * and every unused invite, and of the mail password, every backup
 * destination's credentials and every webhook's signing secret (card 2169).
 * So the file signs nobody in, and restoring it signs everybody out; restored
 * on another server, its secrets are entered again.
 *
 * Being a backup, it carries what a backup carries of two-step sign-in (card
 * 2768): every pending sign-in and enrolment link is cleared from it as the
 * sessions are; each account's second factors go in only as the ciphertext
 * they are stored as, and its recovery codes only as hashes; the MFA key that
 * opens the factors never does, as it is in a file of its own outside the
 * database.
 *
 * A POST with the superadmin's current password, `{ currentPassword }` (card
 * 2701, decision 17): it hands out every account's password hash, so it asks
 * for the password again, as the reset does. It was a GET, which a body
 * cannot be sent with; the page fetches the file and saves it, and never
 * navigates to it, so a POST serves it as well. `GET` is now 405. The copy is
 * made only while the stored hash is the one the password was checked
 * against (`requirePasswordUnchanged`, with nothing awaited between: VACUUM
 * INTO cannot run in a transaction), and the answer is never stored by the
 * browser or a proxy.
 */

import { generateBackupData } from '$lib/server/backup';
import { readBody } from '$lib/server/request-body';
import { requireSuperadmin } from '$lib/server/route-guards';
import { confirmStepUp, requirePasswordUnchanged } from '$lib/server/step-up';
import { stillCallerNow } from '$lib/server/write-as';
import type { RequestHandler } from './$types';

export const POST: RequestHandler = async ({ request, locals, cookies }) => {
	requireSuperadmin(locals.user);
	const body = await readBody(request);

	// The superadmin's password, asked for again, after every refusal that
	// needs none (step-up.ts).
	const { userId, hash } = await confirmStepUp(locals, cookies, body, 'POST /api/admin/export', requireSuperadmin);

	// Asked again once the password is checked, with nothing awaited between
	// this and the copy (card 2253): a session that has ended, or an account
	// that is no longer the superadmin, is sent nothing; and nor is one whose
	// password changed while it was being checked.
	requireSuperadmin(stillCallerNow(locals));
	requirePasswordUnchanged(userId, hash, 'changed');

	const dbBuffer = generateBackupData();

	const timestamp = new Date().toISOString().slice(0, 10);

	return new Response(dbBuffer, {
		headers: {
			'Content-Type': 'application/x-sqlite3',
			'Content-Disposition': `attachment; filename="dumpfire-backup-${timestamp}.db"`,
			'Cache-Control': 'no-store'
		}
	});
}
