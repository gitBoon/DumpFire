/**
 * restore.ts — copy the rows of a backup database into the running one.
 *
 * The restore route (`/api/admin/import`) owns the upload, the temporary file
 * and the safety copy; this owns what happens to the data. It lives here, and
 * takes both connections as arguments, so that it can be tested against
 * in-memory databases — a `+server.ts` file may export only HTTP handlers.
 *
 * A restore replaces rows, never structure. The running database keeps the
 * tables and columns its own migrations gave it, and the backup's rows are
 * copied into them, column by column, wherever a column of the same name
 * exists on both sides.
 */
import type Database from 'better-sqlite3';
import { dev } from '$app/environment';
import { schedulerSetting } from '../schedulers';
import { putBackFromTrash, type UploadFile } from '../uploads';
import { BOARDS_UNDER_DELETED_GROUPINGS, defaultsForNull, orDefault, runBackfills, type Backfill } from './migrate';
import { normaliseTimestamps, unreadableList, type TimestampNormalisation } from './timestamps';
import { KNOWN_BROWSER_SECRET_KEY } from '../known-browsers';
import { REQUEST_FORM_SECRET_KEY } from '../request-tokens';
import {
	BACKUP_SEAL,
	BACKUP_SEAL_KEY,
	WEBHOOK_SECRETS_LEFT_OUT_KEY,
	fillSecretGaps,
	fromTableStorage,
	keepSealKey,
	nothingHere,
	readListed,
	readSecretsHere,
	sealKeyHere,
	unsealedBecause,
	type SecretsAccount,
	type Unsealed
} from '../backup-secrets';

/** The runner's record of which migration files this database has applied. */
const MIGRATION_RECORD = '__drizzle_migrations';

/**
 * What a restore does with the parts of a backup that reach outside the
 * instance: `keep` restores them as the backup has them, and `off` switches
 * them off or removes them. See `switchOffOutside`. A backup made since card
 * 2169 holds no mail password, destination credential or webhook secret:
 * either way, the ones this server has for the same accounts are filled in
 * first (`fillSecretGaps`), and `keep` leaves a webhook that had a secret off
 * until it is set, where none is filled.
 */
export type Outside = 'keep' | 'off';

/** What `switchOffOutside` did. */
export type OutsideSwitchedOff = {
	/** Report schedules that were enabled and are not now. */
	reportSchedules: number;
	/** Webhooks that were active and are not now. */
	webhooks: number;
	/** Whether the backup schedule was anything other than disabled. It is disabled now. */
	backupScheduleWasOn: boolean;
	/** Backup destinations the configuration had. It has none now. */
	backupDestinations: number;
	/** Mail settings removed. */
	mailSettings: number;
};

export type RestoreResult = {
	/**
	 * Rows put into each table: copied from the backup or, for
	 * `work_dependencies` when the backup predates it, carried across from the
	 * restored `card_dependencies`.
	 */
	restored: Record<string, number>;
	/**
	 * NULLs in the backup that went into a column which is NOT NULL here, and
	 * were given that column's default: the table, the column, how many rows,
	 * and the default as SQL.
	 */
	defaulted: { table: string; column: string; rows: number; value: string }[];
	/**
	 * What could not be cleared, copied or filled in, and anything else found
	 * that somebody should know about. The restore committed all the same, and
	 * what could not be copied was left out.
	 *
	 * It never holds a row that other rows depend on through a foreign key: a
	 * restore that would leave rows pointing, through one, at a row it could not
	 * copy is rolled back instead, and throws. A reference with no foreign key,
	 * which `cards.milestone_id` and `boards.category_id` are, is not seen by
	 * that check.
	 */
	errors: string[];
	/** Rows the backup left without a value that the current code needs. */
	backfilled: Backfill;
	/**
	 * Timestamps the backup held in another form, now in the stored one, and
	 * any it held that could not be read (card 2095). A failure, and each column
	 * left unread, is in `errors` too.
	 */
	timestamps: TimestampNormalisation;
	/**
	 * What was switched off or removed once the tables were copied, for a
	 * restore asked to switch off what reaches outside. `null` for one that
	 * kept it all.
	 */
	outside: OutsideSwitchedOff | null;
	/**
	 * Task requests given a new link inside the restore's transaction: every
	 * request there is now (card 2158). A link mailed before the restore no
	 * longer works.
	 */
	requestLinksReplaced: number;
	/**
	 * The secrets a backup does not hold (card 2169): those kept from this
	 * server, where they were for the same account, and those to enter again.
	 * A working copy names only webhooks: its mail settings and destinations
	 * are removed. Both empty for a backup made before card
	 * 2169, which holds its secrets.
	 */
	secrets: SecretsAccount;
	/**
	 * Whether the backup's seal verified with this server's key (the review's
	 * S1): it was made by this server and nobody has changed it since. Only
	 * then is anything kept from this server; otherwise every gap is in
	 * `secrets.toEnter`. False for a backup made before seals, which holds its
	 * secrets and has no gap.
	 */
	sealVerified: boolean;
	/**
	 * Why nothing was kept from this server, or null where the seal verified:
	 * no seal this server can check, or a seal that does not verify or a file
	 * that failed the checks made before it, which `check` names (the second
	 * review's B1 and N7). The restore goes ahead either way.
	 */
	unsealed: Unsealed | null;
};

/** What a restore that committed had done, for a `RestoreError` thrown after the commit. */
export type CommittedRestore = Pick<RestoreResult, 'requestLinksReplaced' | 'secrets' | 'sealVerified' | 'unsealed'>;

