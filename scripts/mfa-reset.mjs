/**
 * mfa-reset.mjs — resets an account's two-step sign-in from the server's host
 * (card 2773, plan 4.5).
 *
 *     docker exec <container> node scripts/mfa-reset.mjs [--keep-api-keys] [--] <username>
 *     node scripts/mfa-reset.mjs <username>          outside the image, DB_PATH or ./dumpfire.db
 *
 * Nobody manages the superadmin's account through the app, so when the
 * superadmin loses the phone their second factor is on, this is the way back
 * (decision 10). It works for any account, by its username, trimmed and
 * matched exactly, as sign-in matches it (decision 12).
 *
 * The options are read strictly (card 2915, S2): each argument trimmed;
 * `--keep-api-keys`, once only, keeps the account's API keys and the webhooks
 * it set; any other argument starting with "-" is an unknown option, unless
 * it comes after a lone `--`, which ends the options, so a username starting
 * with "-" can be named. Exactly one username. Every refusal of the arguments
 * is a usage error, before the database is opened: a misspelt flag is never
 * read as a username, nor a reset that ends keys the operator meant to keep.
 *
 * It does what `resetTwoStep` (src/lib/server/mfa-store.ts) does, statement
 * for statement, in raw SQL in one `BEGIN IMMEDIATE` transaction: the
 * account's factors and recovery codes are deleted, its wrong-code counts set
 * to 0 and their pauses cleared, its sessions, unused invites, pending
 * sign-ins and enrolment links ended, its API keys deleted and the webhooks it
 * set that are on switched off with the hold 'setter access ended' (card
 * 2915: `endAccountAccess` with `apiKeys: true`, unless `--keep-api-keys`,
 * which is `resetTwoStep`'s `apiKeys: false`), and, with them, those it set
 * that were already switched off without a hold held the same way, left off
 * (card 2923), its report schedules that are
 * on paused (always, card 2894), and one enrolment link issued, `issued_by
 * 'host-reset'`, for seven days. Before the CRITICAL line, the server's
 * Webhooks WARN lines for those switched off and those held (`tellSwitchedOff`
 * in webhooks.ts, copied as `webhookLines`), with no account, and one saying
 * that their boards' owners were not mailed, as the host sends no mail (card
 * 2923, S6): stdout says to tell them. A CRITICAL line goes to `system_logs` in the
 * same transaction, so there is no reset without its line; its meta has the
 * fields the route's has (`twoStepResetMeta` in mfa-store.ts), the ids of the
 * keys ended (ids only), the webhooks switched off and the schedules paused
 * included, and, on a keep,
 * the live keys and the webhooks kept, with their ids (S3). Its password,
 * security banner and last sign-in are kept. tests/mfa-reset-script.test.ts
 * compares every table and column after this with what `resetTwoStep` leaves,
 * and the line's meta with the route's, so a change to one that is not made
 * to the other fails there. A scheduled report run already claimed when the
 * pause commits still sends once.
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
 * URL setting, which the superadmin alone can change since card 2847 (any
 * administrator before, so a row may still be theirs) and is said so; failing
 * all three, the path alone, to put the server's address in front of. It
 * says which it used. The link goes to stdout only, and never to the log; so
 * do the account's API keys and the webhooks it set that the reset ended, or,
 * on a keep, kept, each by its name (a webhook by its board and host) and the
 * day it was made (card 2894's code review, CS1; card 2915), and the
 * already-off webhooks it held, listed apart (card 2923, S2), the keys read
 * before they are deleted and the webhooks by the switch-off's own ids (S5):
 * the host may read them, and passes them on to the holder. So do the
 * settings the account is recorded as having set (`setting_setters`, card
 * 2915, S1): recorded, since whether one is still at the recorded place needs
 * the server's own rules, which this does not copy.
 *
 * Exit code 0 when the account was reset; 1 when it was refused (run as root,
 * no database file, a database with no two-step sign-in tables, no report
 * schedules or no webhook holds, no such account, a disabled account, or the
 * database stayed busy) with nothing changed; 2 for a usage error.
 */
import Database from 'better-sqlite3';
import { createHash, randomBytes } from 'node:crypto';
import { join, resolve } from 'node:path';
import { fileURLToPath } from 'node:url';

