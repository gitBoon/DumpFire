/**
 * account-endings.ts — the record of every ending of an account on this server (card 2996, migration 0077).
 *
 * A row of `account_endings` says what happened to the account with this row id and this creation time
 * (`account_created`, its `created_at` in the stored form): `deleted`, with `credential` a fingerprint of its password
 * hash; `disabled`; `enabled`; or `role`, with the role after (a raise, a lowering, or the role it was made with, R2).
 * `origin` is `here` for a row this server wrote and `backup` for one a restore brought; `seq` is the order of writing,
 * so that two endings in one second keep their order. The record is this server's, as the system log is: a restore
 * never clears it and adds the backup's rows to it, Reset Everything keeps it, and no write deletes, changes or replaces
 * a row of it. Every write here is a plain INSERT (R4), through `recordAccountEnding` alone.
 *
 * A seed row (`deleted`, `account_created` '') names an account by its id alone: migration 0077 wrote one for every id
 * up to the watermark W that `users` no longer held, whose creation time nobody knew. It names an account only where
 * the id is at most W, the account was made no later than the row, no `here` row names it exactly, and it is not a
 * superadmin (R1). W is the largest `user_id` of the watermark rows (`ending` 'watermark', R12: never an ending of
 * anyone); with no watermark row, every seed row names its id (fail closed).
 *
 * The one rule is `accountRulings`, read by the restore and by the start's pass, and `deletedHere`, read by the gates
 * and the enable, is built on the same matcher (R3): so none of them can disagree on which account a row names.
 *
 * This module imports only the database's types, the stored form of a moment, `createHash` and the one hash nothing
 * matches (dummy-hash.ts, R20): auth.ts, the restore and the routes all read it.
 */
import type Database from 'better-sqlite3';
import { createHash } from 'node:crypto';
import { stamp, toStamp } from '$lib/timestamps';
import { DUMMY_HASH } from './dummy-hash';

/** The table, by its name. */
export const ACCOUNT_RECORD_TABLE = 'account_endings';

/** What a row says happened, and the watermark's word, which is no ending of anyone (R12). */
export const ACCOUNT_ENDING = {
	deleted: 'deleted',
	disabled: 'disabled',
	enabled: 'enabled',
	role: 'role',
	watermark: 'watermark'
} as const;

/** An ending a writer records. */
export type AccountEnding = Exclude<(typeof ACCOUNT_ENDING)[keyof typeof ACCOUNT_ENDING], 'watermark'>;

/** Every word `ending` may hold. */
export const ACCOUNT_ENDING_WORDS: readonly string[] = Object.values(ACCOUNT_ENDING);

/**
 * Who wrote a row: this server (`here`), a restore that brought it from a backup (`backup`), or the restore's or the
 * start's own belt (`belt`, card 2996's code review, FP2): a row the record's own rule wrote, counted as this
 * server's for any account but a superadmin, and never as evidence against a superadmin.
 */
export const ORIGIN = { here: 'here', backup: 'backup', belt: 'belt' } as const;
export type Origin = (typeof ORIGIN)[keyof typeof ORIGIN];

/** The roles a `role` row may hold: the superadmin's role is never recorded (R1, R20). */
export const ENDED_ROLES: readonly string[] = ['user', 'admin'];

/** The label the fingerprint is made with (R17), so that it is no plain SHA-256 of a bcrypt string. */
const CREDENTIAL_LABEL = 'dumpfire account credential v1';

/** A bcrypt string as passwords.ts stores one (bcryptjs writes `$2b$`), and the two other forms bcrypt has used. */
const BCRYPT_HASH = /^\$2[aby]\$\d{2}\$[./A-Za-z0-9]{53}$/;

/**
 * The fingerprint of a deleted account's password hash (R17): the SHA-256, in lower-case hex, of the label, a NUL and
 * the hash; '' for anything that is not a well-formed bcrypt string, and for `DUMMY_HASH`, which every inert account
 * holds. It tells an account brought back under another id or creation time by the hash it held; it is not a secret,
 * and it cannot be checked against a guessed password without the bcrypt hash, which the record never holds.
 */