/**
 * A restore that went wrong in a way the caller has to be told about, as
 * distinct from one that left a row out and said so in `errors`.
 *
 * `committed` says which of two very different things happened, and the
 * message says the same in words:
 *
 * - `false`: the restore did not commit, and the database holds what it held
 *   before. This is every case but one.
 * - `true`: the backup's rows are in and committed, and it is the connection
 *   that is wrong: foreign keys could not be switched back on. Nothing is to be
 *   restored again; the server is to be restarted.
 *
 * `errors` is what had already gone wrong, row by row and table by table, when
 * it stopped. The caller would otherwise never see that list: it is built up
 * inside `restoreFromBackup`, which is throwing rather than returning.
 *
 * `done`, for the one that committed, is what it did that the import's answer
 * says of every restore that commits (the review's O8): the request links it
 * replaced, and the secrets it kept and those to enter again.
 */
export class RestoreError extends Error {
	readonly errors: string[];
	readonly committed: boolean;
	readonly done: CommittedRestore | null;

	constructor(
		message: string,
		detail: { errors: readonly string[]; committed: boolean; cause?: unknown; done?: CommittedRestore }
	) {
		super(message, detail.cause ? { cause: detail.cause } : undefined);
		this.name = 'RestoreError';
		this.errors = [...detail.errors];
		this.committed = detail.committed;
		this.done = detail.done ?? null;
	}
}

/**
 * A restore refused because the rows it restored would have user accounts and
 * none of them the superadmin. Never committed: nothing was changed. It is
 * what the backup holds, not a fault, so the import answers it 422 and logs
 * it at WARN, where a `RestoreError` is a 500 and CRITICAL.
 */
export class RestoreLeavesNoSuperadmin extends RestoreError {
	constructor(message: string, detail: { errors: readonly string[]; cause?: unknown }) {
		super(message, { ...detail, committed: false });
		this.name = 'RestoreLeavesNoSuperadmin';
	}
}

/**
 * The copy that migration 0043 made, once, when `work_dependencies` replaced
 * `card_dependencies`: every card dependency as a (card, card) pair. Taken
 * from `drizzle/0043_add_work_dependencies.sql`.
 */
const CARRY_CARD_DEPENDENCIES = `
	INSERT OR IGNORE INTO work_dependencies
		(blocked_type, blocked_id, blocker_type, blocker_id, created_by_user_id, created_at)
	SELECT 'card', card_id, 'card', depends_on_card_id, created_by_user_id, created_at
	FROM card_dependencies
`;

/**
 * Every task request given a new link (card 2158), in the form the runner's
 * backfill and migration 0055 give one: 32 random bytes as 64 hex characters.
 */
const REPLACE_REQUEST_LINKS = 'UPDATE task_requests SET access_token = lower(hex(randomblob(32)))';

function messageOf(err: unknown): string {
	return err instanceof Error ? err.message : String(err);
}

/** The first few of a list, and how many more there are. */
function some(items: readonly string[], limit = 10, separator = '; '): string {
	const more = items.length > limit ? `${separator}and ${items.length - limit} more` : '';
	return items.slice(0, limit).join(separator) + more;
}

/**
 * What a row of the backup that could not be copied is called in `errors`: its
 * primary key, as `id 4` or `card_id 1, label_id 2`, or its place in the
 * backup's table where it has no key to go by.
 */
function nameOf(row: Record<string, unknown>, keyColumns: readonly string[], index: number): string {
	if (keyColumns.length === 0) return `number ${index + 1} of the table in the backup`;
	const shown = (value: unknown) =>
		value === null || value === undefined
			? 'NULL'
			: typeof value === 'string'
				? `'${value}'`
				: Buffer.isBuffer(value)
					? 'a blob'
					: String(value);
	return keyColumns.map((column) => `${column} ${shown(row[column])}`).join(', ');
}

/** Rows of one table that refer to rows of another which are not there. */
type Stranded = { table: string; parent: string; rows: (number | null)[] };

/** The columns of `table` in `database`: none when there is no such table. */
const columnNamesOf = (database: Database.Database, table: string): string[] =>
	(database.prepare(`PRAGMA table_info("${table}")`).all() as { name: string }[]).map((column) => column.name);

/**
 * Every row in `live` that refers, through a foreign key, to a row that is not
 * there (`PRAGMA foreign_key_check`), sorted by whose doing that is.
 *
 * And one reference with no foreign key, asked as if it had one (card 2293):
 * a board filed under a dashboard grouping that is not there
 * (`boards.category_id`). The pragma cannot see it, and the backfill after the
 * commit clears it, so a grouping this restore could not copy would otherwise
 * have its boards unfiled without a word. It is sorted board by board, by the
 * grouping each names, which the pragma cannot do: fatal when that grouping is
 * one the backup holds and this restore did not copy (`groupingsLeftOut`), and
 * as it was otherwise, however many other groupings were left out (the review
 * of card 2293).
 *
 * `fatal`: the row it wants is in a table that this restore left something out
 * of. Committing would make an orphan of it.
 *
 * `asItWas`: every row of the table it refers to was copied, so no row of that
 * table is missing because of this restore.
 */
function strandedBy(
	live: Database.Database,
	leftOut: ReadonlyMap<string, string[]>,
	groupingsLeftOut: ReadonlySet<number>
): { fatal: Stranded[]; asItWas: Stranded[] } {
	const groups = new Map<string, Stranded>();
	for (const violation of live.pragma('foreign_key_check') as {
		table: string;
		rowid: number | null;
		parent: string;
	}[]) {
		const key = `${violation.table}\n${violation.parent.toLowerCase()}`;
		const group = groups.get(key) ?? { table: violation.table, parent: violation.parent, rows: [] };
		group.rows.push(violation.rowid);
		groups.set(key, group);
	}

	const fatal: Stranded[] = [];
	const asItWas: Stranded[] = [];
	for (const group of groups.values()) {
		(leftOut.has(group.parent.toLowerCase()) ? fatal : asItWas).push(group);
	}
	if (columnNamesOf(live, 'boards').includes('category_id') && columnNamesOf(live, 'board_categories').includes('id')) {
		const unfiled = live.prepare(BOARDS_UNDER_DELETED_GROUPINGS).all() as { id: number; groupingId: number }[];
		const lost = unfiled.filter((board) => groupingsLeftOut.has(Number(board.groupingId)));
		const own = unfiled.filter((board) => !groupingsLeftOut.has(Number(board.groupingId)));
		const of = (boards: typeof unfiled): Stranded => ({ table: 'boards', parent: 'board_categories', rows: boards.map((b) => b.id) });
		if (lost.length > 0) fatal.push(of(lost));
		if (own.length > 0) asItWas.push(of(own));
	}

	// By name, so that what is said about them does not depend on the order
	// SQLite happened to check the tables in.
	const byName = (a: Stranded, b: Stranded) => a.table.localeCompare(b.table) || a.parent.localeCompare(b.parent);
	return { fatal: fatal.sort(byName), asItWas: asItWas.sort(byName) };
}