/** How long the link works for: `ENROLMENT_LINK_LIFETIME_MS` in mfa-store.ts. */
const ENROLMENT_LINK_LIFETIME_MS = 7 * 24 * 60 * 60 * 1000;

/** The path a link's token follows: `ENROLMENT_LINK_PATH` in mfa-store.ts. */
const ENROLMENT_LINK_PATH = '/enrol/';

/** The `ORIGIN` the image is built with, which is nobody's real address: `PLACEHOLDER_ORIGIN` in email.ts. */
const PLACEHOLDER_ORIGIN = 'http://localhost:3000';

/**
 * The tables migration 0065 makes, the oldest table this writes to (the
 * system log, 0039), and the report schedules it pauses (card 2894, S15): a
 * database without them is refused, not reset in part.
 */
const NEEDED_TABLES = ['mfa_factors', 'mfa_recovery_codes', 'sign_in_challenges', 'enrolment_links', 'system_logs', 'report_schedules'];

/** What `held_because` records for a webhook whose setter's access ended: `'setter access ended'` in src/lib/server/webhooks.ts. */
const SETTER_ACCESS_ENDED = 'setter access ended';

const USAGE =
	'Usage: node scripts/mfa-reset.mjs [--keep-api-keys] [--] <username>\n\n' +
	'Resets the two-step sign-in of the account with that username, and prints the link that sets up a new one. ' +
	"It ends the account's API keys and switches off the webhooks it set up, as a password reset does.\n\n" +
	'  --keep-api-keys  keeps them.\n' +
	'  --               ends the options, so a username starting with "-" can be named.';

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

/**
 * A moment as the server reads one, in the stored form, or null: `toStamp`
 * in src/lib/timestamps.ts, at a range's lower end (a bare date is its
 * first second). @param {unknown} input
 */
function toStamp(input) {
	if (typeof input !== 'string') return null;
	const m = /^(\d{4})-(\d{2})-(\d{2})(?:[T ](\d{2}):(\d{2})(?::(\d{2})(?:\.\d{1,9})?)?(Z|[+-](\d{2}):(\d{2}))?)?$/.exec(input);
	if (!m) return null;
	const [, y, mo, d, h, mi, s, zone, zh, zm] = m;
	const year = Number(y);
	const month = Number(mo);
	const day = Number(d);
	const hour = h === undefined ? 0 : Number(h);
	const minute = h === undefined ? 0 : Number(mi);
	const second = h === undefined ? 0 : Number(s ?? 0);
	const daysIn = month === 2 ? (year % 4 === 0 && (year % 100 !== 0 || year % 400 === 0) ? 29 : 28) : [4, 6, 9, 11].includes(month) ? 30 : 31;
	if (month < 1 || month > 12 || day < 1 || day > daysIn) return null;
	if (hour > 23 || minute > 59 || second > 59) return null;
	let offsetMinutes = 0;
	if (zone !== undefined && zone !== 'Z') {
		if (Number(zh) > 23 || Number(zm) > 59) return null;
		offsetMinutes = (zone.startsWith('-') ? -1 : 1) * (Number(zh) * 60 + Number(zm));
	}
	const moment = new Date(0);
	moment.setUTCFullYear(year, month - 1, day);
	moment.setUTCHours(hour, minute - offsetMinutes, second, 0);
	const out = moment.getUTCFullYear();
	if (out < 0 || out > 9999) return null;
	return stamp(moment);
}

/**
 * Whether an API key has ended at `now`, a moment in the stored form:
 * `keyEnded` and `deadlinePassed` in src/lib/server/auth.ts, the gate's own
 * rule, so the keys this lists are the keys that work.
 * @param {{ expires_at: string | null, deadline_at: string | null }} key @param {string} now
 */
function keyEnded(key, now) {
	if (key.expires_at !== null) {
		const expires = toStamp(key.expires_at);
		if (expires === null || expires <= now) return true;
	}
	if (key.deadline_at === null) return false;
	const deadline = toStamp(key.deadline_at);
	return deadline === null || deadline <= now;
}

/** A webhook's host alone, as `keysAndWebhooksOf` in second-step.ts gives it: a path or a query may hold the receiver's secret. @param {string} url */
function hostOf(url) {
	try {
		return new URL(url).host;
	} catch {
		return 'an address that cannot be read';
	}
}

