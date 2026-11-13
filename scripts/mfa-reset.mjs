/**
 * mfa-reset.mjs — resets an account's two-step sign-in from the server's host
 * (card 2773, plan 4.5).
 *
 *     docker exec <container> node scripts/mfa-reset.mjs <username>
 *     node scripts/mfa-reset.mjs <username>          outside the image, DB_PATH or ./dumpfire.db
 *
 * Nobody manages the superadmin's account through the app, so when the
 * superadmin loses the phone their second factor is on, this is the way back
 * (decision 10). It works for any account, by its username, trimmed and
 * matched exactly, as sign-in matches it (decision 12).
 *
 * It does what `resetTwoStep` (src/lib/server/mfa-store.ts) does, statement
 * for statement, in raw SQL in one `BEGIN IMMEDIATE` transaction: the
 * account's factors and recovery codes are deleted, its wrong-code counts set
 * to 0 and their pauses cleared, its sessions, unused invites, pending
 * sign-ins and enrolment links ended (`endAccountAccess` with API keys and
 * report schedules kept), and one enrolment link issued, `issued_by
 * 'host-reset'`, for seven days. A CRITICAL line goes to `system_logs` in the
 * same transaction, so there is no reset without its line. Its password, API
 * keys, webhooks, report schedules, security banner and last sign-in are kept.
 * tests/mfa-reset-script.test.ts compares every table and column after this
 * with what `resetTwoStep` leaves, so a change to one that is not made to the
 * other fails there.
 *
 * Standalone: better-sqlite3 and node's own modules, no `$lib` and no
 * TypeScript, because the image holds the built server and not its source.
 * So the few rules it shares with the server are copied here, each saying
 * where from: the stored form of a moment (src/lib/timestamps.ts), a token's
 * hash (mfa-crypto.ts `sha256Hex`), the logger's `printable`, and how an
 * address is read (email.ts `appUrlAsRead`, `configuredOrigin`).
 *
 * The link's address (decision 13) is the host's own configuration first:
 * `APP_URL`, then `ORIGIN` unless it is the image's placeholder, then the App
 * URL setting, which any administrator can change and is said so; failing
 * all three, the path alone, to put the server's address in front of. It
 * says which it used. The link goes to stdout only, and never to the log.
 *
 * Exit code 0 when the account was reset; 1 when it was refused (run as root,
 * no database file, a database with no two-step sign-in tables, no such
 * account, or the database stayed busy) with nothing changed; 2 for a usage
 * error.
 */
import Database from 'better-sqlite3';
import { createHash, randomBytes } from 'node:crypto';
import { join, resolve } from 'node:path';

/** How long the link works for: `ENROLMENT_LINK_LIFETIME_MS` in mfa-store.ts. */
const ENROLMENT_LINK_LIFETIME_MS = 7 * 24 * 60 * 60 * 1000;

/** The path a link's token follows: `ENROLMENT_LINK_PATH` in mfa-store.ts. */
const ENROLMENT_LINK_PATH = '/enrol/';

/** The `ORIGIN` the image is built with, which is nobody's real address: `PLACEHOLDER_ORIGIN` in email.ts. */
const PLACEHOLDER_ORIGIN = 'http://localhost:3000';

/** The tables migration 0065 makes, and the oldest table this writes to (the system log, 0039). */
const NEEDED_TABLES = ['mfa_factors', 'mfa_recovery_codes', 'sign_in_challenges', 'enrolment_links', 'system_logs'];

const USAGE = 'Usage: node scripts/mfa-reset.mjs <username>\n\nResets the two-step sign-in of the account with that username, and prints the link that sets up a new one.';

/** A refusal: said on stderr, with the exit code it ends with. */
class Refused extends Error {
	/** @param {string} message @param {number} code */
	constructor(message, code = 1) {
		super(message);
		this.code = code;
	}
}

/** The stored form of a moment, `YYYY-MM-DD HH:MM:SS` in UTC: `stamp` in src/lib/timestamps.ts. */
function stamp(date = new Date()) {
	/** @param {number} n @param {number} [width] */
	const pad = (n, width = 2) => String(n).padStart(width, '0');
	return (
		`${pad(date.getUTCFullYear(), 4)}-${pad(date.getUTCMonth() + 1)}-${pad(date.getUTCDate())} ` +
		`${pad(date.getUTCHours())}:${pad(date.getUTCMinutes())}:${pad(date.getUTCSeconds())}`
	);
}

/** A token's hash as it is stored: `sha256Hex` in mfa-crypto.ts. @param {string} text */
function sha256Hex(text) {
	return createHash('sha256').update(text, 'utf8').digest('hex');
}

/**
 * Text as a log line holds it, each control, direction and invisible character
 * one space: `printable` and `UNPRINTABLE` in logger.ts (card 2214), whose
 * comment says why. A username is stored text, and is said in the log line
 * and on the terminal.
 */