/**
 * The ids of the backup's dashboard groupings that are not in `live` after the
 * copy: the rows of `board_categories` this restore could not copy. Empty when
 * either database has no such table. Read from the table's storage, as every
 * other read of the backup is.
 */
function groupingsNotCopied(live: Database.Database, backup: Database.Database): Set<number> {
	if (!columnNamesOf(backup, 'board_categories').includes('id') || !columnNamesOf(live, 'board_categories').includes('id')) {
		return new Set();
	}
	const copied = new Set(
		(live.prepare('SELECT id FROM board_categories').all() as { id: number }[]).map((row) => Number(row.id))
	);
	const held = (backup.prepare(fromTableStorage(backup, 'board_categories')).all() as { id: unknown }[])
		.map((row) => Number(row.id))
		.filter((id) => Number.isInteger(id));
	return new Set(held.filter((id) => !copied.has(id)));
}

/**
 * The tables a restore clears and refills: every table in the running database
 * except SQLite's own, tables drizzle-kit left behind mid-rebuild (`__new_*`),
 * and the migration record.
 *
 * The migration record is excluded by its exact name, and that matters. It
 * describes the structure of *this* database, which a restore does not change.
 * Replacing it with an older backup's shorter list tells the runner, at the
 * next start, that migrations already applied here have not been — and it runs
 * them again, against columns that already exist, and halts. The filter used to
 * be `NOT LIKE '_drizzle%'`, which does not match `__drizzle_migrations` at all:
 * in LIKE an underscore is a wildcard for exactly one character. The names are
 * compared in code here so that no wildcard is involved.
 */
export function restorableTables(live: Database.Database): string[] {
	return (live.prepare("SELECT name FROM sqlite_master WHERE type = 'table'").all() as { name: string }[])
		.map((row) => row.name)
		.filter(
			(name) =>
				!name.startsWith('sqlite_') && !name.startsWith('__new_') && name !== MIGRATION_RECORD
		);
}

/**
 * Whether `backup` has user accounts and none of them is the superadmin.
 *
 * Restoring such a backup would leave an installation that nobody could
 * export, import into or reset: those are the superadmin's alone (the backup
 * and mail settings are every administrator's since card 2395), `superadmin`
 * is written by set-up and by nothing else,
 * and set-up is closed while there is any user. So the import asks here
 * first, and refuses before anything is written.
 *
 * A backup with no users at all is another matter, and is not refused: with
 * nobody in it, set-up is open again and whoever completes it is the
 * superadmin. Its `users` table having no `role` column counts as nobody
 * being one.
 */
export function backupLacksSuperadmin(backup: Database.Database): boolean {
	return lacksSuperadmin(backup);
}

/**
 * Whether `database` has user accounts and none of them is the superadmin:
 * `backupLacksSuperadmin`, asked of any database. `restoreFromBackup` asks it
 * of the restored rows before it commits. Both counts read the table's own
 * rows, never an index (`NOT INDEXED`), as the restore copies them: in a
 * backup an index can hold rows its table does not (the second review's B1).
 */
export function lacksSuperadmin(database: Database.Database): boolean {
	const hasUsers = !!database.prepare("SELECT name FROM sqlite_master WHERE type = 'table' AND name = 'users'").get();
	if (!hasUsers) return false;
	const users = (database.prepare('SELECT COUNT(*) AS n FROM users NOT INDEXED').get() as { n: number }).n;
	if (users === 0) return false;

	const hasRole = (database.prepare('PRAGMA table_info("users")').all() as { name: string }[]).some(
		(column) => column.name === 'role'
	);
	if (!hasRole) return true;
	const superadmins = (database.prepare("SELECT COUNT(*) AS n FROM users NOT INDEXED WHERE role = 'superadmin'").get() as { n: number }).n;
	return superadmins === 0;
}

/**
 * The usernames of the superadmins `database` has, in the order they were
 * made: what an import's answer names, so that whoever restored it knows who
 * can sign in to undo it. Empty where there are no users, or no `role`.
 */
export function superadminsOf(database: Database.Database): string[] {
	try {
		return database.prepare("SELECT username FROM users WHERE role = 'superadmin' ORDER BY id").pluck().all() as string[];
	} catch {
		return [];
	}
}

/** What the import answers for a backup that `backupLacksSuperadmin`. */
export const NO_SUPERADMIN_IN_BACKUP =
	'This backup has user accounts and none of them is the superadmin. Restoring it would leave nobody able to ' +
	'export, import or reset the database, so it is refused. ' +
	'Nothing was changed.';

/**
 * What a restore says of the sessions, in its answer: whoever restores is
 * signed out with everybody else.
 */
export const SIGNED_OUT = 'Everybody has been signed out, you included: sign in again.';

