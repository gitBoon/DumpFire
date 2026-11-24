import { error, isHttpError, json } from '@sveltejs/kit';
import { sqlite } from '$lib/server/db';
import { restorableTables } from '$lib/server/db/restore';
import { REVOKED_BECAUSE, endApiKeys } from '$lib/server/key-revocations';
import { ACCOUNT_ENDING, recordAccountEnding, recordPasswordReplaced } from '$lib/server/account-endings';
import { clearSessionCookie, whilePasswordHolds, type SessionUser } from '$lib/server/auth';
import { readBody } from '$lib/server/request-body';
import { resetFormSecretCache, writeFormSecret } from '$lib/server/request-tokens';
import { markScrubPending } from '$lib/server/stored-secrets';
import { resetKnownBrowserSecretCache } from '$lib/server/known-browsers';
import { requireSuperadmin } from '$lib/server/route-guards';
import { TWO_STEP_REQUIRED_AT } from '$lib/server/two-step-switch';
import { confirmStepUp } from '$lib/server/step-up';
import { moveToTrash, type TrashResult, type UploadFile } from '$lib/server/uploads';
import { writeAs } from '$lib/server/write-as';
import type { RequestHandler } from './$types';
import { createLogger } from '$lib/server/logger';

const log = createLogger('ADMIN');

/**
 * What a reset keeps: the record of what was done to this installation, the record of every API key ended here
 * (card 2995), the record of every account ended here (card 2996), the record of every change of access here (card
 * 3002) and the record of every change of where this server sends (card 3004), which `restorableTables` leaves out
 * already and which are named here so that no change to that list can make a reset clear them.
 */
const KEPT = ['system_logs', 'backup_log', 'api_key_revocations', 'account_endings', 'access_changes', 'outbound_changes'];

/**
 * The settings a reset writes back when two-step sign-in is required (card 3064, R1, F3): the switch first, then the
 * moment it was released at.
 */
const TWO_STEP_KEPT = [TWO_STEP_REQUIRED_AT, 'two_step_released_at'] as const;

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
 * Every API key is recorded as ended here, `reset`, before the clear, and the
 * record is kept (card 2995, R5): an import after a reset never brings a key
 * back. The answer counts them, `apiKeysRecorded`.
 *
 * And every account but the superadmin is recorded as disabled here, before
 * the clear, in the record of account endings, which is kept too (card 2996,
 * R19): an import after a reset brings the accounts back disabled, and the
 * superadmin enables the ones wanted. The answer counts them,
 * `accountsRecorded`. The password hash of each is recorded as replaced too
 * (card 2997, decision 5), so each comes back needing its password set.
 *
 * Two-step sign-in, where it is required, stays required (card 3064, R1, F3):
 * its switch and `two_step_released_at` are read before the clear and written
 * back after it, in the same transaction. Where it is dormant, neither is.
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
	let cleared: { tables: number; rows: number; files: UploadFile[]; apiKeysRecorded: number; accountsRecorded: number };
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

			// Two-step sign-in's switch and its release moment, read before the
			// settings are cleared, and written back after (card 3064, R1, F3): a
			// Reset never makes two-step sign-in optional again, and card 2935's
			// "made after the release" keeps its moment. With the switch off,
			// neither is written back.
			const kept = TWO_STEP_KEPT.map((key) => ({
				key,
				row: sqlite.prepare('SELECT value FROM settings WHERE key = ?').get(key) as { value: string } | undefined
			}));
			const twoStepOn = kept[0].row !== undefined;

			// Read before anything is deleted: the rows of one table go with the
			// rows of another by cascade, and cannot be asked about afterwards.
			const files = sqlite
				.prepare('SELECT card_id AS cardId, filename FROM card_attachments ORDER BY id')
				.all() as UploadFile[];
			let rows = 0;
			for (const table of tables) {
				rows += (sqlite.prepare(`SELECT COUNT(*) AS n FROM "${table}"`).get() as { n: number }).n;
			}

			// Every account but the superadmin recorded as disabled here, before the clear (card 2996, R19): an import
			// after the reset brings each back disabled, and the superadmin enables the ones wanted. The record is kept.
			const accounts = sqlite.prepare("SELECT id FROM users WHERE role <> 'superadmin' ORDER BY id").pluck().all() as number[];
			for (const id of accounts) recordAccountEnding(sqlite, id, ACCOUNT_ENDING.disabled);
			// And the fingerprint of each one's password hash, as replaced here (card 2997, decision 5): an import after
			// the reset brings each back with a password nothing matches too. The superadmin's own is not recorded: in a
			// restore it would do nothing, and the start would warn about it every five minutes.
			for (const id of accounts) recordPasswordReplaced(sqlite, id);
			const accountsRecorded = accounts.length;

			// Every API key recorded as ended here, `reset`, and deleted, before the clear (card 2995, R5): a reset done
			// to shut someone out is not undone for keys by an import of an older backup. The record is kept below.
			const apiKeysRecorded = endApiKeys(sqlite, { every: true }, REVOKED_BECAUSE.reset).length;

			// Nothing is caught: one table that cannot be cleared fails them all.
			for (const table of tables) sqlite.prepare(`DELETE FROM "${table}"`).run();

			// Two-step sign-in, on before the reset, is on after it, with its moment (card 3064, F3).
			if (twoStepOn) {
				for (const { key, row } of kept) {
					if (row !== undefined) sqlite.prepare('INSERT INTO settings (key, value) VALUES (?, ?)').run(key, row.value);
				}
			}

			// The form signing key was a setting and went with the rest: a new
			// one, in this transaction, so the reset never commits without one
			// and no read-only check is ever the first to need it (card 2750).
			writeFormSecret();
			// The rows deleted, the sealed secrets among them, are still in the
			// file's free space and its log: the scrub is marked pending, in this
			// transaction, and tried at the next start (card 2898's code review, S1).
			markScrubPending(sqlite);

			return { tables: tables.length, rows, files, apiKeysRecorded, accountsRecorded };
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
			`${cleared.apiKeysRecorded} API key(s) recorded as ended, so that no import brings one back, and that record kept; ` +
			`${cleared.accountsRecorded} account(s) recorded as disabled, so that an import brings each back disabled, and that record kept; ` +
			`${trash.moved} attachment file(s) moved to the trash${notMoved}`,
		undefined,
		{ userId: actor.id }
	);

	// Clear the session cookie so the caller is logged out
	clearSessionCookie(cookies, url);

	return json({ success: true, redirect: '/setup', trash, apiKeysRecorded: cleared.apiKeysRecorded, accountsRecorded: cleared.accountsRecorded });
};
