import { error, isHttpError, json } from '@sveltejs/kit';
import { sqlite } from '$lib/server/db';
import { restorableTables } from '$lib/server/db/restore';
import { clearSessionCookie, whilePasswordHolds, type SessionUser } from '$lib/server/auth';
import { readBody } from '$lib/server/request-body';
import { resetFormSecretCache, writeFormSecret } from '$lib/server/request-tokens';
import { markScrubPending } from '$lib/server/stored-secrets';
import { resetKnownBrowserSecretCache } from '$lib/server/known-browsers';
import { requireSuperadmin } from '$lib/server/route-guards';
import { confirmStepUp } from '$lib/server/step-up';
import { moveToTrash, type TrashResult, type UploadFile } from '$lib/server/uploads';
import { writeAs } from '$lib/server/write-as';
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
 *
 * With the superadmin's current password (card 2701): `{ currentPassword }`,
 * checked before the transaction, which runs only while the stored hash is
 * the one it was checked against (step-up.ts).
 */
export const POST: RequestHandler = async ({ request, locals, cookies, url }) => {
	requireSuperadmin(locals.user);
	const body = await readBody(request);

	let actor: SessionUser | undefined;
	let cleared: { tables: number; rows: number; files: UploadFile[] };
	try {
		// Who resets, as the account is now (card 2253), named for the lines
		// below, which are written whether the reset commits or fails: the
		// step-up's guard asks it, before the password is checked. The reset's
		// own writeAs asks again.
		const confirmed = await confirmStepUp(locals, cookies, body, 'POST /api/admin/reset', requireSuperadmin);
		actor = confirmed.actor;
		cleared = await whilePasswordHolds(confirmed.userId, confirmed.hash, () => writeAs(locals, (caller) => {
			requireSuperadmin(caller);
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

			// The form signing key was a setting and went with the rest: a new
			// one, in this transaction, so the reset never commits without one
			// and no read-only check is ever the first to need it (card 2750).
			writeFormSecret();
			// The rows deleted, the sealed secrets among them, are still in the
			// file's free space and its log: the scrub is marked pending, in this
			// transaction, and tried at the next start (card 2898's code review, S1).
			markScrubPending(sqlite);

			return { tables: tables.length, rows, files };
		}));
	} catch (e) {
		// Refused at the write (card 2253): an answer already, and nothing was
		// cleared or tried, so no line.
		if (isHttpError(e)) throw e;
		// For the line alone: the account as it is now, or, where a fault in the
		// database stopped even that being asked, the one the gate let in. It
		// decides nothing; the reset has failed (the slices 5–7 review).
		const who = actor ?? locals.user;
		log.error(
			`A reset by ${who?.username} (ID: ${who?.id}) failed, and nothing was cleared: ${messageOf(e)}`,
			e,
			{ userId: who?.id ?? null }
		);
		throw error(500, `The reset failed and nothing was cleared: ${messageOf(e)}`);
	}

	// Committed. From here on a failure is something to say about a reset that
	// succeeded.

	// The key the public request form's tokens are signed with was a setting,
	// and was replaced in the reset's transaction. The copy of the old one kept
	// in memory is forgotten, so that the next token is signed with the new
	// key and a token signed with the old one is refused. Left in memory, the
	// old key went on signing until the server stopped.
	resetFormSecretCache();
	// So was the key remembered browsers are signed with (card 2194): every
	// browser is forgotten, and the next one remembered makes a new key.
	resetKnownBrowserSecretCache();

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
	clearSessionCookie(cookies, url);

	return json({ success: true, redirect: '/setup', trash });
};