const UNPRINTABLE_EVERYWHERE = /[\x00-\x1f\x7f-\x9f\u200b-\u200f\u2028-\u202e\u2066-\u2069\ufeff\p{Cf}]/gu;
/** @param {string} text */
const printable = (text) => String(text).replace(UNPRINTABLE_EVERYWHERE, ' ');

/** An App URL as a link reads it: `appUrlAsRead` in email.ts. @param {string} value */
function appUrlAsRead(value) {
	const url = value.trim().replace(/\/+$/, '');
	return url && !/^https?:\/\//i.test(url) ? `http://${url}` : url;
}

/** `ORIGIN` as the node adapter reads it, or null: `configuredOrigin` in email.ts. @param {string | undefined} value */
function configuredOrigin(value) {
	if (value === undefined) return null;
	try {
		const url = new URL(value.trim());
		return url.protocol === 'http:' || url.protocol === 'https:' ? url.origin : null;
	} catch {
		return null;
	}
}

/**
 * Where the link's address comes from (decision 13): the host's own
 * configuration before a setting any administrator can change, and never the
 * image's placeholder `ORIGIN`. Null for none.
 *
 * @param {Database.Database} database
 * @returns {{ base: string, said: string } | null}
 */
function linkAddress(database) {
	const fromEnv = appUrlAsRead(process.env.APP_URL || '');
	if (fromEnv) return { base: fromEnv, said: "The link's address is from APP_URL." };

	const origin = configuredOrigin(process.env.ORIGIN);
	if (origin && origin !== PLACEHOLDER_ORIGIN) return { base: origin, said: "The link's address is from ORIGIN." };

	const row = /** @type {{ value: string | null } | undefined} */ (
		database.prepare("SELECT value FROM settings WHERE key = 'app_url'").get()
	);
	const setting = appUrlAsRead(row?.value ?? '');
	if (setting) {
		return {
			base: setting,
			said:
				"The link's address is from the App URL setting. Warning: an administrator set it, and any administrator " +
				"can change it. Check it is this server's address before you pass the link on, or set APP_URL on the host."
		};
	}
	return null;
}

/**
 * Refuse to run as root on POSIX (card 2776): a write as root makes the
 * database's `-wal` and `-shm` files root's, and the server, which runs as
 * `node`, then cannot open its database. Tests give the uid through
 * `DUMPFIRE_TEST_UID`, because the image build runs them as root. It is read
 * only when `NODE_ENV` is `test` and `VITEST` is set (card 2773's review), so
 * that one variable left set on a host is not enough. The seam can only remove
 * this refusal (or make it, for a uid of 0): it gives the script no other
 * power, and every other check below still runs.
 */
function refuseRoot() {
	if (process.platform === 'win32' || typeof process.getuid !== 'function') return;
	const seam = process.env.NODE_ENV === 'test' && process.env.VITEST ? process.env.DUMPFIRE_TEST_UID : undefined;
	const uid = seam !== undefined && seam !== '' ? Number(seam) : process.getuid();
	if (uid === 0) {
		throw new Refused(
			'Refused: this is running as root. Run it as the user the server runs as, so the files the database ' +
				'writes beside itself stay the server\'s: docker exec -u node <container> node scripts/mfa-reset.mjs <username>'
		);
	}
}

/**
 * Open the database, never making one: a path that names no file is refused,
 * as is a database the server has not migrated to two-step sign-in.
 *
 * @param {string} path
 */
function openDatabase(path) {
	/** @type {Database.Database} */
	let database;
	try {
		database = new Database(path, { fileMustExist: true });
	} catch (err) {
		throw new Refused(`Refused: there is no database at ${path} (${/** @type {Error} */ (err).message}). Set DB_PATH to the server's database file.`);
	}
	const tables = new Set(
		/** @type {{ name: string }[]} */ (database.prepare("SELECT name FROM sqlite_master WHERE type = 'table'").all()).map((t) => t.name)
	);
	if (NEEDED_TABLES.some((table) => !tables.has(table))) {
		database.close();
		throw new Refused(`Refused: this database has no two-step sign-in tables; start the server once to migrate it (${path}).`);
	}
	// As the server's connection: wait for its write to end rather than fail at once, and keep the keys to users.
	database.pragma('busy_timeout = 5000');
	database.pragma('foreign_keys = ON');
	return database;
}

/**
 * `resetTwoStep(userId, 'host-reset')` in raw SQL, with the account looked up
 * in the same transaction, and the CRITICAL line written in it. Answers the
 * counts and the token, which is stored only as its hash.
 *
 * @param {Database.Database} database
 * @param {string} username
 */
