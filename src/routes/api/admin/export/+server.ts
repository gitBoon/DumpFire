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
 */

import { generateBackupData } from '$lib/server/backup';
import { requireSuperadmin } from '$lib/server/route-guards';
import type { RequestHandler } from './$types';

export const GET: RequestHandler = async ({ locals }) => {
	requireSuperadmin(locals.user);

	const dbBuffer = generateBackupData();

	const timestamp = new Date().toISOString().slice(0, 10);

	return new Response(dbBuffer, {
		headers: {
			'Content-Type': 'application/x-sqlite3',
			'Content-Disposition': `attachment; filename="dumpfire-backup-${timestamp}.db"`
		}
	});
}