/**
 * The backup's rows of `table` that a restore brings in: all of them, for
 * every table but three.
 *
 * No session is brought in, and no invite that has not been used. A backup
 * made by this version holds neither (`withoutSecrets`, in `backup.ts`). One
 * made before it holds the session of everybody who was signed in when it was
 * made, and a session's expiry moves on every time it is used, so those are as
 * good today as they were then: restored, each would sign in whoever has read
 * that file. So they are left out whatever the backup's age, and a restore
 * signs everybody out.
 *
 * An invite with no `used` column to say otherwise is taken to be unused.
 *
 * Nor is the key remembered browsers are signed with (card 2194), which a
 * backup made by this version does not hold either: the restored server makes
 * a new one, and every browser is forgotten, as every session is. Nor the key
 * the public request form signs its tokens with (card 2158), which a backup
 * made since does not hold: the restored server makes a new one at first use,
 * and a form open during the restore fails once and is reloaded. Nor the list
 * of webhooks a backup left without their secrets (card 2169): the restore
 * reads it from the backup (`readListed`), and writes it again itself only
 * for the webhooks it could not fill (`fillSecretGaps`). Nor the backup's
 * seal, which is about the file and not the data, nor any key to seal with
 * that a backup holds (the review's S1): this server keeps its own, and
 * puts it back itself (`keepSealKey`).
 *
 * Every table is read from its own storage, never through an index, in rowid
 * order (`fromTableStorage`), as the seal is made: an index in a backup can
 * hold rows its table does not, and a bare `SELECT *` that a `sqlite_stat1`
 * row steers to it would copy rows the seal never saw (the second review's B1).
 */
export function rowsToRestore(backup: Database.Database, table: string): Record<string, unknown>[] {
	const name = table.toLowerCase();
	if (name === 'sessions') return [];
	if (name === 'settings') {
		const hasKey = (backup.prepare(`PRAGMA table_info("${table}")`).all() as { name: string }[]).some(
			(column) => column.name === 'key'
		);
		if (hasKey) {
			const leftOut = [KNOWN_BROWSER_SECRET_KEY, REQUEST_FORM_SECRET_KEY, WEBHOOK_SECRETS_LEFT_OUT_KEY, BACKUP_SEAL, BACKUP_SEAL_KEY];
			return backup
				.prepare(fromTableStorage(backup, table, leftOut.map(() => 'key IS NOT ?').join(' AND ')))
				.all(...leftOut) as Record<string, unknown>[];
		}
	}
	if (name === 'invite_tokens') {
		const hasUsed = (backup.prepare(`PRAGMA table_info("${table}")`).all() as { name: string }[]).some(
			(column) => column.name === 'used'
		);
		if (!hasUsed) return [];
		return backup.prepare(fromTableStorage(backup, table, 'used != 0')).all() as Record<string, unknown>[];
	}
	return backup.prepare(fromTableStorage(backup, table)).all() as Record<string, unknown>[];
}

/**
 * The settings that make up the mail configuration. No mail is sent without
 * `smtp_host`; the others go with it because one of them is a password.
 * `smtp_secure` is no longer read (card 2189) but goes with the rest;
 * `smtp_allow_insecure` is the way out that took its place.
 */
const MAIL_SETTINGS = [
	'smtp_host',
	'smtp_port',
	'smtp_user',
	'smtp_pass',
	'smtp_secure',
	'smtp_allow_insecure',
	'smtp_from_address',
	'smtp_from_name'
] as const;

/**
 * Switch off or remove everything in `database` that reaches outside the
 * instance, and say what was done.
 *
 * Not running the schedulers does not do this. An instance that holds
 * production's rows still mails real people and calls real webhook addresses
 * when a card is assigned or moved, and a backup run by hand still uploads to
 * production's destination and prunes the backups there.
 *
 * Where there is a flag it is cleared, so that it can be set again:
 * `report_schedules.enabled`, by the schedule's owner on the Reports page,
 * and `webhooks.active`, by the board's owner or an administrator through the
 * API (`PUT /api/v1/webhooks/{id}`), since no screen shows webhooks. Where there
 * is none the setting is removed: the backup destinations, and the mail
 * settings. The backup schedule is set to disabled. `app_url` and every other
 * setting are left alone, and so is every other table.
 *
 * A `backup_config` that is not a JSON object is removed rather than
 * rewritten. A missing one is read as no destinations and no schedule, which
 * is what is wanted of it.
 *
 * A table or a setting that is not there is skipped. No transaction is opened
 * here. The caller has one open, and this is undone with the rest of it if it
 * rolls back.
 */
export function switchOffOutside(database: Database.Database): OutsideSwitchedOff {
	const hasColumns = (table: string, ...columns: string[]) => {
		const present = (database.prepare(`PRAGMA table_info("${table}")`).all() as { name: string }[]).map(
			(c) => c.name
		);
		return columns.every((column) => present.includes(column));
	};

	const done: OutsideSwitchedOff = {
		reportSchedules: 0,
		webhooks: 0,
		backupScheduleWasOn: false,
		backupDestinations: 0,
		mailSettings: 0
	};

	if (hasColumns('report_schedules', 'enabled')) {
		done.reportSchedules = database
			.prepare('UPDATE report_schedules SET enabled = 0 WHERE enabled != 0')
			.run().changes;
	}
	if (hasColumns('webhooks', 'active')) {
		done.webhooks = database.prepare('UPDATE webhooks SET active = 0 WHERE active != 0').run().changes;
	}
	if (!hasColumns('settings', 'key', 'value')) return done;

	const stored = database.prepare("SELECT value FROM settings WHERE key = 'backup_config'").get() as
		| { value: string }
		| undefined;
	if (stored) {
		let config: unknown = null;
		try {
			config = JSON.parse(stored.value);
		} catch {
			// Not JSON. Removed below, with whatever else is not an object.
		}
		if (config !== null && typeof config === 'object' && !Array.isArray(config)) {
			const was = config as Record<string, unknown>;
			// A configuration with no schedule in it is one that was never on.
			done.backupScheduleWasOn = typeof was.schedule === 'string' && was.schedule !== 'disabled';
			done.backupDestinations = Array.isArray(was.destinations) ? was.destinations.length : 0;
			database
				.prepare("UPDATE settings SET value = ? WHERE key = 'backup_config'")
				.run(JSON.stringify({ ...was, schedule: 'disabled', destinations: [] }));
		} else {
			database.prepare("DELETE FROM settings WHERE key = 'backup_config'").run();
		}
	}

	done.mailSettings = database
		.prepare(`DELETE FROM settings WHERE key IN (${MAIL_SETTINGS.map(() => '?').join(', ')})`)
		.run(...MAIL_SETTINGS).changes;

	return done;
}