export function credentialOf(passwordHash: unknown): string {
	if (typeof passwordHash !== 'string' || passwordHash === DUMMY_HASH || !BCRYPT_HASH.test(passwordHash)) return '';
	return createHash('sha256').update(`${CREDENTIAL_LABEL}\u0000${passwordHash}`).digest('hex');
}

/** An account's creation time as the record holds it: the stored form where it names a moment, else its text as it is. */
export function storedCreated(createdAt: unknown): string {
	const moment = toStamp(createdAt);
	if (moment !== null) return moment;
	// '' is a seed row's: an account whose creation time is empty is held as one that names no moment.
	return typeof createdAt === 'string' && createdAt !== '' ? createdAt : 'unreadable';
}

/** A row of the record, as the rule reads it; `belt` where it was a belt, counted as this server's own (FP2). */
type RecordRow = { seq: number; accountCreated: string; ending: string; role: string; credential: string; endedAt: string; origin: string; belt?: boolean };

/** The rows that may name the account `?` by its id and creation time (R11: a search on `(user_id, account_created)`); the watermark never (R12). */
export const EXACT_ROWS_SQL =
	'SELECT seq, account_created AS accountCreated, ending, role, credential, ended_at AS endedAt, origin FROM account_endings ' +
	"WHERE user_id = ? AND ending <> 'watermark'";

/** The seed rows of the id `?` (R11: a search on both columns of `(user_id, account_created)`). */
export const SEED_ROWS_SQL = "SELECT ended_at AS endedAt FROM account_endings WHERE user_id = ? AND account_created = '' AND ending = 'deleted'";

/** Whether a `deleted` row carries the fingerprint `?` (R11: a search on the partial index, which its literal term allows). */
export const CREDENTIAL_ROWS_SQL = "SELECT 1 FROM account_endings WHERE credential = ? AND credential <> '' AND ending = 'deleted' LIMIT 1";

/** W, the largest watermark, or NULL where there is none (R11: the partial index on the watermark rows). */
export const WATERMARK_SQL = "SELECT max(user_id) AS w FROM account_endings WHERE ending = 'watermark'";

/**
 * `deletedHere`'s one statement (R16; card 2996's code review, FP3): whether any `deleted` row names the account, the
 * creation time matched in SQL so that a sign-in or a key's check reads one row at most: of its id and creation time in
 * the stored form (`@created`), or of its id at all where its creation time names no moment (`@created` NULL); or one
 * carrying its fingerprint. For a superadmin (`@super` 1) only this server's own rows that name a creation time count,
 * and no fingerprint (R1, FP1). Each half a search on an index; `LIMIT 1` stops at the first.
 */
export const DELETED_HERE_SQL =
	"SELECT 1 FROM account_endings WHERE user_id = @id AND account_created = @created AND ending = 'deleted' AND (@super = 0 OR origin = 'here') " +
	"UNION ALL SELECT 1 FROM account_endings WHERE @created IS NULL AND user_id = @id AND ending = 'deleted' AND (@super = 0 OR (origin = 'here' AND account_created <> '')) " +
	"UNION ALL SELECT 1 FROM account_endings WHERE @super = 0 AND credential = @credential AND credential <> '' AND ending = 'deleted' LIMIT 1";

/**
 * The restore's union, one row (card 2996, R4; its code review, FP3 and FP5): the backup's row added, `origin`
 * `backup`, where no row this server held before the restore (`seq <= @before`) has the same natural key, the creation
 * time compared in its stored form and the moment as the backup stated it (`stated_ended`), so that importing the same
 * backup again adds nothing whenever it runs. A row with no stated moment (`''`, one written by hand) is compared by its
 * `ended_at`. A search on `account_endings_account`.
 */