/**
 * The host a webhook is listed by (card 2928): its stored `receiver`, as
 * `hookAsListed` in second-step.ts reads it. The address itself is sealed
 * under the MFA key, which this reads nothing of: only one that is not sealed
 * (a database this release has not started yet, which has no `receiver`) is
 * read for its host.
 * @param {{ url: string, receiver: string | null }} hook
 */
function hostOfHook(hook) {
	if (hook.receiver) return hostOf(hook.receiver);
	if (hook.url.startsWith('dfsealed:') || hook.url === '') return 'an address that cannot be read here';
	return hostOf(hook.url);
}

/** The ids a log line names, or nothing for none: `namingIds` in auth.ts. @param {number[]} ids */
const namingIds = (ids) => (ids.length === 0 ? '' : ` (${ids.length === 1 ? 'id' : 'ids'} ${ids.join(', ')})`);

/** How many webhooks one Webhooks line names; the rest are counted: `SWITCHED_OFF_NAMED` in webhooks.ts. */
const SWITCHED_OFF_NAMED = 20;

/**
 * The Webhooks WARN lines the server writes for webhooks switched off, and
 * already-off webhooks held, as their setter's access ended, and the line
 * that their boards' owners were not mailed: `tellSwitchedOff` in
 * src/lib/server/webhooks.ts, word for word, with `HOLD_IN_WORDS['setter
 * access ended']` and the reason the host gives for sending no mail (card
 * 2923, S6). Never the address. None for neither group.
 *
 * @param {{ id: number, board_id: number, set_by: number | null }[]} done
 * @param {{ id: number, board_id: number, set_by: number | null }[]} held
 * @param {string} cause
 * @returns {string[]}
 */