/**
 * Put back, from the uploads trash, the file of every attachment row in
 * `database` whose file is missing from its card's folder and is in the
 * trash, and say how many were.
 *
 * A backup holds the database and not the files. When a card is deleted its
 * files are moved to the trash and kept there for 30 days (`uploads.ts`), so
 * an import of a backup taken before the delete brings back rows whose files
 * are there to be had.
 *
 * Call it once the import is committed, with no transaction open: it moves
 * files, which no rollback undoes. It never throws. A file that could not be
 * put back, or an uploads folder that could not be used, is in `errors`, and
 * is something to report about an import that succeeded.
 */
export function putBackTrashedFiles(database: Database.Database): { putBack: number; errors: string[] } {
	try {
		const files = database
			.prepare('SELECT card_id AS cardId, filename FROM card_attachments ORDER BY id')
			.all() as UploadFile[];
		const { putBack, failed } = putBackFromTrash(files);
		return {
			putBack,
			errors: failed.map((entry) => `Attachment file not put back from the trash (${entry})`)
		};
	} catch (e) {
		return { putBack: 0, errors: [`Attachment files were not put back from the trash: ${messageOf(e)}`] };
	}
}

/**
 * What an import does about the outside when it is not told: `off` on an
 * instance whose schedulers are off, and `keep` on one that runs them.
 *
 * An instance that does not run its schedulers is a dev server or a
 * rehearsal, and what is restored into it is a copy. One that runs them is
 * the installation, being put back. The import route and the admin page's
 * load both ask here, so the choice the dialog shows as selected is the one
 * the route makes when it is given none.
 */
export function defaultOutside(
	value: string | undefined = process.env.SCHEDULERS,
	isDev: boolean = dev
): Outside {
	return schedulerSetting(value, isDev).run ? 'keep' : 'off';
}

/**
 * Replace the rows of `live` with the rows of `backup`.
 *
 * Foreign keys are off for the copy, because tables are cleared and refilled
 * in no particular order, and are switched back on whether it succeeds or
 * throws: `live` is the application's only connection, and leaving it with
 * foreign keys off would silently stop every cascade in the application.
 *
 * A backup can be older than the migrations this database has applied, and
 * those migrations are recorded here and will not run again. What they did to
 * the rows is therefore repeated:
 *
 * - A backup taken before migration 0043 has no `work_dependencies` table, so
 *   the table here is cleared and nothing refills it. 0043's copy from
 *   `card_dependencies` is run again, inside the restore's transaction. This
 *   happens here and nowhere else. `card_dependencies` is kept after 0043 and
 *   nothing removes a row from it when a dependency is deleted, so the same
 *   copy at every start would bring deleted dependencies back.
 * - A backup taken before `cards.first_completed_at` existed has no values
 *   for it. The runner's backfills are repeated once the restore has
 *   committed. If they fail, the restore has still succeeded: the failure is
 *   reported in `errors`, and the backfills run again at the next start. One
 *   taken before `task_requests.access_token` existed has none either, and
 *   every request is given one inside the transaction, as every request is
 *   at every restore (below), so that backfill finds nothing to do. One
 *   taken before cards 2155 and 2179 can hold a card in a milestone of
 *   another board: the backfills take it out, as 0057 did once (card 2179).
 * - A backup taken before card 2095 holds timestamps in two forms. They are
 *   brought to the stored one after the backfills, as at every start
 *   (`normaliseTimestamps`), and the count is in `timestamps`. A failure, or a
 *   value in no form that can be read, is reported in `errors`.
 * - A backup taken while a column was nullable can hold a NULL where the
 *   column is NOT NULL here: `columns.wip_limit`, in every backup of
 *   production taken before card 2006. Where the column has a default, the
 *   NULL is given it, which is the rule the rebuild of that table follows
 *   (`defaultsForNull`, in `migrate.ts`). Without it the row would be refused,
 *   and for `columns` that is a column of a board gone and every card on it
 *   left pointing at nothing.
 *
 * A row that still cannot be copied is left out and reported in `errors`, and
 * the restore goes on, on one condition: nothing depends on that row. Before
 * the commit the whole database is checked for rows that point at a row which
 * is not there. If any of them points into a table from which this restore
 * left something out, the restore is rolled back and throws: a restore must
 * not report success over a board whose columns have gone. Rows that point at
 * nothing in a table this restore copied in full were that way in the backup;
 * they are reported in `errors` and do not stop it.
 *
 * Two kinds of row are never copied, though the backup has them: a session,
 * and an invite that has not been used (`rowsToRestore`). Both tables are
 * cleared like any other, so a restore signs everybody out, whoever started
 * it included, and ends every invite that was waiting here.
 *
 * Every task request is given a new link (card 2158). Once the rows are
 * copied, inside the transaction, every `task_requests.access_token` is
 * replaced with a new random one, whatever the backup's age: a backup made
 * before card 2158 holds every request's token as it was mailed, and one made
 * since holds none. A link mailed before the restore stops working, and its
 * requester can have the new one sent from the page it opens
 * (`POST /api/requests/[id]/link`). The count is `requestLinksReplaced`. This
 * is the restore's own rule, made at every restore, and not migration 0055's
 * one-off repeated. A request's token is not kept even where the same id is
 * in the database being replaced: a backup of another installation, whose
 * request 5 is somebody else's, would give one requester's link to another
 * person's thread.
 *
 * A backup made since card 2169 holds no mail password, destination
 * credential or webhook secret, and a webhook that had a secret is off in it
 * and listed in its `webhook_secrets_left_out`. A restore clears `settings`
 * and `webhooks` with the rest, so on its own it would leave this server with
 * no mail, no backups and its signed webhooks off, a restore of its own backup
 * included. So this server's secrets are read before anything is cleared
 * (`readSecretsHere`), and once the rows are copied each gap is filled from
 * them where it is for the same account, inside the transaction
 * (`fillSecretGaps`): only from an entry that is the same in every field that
 * is not secret, and only when exactly one is. A value the backup has is never
 * replaced, so a backup made before card 2169 restores as it did. What was
 * kept and what is to enter again is `secrets`. A restore that rolls back
 * leaves this server's secrets as they were.
 *
 * And only into a backup whose seal verifies (the review's S1): every backup
 * this server makes carries an HMAC of its rows made with a key this server
 * keeps and no backup holds, and it is made again here, from the backup, with
 * this server's key, before anything is written (`sealVerifies`). A backup
 * made by another server, or changed since, by one added superadmin or one
 * changed card, has nothing filled, and every gap is listed to enter again;
 * `sealVerified` says which, and `unsealed` why. A file that fails
 * `PRAGMA integrity_check`, or holds an object named as SQLite's own that no
 * backup of this server's holds, is unsealed before its seal is asked (the
 * second review's B1). This server's key stays this server's: it is read
 * before the clear and put back after the copy (`keepSealKey`), so that the
 * backups it made before the restore still verify after it.
 *
 * Nor is a restore committed whose rows would have user accounts and no
 * superadmin among them (`lacksSuperadmin`): it is rolled back and throws.
 * The backup can have a superadmin and the restore still lose it, when that
 * row is one that cannot be copied, and then nobody could undo it.
 *
 * `outside` says what the restore is for. `'keep'`, the default, puts an
 * installation back: its backup destinations, report schedules, mail settings
 * and webhooks return as the backup has them, with the secrets filled as above
 * and a webhook not filled left off. `'off'` makes a working copy. A
 * copy of production's data is as able to mail people, call webhooks and
 * change the backup store as production is, so once the tables are copied all
 * four are switched off or removed (`switchOffOutside`) and the result says
 * what was done. That happens inside the restore's transaction: a restore
 * that rolls back leaves all four as they were, and a working copy that could
 * not be switched off is not committed.
 *
 * Throws a `RestoreError` in every case but a clean return. Its `committed`
 * says whether the database was changed: it is false, and the database is as
 * it was, for everything except foreign keys that could not be switched back
 * on after the commit.
 */