export const CARRY_ACCOUNT_ENDING_SQL =
	'INSERT INTO account_endings (user_id, account_created, ending, role, credential, ended_at, stated_ended, origin) ' +
	"SELECT @id, @created, @ending, @role, @credential, @endedAt, @stated, 'backup' WHERE NOT EXISTS (" +
	'SELECT 1 FROM account_endings WHERE user_id = @id AND account_created = @created AND ending = @ending ' +
	"AND (stated_ended = @stated OR (stated_ended = '' AND ended_at = @stated)) AND role = @role AND credential = @credential AND seq <= @before)";

/** W as `database`'s record holds it: the largest watermark, or null where there is none. */
export function accountWatermarkOf(database: Database.Database): number | null {
	const row = database.prepare(WATERMARK_SQL).get() as { w: number | null };
	return row.w === null ? null : Number(row.w);
}

/** Whether `database` has the record at all: a database from before 0077 has not. */
export function hasAccountRecord(database: Database.Database): boolean {
	return !!database.prepare("SELECT 1 FROM sqlite_master WHERE type = 'table' AND name = ?").get(ACCOUNT_RECORD_TABLE);
}

/**
 * The matcher (R3): the rows that name an account exactly, by its id and its creation time compared as moments; where
 * its creation time names none, every row of its id (fail closed: a garbled time does not escape the record). For a
 * superadmin only this server's own `deleted` rows that name a creation time, which `deleteUser` writes (card 2996's
 * code review, FP1, FP2): no backup's row, no seed row and no belt ever ends one, and no role, disable or enable row
 * counts, since the application writes none for a superadmin (a host promotion leaves the account's older rows, which
 * must not lower it). For anyone else a belt counts as this server's own (FP2).
 */
function exactRowsOf(rows: readonly RecordRow[], account: { createdAt: unknown }, superadmin: boolean): RecordRow[] {
	const created = toStamp(account.createdAt);
	const named = created === null ? [...rows] : rows.filter((row) => toStamp(row.accountCreated) === created);
	if (superadmin) return named.filter((row) => row.origin === ORIGIN.here && row.ending === ACCOUNT_ENDING.deleted && row.accountCreated !== '');
	return named.map((row) => (row.origin === ORIGIN.belt ? { ...row, origin: ORIGIN.here, belt: true } : row));
}

/** Whether a row names this account by its very creation time: the same moment, or, where it names none, the same text. */
function sameCreated(row: RecordRow, createdAt: unknown): boolean {
	const created = toStamp(createdAt);
	return created === null ? row.accountCreated === storedCreated(createdAt) : toStamp(row.accountCreated) === created;
}

/** A row's moment for ordering: the stored form, or '' for one that names none (the earliest). */
const momentOf = (row: RecordRow) => toStamp(row.endedAt) ?? '';

/** The latest of `rows` by (ended_at, seq) (decision 16), or null. */
function latestOf(rows: readonly RecordRow[]): RecordRow | null {
	let latest: RecordRow | null = null;
	for (const row of rows) {
		if (latest === null) latest = row;
		else {
			const a = momentOf(row);
			const b = momentOf(latest);
			if (a > b || (a === b && row.seq > latest.seq)) latest = row;
		}
	}
	return latest;
}

/** The rank of a role: a ceiling only lowers. */
const RANK: Record<string, number> = { user: 0, admin: 1, superadmin: 2 };

/** An account the rule is asked about: its row as restored, or as it is here. */
export type AccountToRule = { id: number; createdAt: unknown; role: string; passwordHash: unknown };

