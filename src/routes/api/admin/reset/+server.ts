import { json, error } from '@sveltejs/kit';
import { sqlite } from '$lib/server/db';
import { restorableTables } from '$lib/server/db/restore';
import { inTransaction } from '$lib/server/db/transaction';
import { SESSION_COOKIE_NAME } from '$lib/server/auth';
import { resetFormSecretCache } from '$lib/server/request-tokens';
import { requireSuperadmin } from '$lib/server/route-guards';
import { moveToTrash, type TrashResult, type UploadFile } from '$lib/server/uploads';
import type { RequestHandler } from './$types';
import { createLogger } from '$lib/server/logger';

const log = createLogger('ADMIN');

/** What a reset keeps: the record of what was done to this installation. */
const KEPT = ['system_logs', 'backup_log'];

const messageOf = (err: unknown) => (err instanceof Error ? err.message : String(err));

/**
 * POST — Nuclear reset: clear every table but the system log and the backup
 * history, and redirect to setup.
 *
 * All or nothing. It used to clear a fixed list of tables one at a time and
 * carry on past any that failed, so a user named by a dependency left every
 * user in place with their sessions and the settings gone, and the answer was
 * success. Now it is one transaction, and a failure is answered 500 with the
 * database as it was.
 *
 * The tables are the ones a restore replaces (`restorableTables`), so the
 * migration runner's record is not among them: the structure is unchanged, and
 * clearing its record would run every migration again at the next start. The
 * id counters (`sqlite_sequence`) are left alone too, so no id is used twice.
 *
 * A table left behind half way through a rebuild (`__new_...`) is not one a
 * restore replaces, but it is emptied here with the rest. Its rows are copies
 * of rows that are going, and one that named a user would otherwise fail the
 * foreign key check at the commit and refuse every reset on that database.
 *
 * Attachment files are moved to the trash once the reset is committed. A file
 * that cannot be moved is named in the answer, which is still a success: the
 * rows are gone either way.
 *
 * The superadmin's alone. Whoever resets is signed out with everybody else,
 * and the next person to open the site sets it up and is its superadmin: an
 * administrator who could reset could make themselves that.
 */
export const POST: RequestHandler = async ({ locals, cookies }) => {
	const actor = requireSuperadmin(locals.user);

	let cleared: { tables: number; rows: number; files: UploadFile[] };
	try {
		cleared = inTransaction(() => {
			// Holds the foreign key checks until the commit, so that the tables can
			// be cleared in any order, and switches itself off there. `PRAGMA
			// foreign_keys` cannot be changed inside a transaction and is not touched.
			sqlite.pragma('defer_foreign_keys = ON');

			const leftBehind = (
				sqlite.prepare("SELECT name FROM sqlite_master WHERE type = 'table'").all() as { name: string }[]
			)
				.map((row) => row.name)
				.filter((name) => name.startsWith('__new_'));
			const tables = [
				...restorableTables(sqlite).filter((table) => !KEPT.includes(table.toLowerCase())),
				...leftBehind
			];

			// Read before anything is deleted: the rows of one table go with the
			// rows of another by cascade, and cannot be asked about afterwards.
			const files = sqlite
				.prepare('SELECT card_id AS cardId, filename FROM card_attachments ORDER BY id')
				.all() as UploadFile[];
			let rows = 0;
			for (const table of tables) {
				rows += (sqlite.prepare(`SELECT COUNT(*) AS n FROM "${table}"`).get() as { n: number }).n;
			}

			// Nothing is caught: one table that cannot be cleared fails them all.
			for (const table of tables) sqlite.prepare(`DELETE FROM "${table}"`).run();

			return { tables: tables.length, rows, files };
		});
	} catch (e) {
		log.error(
			`A reset by ${actor.username} (ID: ${actor.id}) failed, and nothing was cleared: ${messageOf(e)}`,
			e,
			{ userId: actor.id }
		);
		throw error(500, `The reset failed and nothing was cleared: ${messageOf(e)}`);
	}

	// Committed. From here on a failure is something to say about a reset that
	// succeeded.

	// The key the public request form's tokens are signed with was a setting,
	// and is gone. The copy of it kept in memory is forgotten with it, so that
	// the next token is signed with a new key, kept in the settings, and a
	// token signed with the old one is refused. Left in memory, the old key
	// went on signing until the server stopped, with no setting behind it.
	resetFormSecretCache();

	let trash: TrashResult;
	try {
		trash = moveToTrash(cleared.files);
	} catch (e) {
		trash = { moved: 0, missing: 0, failed: [messageOf(e)] };
	}

	// Written after the commit, into a table the reset keeps, so it is there
	// afterwards to say who did this.
	const notMoved =
		trash.failed.length > 0
			? `, and ${trash.failed.length} could not be moved and are where they were: ` +
				trash.failed.slice(0, 10).join('; ') +
				(trash.failed.length > 10 ? `; and ${trash.failed.length - 10} more` : '')
			: '';
	log.critical(
		`The database was reset by ${actor.username} (ID: ${actor.id}): ${cleared.rows} row(s) cleared from ` +
			`${cleared.tables} table(s), the system log and the backup history kept; ` +
			`${trash.moved} attachment file(s) moved to the trash${notMoved}`,
		undefined,
		{ userId: actor.id }
	);

	// Clear the session cookie so the caller is logged out
	cookies.delete(SESSION_COOKIE_NAME, { path: '/' });

	return json({ success: true, redirect: '/setup', trash });
};