export function webhookLines(done, held, cause) {
	if (done.length === 0 && held.length === 0) return [];
	/** @param {{ set_by: number | null }} hook */
	const words = (hook) =>
		hook.set_by === null ? 'nobody is recorded as having set it up' : `the account that set it up (user ${hook.set_by}) had its access ended`;
	/** @param {{ id: number, board_id: number, set_by: number | null }[]} hooks */
	const named = (hooks) =>
		hooks
			.slice(0, SWITCHED_OFF_NAMED)
			.map((hook) => `webhook ${hook.id} on board ${hook.board_id}: ${words(hook)}`)
			.join('; ') + (hooks.length > SWITCHED_OFF_NAMED ? `; and ${hooks.length - SWITCHED_OFF_NAMED} more` : '');
	/** @type {string[]} */
	const lines = [];
	if (done.length === 1) {
		lines.push(
			`Webhook ${done[0].id} on board ${done[0].board_id} switched off: ${words(done[0])} (${cause}). ` +
				'It stays off until an owner of the board or an administrator switches it on.'
		);
	} else if (done.length > 1) {
		lines.push(`${done.length} webhooks switched off (${cause}): ${named(done)}. Each stays off until an owner of its board or an administrator switches it on.`);
	}
	if (held.length === 1) {
		lines.push(
			`Webhook ${held[0].id} on board ${held[0].board_id}, already switched off, is now held: ${words(held[0])} (${cause}). ` +
				'Switched on again by an owner of the board or an administrator, it is given a new secret.'
		);
	} else if (held.length > 1) {
		lines.push(
			`${held.length} webhooks already switched off are now held (${cause}): ${named(held)}. ` +
				'Each, switched on again by an owner of its board or an administrator, is given a new secret.'
		);
	}
	const all = done.length + held.length;
	const tail = done.length > 0 && held.length > 0 ? 'The lines above name them.' : all === 1 ? 'The line above names it.' : 'The line above names them.';
	lines.push(
		`The owners of the boards of the ${all} webhook(s) ${held.length === 0 ? 'switched off' : 'switched off or held'} above were not mailed, ` +
			`as this ran on the server's host, which sends no mail. ${tail}`
	);
	return lines;
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

/**
 * The App URL setting as it may be used, or null for none or for text that is
 * no plain web address: `appUrlNormalised` in email.ts (card 2847's code
 * review, CS1). Refused: a backslash or a control character, a user name or
 * password, a query or fragment, a path beginning `//`, anything but http or
 * https. Otherwise the address's origin and path, trailing slashes stripped,
 * so the link printed is the address that was judged.
 * @param {string} value
 */
function appUrlNormalised(value) {
	const read = appUrlAsRead(value);
	if (read === '' || /[\p{Cc}\\]/u.test(read)) return null;
	let url;
	try {
		url = new URL(read);
	} catch {
		return null;
	}
	if (url.protocol !== 'http:' && url.protocol !== 'https:') return null;
	if (url.username || url.password || url.search || url.hash || url.pathname.startsWith('//')) return null;
	return (url.origin + url.pathname).replace(/\/+$/, '');
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
 * configuration before a setting an account can change, and never the
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
	// Read as the server reads it (card 2847's code review): a row that is no
	// plain web address is not used, and the link falls to the path alone.
	// It is used only where the host configures no address, so no origin is
	// there to hold it to.
	const setting = appUrlNormalised(row?.value ?? '');
	if (setting) {
		return {
			base: setting,
			said:
				"The link's address is from the App URL setting. Warning: an administrator set it (the superadmin alone " +
				"since card 2847, any administrator before). Check it is this server's address before you pass the link " +
				'on, or set APP_URL on the host.'
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
 * as is a database the server has not migrated to two-step sign-in, report
 * schedules or webhook holds.
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
	const missing = NEEDED_TABLES.filter((table) => !tables.has(table));
	if (missing.length > 0) {
		database.close();
		const what = missing.length === 1 && missing[0] === 'report_schedules' ? 'no report schedules table' : 'no two-step sign-in tables';
		throw new Refused(`Refused: this database has ${what}; start the server once to migrate it (${path}).`);
	}
	// The webhook holds (migration 0071, card 2752) the switch-off records (card 2915, E16): a database
	// from between 0065 and 0071 is refused, not reset in part.
	const webhookColumns = new Set(
		/** @type {{ name: string }[]} */ (database.prepare('PRAGMA table_info(webhooks)').all()).map((column) => column.name)
	);
	if (!webhookColumns.has('held_because') || !webhookColumns.has('held_at')) {
		database.close();
		throw new Refused(`Refused: this database has no webhook holds; start the server once to migrate it (${path}).`);
	}
	// As the server's connection: wait for its write to end rather than fail at once, and keep the keys to users.
	database.pragma('busy_timeout = 5000');
	database.pragma('foreign_keys = ON');
	return database;
}

/**
 * `resetTwoStep(userId, 'host-reset')` in raw SQL, or with `keep`
 * `resetTwoStep(userId, 'host-reset', { apiKeys: false })`, with the account
 * looked up in the same transaction, and the CRITICAL line written in it.
 * Answers the counts, what ended or was kept, the settings recorded, and the
 * token, which is stored only as its hash.
 *
 * @param {Database.Database} database
 * @param {string} username
 * @param {boolean} keep
 */
function reset(database, username, keep) {
	return database
		.transaction(() => {
			// Every column, so that a database from before 0072, with no disabled_at, is read too.
			const account = /** @type {{ id: number, username: string, disabled_at?: string | null } | undefined} */ (
				database.prepare('SELECT * FROM users WHERE username = ?').get(username)
			);
			if (!account) throw new Refused(`Refused: there is no account with the username "${printable(username)}". Nothing was changed.`);
			// A disabled account is not reset (card 2671, S15): an administrator enables it first.
			if (account.disabled_at !== undefined && account.disabled_at !== null) {
				throw new Refused(
					`Refused: the account "${printable(username)}" is disabled. An administrator enables it on the admin page first. Nothing was changed.`
				);
			}
			const id = account.id;
			const now = new Date();
			const nowStamp = stamp(now);

			// Read before anything ends (card 2915): the live keys, `liveApiKeysOf` in second-step.ts, which the
			// end statements below delete; for stdout alone, never the log. The host may read these names.
			const keys = /** @type {{ name: string, created_at: string, expires_at: string | null, deadline_at: string | null }[]} */ (
				database.prepare('SELECT name, created_at, expires_at, deadline_at FROM api_keys WHERE user_id = ? ORDER BY id').all(id)
			)
				.filter((key) => !keyEnded(key, nowStamp))
				.map((key) => ({ name: key.name, createdAt: key.created_at }));
			// And the settings the account is recorded as having set (S1): the rows of setting_setters, not
			// whether each is still at the recorded place, which needs the server's rules (`settingsHeldBy`).
			const recorded = /** @type {{ setting: string }[]} */ (
				database.prepare('SELECT DISTINCT setting FROM setting_setters WHERE user_id = ? ORDER BY setting').all(id)
			).map((row) => row.setting);
			const settings = {
				mail: recorded.includes('mail'),
				destinations: recorded.filter((setting) => setting.startsWith('backup_destination:')).length,
				appUrl: recorded.includes('app_url')
			};

			const factors = database.prepare('DELETE FROM mfa_factors WHERE user_id = ?').run(id).changes;
			const recoveryCodes = database.prepare('DELETE FROM mfa_recovery_codes WHERE user_id = ?').run(id).changes;
			database
				.prepare(
					'UPDATE users SET mfa_known_wrong = 0, mfa_other_wrong = 0, mfa_recovery_wrong = 0, ' +
						'mfa_known_resumes_at = NULL, mfa_other_resumes_at = NULL, mfa_recovery_resumes_at = NULL, ' +
						// No setting up on the password alone after a reset (card 2769).
						'mfa_password_enrol = 0 WHERE id = ?'
				)
				.run(id);

			// endAccountAccess(id, { apiKeys: !keep }): sessions, unused invites (endUnusedInvites), then
			// endPendingSignIns' challenges and links, then, unless kept, the keys deleted and the webhooks the
			// account set that are on switched off with their hold (card 2915), and those already off without one
			// held (card 2923), then the report schedules that are
			// on paused, stamped, their ids in order (card 2894).
			const sessions = database.prepare('DELETE FROM sessions WHERE user_id = ?').run(id).changes;
			const invites = database.prepare('DELETE FROM invite_tokens WHERE user_id = ? AND used = 0').run(id).changes;
			// Sign-ins left at their second step are ended unfinished: said at WARN below, and not mailed (card 2769, CS1).
			const unfinished = /** @type {{ n: number }} */ (
				database.prepare("SELECT COUNT(*) AS n FROM sign_in_challenges WHERE user_id = ? AND purpose = 'verify'").get(id)
			).n;
			const challenges = database.prepare('DELETE FROM sign_in_challenges WHERE user_id = ?').run(id).changes;
			database.prepare('DELETE FROM enrolment_links WHERE user_id = ?').run(id);
			/** @type {number[]} */
			let apiKeyIds = [];
			/** @type {number[]} */
			let webhookIds = [];
			// Those already switched off without a hold that the statement below held (card 2923).
			/** @type {{ id: number, board_id: number, set_by: number | null }[]} */
			let switchedOffRows = [];
			/** @type {{ id: number, board_id: number, set_by: number | null }[]} */
			let heldRows = [];
			if (!keep) {
				// The ids of the keys deleted, in order, for the meta (card 2915's code review, CS2): ids only.
				apiKeyIds = /** @type {{ id: number }[]} */ (database.prepare('DELETE FROM api_keys WHERE user_id = ? RETURNING id').all(id))
					.map((row) => row.id)
					.sort((a, b) => a - b);
				// The hold endAccountAccess records (SETTER_ACCESS_ENDED, copied from webhooks.ts): switched on again
				// by the board's owner or an administrator, the webhook is given a new secret. One already switched off
				// without a hold is held too, left off (card 2923), read first so that the two groups are told apart.
				const alreadyOff = new Set(
					/** @type {{ id: number }[]} */ (
						database.prepare('SELECT id FROM webhooks WHERE set_by = ? AND active = 0 AND held_because IS NULL').all(id)
					).map((row) => row.id)
				);
				const rows = /** @type {{ id: number, board_id: number, set_by: number | null }[]} */ (
					database
						.prepare(
							'UPDATE webhooks SET active = 0, held_because = ?, held_at = ? WHERE set_by = ? AND (active = 1 OR held_because IS NULL) ' +
								'RETURNING id, board_id, set_by'
						)
						.all(SETTER_ACCESS_ENDED, stamp(now), id)
				).sort((a, b) => a.id - b.id);
				switchedOffRows = rows.filter((row) => !alreadyOff.has(row.id));
				heldRows = rows.filter((row) => alreadyOff.has(row.id));
				webhookIds = switchedOffRows.map((row) => row.id);
			}
			const heldIds = heldRows.map((row) => row.id);
			// The webhooks listed: those switched off, by their own ids (S5), or, kept, those the account set that
			// are on, as `keysAndWebhooksOf` in second-step.ts lists them. For stdout alone, never the log.
			// Each listed by the host of its stored receiver (card 2928, migration 0073), where the database has the column.
			const receiver = database.prepare("SELECT 1 FROM pragma_table_info('webhooks') WHERE name = 'receiver'").get() ? 'w.receiver' : 'NULL';
			const listed = `SELECT w.id, b.name AS board, w.url, ${receiver} AS receiver, w.created_at FROM webhooks w JOIN boards b ON b.id = w.board_id `;
			const hooks = /** @type {{ id: number, board: string, url: string, receiver: string | null, created_at: string }[]} */ (
				keep
					? database.prepare(listed + 'WHERE w.set_by = ? AND w.active = 1 ORDER BY w.id').all(id)
					: webhookIds.length === 0
						? []
						: database.prepare(listed + `WHERE w.id IN (${webhookIds.map(() => '?').join(', ')}) ORDER BY w.id`).all(...webhookIds)
			).map((hook) => ({ id: hook.id, board: hook.board, host: hostOfHook(hook), createdAt: hook.created_at }));
			// The webhooks held where they were already off (card 2923, S2), by their own ids as above. For stdout alone.
			const held = /** @type {{ id: number, board: string, url: string, receiver: string | null, created_at: string }[]} */ (
				heldIds.length === 0 ? [] : database.prepare(listed + `WHERE w.id IN (${heldIds.map(() => '?').join(', ')}) ORDER BY w.id`).all(...heldIds)
			).map((hook) => ({ id: hook.id, board: hook.board, host: hostOfHook(hook), createdAt: hook.created_at }));
			const keptWebhookIds = keep ? hooks.map((hook) => hook.id) : [];
			const apiKeys = apiKeyIds.length;
			const reportScheduleIds = /** @type {{ id: number }[]} */ (
				database.prepare('UPDATE report_schedules SET enabled = 0, updated_at = ? WHERE user_id = ? AND enabled = 1 RETURNING id').all(stamp(now), id)
			)
				.map((row) => row.id)
				.sort((a, b) => a - b);

			// issueEnrolmentLink(id, 'host-reset'): the account's one link, its token kept only as its hash.
			database.prepare('DELETE FROM enrolment_links WHERE user_id = ?').run(id);
			const token = randomBytes(32).toString('base64url');
			database
				.prepare('INSERT INTO enrolment_links (token_hash, user_id, issued_by, created_at, expires_at) VALUES (?, ?, ?, ?, ?)')
				.run(sha256Hex(token), id, 'host-reset', stamp(now), stamp(new Date(now.getTime() + ENROLMENT_LINK_LIFETIME_MS)));

			// The route's line, said as the host's; the counts and the account, never the token or the link.
			const name = printable(account.username);
			// On a keep, what was kept, with the webhooks' ids (card 2915, S3): a keep is never silent in the log.
			const endedOrKept = keep
				? `ended ${sessions} session(s), ${challenges} pending sign-in(s) and ${invites} invite(s), kept ${keys.length} live ` +
					`API key(s) and ${hooks.length} webhook(s) they set up${namingIds(keptWebhookIds)}, as --keep-api-keys asked, and paused `
				: `ended ${sessions} session(s), ${challenges} pending sign-in(s), ${invites} invite(s) and ${apiKeys} API key(s), ` +
					`switched off ${webhookIds.length} webhook(s) they set up${namingIds(webhookIds)}, and paused `;
			const message =
				`Two-step sign-in reset for user ${id} ("${name}") on the server's host, with scripts/mfa-reset.mjs: removed ` +
				`${factors} factor(s) and ${recoveryCodes} recovery code(s), ${endedOrKept}${reportScheduleIds.length} report schedule(s)` +
				`${namingIds(reportScheduleIds)}; an enrolment link was issued`;
			// The route's meta (`twoStepResetMeta` in mfa-store.ts), field for field, the host as who reset it (S15).
			const meta = printable(
				JSON.stringify({
					targetUserId: id,
					resetBy: 'host',
					factorsRemoved: factors,
					recoveryCodesRemoved: recoveryCodes,
					sessionsEnded: sessions,
					challengesEnded: challenges,
					invitesEnded: invites,
					apiKeysEnded: apiKeys,
					apiKeyIds,
					webhooksSwitchedOff: webhookIds.length,
					webhookIds,
					apiKeysKept: keep,
					liveApiKeysKept: keep ? keys.length : 0,
					webhooksKept: keptWebhookIds.length,
					keptWebhookIds,
					reportSchedulesPaused: reportScheduleIds.length,
					reportScheduleIds
				})
			);
			// The server's Webhooks lines for the same switch-off and hold (card 2923, S6), before the CRITICAL line,
			// with no account, as the server writes them; and that the owners were not mailed, as the host sends none.
			for (const line of webhookLines(switchedOffRows, heldRows, `${name}'s two-step sign-in was reset on the server's host`)) {
				database
					.prepare('INSERT INTO system_logs (timestamp, level, context, message, meta, user_id, ip) VALUES (?, ?, ?, ?, ?, ?, ?)')
					.run(stamp(now), 'WARN', 'Webhooks', line, null, null, null);
			}
			database
				.prepare('INSERT INTO system_logs (timestamp, level, context, message, meta, user_id, ip) VALUES (?, ?, ?, ?, ?, ?, ?)')
				.run(stamp(now), 'CRITICAL', 'AUTH', message, meta, id, null);
			if (unfinished > 0) {
				database
					.prepare('INSERT INTO system_logs (timestamp, level, context, message, meta, user_id, ip) VALUES (?, ?, ?, ?, ?, ?, ?)')
					.run(
						stamp(now),
						'WARN',
						'AUTH',
						`The reset ended ${unfinished} sign-in(s) of user ${id} ("${name}") left at their second step; no notice was mailed`,
						null,
						id,
						null
					);
			}

			return {
				id,
				name,
				factors,
				recoveryCodes,
				sessions,
				invites,
				challenges,
				schedules: reportScheduleIds.length,
				apiKeys,
				keys,
				hooks,
				held,
				settings,
				token
			};
		})
		.immediate();
}

/**
 * The command's arguments, read strictly (card 2915, S2, E7): each trimmed;
 * until a lone `--`, `--keep-api-keys` sets `keep` (a second one is refused)
 * and any other argument starting with "-" is an unknown option; `--` itself
 * is consumed; everything after it, and every other argument, is a username,
 * of which there must be exactly one, not empty. Every refusal is a usage
 * error, exit 2, before the database is opened.
 *
 * @param {string[]} args
 * @returns {{ keep: boolean, username: string }}
 */
function readArguments(args) {
	let keep = false;
	let options = true;
	/** @type {string[]} */
	const names = [];
	for (const given of args) {
		const arg = given.trim();
		if (options && arg === '--') {
			options = false;
		} else if (options && arg === '--keep-api-keys') {
			if (keep) throw new Refused(`--keep-api-keys was given twice.\n\n${USAGE}`, 2);
			keep = true;
		} else if (options && arg.startsWith('-')) {
			throw new Refused(`Unknown option "${printable(arg)}".\n\n${USAGE}`, 2);
		} else {
			names.push(arg);
		}
	}
	if (names.length !== 1 || names[0] === '') throw new Refused(USAGE, 2);
	return { keep, username: names[0] };
}

/** "a", "a and b", "a, b and c". @param {string[]} parts */
const joined = (parts) => (parts.length <= 1 ? (parts[0] ?? '') : `${parts.slice(0, -1).join(', ')} and ${parts[parts.length - 1]}`);

function main() {
	const { keep, username } = readArguments(process.argv.slice(2));

	refuseRoot();
	const path = resolve(process.env.DB_PATH || join(process.cwd(), 'dumpfire.db'));
	const database = openDatabase(path);
	try {
		let done;
		try {
			done = reset(database, username, keep);
		} catch (err) {
			if (err instanceof Refused) throw err;
			throw new Refused(`Refused: the reset could not be written, and nothing was changed: ${/** @type {Error} */ (err).message}`);
		}
		const address = linkAddress(database);

		console.log(
			`Two-step sign-in was reset for "${done.name}" (user ${done.id}): removed ${done.factors} factor(s) and ` +
				`${done.recoveryCodes} recovery code(s), ended ${done.sessions} session(s), ${done.challenges} pending ` +
				`sign-in(s) and ${done.invites} invite(s), and paused ${done.schedules} report schedule(s). The account's ` +
				'owner turns back on the ones they recognise on the Reports page.'
		);
		// What the reset ended, or on a keep kept, each by its name and the day it was made (card 2894's code
		// review, CS1; card 2915, E5, E6): the keys that were still working, of every key ended.
		const day = (/** @type {string} */ at) => String(at).slice(0, 10);
		const keyList = done.keys.map((key) => `${printable(key.name)} (made ${day(key.createdAt)})`).join('; ');
		const hookList = done.hooks.map((hook) => `${printable(hook.board)}, to ${printable(hook.host)} (made ${day(hook.createdAt)})`).join('; ');
		if (keep) {
			if (done.keys.length === 0 && done.hooks.length === 0) {
				console.log('They have no API key and no webhook they set up.');
			} else {
				console.log(done.keys.length === 0 ? 'They keep no API key.' : `They keep ${done.keys.length} API key(s): ${keyList}.`);
				console.log(
					done.hooks.length === 0 ? 'They keep no webhook they set up.' : `They keep ${done.hooks.length} webhook(s) they set up: ${hookList}.`
				);
				console.log('Kept, as --keep-api-keys asked: a password reset ends them.');
			}
		} else if (done.apiKeys === 0 && done.hooks.length === 0 && done.held.length === 0) {
			// Both groups counted (card 2923, S2): one whose only webhooks were already off is not told they had none.
			console.log('They had no API key and no webhook they set up.');
		} else {
			console.log(
				done.apiKeys === 0
					? 'They had no API key.'
					: `Ended ${done.apiKeys} API key(s); ` +
							(done.keys.length === 0 ? 'none was still working.' : `the ${done.keys.length} still working: ${keyList}.`)
			);
			if (done.hooks.length > 0) console.log(`Switched off ${done.hooks.length} webhook(s) they set up: ${hookList}.`);
			else if (done.held.length === 0) console.log('They had no webhook they set up.');
			// The already-off webhooks held (card 2923, S2), by board, host and day: on stdout only, never the log.
			if (done.held.length > 0) {
				const heldList = done.held.map((hook) => `${printable(hook.board)}, to ${printable(hook.host)} (made ${day(hook.createdAt)})`).join('; ');
				console.log(
					`Held ${done.held.length} webhook(s) they set up that were already switched off: ${heldList}; switched on, each is given a new secret.`
				);
			}
			console.log(
				"Give them the names: they make new keys once signed in, and the board's owner or an administrator switches back on " +
					'any webhook they recognise, which gives it a new secret.'
			);
			// The host sends no mail (card 2923, S2): the boards' owners are the operator's to tell.
			if (done.hooks.length > 0 || done.held.length > 0) console.log("Their boards' owners were not mailed: tell them.");
		}
		// The settings the account is recorded as having set (card 2915, S1): recorded, not judged here.
		const set = [
			done.settings.mail ? 'the mail settings' : null,
			done.settings.destinations === 0 ? null : `${done.settings.destinations} backup destination(s)`,
			done.settings.appUrl ? 'the App URL' : null
		].filter((part) => part !== null);
		if (set.length > 0) {
			console.log(`They are recorded as having set ${joined(set)}; some may have changed since: review them on the admin page.`);
		}
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

// Run as a command only: imported (tests/mfa-reset-script.test.ts, card 2923's code review, E8, which compares
// `webhookLines` with the server's lines), it does nothing.
/** A path as compared here: resolved, and in one case on Windows, whose paths ignore it. @param {string} path */
const samePath = (path) => (process.platform === 'win32' ? resolve(path).toLowerCase() : resolve(path));
if (process.argv[1] !== undefined && samePath(process.argv[1]) === samePath(fileURLToPath(import.meta.url))) {
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
}