/** What the record says of an account (section 3.3), where it says anything. */
export type AccountRuling = {
	id: number;
	/**
	 * `deleted`: brought back inert (rule 1); `before record`: an id this server had before it recorded endings, or held
	 * with a later creation time (rule 2); `disabled`: the latest disable that counts is not lifted (rule 3); null: none.
	 */
	ended: 'deleted' | 'before record' | 'disabled' | null;
	/** For `disabled`: when, as the latest `disabled` row that counts says. */
	disabledAt: string | null;
	/** The role it is lowered to, where the latest role row that counts is below its role (rule 4); null for none. */
	lowerTo: 'user' | 'admin' | null;
	/** Whether a `deleted` row names it by its very creation time: an inert account without one is given one (R3). */
	exactDeleted: boolean;
	/** Its role as it was asked about, before any lowering: what it could read (R7). */
	role: string;
	/** A superadmin, in the data asked about or here (FP2): never given a belt, nor ruled by a fingerprint, a seed row or the held-here half. */
	superadmin: boolean;
	/**
	 * For `disabled`: who wrote the deciding row, `here` (an administrator's own disable), `belt` or `backup` (card 2996's
	 * code review, FP15: a disable the record ruled, which only the superadmin lifts).
	 */
	disabledOrigin: Origin | null;
};

/**
 * The one rule (section 3.3, as section 11 rules it), over `accounts`, on `database`'s record. Returns a ruling for
 * every account the record says anything of, in id order; an account it says nothing of is left out.
 *
 * 1. **Deleted (inert):** an exact `deleted` row, or a `deleted` row carrying the fingerprint of its password hash
 *    (never for a superadmin).
 * 2. **Before record:** a seed row of its id, at most W, the account made no later than the row, with no exact `here`
 *    row; or (`heldHere`, the restore's) this server held the id just before, at most W, with a later creation time.
 *    Never for a superadmin, and never where its own creation time names no moment (rule 1 already took every row).
 * 3. **Disabled:** the latest, by (ended_at, seq), of its exact `disabled` and `enabled` rows that count: every
 *    `here` one, and a `backup` one where it has no `here` row of the two, or a `backup` `disabled` where it has. A
 *    backup can add a disable to an account this server knows, never lift one.
 * 4. **Ceiling:** the latest exact `role` row that counts, by the same precedence (a `backup` raise counts only where
 *    it has no `here` role row): its role is lowered to it where it is below.
 *
 * Every statement is a search on an index (R11, test g). Reads only.
 */