export function restoreFromBackup(
	live: Database.Database,
	backup: Database.Database,
	options: { outside?: Outside } = {}
): RestoreResult {
	// Every read of the backup, from its list and its seal (and the file's
	// checks before it) to the rows copied, inside one read transaction on its
	// connection, so that all of them see the one snapshot: the rows copied are
	// the rows the seal was checked over, even were the file written to
	// meanwhile. It writes nothing, so it is always rolled back, whether the
	// restore returns or throws. A transaction the caller already has open is
	// the caller's to end.
	const began = !backup.inTransaction;
	if (began) backup.exec('BEGIN');
	try {
		return restoreInOneSnapshot(live, backup, options);
	} finally {
		if (began && backup.inTransaction) backup.exec('ROLLBACK');
	}
}

/** `restoreFromBackup`, inside its read transaction on the backup: see there. */
function restoreInOneSnapshot(live: Database.Database, backup: Database.Database, options: { outside?: Outside }): RestoreResult {
	const tables = restorableTables(live);
	const errors: string[] = [];
	const restored: Record<string, number> = {};
	const defaulted: RestoreResult['defaulted'] = [];
	let outside: OutsideSwitchedOff | null = null;
	let requestLinksReplaced = 0;
	let secrets: SecretsAccount = {
		kept: { mailPassword: false, destinations: [], webhooks: [] },
		toEnter: { mailPassword: false, destinations: [], webhooks: [] }
	};
	/**
	 * Tables that do not hold everything the backup had for them, by name in
	 * lower case, with what `errors` says about each.
	 */
	const leftOut = new Map<string, string[]>();
	const leaveOut = (table: string, entry: string) => {
		errors.push(entry);
		leftOut.set(table.toLowerCase(), [...(leftOut.get(table.toLowerCase()) ?? []), entry]);
	};
	const foreignKeys = () => live.pragma('foreign_keys', { simple: true });

	// SQLite ignores `PRAGMA foreign_keys` inside a transaction, without an
	// error, so the restore must not start in one.
	if (live.inTransaction) {
		throw new RestoreError(
			'A restore cannot start while a transaction is open on the database connection, because foreign keys ' +
				'cannot be switched off inside one. Nothing was changed. Try again; if it repeats, restart the server.',
			{ errors, committed: false }
		);
	}

	const inBackup = (table: string) =>
		!!backup.prepare("SELECT name FROM sqlite_master WHERE type='table' AND name=?").get(table);

	// The webhooks the backup lists as left without their secrets (card 2169),
	// read from the backup, whose word it is: what cannot be read is ignored
	// and said, and the restore goes on (the plan's N4).
	const { listed, problems } = readListed(backup);
	errors.push(...problems);

	// Whether this server made the backup, and nobody has changed it since
	// (S1): its seal made again with this server's key. Asked before anything
	// is written, and of the backup alone, after the file's own checks (the
	// second review's B1): one that holds an object named as SQLite's own
	// that no backup of this server's holds, or fails its integrity check, is
	// unsealed whatever its seal says. The restore goes ahead either way; only
	// the filling is withheld. The key is read now, to be put back once the
	// restore has cleared the settings it is in.
	const sealKey = sealKeyHere(live);
	const unsealed = unsealedBecause(backup, sealKey);
	const sealVerified = unsealed === null;

	// Off, and read back as off. With them on, clearing a table would delete
	// the rows of every table that refers to it, and a row copied in before the
	// row it refers to would be refused: left out, in a restore that then
	// reported success.
	let switchingOff: unknown = null;
	try {
		live.pragma('foreign_keys = OFF');
	} catch (e) {
		switchingOff = e;
	}
	if (foreignKeys() !== 0) {
		throw new RestoreError(
			'The restore was not started, because foreign keys could not be switched off' +
				(switchingOff ? ` (${messageOf(switchingOff)})` : '') +
				'. Nothing was changed. Try again; if it repeats, restart the server.',
			{ errors, committed: false, cause: switchingOff }
		);
	}

	let failure: unknown = null;
	try {
		live.transaction(() => {
			// This server's secrets, read before anything is cleared, for the
			// gaps a backup leaves (card 2169): see above.
			const here = readSecretsHere(live);

			// Clear every table first, so the order of the copy does not matter.
			for (const table of tables) {
				try {
					live.prepare(`DELETE FROM "${table}"`).run();
				} catch (e) {
					// Its old rows are still in it, so it is not what the backup had.
					leaveOut(table, `Clear ${table}: ${(e as Error).message}`);
				}
			}

			// Copy data from the backup, table by table.
			for (const table of tables) {
				try {
					const exists = backup
						.prepare("SELECT name FROM sqlite_master WHERE type='table' AND name=?")
						.get(table);
					if (!exists) continue;

					// Every row, but no session and no unused invite: see rowsToRestore.
					const rows = rowsToRestore(backup, table);
					if (rows.length === 0) continue;

					// Only the columns both sides have.
					const backupCols = Object.keys(rows[0]);
					const liveInfo = live.prepare(`PRAGMA table_info("${table}")`).all() as { name: string; pk: number }[];
					const liveCols = liveInfo.map((c) => c.name);
					const commonCols = backupCols.filter((c) => liveCols.includes(c));

					if (commonCols.length === 0) {
						leaveOut(table, `${table}: no matching columns`);
						continue;
					}

					// A NULL headed for a column that is NOT NULL here and has a
					// default is given the default. See the comment above.
					const defaults = defaultsForNull(live, table);
					const defaulting = commonCols.filter((c) => defaults.has(c));
					const values = commonCols
						.map((c) => (defaults.has(c) ? orDefault('?', defaults.get(c) as string) : '?'))
						.join(', ');
					const quotedCols = commonCols.map((c) => `"${c}"`).join(', ');
					const insert = live.prepare(`INSERT INTO "${table}" (${quotedCols}) VALUES (${values})`);

					// What a row that cannot be copied is called in `errors`.
					const keyCols = liveInfo
						.filter((c) => c.pk > 0 && commonCols.includes(c.name))
						.sort((a, b) => a.pk - b.pk)
						.map((c) => c.name);

					let rowCount = 0;
					const given = new Map<string, number>();
					rows.forEach((row, index) => {
						try {
							insert.run(...commonCols.map((c) => row[c]));
							rowCount++;
							for (const c of defaulting) {
								if (row[c] === null) given.set(c, (given.get(c) ?? 0) + 1);
							}
						} catch (e) {
							leaveOut(table, `${table} row (${nameOf(row, keyCols, index)}): ${(e as Error).message}`);
						}
					});
					restored[table] = rowCount;
					for (const [column, count] of given) {
						defaulted.push({ table, column, rows: count, value: defaults.get(column) as string });
					}
				} catch (e) {
					leaveOut(table, `${table}: ${(e as Error).message}`);
				}
			}

			// A backup from before 0043: see above.
			if (
				!inBackup('work_dependencies') &&
				tables.includes('work_dependencies') &&
				tables.includes('card_dependencies')
			) {
				try {
					const carried = live.prepare(CARRY_CARD_DEPENDENCIES).run().changes;
					if (carried > 0) restored['work_dependencies'] = carried;
				} catch (e) {
					leaveOut('work_dependencies', `work_dependencies, carried from card_dependencies: ${messageOf(e)}`);
				}
			}

			// This server's key for sealing its backups, as it was before the
			// clear: see above. Not caught: a restore that lost it is rolled back.
			if (sealKey !== null) keepSealKey(live, sealKey);

			// Every request a new link: see above. Not caught, so that a restore
			// that could not replace them is rolled back, and brings in no link
			// a backup held.
			if (
				tables.includes('task_requests') &&
				(live.prepare('PRAGMA table_info("task_requests")').all() as { name: string }[]).some(
					(column) => column.name === 'access_token'
				)
			) {
				requestLinksReplaced = live.prepare(REPLACE_REQUEST_LINKS).run().changes;
			}

			// Nothing is committed that leaves a row pointing at a row this
			// restore left out. Foreign keys are off, so nothing has objected
			// until now; this is where it is asked.
			const stranded = strandedBy(live, leftOut, groupingsNotCopied(live, backup));
			if (stranded.fatal.length > 0) {
				const parents = [...new Set(stranded.fatal.map((group) => group.parent.toLowerCase()))];
				const notCopied = parents.flatMap((parent) => leftOut.get(parent) ?? []);
				const dependants = stranded.fatal.map(
					(group) => `${group.rows.length} row(s) of ${group.table} refer to a row of ${group.parent} that would not be there`
				);
				throw new Error(
					`rows that other rows depend on could not be copied (${some(notCopied)}), and ${dependants.join(', and ')}`
				);
			}
			for (const group of stranded.asItWas) {
				// A board's grouping is sorted board by board (strandedBy), so its
				// table can have lost other rows: then only the ones referred to were not.
				const notLeftOut = leftOut.has(group.parent.toLowerCase())
					? `The backup holds no row of ${group.parent} they refer to`
					: `No row of ${group.parent} was left out by this restore`;
				errors.push(
					`${group.table}: ${group.rows.length} row(s) refer to a row of ${group.parent} that is not there ` +
						`(rowid ${some(group.rows.map(String), 5, ', ')}). ${notLeftOut}` +
						(tables.includes(group.table)
							? ', so the backup holds them that way'
							: `; ${group.table} is not a table a restore replaces, and its rows are the ones it had before`)
				);
			}

			// Nothing is committed that leaves user accounts and no superadmin
			// among them: nobody could export, import or reset again, and
			// `superadmin` is written by set-up alone. The import refuses a backup
			// that has no superadmin before it starts (`backupLacksSuperadmin`),
			// but that asks the backup, and a row that cannot be copied is left
			// out above: the superadmin's among them, in a restore that would
			// otherwise commit. So it is asked again here, of the rows as restored.
			if (lacksSuperadmin(live)) {
				const users = leftOut.get('users') ?? [];
				throw new RestoreLeavesNoSuperadmin(
					'the restored data would have user accounts and none of them the superadmin' +
						(users.length > 0 ? `, because a row of users could not be copied (${some(users)})` : ''),
					{ errors }
				);
			}

			// The secrets the backup does not hold, filled from this server
			// where they are for the same account, and before a working copy
			// switches off what reaches outside, so that it lists no mail
			// password and no destination. Not caught: a restore that could
			// not fill them is rolled back, and leaves this server's secrets
			// as they were.
			// Only for a backup whose seal verified (S1): for any other, from
			// nothing, so that nothing is filled and every gap is listed.
			const working = options.outside === 'off';
			const filled = fillSecretGaps(live, sealVerified ? here : nothingHere(), listed, { writeMarker: !working });

			// A working copy: see above. Not caught, so that a failure here rolls
			// the restore back like any other.
			if (working) {
				const done = switchOffOutside(live);
				// What the backup had on, as before card 2169: a webhook that
				// had a secret is off in a backup made since, and is counted
				// from the list, where it was not switched on above (R3).
				outside = { ...done, webhooks: done.webhooks + filled.listedOnLeftOff };
			}
			// A working copy has removed its mail settings and destinations, so
			// it says nothing of their secrets, kept or to enter: only of its
			// webhooks, which stay, switched off.
			secrets = working
				? {
						kept: { mailPassword: false, destinations: [], webhooks: filled.kept.webhooks },
						toEnter: { mailPassword: false, destinations: [], webhooks: filled.unfilled.webhooks }
					}
				: { kept: filled.kept, toEnter: filled.unfilled };
		})();
	} catch (e) {
		failure = e;
	}
	const committed = failure === null;

	// Back on, and read back as on, whichever way that went: this is the
	// application's only connection. Inside a transaction this pragma is
	// ignored too, so a rollback that did not happen shows up here.
	let switchingOn: unknown = null;
	try {
		live.pragma('foreign_keys = ON');
	} catch (e) {
		switchingOn = e;
	}
	if (foreignKeys() !== 1) {
		const cause = switchingOn ?? failure;
		if (committed) {
			throw new RestoreError(
				'The backup was restored and committed, but foreign keys could not be switched back on. Restart the ' +
					'server now: until it restarts, deleting a board, a card or a user leaves behind what belonged to it.',
				{ errors, committed: true, cause, done: { requestLinksReplaced, secrets, sealVerified, unsealed } }
			);
		}
		throw new RestoreError(
			live.inTransaction
				? `The restore failed (${messageOf(failure)}) and its transaction could not be rolled back, so foreign ` +
					'keys could not be switched back on either. Nothing was committed, and what it had done is ' +
					'discarded when the server stops. Restart the server now.'
				: `The restore failed and nothing was changed (${messageOf(failure)}), and foreign keys could not be ` +
					'switched back on afterwards. Restart the server now.',
			{ errors, committed: false, cause }
		);
	}
	if (failure) {
		// Rolled back, and foreign keys are on again. A refusal for want of a
		// superadmin stays one: see RestoreLeavesNoSuperadmin.
		const message = `The restore failed and nothing was changed: ${messageOf(failure)}`;
		if (failure instanceof RestoreLeavesNoSuperadmin) {
			throw new RestoreLeavesNoSuperadmin(message, { errors, cause: failure });
		}
		throw new RestoreError(message, { errors, committed: false, cause: failure });
	}

	// The restore is committed. A failure from here on is something to report
	// about a restore that succeeded, not a failed restore.
	let backfilled: Backfill = {
		firstCompletedAt: 0,
		accessTokens: 0,
		releasedFromMilestones: 0,
		released: [],
		unfiledBoards: 0,
		unfiled: []
	};
	try {
		backfilled = runBackfills(live);
	} catch (e) {
		errors.push(`Backfill after the restore: ${messageOf(e)}`);
	}

	// A backup copies its timestamps as it holds them, and one made before card
	// 2095 holds two forms: brought to one, as every start does. It never throws.
	const timestamps = normaliseTimestamps(live);
	if (timestamps.failed !== null) {
		errors.push(
			`Timestamps after the restore were not brought to the stored form, and none was changed: ${timestamps.failed}. ` +
				'The next start tries again.'
		);
	}
	if (Object.keys(timestamps.unreadable).length > 0) {
		errors.push(
			`Timestamps in no form this build can read were left as they are: ${unreadableList(timestamps.unreadable)}. ` +
				'Each start reports them until they are corrected.'
		);
	}

	return { restored, defaulted, errors, backfilled, timestamps, outside, requestLinksReplaced, secrets, sealVerified, unsealed };
}