function reset(database, username) {
	return database
		.transaction(() => {
			const account = /** @type {{ id: number, username: string } | undefined} */ (
				database.prepare('SELECT id, username FROM users WHERE username = ?').get(username)
			);
			if (!account) throw new Refused(`Refused: there is no account with the username "${printable(username)}". Nothing was changed.`);
			const id = account.id;

			const factors = database.prepare('DELETE FROM mfa_factors WHERE user_id = ?').run(id).changes;
			const recoveryCodes = database.prepare('DELETE FROM mfa_recovery_codes WHERE user_id = ?').run(id).changes;
			database
				.prepare(
					'UPDATE users SET mfa_known_wrong = 0, mfa_other_wrong = 0, mfa_recovery_wrong = 0, ' +
						'mfa_known_resumes_at = NULL, mfa_other_resumes_at = NULL, mfa_recovery_resumes_at = NULL WHERE id = ?'
				)
				.run(id);

			// endAccountAccess(id, { apiKeys: false, reportSchedules: false }): sessions, unused invites
			// (endUnusedInvites), then endPendingSignIns' challenges and links. Keys, webhooks and schedules kept.
			const sessions = database.prepare('DELETE FROM sessions WHERE user_id = ?').run(id).changes;
			const invites = database.prepare('DELETE FROM invite_tokens WHERE user_id = ? AND used = 0').run(id).changes;
			const challenges = database.prepare('DELETE FROM sign_in_challenges WHERE user_id = ?').run(id).changes;
			database.prepare('DELETE FROM enrolment_links WHERE user_id = ?').run(id);

			// issueEnrolmentLink(id, 'host-reset'): the account's one link, its token kept only as its hash.
			database.prepare('DELETE FROM enrolment_links WHERE user_id = ?').run(id);
			const token = randomBytes(32).toString('base64url');
			const now = new Date();
			database
				.prepare('INSERT INTO enrolment_links (token_hash, user_id, issued_by, created_at, expires_at) VALUES (?, ?, ?, ?, ?)')
				.run(sha256Hex(token), id, 'host-reset', stamp(now), stamp(new Date(now.getTime() + ENROLMENT_LINK_LIFETIME_MS)));

			// The route's line, said as the host's; the counts and the account, never the token or the link.
			const name = printable(account.username);
			const message =
				`Two-step sign-in reset for user ${id} ("${name}") on the server's host, with scripts/mfa-reset.mjs: removed ` +
				`${factors} factor(s) and ${recoveryCodes} recovery code(s), ended ${sessions} session(s), ${challenges} ` +
				`pending sign-in(s) and ${invites} invite(s); an enrolment link was issued`;
			const meta = printable(
				JSON.stringify({
					targetUserId: id,
					resetBy: 'host',
					factorsRemoved: factors,
					recoveryCodesRemoved: recoveryCodes,
					sessionsEnded: sessions,
					challengesEnded: challenges,
					invitesEnded: invites
				})
			);
			database
				.prepare('INSERT INTO system_logs (timestamp, level, context, message, meta, user_id, ip) VALUES (?, ?, ?, ?, ?, ?, ?)')
				.run(stamp(now), 'CRITICAL', 'AUTH', message, meta, id, null);

			return { id, name, factors, recoveryCodes, sessions, invites, challenges, token };
		})
		.immediate();
}

function main() {
	const args = process.argv.slice(2);
	const username = args.length === 1 ? args[0].trim() : '';
	if (username === '') throw new Refused(USAGE, 2);

	refuseRoot();
	const path = resolve(process.env.DB_PATH || join(process.cwd(), 'dumpfire.db'));
	const database = openDatabase(path);
	try {
		let done;
		try {
			done = reset(database, username);
		} catch (err) {
			if (err instanceof Refused) throw err;
			throw new Refused(`Refused: the reset could not be written, and nothing was changed: ${/** @type {Error} */ (err).message}`);
		}
		const address = linkAddress(database);

		console.log(
			`Two-step sign-in was reset for "${done.name}" (user ${done.id}): removed ${done.factors} factor(s) and ` +
				`${done.recoveryCodes} recovery code(s), ended ${done.sessions} session(s), ${done.challenges} pending ` +
				`sign-in(s) and ${done.invites} invite(s).`
		);
		console.log('');
		console.log(
			`Give ${done.name} this link yourself, by a way only they read. It is shown once and works for seven days, ` +
				'and the account still needs its password.'
		);
		if (address) {
			console.log(address.said);
			console.log('');
			console.log(`${address.base}${ENROLMENT_LINK_PATH}${done.token}`);
		} else {
			console.log(
				"No address for the link was found in APP_URL, ORIGIN or the App URL setting: put your server's address in " +
					'front of this path.'
			);
			console.log('');
			console.log(`${ENROLMENT_LINK_PATH}${done.token}`);
		}
	} finally {
		database.close();
	}
}

try {
	main();
} catch (err) {
	if (err instanceof Refused) {
		console.error(err.message);
		process.exit(err.code);
	}
	console.error(`Refused: ${/** @type {Error} */ (err)?.message ?? err}`);
	process.exit(1);
}