export function accountRulings(
	database: Database.Database,
	accounts: readonly AccountToRule[],
	options: { heldHere?: ReadonlyMap<number, unknown>; watermark?: number | null; superadminsHere?: ReadonlySet<number> } = {}
): AccountRuling[] {
	if (accounts.length === 0 || !hasAccountRecord(database)) return [];
	const watermark = options.watermark !== undefined ? options.watermark : accountWatermarkOf(database);
	const exact = database.prepare(EXACT_ROWS_SQL);
	const seed = database.prepare(SEED_ROWS_SQL);
	const byCredential = database.prepare(CREDENTIAL_ROWS_SQL);
	const credentialHits = new Map<string, boolean>();
	const credentialHit = (credential: string) => {
		if (credential === '') return false;
		if (!credentialHits.has(credential)) credentialHits.set(credential, byCredential.get(credential) !== undefined);
		return credentialHits.get(credential) as boolean;
	};
	const rulings: AccountRuling[] = [];
	for (const account of [...accounts].sort((a, b) => a.id - b.id)) {
		// A superadmin of the data asked about, or one this server held just before a restore (FP2): a backup that makes
		// this server's superadmin an administrator still cannot have it ruled by a fingerprint, a seed row or the held-here half.
		const superadmin = account.role === 'superadmin' || options.superadminsHere?.has(account.id) === true;
		const created = toStamp(account.createdAt);
		const rows = exactRowsOf((exact.all(account.id) as RecordRow[]).sort((a, b) => a.seq - b.seq), account, superadmin);
		const here = rows.filter((row) => row.origin === ORIGIN.here);
		const exactDeleted = rows.some((row) => row.ending === ACCOUNT_ENDING.deleted && sameCreated(row, account.createdAt));
		const withinW = watermark === null || account.id <= watermark;

		/** Rule 2's seed half: a seed row of its id that it is no later than, with no exact `here` row. */
		const seeded = (made: string) =>
			here.length === 0 &&
			(seed.all(account.id) as { endedAt: string }[]).some((row) => {
				const at = toStamp(row.endedAt);
				return at === null || made <= at;
			});
		/** Rule 2's held-here half: this server held the id just before with a later creation time (one that names none fails closed). */
		const heldLater = (made: string) => {
			if (options.heldHere === undefined || !options.heldHere.has(account.id)) return false;
			const heldCreated = toStamp(options.heldHere.get(account.id));
			return heldCreated === null || heldCreated > made;
		};

		let ended: AccountRuling['ended'] = null;
		let disabledAt: string | null = null;
		let disabledOrigin: Origin | null = null;
		if (rows.some((row) => row.ending === ACCOUNT_ENDING.deleted) || (!superadmin && credentialHit(credentialOf(account.passwordHash)))) {
			ended = 'deleted';
		} else if (!superadmin && created !== null && withinW && (seeded(created) || heldLater(created))) {
			ended = 'before record';
		} else {
			const switches = rows.filter((row) => row.ending === ACCOUNT_ENDING.disabled || row.ending === ACCOUNT_ENDING.enabled);
			const hereSwitch = switches.some((row) => row.origin === ORIGIN.here);
			const latest = latestOf(switches.filter((row) => row.origin === ORIGIN.here || !hereSwitch || row.ending === ACCOUNT_ENDING.disabled));
			if (latest?.ending === ACCOUNT_ENDING.disabled) {
				ended = 'disabled';
				disabledAt = toStamp(latest.endedAt) ?? stamp();
				disabledOrigin = latest.belt ? ORIGIN.belt : (latest.origin as Origin);
			}
		}

		const roles = rows.filter((row) => row.ending === ACCOUNT_ENDING.role && ENDED_ROLES.includes(row.role));
		const hereRole = roles.some((row) => row.origin === ORIGIN.here);
		const ceiling = latestOf(roles.filter((row) => row.origin === ORIGIN.here || !hereRole || row.role === 'user'));
		const lowerTo = ceiling !== null && RANK[ceiling.role] < (RANK[account.role] ?? 0) ? (ceiling.role as 'user' | 'admin') : null;

		if (ended !== null || lowerTo !== null) rulings.push({ id: account.id, ended, disabledAt, lowerTo, exactDeleted, role: account.role, superadmin, disabledOrigin });
	}
	return rulings;
}

const deletedStatements = new WeakMap<Database.Database, Database.Statement>();

/**
 * Whether the record names this account deleted (rule 1, through the same matcher, R3): a `deleted` row of its id
 * and creation time, or of its id where its creation time names none, or one carrying its fingerprint (never for a
 * superadmin, of whom only this server's own rows count, R1, FP1). One prepared statement per connection, each half a
 * search on an index, the creation time matched in SQL and stopping at the first row (R16; card 2996's code review,
 * FP3). Every row holds its creation time in the stored form (`storedCreated`, the seed's `datetime()`), so the
 * stored form is compared. Asked by `createSession`, `keyHolder` and the enable. False where the database has no record.
 */
export function deletedHere(database: Database.Database, account: AccountToRule): boolean {
	let statement = deletedStatements.get(database);
	if (statement === undefined) {
		if (!hasAccountRecord(database)) return false;
		statement = database.prepare(DELETED_HERE_SQL);
		deletedStatements.set(database, statement);
	}
	const superadmin = account.role === 'superadmin';
	return (
		statement.get({
			id: account.id,
			created: toStamp(account.createdAt),
			super: superadmin ? 1 : 0,
			credential: superadmin ? '' : credentialOf(account.passwordHash)
		}) !== undefined
	);
}

/**
 * Whether the account's disable is one the record of account endings ruled (card 2996's code review, FP15): it is
 * named deleted or as one this server had before it recorded endings, or the row its disable rests on is a belt or a
 * backup's, not an administrator's own disable here. Only the superadmin enables such an account.
 */
export function disableRuledByRecord(database: Database.Database, account: AccountToRule): boolean {
	const ruling = accountRulings(database, [account])[0];
	if (ruling === undefined) return false;
	return ruling.ended === 'deleted' || ruling.ended === 'before record' || (ruling.ended === 'disabled' && ruling.disabledOrigin !== ORIGIN.here);
}

/**
 * Raise the `users` id counter to the largest id a seed row or a watermark names, in SQL with `max()`, writing its row
 * where there is none (decision 13): so that an account made here never takes an id a seed row names, which would
 * disable it. Exact rows raise nothing: an id issued again is told apart by its creation time. Run in every restore
 * and at every start. Opens no transaction; the caller's holds it.
 */
export function raiseUserCounterOverSeed(database: Database.Database): void {
	const named = "(SELECT max(user_id) FROM account_endings WHERE ending = 'watermark' OR (ending = 'deleted' AND account_created = ''))";
	database.prepare(`UPDATE sqlite_sequence SET seq = max(seq, coalesce(${named}, 0)) WHERE name = 'users'`).run();
	database
		.prepare(
			`INSERT INTO sqlite_sequence (name, seq) SELECT 'users', ${named} ` +
				`WHERE coalesce(${named}, 0) > 0 AND NOT EXISTS (SELECT 1 FROM sqlite_sequence WHERE name = 'users')`
		)
		.run();
}

/**
 * The record's one statement for an ending made here (R4: a plain INSERT, `origin` `here`, or `belt` for the record's
 * own belts, FP2), its moment as stated the moment written (FP5). Exported so that the pinned write sequences can hold
 * it whole (R10).
 */
export const RECORD_ACCOUNT_ENDING_SQL =
	'INSERT INTO account_endings (user_id, account_created, ending, role, credential, ended_at, stated_ended, origin) ' +
	'VALUES (@userId, @accountCreated, @ending, @role, @credential, @endedAt, @endedAt, @origin)';

/**
 * Record an ending of the account `userId` on `database`, in the transaction that makes it: its creation time, role
 * and password hash read from `users` on that connection (R20), so a `role` row holds the role after the change (call
 * it after the write) and a `deleted` row the fingerprint of the hash it held (call it before the delete), unless
 * `credential` gives the one a match was made on (R3). `at` is when, the stored form, now where it is not given.
 * `origin` is `belt` for a row the restore or the start's pass writes by the record's own rule (FP2), `here` otherwise.
 * Throws without writing where no transaction is open on `database`, where the account is not there, and for a
 * superadmin, of whom no ending is recorded (R1, R20).
 */
export function recordAccountEnding(
	database: Database.Database,
	userId: number,
	ending: AccountEnding,
	extra: { at?: string; credential?: string; origin?: 'here' | 'belt' } = {}
): void {
	if (!database.inTransaction) {
		throw new Error('recordAccountEnding records inside the transaction of the change, and none is open on the connection it was given');
	}
	const account = database.prepare('SELECT created_at AS createdAt, role, password_hash AS passwordHash FROM users WHERE id = ?').get(userId) as
		| { createdAt: unknown; role: string; passwordHash: unknown }
		| undefined;
	if (account === undefined) throw new Error(`No ending of user ${userId} can be recorded: the account is not there`);
	if (account.role === 'superadmin') throw new Error('No ending of the superadmin is recorded: nobody may end, disable or lower that account');
	database.prepare(RECORD_ACCOUNT_ENDING_SQL).run({
		userId,
		accountCreated: storedCreated(account.createdAt),
		ending,
		role: ending === ACCOUNT_ENDING.role ? account.role : '',
		credential: ending === ACCOUNT_ENDING.deleted ? (extra.credential ?? credentialOf(account.passwordHash)) : '',
		endedAt: toStamp(extra.at) ?? stamp(),
		origin: extra.origin ?? ORIGIN.here
	});
}
