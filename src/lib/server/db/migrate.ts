/**
 * migrate.ts — applies the SQL files in `drizzle/` at start-up, brings six
 * tables that reached databases in two shapes to the shape the model declares,
 * and stops the server if a file cannot be applied.
 *
 * The order of work, every start:
 *
 *   1. make sure `system_logs` exists (the logger writes to it, on the
 *      application's connection)
 *   2. convert a legacy-shaped `card_dependencies` table, if there is one
 *   3. apply each file not yet recorded, one transaction per file
 *   4. rebuild any of the six reconciled tables that is not in the model's
 *      shape — unless the database records a migration that has no file on
 *      disk, in which case that is reported and no table is reshaped
 *   5. repeat the backfills from 0050 and 0051 for rows that still need them
 *   6. bring every timestamp to the stored form, `YYYY-MM-DD HH:MM:SS` in UTC
 *      (`normaliseTimestamps`, card 2095) — unless, as in step 4, the
 *      database records a migration that has no file on disk
 *   7. compare the whole database with the model, and report any difference
 *
 * What stops start-up and what does not:
 *
 * - Step 1 never does. If the table cannot be created the logger carries on
 *   with the console alone.
 * - Steps 3 and 5 either complete or stop it. A failure this file anticipates
 *   is logged at CRITICAL and thrown as a `MigrationError`; one it does not
 *   anticipate is thrown as whatever it is. `runMigrations` catches neither.
 * - Step 2 has those two outcomes and a third. A `card_dependencies` table
 *   that is in neither the legacy shape nor the current one is logged at
 *   ERROR and left as it is, and start-up goes on to step 3. A migration
 *   still to run that needs the current columns, as 0042 does, then fails on
 *   that table, and that is a halt like any other.
 * - Step 4 stops it in one case only: foreign keys were switched off for a
 *   rebuild and cannot be switched back on. That can follow a rebuild that
 *   was committed. The tables it rebuilt are then in the model's shape and
 *   stay so, the database is not as it was, and that halt says so: it is the
 *   one halt that does not end by saying the database is as it was before the
 *   failing step. Anything else that goes wrong in step 4 leaves the database
 *   as it was, which is the shape it has been running on, so the server
 *   starts. A table that fails a guard is left alone while the others are
 *   rebuilt; a rebuild that fails its checks is rolled back as a whole. Each
 *   is logged at ERROR with what to do about it, appears in the report
 *   `runMigrations` returns, and is found and reported again at every start
 *   until its cause is dealt with. Reported, never swallowed.
 * - Step 6 never does. It runs in a transaction of its own, and a failure is
 *   rolled back, logged at ERROR and tried again at the next start: the server
 *   ran on mixed forms before card 2095, and stopping it would be worse than
 *   what the step fixes. A value it cannot read is left as it is and logged at
 *   ERROR at every start until somebody deals with it.
 * - Step 7 never does. It logs at ERROR and returns: an older build started
 *   against a newer database is exactly what it would find, and going back to
 *   the previous image has to work. The same goes for a recorded migration
 *   with no file, in step 4.
 *
 * Whether a throw stops the *server* is up to the caller. `hooks.server.ts`
 * calls `runMigrations()` bare, and in the built server that ends the process
 * before it listens. Never call `process.exit` from this file — it would also
 * kill the test workers.
 *
 * One rule runs through all of it: **nothing is logged while this file has a
 * transaction open**. The logger inserts into `system_logs`, on the
 * application's connection, so a row written inside a transaction on that
 * connection is rolled back with it, and the one message that mattered would be
 * the one that vanished. During a rebuild it would also change a row count the
 * rebuild is watching. Messages are collected and logged after the commit or
 * the rollback.
 */
import Database from 'better-sqlite3';
import { existsSync, readFileSync, readdirSync } from 'node:fs';
import { join } from 'node:path';
import { sqlite } from './index';
import { EXPECTED_SCHEMA } from './expected-schema';
import { createLogger, ensureSystemLogsTable } from '../logger';
import {
	convertedList,
	normaliseTimestamps,
	totalConverted,
	unreadableList,
	type TimestampNormalisation
} from './timestamps';

const log = createLogger('DB');

// ─── What the runner tolerates ───────────────────────────────────────────────

/**
 * The only files in which "already exists" and "duplicate column" are skipped
 * rather than fatal.
 *
 * Two lineages of migration share the numbers 0001 to 0005 and interleave in
 * file-name order, so on a new database 25 statements in these 19 files try to
 * create something an earlier file already created. That is history and cannot
 * be changed without renaming files every database has recorded.
 *
 * The list is frozen. A new migration is never added to it: a statement that
 * fails in a new file is a fault in that file, and the runner must say so.
 */
export const TOLERANT_FILES: readonly string[] = Object.freeze([
	'0001_dear_pandemic.sql',
	'0002_add_subtasks.sql',
	'0003_add_detail_fields.sql',
	'0005_add_on_hold_note.sql',
	'0006_add_completed_at.sql',
	'0009_add_pinned_field.sql',
	'0010_add_sub_boards.sql',
	'0011_add_user_management.sql',
	'0012_add_public_boards.sql',
	'0017_add_board_categories.sql',
	'0022_add_notification_prefs.sql',
	'0023_add_wip_limits.sql',
	'0025_add_card_archive.sql',
	'0026_add_card_covers.sql',
	'0031_add_card_recurrence.sql',
	'0034_reports_email.sql',
	'0035_add_report_period_days.sql',
	'0036_add_webhooks_and_deps.sql',
	'0037_add_report_detail_level.sql'
]);

const tolerantFiles = new Set(TOLERANT_FILES);

function isAlreadyApplied(message: string): boolean {
	return message.includes('already exists') || message.includes('duplicate column');
}

/**
 * Statements the runner cannot honour inside a file's transaction. Some fail
 * there (`VACUUM`, `ATTACH`), some end the transaction early (`COMMIT`), and
 * the worst do nothing at all without saying so (`PRAGMA foreign_keys`).
 */
const UNSAFE_IN_TRANSACTION = new Set([
	'PRAGMA',
	'BEGIN',
	'COMMIT',
	'END',
	'ROLLBACK',
	'SAVEPOINT',
	'RELEASE',
	'VACUUM',
	'ATTACH',
	'DETACH'
]);

// ─── Types ───────────────────────────────────────────────────────────────────

export type MigrationOptions = {
	/** The connection to migrate. Defaults to the application's. */
	database?: Database.Database;
	/** Where the `.sql` files are. Defaults to `<cwd>/drizzle`. */
	migrationsDir?: string;
	/**
	 * The model's DDL, one statement per entry. Defaults to the generated
	 * `EXPECTED_SCHEMA`, which is the only value the application ever uses.
	 */
	expectedSchema?: readonly string[];
};

export type ToleratedError = {
	file: string;
	/** 1-based position of the statement in its file. */
	statement: number;
	of: number;
	message: string;
};

export type RebuiltTable = {
	table: string;
	/** Rows carried across. */
	rows: number;
	/** Columns in which NULL was replaced by the model's default, and in how many rows. */
	defaulted: { column: string; rows: number; value: string }[];
	/**
	 * Every way the table differed from the model, which is why it was rebuilt
	 * and what the rebuild changed: a foreign key the table had and the model
	 * has not is in this list, and is gone.
	 */
	differences: string[];
};

/** A reconciled table that was not rebuilt. Nothing in it was changed. */
export type TableLeftAlone = {
	table: string;
	/**
	 * How far it got.
	 *
	 * `compare`: it could not be compared with the model, because the table or
	 * the model could not be read. Whether it differs is not known.
	 *
	 * `guard`: it differs, and it failed a check made before anything was
	 * changed. It was never touched, and the other tables went ahead without it.
	 *
	 * `rebuild`: it differs, it passed its guards and was to be rebuilt with the
	 * others, and it was not. A rebuild is one transaction, so the tables in it
	 * have this outcome together and for the same reason: it was never begun, or
	 * it was rolled back whole. One failure is retried, a table's own values:
	 * that table has this outcome with a reason of its own, and the rebuild is
	 * done again without it, so the others may be rebuilt in the same start.
	 */
	stage: 'compare' | 'guard' | 'rebuild';
	/** What was found, or what stopped the rebuild. */
	reason: string;
	/** What to do about it. The log line gives both. */
	whatToDo: string;
};

/** A sub-board whose card no longer exists, made an ordinary board. Nothing was deleted. */
export type DetachedSubBoard = {
	id: number;
	name: string;
	/**
	 * What its `parent_card_id` held, which is the id of no card. The log is the
	 * only other record of it.
	 *
	 * Nearly always a whole number. The column is declared INTEGER, and that
	 * does not stop SQLite keeping a real there, or text that is not a number,
	 * or a blob: whatever was there is reported as it was read.
	 */
	parentCardId: number | string | Buffer;
};

/** What became of each reconciled table that was not in the model's shape. */
export type Reconciliation = {
	rebuilt: RebuiltTable[];
	leftAlone: TableLeftAlone[];
	/** Sub-boards detached while `boards` was rebuilt. Empty unless it was. */
	detached: DetachedSubBoard[];
};

export type Backfill = {
	/** Cards given a `first_completed_at`. */
	firstCompletedAt: number;
	/** Task requests given an `access_token`. */
	accessTokens: number;
	/** Cards taken out of a milestone that belongs to another board. */
	releasedFromMilestones: number;
	/**
	 * The first 50 of them, by card id, with the milestone each left: once a
	 * card is out, nothing records which goal held it (review of card 2179).
	 */
	released: ReleasedCard[];
	/** Boards taken out of a dashboard grouping that no longer exists (card 2293). */
	unfiledBoards: number;
	/** The first 50 of them, by board id, with the id of the grouping each named. */
	unfiled: UnfiledBoard[];
};

/** A card the backfill took out of a milestone of another board, and that milestone. */
export type ReleasedCard = { cardId: number; milestoneId: number };

/** A board the backfill took out of a grouping that was not there, and the id it named. */
export type UnfiledBoard = { boardId: number; groupingId: number };

export type MigrationReport = {
	/** Files applied and recorded by this run, in order. */
	applied: string[];
	/** Statements skipped as already applied. Only ever in `TOLERANT_FILES`. */
	tolerated: ToleratedError[];
	/** Tables rebuilt in the model's shape by this run. Empty when none needed it. */
	rebuilt: RebuiltTable[];
	/**
	 * Tables that were not in the model's shape, or could not be compared with
	 * it, and were left as they were, with why and what to do. Each is also
	 * logged at ERROR. Empty on a healthy database.
	 */
	leftAlone: TableLeftAlone[];
	/** Sub-boards detached from a card that no longer exists, while `boards` was rebuilt. */
	detachedSubBoards: DetachedSubBoard[];
	/**
	 * Why none of the six tables was even compared, when none was: the database
	 * records a migration this build has no file for. Null when they were.
	 */
	reconciliationSkipped: string | null;
	backfilled: Backfill;
	/**
	 * What bringing every timestamp to the stored form did (card 2095): the
	 * values converted and the values it could not read, column by column, or
	 * why it was rolled back. Null when it was not run, for the same reason as
	 * `reconciliationSkipped`: the database may be newer than this build.
	 */
	timestamps: TimestampNormalisation | null;
	/** Where the database still differs from the model. Empty on a healthy database. */
	schemaDifferences: string[];
	/** Names recorded as applied that have no file in the migrations directory. */
	missingFromDisk: string[];
};

type MigrationErrorDetail = {
	/** What was being done, when the failure does not belong to a file. */
	stage?: string;
	file?: string;
	statementNumber?: number;
	statementCount?: number;
	statement?: string;
	/**
	 * How many SQL statements the failing block holds, when more than one.
	 * SQLite does not say which of them failed, so the message must not
	 * pretend to know.
	 */
	blockOf?: number;
	/** True when the file was turned away before any of it ran. */
	refused?: boolean;
	reason: string;
	/** What the reason usually means and what to do about that, when there is more to say than the reason. */
	hint?: string;
	/**
	 * What became of the file, when it is not the usual "rolled back and not
	 * recorded" or, for a refusal, "none of it was run".
	 */
	outcome?: string;
	/**
	 * How the message ends, when `WHAT_NEXT` would not be true: what state the
	 * database is in, and what to do.
	 */
	next?: string;
	committed: readonly string[];
	cause?: unknown;
};

/**
 * How every halt ends but the one for foreign keys that will not come back on:
 * what state the database is in, and what to do.
 */
const WHAT_NEXT =
	'The database is as it was before the failing step. Fix the cause and start again, or start the previous image.';

/*
 * How the halt for foreign keys that will not come back on ends. `WHAT_NEXT`
 * would be false of it once a rebuild has been committed, and says nothing
 * useful of it otherwise: the cause is in the connection, and a new process
 * has a new one.
 */

const STARTING_AGAIN =
	'Start again: a new process opens a new connection with foreign keys on, the rebuild is attempted again, ' +
	'and what stops it, if anything does, is reported. If it stops here again, start the previous image.';

/** A rebuild had been committed. */
const AFTER_A_COMMITTED_REBUILD =
	'The rebuild was committed before this and is not undone, so the database is not as it was: the tables named ' +
	"as rebuilt are in the model's shape and stay so. Nothing needs restoring. Start again: a new process opens a " +
	'new connection with foreign keys on, and has nothing left to do for those tables. If it stops here again, ' +
	'start the previous image.';

/** No rebuild had been committed, and no transaction is open. */
const AFTER_NO_REBUILD = `No table was changed. ${STARTING_AGAIN}`;

/** No rebuild had been committed, and the one that was begun could not be rolled back. */
const WITH_THE_REBUILD_STILL_OPEN =
	"Nothing was committed: the rebuild's transaction is still open on this connection and is discarded when the " +
	`process ends, so no table is changed. ${STARTING_AGAIN}`;

/** Something this file did not anticipate, during reconciliation. Nothing is claimed about the database. */
const AFTER_THE_UNEXPECTED =
	'This was not expected, and whether a rebuild had been committed is not known here. Start again: a table ' +
	"that is still not in the model's shape is found again then. If it stops here again, start the previous image.";

function explain(detail: MigrationErrorDetail): string {
	const earlier =
		detail.committed.length > 0
			? `Committed earlier in this start: ${detail.committed.join(', ')}.`
			: 'No migration was committed earlier in this start.';
	const next = detail.next ?? WHAT_NEXT;

	if (!detail.file) {
		return `Migrations halted (${detail.stage ?? 'start-up'}): ${detail.reason}. ${earlier} ${next}`;
	}

	const shown = !detail.statement
		? ''
		: detail.blockOf && detail.blockOf > 1
			? ` (one of the ${detail.blockOf} statements in the block beginning: ${detail.statement})`
			: ` (${detail.statement})`;
	const where =
		detail.statementNumber !== undefined
			? ` at statement ${detail.statementNumber} of ${detail.statementCount}${shown}`
			: '';
	const outcome =
		detail.outcome ??
		(detail.refused
			? 'None of the file was run and it was not recorded.'
			: 'The file was rolled back and not recorded.');
	const verb = detail.refused ? 'was refused' : 'failed';
	const hint = detail.hint ? ` ${detail.hint}` : '';
	return `Migration ${detail.file} ${verb}${where}: ${detail.reason}.${hint} ${outcome} ${earlier} ${next}`;
}

/**
 * Why start-up stopped. Carries the parts separately as well as in the message,
 * so a caller (or a test) does not have to parse a sentence.
 */
export class MigrationError extends Error {
	/** The migration file, when the failure belongs to one. */
	readonly file: string | null;
	/** 1-based position, in the file, of the failing block of SQL. */
	readonly statementNumber: number | null;
	/** How many blocks the file has. */
	readonly statementCount: number | null;
	/**
	 * First line of the statement that was refused, or of the block that
	 * failed. A block is usually one statement; where it is several, the message
	 * says so.
	 */
	readonly statement: string | null;
	/** What SQLite said, or what the runner's own check found. */
	readonly reason: string;
	/** Files this run had already committed when it stopped. */
	readonly committed: readonly string[];

	constructor(detail: MigrationErrorDetail) {
		super(explain(detail), { cause: detail.cause });
		this.name = 'MigrationError';
		this.file = detail.file ?? null;
		this.statementNumber = detail.statementNumber ?? null;
		this.statementCount = detail.statementCount ?? null;
		this.statement = detail.statement ?? null;
		this.reason = detail.reason;
		this.committed = [...detail.committed];
	}
}

/** A block of SQL that failed, with its position. Never leaves this module. */
class StatementFailure extends Error {
	/** 0-based position of the block in its file. */
	readonly index: number;

	constructor(index: number, message: string, cause: unknown) {
		super(message, { cause });
		this.index = index;
	}
}

/** A file whose SQL ran but whose name could not be recorded. Never leaves this module. */
class RecordFailure extends Error {}

/**
 * Why a reconciled table cannot be rebuilt, with what to do about it. Thrown
 * by a guard, or by one of the rebuild's own checks. Never leaves this module:
 * the two parts end up in a `TableLeftAlone`.
 */
class Obstacle extends Error {
	readonly whatToDo: string;
	/**
	 * The one table this is about, where it is that table's own rows that are in
	 * the way and nothing is wrong with the rebuild. Only then can the rebuild be
	 * done again without it. Left unset by every check that means the rebuild
	 * itself went wrong: after one of those, no part of it is to be trusted.
	 */
	readonly table?: string;

	constructor(reason: string, whatToDo: string, table?: string) {
		super(reason);
		this.whatToDo = whatToDo;
		this.table = table;
	}
}

/**
 * Foreign keys were switched off for a rebuild and could not be switched back
 * on: the one thing in reconciliation that stops start-up. `next` is how the
 * halt must end, which depends on whether the rebuild had been committed.
 */
class ForeignKeysStayedOff extends Error {
	readonly next: string;

	constructor(message: string, next: string, cause: unknown) {
		super(message, cause ? { cause } : undefined);
		this.next = next;
	}
}

function messageOf(err: unknown): string {
	return err instanceof Error ? err.message : String(err);
}

// ─── Reading a migration file ────────────────────────────────────────────────

type SqlToken = {
	kind: 'word' | 'quoted' | 'semicolon' | 'other';
	/** Offsets into the text that was scanned. */
	start: number;
	end: number;
};

/**
 * The tokens of `sql` that are code.
 *
 * Comments and white space are left out. A string literal or a quoted name is
 * one token whatever it holds, so a `;` or a keyword inside one is never
 * mistaken for code.
 */
function* sqlTokens(sql: string): Generator<SqlToken> {
	const length = sql.length;
	let i = 0;
	while (i < length) {
		const c = sql[i];
		const start = i;

		if (c === '-' && sql[i + 1] === '-') {
			const newline = sql.indexOf('\n', i);
			i = newline === -1 ? length : newline + 1;
		} else if (c === '/' && sql[i + 1] === '*') {
			const close = sql.indexOf('*/', i + 2);
			i = close === -1 ? length : close + 2;
		} else if (c === "'" || c === '"' || c === '`') {
			// A doubled quote inside is an escaped quote, not the end.
			i++;
			while (i < length) {
				if (sql[i] === c) {
					if (sql[i + 1] !== c) break;
					i++;
				}
				i++;
			}
			i = Math.min(i + 1, length);
			yield { kind: 'quoted', start, end: i };
		} else if (c === '[') {
			const close = sql.indexOf(']', i + 1);
			i = close === -1 ? length : close + 1;
			yield { kind: 'quoted', start, end: i };
		} else if (c === ';') {
			i++;
			yield { kind: 'semicolon', start, end: i };
		} else if (/[A-Za-z_]/.test(c)) {
			i++;
			while (i < length && /[A-Za-z0-9_$]/.test(sql[i])) i++;
			yield { kind: 'word', start, end: i };
		} else if (/[0-9]/.test(c)) {
			// A number, so that the `e5` of `1e5` is not read as a word.
			i++;
			while (i < length && /[A-Za-z0-9_.]/.test(sql[i])) i++;
			yield { kind: 'other', start, end: i };
		} else if (/\s/.test(c)) {
			i++;
		} else {
			i++;
			yield { kind: 'other', start, end: i };
		}
	}
}

/** True if `word` appears in `sql` as code: not in a comment, a string or a quoted name. */
function hasWord(sql: string, word: string): boolean {
	for (const token of sqlTokens(sql)) {
		if (token.kind === 'word' && sql.slice(token.start, token.end).toUpperCase() === word) return true;
	}
	return false;
}

export type SqlStatement = {
	/** Its first word, upper-cased: CREATE, INSERT, PRAGMA and so on. */
	keyword: string;
	/** Its text, from its first token to its closing `;`. */
	text: string;
};

/**
 * The SQL statements in `sql`.
 *
 * One block between breakpoints can hold several statements, and can open with
 * a comment, so "does it start with PRAGMA?" and "is this one statement?" need
 * a scanner rather than a `startsWith`.
 *
 * A `CREATE TRIGGER` is one statement however many `;` its body holds. Every
 * statement of the body ends with `;`, so the `END` that closes the trigger is
 * the one that comes straight after a `;`. No other `END` can: the one closing
 * a `CASE` follows an expression, and a column that happens to be called `end`
 * follows a keyword, a comma or a dot.
 */
export function sqlStatements(sql: string): SqlStatement[] {
	const found: SqlStatement[] = [];

	// The statement being read.
	let words: string[] = [];
	let start = -1;
	let end = -1;
	/** The previous token was a `;` inside a trigger's body. */
	let afterSemicolon = false;
	/** The trigger's closing END has been read. */
	let closed = false;

	const isTrigger = () =>
		words[0] === 'CREATE' &&
		(words[1] === 'TRIGGER' ||
			((words[1] === 'TEMP' || words[1] === 'TEMPORARY') && words[2] === 'TRIGGER'));

	const finish = () => {
		if (start !== -1) found.push({ keyword: words[0] ?? '', text: sql.slice(start, end) });
		words = [];
		start = -1;
		afterSemicolon = false;
		closed = false;
	};

	for (const token of sqlTokens(sql)) {
		if (token.kind === 'semicolon') {
			// A `;` with nothing before it is an empty statement, not a statement.
			if (start === -1) continue;
			end = token.end;
			if (!isTrigger() || closed) finish();
			else afterSemicolon = true;
			continue;
		}

		if (start === -1) start = token.start;
		end = token.end;
		if (token.kind === 'word') {
			const word = sql.slice(token.start, token.end).toUpperCase();
			if (words.length < 3) words.push(word);
			if (word === 'END' && afterSemicolon) closed = true;
		}
		afterSemicolon = false;
	}
	finish();
	return found;
}

/** The leading keyword of every SQL statement in `sql`, upper-cased. */
export function leadingKeywords(sql: string): string[] {
	return sqlStatements(sql).map((statement) => statement.keyword);
}

/** The first line of a piece of SQL that is SQL rather than a comment. */
function firstLine(statement: string): string {
	const line =
		statement
			.split(/\r?\n/)
			.map((l) => l.trim())
			.find((l) => l.length > 0 && !l.startsWith('--')) ?? '';
	return line.length > 160 ? `${line.slice(0, 157)}...` : line;
}

/** One block of a migration file: the SQL between two breakpoints. */
type Block = {
	sql: string;
	/** The statements it holds. Usually one. */
	statements: SqlStatement[];
};

/**
 * Split a file on Drizzle's statement-breakpoint markers. Hand-written files
 * use "-->statement-breakpoint", drizzle-kit generates "--> statement-breakpoint";
 * both are accepted.
 */
function splitBlocks(raw: string): Block[] {
	return raw
		.split(/-->\s*statement-breakpoint/)
		.map((s) => s.trim())
		.filter((s) => s.length > 0)
		.map((sql) => ({ sql, statements: sqlStatements(sql) }));
}

/** The first statement in a file that cannot run inside a transaction, if any. */
function findUnsafeStatement(blocks: Block[]): { index: number; statement: SqlStatement } | null {
	for (let index = 0; index < blocks.length; index++) {
		const statement = blocks[index].statements.find((s) => UNSAFE_IN_TRANSACTION.has(s.keyword));
		if (statement) return { index, statement };
	}
	return null;
}

function listMigrationFiles(migrationsDir: string): string[] {
	if (!existsSync(migrationsDir)) {
		throw new Error(`the migrations directory ${migrationsDir} does not exist`);
	}
	const files = readdirSync(migrationsDir)
		.filter((f) => f.endsWith('.sql'))
		.sort();
	if (files.length === 0) {
		throw new Error(`the migrations directory ${migrationsDir} has no .sql files`);
	}
	return files;
}

// ─── Small readers ───────────────────────────────────────────────────────────

type ColumnInfo = { name: string; notnull: number };

/** A name, quoted for use in SQL. */
function quoted(name: string): string {
	return `"${name.replace(/"/g, '""')}"`;
}

function tableExists(database: Database.Database, table: string): boolean {
	return !!database
		.prepare("SELECT 1 FROM sqlite_master WHERE type = 'table' AND name = ?")
		.get(table);
}

function columnsOf(database: Database.Database, table: string): ColumnInfo[] {
	return database.prepare(`PRAGMA table_info(${quoted(table)})`).all() as ColumnInfo[];
}

function hasColumn(database: Database.Database, table: string, column: string): boolean {
	return columnsOf(database, table).some((c) => c.name === column);
}

function foreignKeysOn(database: Database.Database): boolean {
	return database.pragma('foreign_keys', { simple: true }) === 1;
}

// ─── card_dependencies: legacy shape ─────────────────────────────────────────

/**
 * Bring a legacy-shaped `card_dependencies` table up to the current shape,
 * preserving every row.
 *
 * Migration 0036 used to do this in raw SQL, and on a database that already had
 * the modern shape it dropped the table and renamed an empty one over it on
 * every single boot (see the comment in 0036 for the full mechanism). Plain SQL
 * cannot ask "which shape is this table?", so the check lives here instead,
 * where it can be explicit, guarded and idempotent.
 *
 * Runs before the migration loop so that 0042 — which adds a unique index on
 * (card_id, depends_on_card_id) — is guaranteed a table with those columns.
 *
 * Does nothing at all in the overwhelmingly common case: no table, or a table
 * that already has the modern columns. Throws if the conversion fails, leaving
 * the table as it was.
 *
 * @returns how many rows were converted, or null if there was nothing to do.
 */
function repairLegacyCardDependencies(database: Database.Database): number | null {
	if (!tableExists(database, 'card_dependencies')) return null;

	const cols = columnsOf(database, 'card_dependencies').map((c) => c.name);

	// Already current — the only branch that ever runs on a healthy database.
	if (cols.includes('card_id') && cols.includes('depends_on_card_id')) return null;

	// Not the legacy shape either: leave it alone rather than guess.
	if (!cols.includes('blocker_card_id') || !cols.includes('blocked_card_id')) {
		log.error(`card_dependencies has an unrecognised shape (${cols.join(', ')}) — leaving it untouched`);
		return null;
	}

	// One transaction: either the table is fully converted with every row
	// carried across, or nothing changes at all.
	return database
		.transaction(() => {
			const count = (table: string) =>
				(database.prepare(`SELECT COUNT(*) AS n FROM ${table}`).get() as { n: number }).n;

			const before = count('card_dependencies');
			database.exec(`
				DROP TABLE IF EXISTS card_dependencies_v2;
				CREATE TABLE card_dependencies_v2 (
					id INTEGER PRIMARY KEY AUTOINCREMENT,
					card_id INTEGER NOT NULL REFERENCES cards(id) ON DELETE CASCADE,
					depends_on_card_id INTEGER NOT NULL REFERENCES cards(id) ON DELETE CASCADE,
					created_at TEXT NOT NULL DEFAULT (datetime('now'))
				);
				INSERT INTO card_dependencies_v2 (card_id, depends_on_card_id, created_at)
					SELECT blocked_card_id, blocker_card_id, created_at FROM card_dependencies;
			`);

			const carried = count('card_dependencies_v2');
			if (carried !== before) {
				// Never drop the original unless every row is accounted for.
				throw new Error(`row count mismatch: ${before} before, ${carried} copied`);
			}

			database.exec('DROP TABLE card_dependencies');
			database.exec('ALTER TABLE card_dependencies_v2 RENAME TO card_dependencies');
			return carried;
		})
		.immediate();
}

// ─── The shape of a database ─────────────────────────────────────────────────

/*
 * A database's structure, read with SQLite's own PRAGMAs and never from the
 * text of its DDL: the same table can be written many ways, and after a rename
 * SQLite stores its name quoted, so two identical tables routinely have
 * different text. The one thing taken from the text is whether it says
 * AUTOINCREMENT, which no PRAGMA reports.
 *
 * The model is read the same way. Its DDL (`EXPECTED_SCHEMA`) is run in a
 * throwaway in-memory database and that database is described with the same
 * functions, so the two are compared like with like.
 *
 * What the comparison ignores is a short list of rules, and there is no list
 * of tables or columns excused from it. Four are things SQLite itself treats
 * as identical in a column:
 *
 *   - the case of a type name (`INTEGER`, `integer`)
 *   - NOT NULL on an INTEGER PRIMARY KEY, which is the rowid and never NULL
 *     whether or not NOT NULL is written
 *   - `false` and `true` as defaults, which are SQLite's names for 0 and 1
 *   - `DEFAULT NULL`, which is the same as no default
 *
 * The fifth is a rule of this comparison:
 *
 *   - the order of a table's columns. Column order is not part of the schema.
 *     Columns are matched by name and never by position, although the PRAGMAs
 *     do report position. A column added by ALTER TABLE goes on the end, so a
 *     table that grew over the years has its columns in a different order from
 *     one created whole from the model: nine tables on production do. That is
 *     no difference, because nothing reads a column by its position. Every
 *     INSERT and SELECT in the application, in the restore and in the rebuild
 *     below names its columns, and rows are read as objects keyed by name.
 *
 *     Order inside a primary key or an index is another matter. It decides
 *     what the key or the index does, and it is compared.
 *
 * The sixth is two spellings of one foreign key:
 *
 *   - the case of the parent table's name, which SQLite does not distinguish,
 *     and a parent column left out, which means the parent's primary key.
 *     `REFERENCES Boards` and `REFERENCES boards(id)` are the same key.
 *
 * What these PRAGMAs do not report is not compared, and a difference in any
 * of it goes unseen. The comparison is blind to:
 *
 *   - CHECK constraints
 *   - the WHERE of a partial index (that it is partial is compared)
 *   - COLLATE on a column that no index covers. `index_xinfo` gives the
 *     collation an index uses; nothing read here gives a column's own
 *   - DEFERRABLE and INITIALLY DEFERRED on a foreign key
 *   - STRICT, and WITHOUT ROWID where the key is NOT NULL either way
 *   - ON CONFLICT clauses on a constraint
 *   - the expression of a generated column (that it is generated is compared)
 */

/** The runner's own table. It is not part of the model and is never compared with it. */
const MIGRATION_RECORD = '__drizzle_migrations';

type ColumnShape = {
	/** The declared type, upper-cased. */
	type: string;
	notNull: boolean;
	/** The default, with spellings of one value made the same. Null for none. */
	default: string | null;
	/** The default exactly as SQLite reports it: an expression that can go back into SQL. */
	defaultSql: string | null;
	/** Position in the primary key, from 1. 0 if not part of it. */
	primaryKey: number;
	/** 0 for an ordinary column; 2 or 3 for a generated one. */
	hidden: number;
};

type ForeignKey = {
	/** The child columns, in order. */
	from: string[];
	/** The table it refers to. */
	parent: string;
	/** The parent's columns, in order. Null where none is named, which means its primary key. */
	to: (string | null)[];
	/** As it is written. For example: (board_id) references boards(id), on update NO ACTION, on delete CASCADE */
	description: string;
	/**
	 * What two foreign keys are compared by: the description, with the parent
	 * table's name in lower case and its columns always given, in lower case.
	 * Where the key names no parent column, they are the parent's primary key.
	 */
	identity: string;
};

type TableShape = {
	/** In the table's own order, which is used for messages and for nothing else. */
	columns: Map<string, ColumnShape>;
	foreignKeys: ForeignKey[];
	indexes: string[];
	autoincrement: boolean;
};

type Structure = {
	tables: Map<string, TableShape>;
	/** Views and triggers, as "view name" or "trigger name". The model has none. */
	others: string[];
};

function sameDefault(value: string | null): string | null {
	if (value === null) return null;
	const text = value.trim();
	if (/^null$/i.test(text)) return null;
	if (/^false$/i.test(text)) return '0';
	if (/^true$/i.test(text)) return '1';
	return text;
}

/** The foreign keys declared on `table`, by the id SQLite gives each. */
function foreignKeysOf(database: Database.Database, table: string): Map<number, ForeignKey> {
	const rows = database.prepare(`PRAGMA foreign_key_list(${quoted(table)})`).all() as {
		id: number;
		seq: number;
		table: string;
		from: string;
		to: string | null;
		on_update: string;
		on_delete: string;
		match: string;
	}[];

	// One foreign key is one id; a composite key has a row per column.
	const parts = new Map<number, { parent: string; from: string[]; to: (string | null)[]; rule: string }>();
	for (const row of rows) {
		const key = parts.get(row.id) ?? {
			parent: row.table,
			from: [],
			to: [],
			rule:
				`on update ${row.on_update}, on delete ${row.on_delete}` +
				(row.match.toUpperCase() === 'NONE' ? '' : `, match ${row.match}`)
		};
		key.from[row.seq] = row.from;
		key.to[row.seq] = row.to;
		parts.set(row.id, key);
	}

	const keys = new Map<number, ForeignKey>();
	for (const [id, key] of parts) {
		// `REFERENCES parent` with no column names the parent's primary key. It
		// is described as it is written and compared as what it means, and the
		// parent's name is compared as SQLite matches it, whatever its case.
		const named = !key.to.every((column) => column === null);
		const to = named ? `(${key.to.join(', ')})` : '';
		const target = (named ? key.to : primaryKeyOf(database, key.parent)).map((column) => String(column).toLowerCase());
		const from = `(${key.from.join(', ')}) references `;
		keys.set(id, {
			from: key.from,
			parent: key.parent,
			to: key.to,
			description: `${from}${key.parent}${to}, ${key.rule}`,
			identity: `${from}${key.parent.toLowerCase()}(${target.join(', ')}), ${key.rule}`
		});
	}
	return keys;
}

/** The columns of a table's primary key, in the key's order. None if it has no key, or is not there. */
function primaryKeyOf(database: Database.Database, table: string): string[] {
	return (database.prepare(`PRAGMA table_info(${quoted(table)})`).all() as { name: string; pk: number }[])
		.filter((column) => column.pk > 0)
		.sort((a, b) => a.pk - b.pk)
		.map((column) => column.name);
}

/** The columns of `table`, generated ones included, in the table's own order. */
function columnShapes(database: Database.Database, table: string): Map<string, ColumnShape> {
	const rows = database.prepare(`PRAGMA table_xinfo(${quoted(table)})`).all() as {
		name: string;
		type: string;
		notnull: number;
		dflt_value: string | null;
		pk: number;
		hidden: number;
	}[];
	const keyColumns = rows.filter((row) => row.pk > 0).length;

	const columns = new Map<string, ColumnShape>();
	for (const row of rows) {
		const type = row.type.toUpperCase();
		const isRowid = keyColumns === 1 && row.pk === 1 && type === 'INTEGER';
		columns.set(row.name, {
			type,
			notNull: row.notnull === 1 || isRowid,
			default: sameDefault(row.dflt_value),
			defaultSql: row.dflt_value,
			primaryKey: row.pk,
			hidden: row.hidden
		});
	}
	return columns;
}

function describeTable(database: Database.Database, table: string): TableShape {
	const columns = columnShapes(database, table);

	// An index made by CREATE INDEX is compared by name. One SQLite made for a
	// PRIMARY KEY or UNIQUE constraint has a name nobody chose, and is compared
	// by what it covers.
	const indexes = (
		database.prepare(`PRAGMA index_list(${quoted(table)})`).all() as {
			name: string;
			unique: number;
			origin: string;
			partial: number;
		}[]
	).map((index) => {
		const covered = (
			database.prepare(`PRAGMA index_xinfo(${quoted(index.name)})`).all() as {
				seqno: number;
				name: string | null;
				desc: number;
				coll: string;
				key: number;
			}[]
		)
			.filter((column) => column.key === 1)
			.sort((a, b) => a.seqno - b.seqno)
			.map(
				(column) =>
					(column.name ?? '<expression>') +
					(column.coll.toUpperCase() === 'BINARY' ? '' : ` collate ${column.coll}`) +
					(column.desc ? ' desc' : '')
			);
		const kind = index.unique ? 'unique index' : 'index';
		const name =
			index.origin === 'c'
				? `${kind} ${index.name}`
				: `${kind} for a ${index.origin === 'pk' ? 'primary key' : 'unique constraint'}`;
		return `${name} on (${covered.join(', ')})${index.partial ? ', partial' : ''}`;
	});

	const ddl = database.prepare("SELECT sql FROM sqlite_master WHERE type = 'table' AND name = ?").get(table) as
		| { sql: string | null }
		| undefined;

	return {
		columns,
		foreignKeys: [...foreignKeysOf(database, table).values()],
		indexes,
		autoincrement: hasWord(ddl?.sql ?? '', 'AUTOINCREMENT')
	};
}

function describeDatabase(database: Database.Database): Structure {
	const objects = database
		.prepare("SELECT type, name FROM sqlite_master WHERE type IN ('table', 'view', 'trigger') ORDER BY name")
		.all() as { type: string; name: string }[];

	const tables = new Map<string, TableShape>();
	const others: string[] = [];
	for (const object of objects) {
		if (object.type !== 'table') others.push(`${object.type} ${object.name}`);
		else if (!object.name.startsWith('sqlite_') && object.name !== MIGRATION_RECORD) {
			tables.set(object.name, describeTable(database, object.name));
		}
	}
	return { tables, others };
}

/** What is in `list` and not in `remove`, counting repeats. Two items are the same if `identity` says so. */
function unmatched<T>(list: readonly T[], remove: readonly T[], identity: (item: T) => string): T[] {
	const left = [...list];
	for (const item of remove) {
		const at = left.findIndex((other) => identity(other) === identity(item));
		if (at !== -1) left.splice(at, 1);
	}
	return left;
}

/** What is in `list` and not in `remove`, counting repeats. */
function without(list: readonly string[], remove: readonly string[]): string[] {
	return unmatched(list, remove, (item) => item);
}

const inEither = (a: Iterable<string>, b: Iterable<string>) => [...new Set([...a, ...b])];

/** Every way `has`, a table in a database, differs from `wants`, the model's. Empty if none. */
function tableDifferences(table: string, has: TableShape, wants: TableShape): string[] {
	const found: string[] = [];

	for (const column of inEither(has.columns.keys(), wants.columns.keys())) {
		const where = `${table}.${column}`;
		const live = has.columns.get(column);
		const model = wants.columns.get(column);
		if (!model) found.push(`${where}: the column is in the database but not in the model`);
		else if (!live) found.push(`${where}: the column is in the model but not in the database`);
		else {
			if (live.type !== model.type) {
				found.push(`${where}: type is ${live.type || '(none)'}; the model has ${model.type || '(none)'}`);
			}
			if (live.notNull !== model.notNull) {
				found.push(
					`${where}: is ${live.notNull ? 'NOT NULL' : 'nullable'}; the model has it ${model.notNull ? 'NOT NULL' : 'nullable'}`
				);
			}
			if (live.default !== model.default) {
				found.push(`${where}: default is ${live.default ?? '(none)'}; the model has ${model.default ?? '(none)'}`);
			}
			if (live.primaryKey !== model.primaryKey) {
				found.push(`${where}: primary key position is ${live.primaryKey}; the model has ${model.primaryKey}`);
			}
			if (live.hidden !== model.hidden) {
				const kind = (hidden: number) => (hidden === 0 ? 'an ordinary' : 'a generated or hidden');
				found.push(`${where}: is ${kind(live.hidden)} column; the model has ${kind(model.hidden)} one`);
			}
		}
	}

	// A foreign key is matched by what it means and reported as it is written.
	const keysOnlyIn = (side: ForeignKey[], other: ForeignKey[]) =>
		unmatched(side, other, (key) => key.identity).map((key) => key.description);
	for (const [thing, live, model] of [
		['foreign key', keysOnlyIn(has.foreignKeys, wants.foreignKeys), keysOnlyIn(wants.foreignKeys, has.foreignKeys)],
		['index', without(has.indexes, wants.indexes), without(wants.indexes, has.indexes)]
	] as const) {
		for (const item of live) found.push(`${table}: ${thing} in the database but not in the model: ${item}`);
		for (const item of model) found.push(`${table}: ${thing} in the model but not in the database: ${item}`);
	}

	if (has.autoincrement !== wants.autoincrement) {
		const says = (autoincrement: boolean) => (autoincrement ? 'is AUTOINCREMENT' : 'is not AUTOINCREMENT');
		found.push(`${table}: ${says(has.autoincrement)}; in the model it ${says(wants.autoincrement)}`);
	}

	return found;
}

// ─── A NULL on its way into a column that cannot hold one ────────────────────

/*
 * One rule, used in two places. A rebuild copies a table's rows into the
 * model's table, and a restore copies a backup's rows into the running
 * database's. Either can meet a NULL where the column it is going into is NOT
 * NULL: `columns.wip_limit` was nullable on production, and so in every
 * backup of it, and is NOT NULL in the model.
 *
 * Where that column has a default, the NULL becomes the default, which is what
 * the column would hold had the row been inserted without a value. Where it
 * has none there is nothing to put there, and what happens then is for the
 * caller: the rebuild leaves the whole table alone, and the restore leaves the
 * row out and says so.
 */

/**
 * The default a NULL becomes in `column`, as SQL. Null where there is none to
 * give: the column takes a NULL, or has no default, or is generated.
 */
function defaultForNull(column: ColumnShape): string | null {
	if (column.hidden !== 0 || !column.notNull) return null;
	// `DEFAULT NULL` is no default.
	return column.default === null ? null : column.defaultSql;
}

/**
 * For each column of `table` in which a NULL becomes the column's default:
 * that default, as SQL. See the rule above.
 */
export function defaultsForNull(database: Database.Database, table: string): Map<string, string> {
	const defaults = new Map<string, string>();
	for (const [name, column] of columnShapes(database, table)) {
		const value = defaultForNull(column);
		if (value !== null) defaults.set(name, value);
	}
	return defaults;
}

/** `source`, or `defaultSql` where `source` is NULL. Both are SQL, and `source` may be a `?`. */
export function orDefault(source: string, defaultSql: string): string {
	return `COALESCE(${source}, (${defaultSql}))`;
}

// ─── The model ───────────────────────────────────────────────────────────────

type ExpectedModel = {
	structure: Structure;
	/** The CREATE INDEX statements the model has for each table, in its order. */
	createIndexes: Map<string, string[]>;
};

/** One reading per list of statements: the model does not change while the server runs. */
const expectedModels = new WeakMap<readonly string[], ExpectedModel>();

/**
 * The structure the model declares.
 *
 * Nothing is read from disk and drizzle-kit is not involved: the DDL is run in
 * an in-memory database that is closed again before this returns.
 */
function expectedModel(expectedSchema: readonly string[]): ExpectedModel {
	const known = expectedModels.get(expectedSchema);
	if (known) return known;

	const throwaway = new Database(':memory:');
	try {
		for (const statement of expectedSchema) throwaway.exec(statement);

		const createIndexes = new Map<string, string[]>();
		const indexes = throwaway
			.prepare("SELECT tbl_name, sql FROM sqlite_master WHERE type = 'index' AND sql IS NOT NULL ORDER BY rowid")
			.all() as { tbl_name: string; sql: string }[];
		for (const index of indexes) {
			createIndexes.set(index.tbl_name, [...(createIndexes.get(index.tbl_name) ?? []), index.sql]);
		}

		const model = { structure: describeDatabase(throwaway), createIndexes };
		expectedModels.set(expectedSchema, model);
		return model;
	} finally {
		throwaway.close();
	}
}

/** How a table that the model does not have is reported, after its name. The schema check looks for it. */
const NOT_IN_THE_MODEL = ': the table is in the database but not in the model';

/**
 * Every way a database differs from the model: a table, column, view or
 * trigger on one side only, and a column, foreign key or index that is not the
 * same on both. Empty when there is none. Reads only; changes nothing.
 */
export function schemaDifferences(
	database: Database.Database = sqlite,
	expectedSchema: readonly string[] = EXPECTED_SCHEMA
): string[] {
	const model = expectedModel(expectedSchema).structure;
	const live = describeDatabase(database);
	const found: string[] = [];

	for (const table of inEither(live.tables.keys(), model.tables.keys()).sort()) {
		const has = live.tables.get(table);
		const wants = model.tables.get(table);
		if (!wants) found.push(`${table}${NOT_IN_THE_MODEL}`);
		else if (!has) found.push(`${table}: the table is in the model but not in the database`);
		else found.push(...tableDifferences(table, has, wants));
	}
	for (const other of without(live.others, model.others)) found.push(`${other}: in the database but not in the model`);
	for (const other of without(model.others, live.others)) found.push(`${other}: in the model but not in the database`);

	return found;
}

// ─── Reconciliation: six tables, rebuilt where they differ ───────────────────

/**
 * The tables known to have reached databases in two shapes, and the only ones
 * ever rebuilt.
 *
 * Each was created or altered by a hand-written migration and by a drizzle-kit
 * one, and a database kept whichever reached it first. SQLite cannot alter a
 * NOT NULL, a primary key or a foreign key in place, so the table is rebuilt.
 *
 * The list is not a catch-all and must not become one. A difference in any
 * other table is reported by the schema check and is a fault to look into:
 * rebuilding whatever differs would turn a forgotten migration into a schema
 * change nobody wrote.
 */
export const RECONCILED_TABLES: readonly string[] = Object.freeze([
	'boards',
	'columns',
	'categories',
	'settings',
	'user_xp',
	'invite_tokens'
]);

/** The name a table is built under before it takes the place of the old one. */
export function scratchNameOf(table: string): string {
	return `${table}_rebuild_2006`;
}

const escapeRegExp = (text: string) => text.replace(/[.*+?^${}()|[\]\\]/g, '\\$&');

/** Matches `table` as a whole word, in any case: `board_categories` does not name `categories`. */
function naming(table: string): RegExp {
	return new RegExp(`(?<![A-Za-z0-9_$])${escapeRegExp(table)}(?![A-Za-z0-9_$])`, 'i');
}

/*
 * What to do about a table that was left alone. Each goes into the log line
 * after the reason, so each is written to be read after it. None of them
 * contains the word that the lines for a table that *was* rebuilt are found
 * by: someone searching the log for those must not find these.
 */

/** A check of the rebuild's own failed. Nothing in the database is at fault. */
const A_FAULT_IN_THE_REBUILD =
	'This is a fault in the rebuild, not in the data: one of its own checks failed, and everything it had done was undone. Report this line.';

/** This build's copy of the model is at fault, not the database. */
const A_FAULT_IN_THIS_BUILD =
	'This is a fault in this build, not in the database: its copy of the model (expected-schema.ts) is not one a rebuild can be made from. Report this line.';

/** SQLite would not run one of the rebuild's statements. What it said is in the reason. */
const REFUSED_BY_SQLITE =
	"SQLite refused one of the rebuild's statements, or its commit, for the reason it gave. If that names something in " +
	'the database, such as a view that no longer works, put that right and restart; if it does not, report this line.';

/** The rebuild's transaction could not be opened. */
const COULD_NOT_BEGIN =
	'The transaction for it could not be opened, which usually means another process has the database file open ' +
	'and was writing to it. Make sure nothing else is using the file, and restart.';

/** Something that only an open transaction, or a fault, can cause. */
const START_AGAIN_AND_REPORT =
	'Nothing in start-up should cause this. Restart, and report this line if it appears again.';

/** A table could not be read, so nothing is known about its shape. */
const A_FAILURE_TO_READ =
	'This is a failure to read the table, not a difference found in it. Check the disk and the database file.';

/** A table that does differ could not be read while its rebuild was being planned. */
const A_FAILURE_TO_READ_IT_FURTHER =
	'This is a failure to read the database, not something found in the table. Check the disk and the database file.';

/** The model's DDL could not be run. */
const THE_MODEL_IS_UNREADABLE =
	'This is a fault in this build, not in the database: its copy of the model (expected-schema.ts) does not run ' +
	'as SQL. Regenerate it (npm run schema:expected), build the image again and start that, or start the previous image.';

/** How every line about something left as it was ends. None of them is a halt. */
const UNTIL_DEALT_WITH = 'It is reported at every start until the cause is dealt with.';

/**
 * The log line for one table that was left alone, or for the several that
 * shared a rebuild: what happened, that nothing in them was changed, what to
 * do, and that it will be said again.
 *
 * "Nothing in it was changed", or "in them" for several, is the one way these
 * lines say it. It is said of the tables the line names and of no other:
 * other tables may have been rebuilt in the same start, and "Nothing was
 * changed" would read as a claim about the whole of it. And a table that
 * was compared is said to be in a shape that is not the model's, which is all
 * that is known of it: usually that shape is the older one, but not when it is
 * this build that is the older.
 */
function leftAloneLine(tables: string[], left: TableLeftAlone): string {
	const one = tables.length === 1;
	const names = tables.join(', ');
	const unchanged = `Nothing in ${one ? 'it' : 'them'} was changed`;

	if (left.stage === 'compare') {
		return (
			`${names} ${one ? 'was' : 'were'} not compared with the model: ${left.reason}. ${unchanged}, and ` +
			`the application runs on ${one ? 'the table' : 'the tables'} as it has until now. ${left.whatToDo} ${UNTIL_DEALT_WITH}`
		);
	}

	// Why a line about tables mentions foreign keys: the attempt is the one
	// thing in start-up that switches them off.
	const foreignKeys =
		left.stage === 'rebuild' ? ' A rebuild switches foreign keys off while it works; they have been read back as on.' : '';
	return (
		`${names} ${one ? 'was left in the shape it has, which is' : 'were left in the shapes they have, which are'} ` +
		`not the model's: ${left.reason}. ${unchanged}, and the application runs on ` +
		`${one ? 'that shape' : 'those shapes'} as it has until now.${foreignKeys} ${left.whatToDo} ${UNTIL_DEALT_WITH}`
	);
}

/**
 * The model's CREATE TABLE statement for `table`, creating it under its scratch
 * name instead.
 *
 * drizzle-kit writes every table as "CREATE TABLE `name` (", and only that
 * opening is replaced. A statement in any other form is refused rather than
 * edited by guesswork.
 *
 * So is one that names the table again further on. drizzle-kit writes a CHECK
 * constraint with the table's name in it (`"token_usage"."card_id" IS NULL`),
 * and with only the opening renamed the scratch table would have a CHECK on a
 * table that is not itself. SQLite refuses to create that, inside the
 * rebuild's transaction, and every table in it would be rolled back. It is
 * refused here instead, which is before anything is begun, and costs that one
 * table its rebuild and no other. None of the six has such a statement today.
 * A foreign key from a table to itself is refused the same way: it could be
 * carried across, but nothing here has been made to prove that it is.
 */
export function scratchTableStatement(
	table: string,
	expectedSchema: readonly string[] = EXPECTED_SCHEMA
): string {
	const opening = `CREATE TABLE \`${table}\` (`;
	const matching = expectedSchema.filter((statement) => statement.startsWith(opening));
	if (matching.length !== 1) {
		throw new Obstacle(
			`the model has ${matching.length} statements beginning "${opening}", and a rebuild needs exactly one`,
			A_FAULT_IN_THIS_BUILD
		);
	}
	const body = matching[0].slice(opening.length);
	if (naming(table).test(body)) {
		throw new Obstacle(
			`the model's statement for it names ${table} again after "${opening}", as a CHECK constraint written by ` +
				'drizzle-kit does, and a rebuild renames only that opening',
			'This is a limit of the rebuild, not a fault in the database: it cannot build this table under another ' +
				'name. The table needs a migration of its own. Report this line.'
		);
	}
	return `CREATE TABLE \`${scratchNameOf(table)}\` (${body}`;
}

type RebuildPlan = {
	table: string;
	scratch: string;
	createScratch: string;
	/** The model's columns, and the expression that copies each from the old table. */
	copy: { column: string; from: string }[];
	defaulted: RebuiltTable['defaulted'];
	/** Every way the table differs from the model: why it is being rebuilt. */
	differences: string[];
	createIndexes: string[];
	/** The table as it is now. */
	live: TableShape;
	expected: TableShape;
	/**
	 * Detach orphaned sub-boards before the copy. True for `boards` alone, and
	 * only where `gainsSubBoardKey` says so.
	 */
	detachOrphans: boolean;
};

// ─── Sub-boards whose card has gone ──────────────────────────────────────────

/*
 * One column of one table, and deliberately nothing more general.
 *
 * A database created from the repository before card 2006 has `boards` with no
 * foreign key on `parent_card_id`, so deleting a card left its sub-board
 * behind, still pointing at a card that is not there. The model's `boards` has
 * the key (to `cards`, ON DELETE CASCADE) and such a row would break it.
 *
 * The ruling (decision 14) is that the sub-board is detached: its
 * `parent_card_id` is cleared and it becomes an ordinary board. Nothing is
 * deleted, although deleting it is what the key would have done had it been
 * there when the card went.
 *
 * This is not a way of dealing with rows that break a foreign key. A row that
 * breaks any other key a rebuild adds or changes still fails the rebuild's
 * checks, and the rebuild is rolled back and reported.
 */

/** The boards that are sub-boards of a card that does not exist. */
const ORPHANED_SUB_BOARD =
	'"parent_card_id" IS NOT NULL AND NOT EXISTS (SELECT 1 FROM "cards" WHERE "cards"."id" = "boards"."parent_card_id")';

/** How many rows have a value in a foreign key column, and what the values add up to. */
type ReferenceCount = { set: number; total: number };

/**
 * True where rebuilding `table` gives `boards.parent_card_id` a foreign key to
 * `cards` and the table has no foreign key on that column now. That is where
 * orphaned sub-boards come from, and it is the one case in which they are
 * detached. Where `boards` already has a key on the column, no row of it is
 * changed, whatever the rows hold.
 */
function gainsSubBoardKey(table: string, live: TableShape, expected: TableShape): boolean {
	if (table !== 'boards') return false;
	const onColumn = (key: ForeignKey) => key.from.length === 1 && key.from[0] === 'parent_card_id';
	const toCardId = (key: ForeignKey) =>
		key.parent.toLowerCase() === 'cards' && (key.to[0] === null || key.to[0].toLowerCase() === 'id');
	return expected.foreignKeys.some((key) => onColumn(key) && toCardId(key)) && !live.foreignKeys.some(onColumn);
}

/**
 * Clear `parent_card_id` on every board whose card no longer exists. Deletes
 * nothing. Runs inside the rebuild's transaction, before `boards` is copied.
 *
 * Returns the boards it detached, for the log, and how many references that
 * was and what they added up to, for the rebuild's check: the snapshot is told
 * to expect exactly this change to `boards.parent_card_id` and no other. Both
 * are read before the UPDATE and independently of it, so an UPDATE that
 * cleared any other set of rows does not get past the check.
 */
function detachOrphanedSubBoards(database: Database.Database): {
	boards: DetachedSubBoard[];
	cleared: ReferenceCount;
} {
	const boards = database
		.prepare(
			`SELECT "id" AS id, "name" AS name, "parent_card_id" AS parentCardId FROM "boards" WHERE ${ORPHANED_SUB_BOARD} ORDER BY "id"`
		)
		.all() as DetachedSubBoard[];
	// Counted the way the snapshot counts, so that the two can be compared.
	const cleared = database
		.prepare(
			`SELECT COUNT("parent_card_id") AS "set", TOTAL("parent_card_id") AS total FROM "boards" WHERE ${ORPHANED_SUB_BOARD}`
		)
		.get() as ReferenceCount;

	if (boards.length > 0) {
		database.prepare(`UPDATE "boards" SET "parent_card_id" = NULL WHERE ${ORPHANED_SUB_BOARD}`).run();
	}
	return { boards, cleared };
}

// ─── Planning a rebuild ──────────────────────────────────────────────────────

/**
 * A column's default, as the literal a column of that declared type stores.
 *
 * The two are not always the same. `position real DEFAULT 0` stores 0.0, and a
 * rebuild that copied the literal 0 would then find 0.0 in the copy, which is
 * not what it put there. So the default is put through a column of the model's
 * type and read back, in an in-memory database that is closed again before
 * this returns: nothing is created in the database being rebuilt.
 */
function storedDefault(declaredType: string, defaultSql: string): string {
	const throwaway = new Database(':memory:');
	try {
		throwaway.exec(`CREATE TABLE t (v ${declaredType})`);
		throwaway.exec(`INSERT INTO t (v) VALUES ((${defaultSql}))`);
		return (throwaway.prepare('SELECT quote(v) AS value FROM t').get() as { value: string }).value;
	} finally {
		throwaway.close();
	}
}

/**
 * Check that `table` can be rebuilt, and work out how. Changes nothing.
 *
 * Throws an `Obstacle` if it cannot be: the rebuild drops a table and puts
 * another in its place, and that is only attempted where what is carried
 * across is known. The caller leaves that table alone and reports why and what
 * to do; the others go ahead.
 */
function planRebuild(
	database: Database.Database,
	table: string,
	live: TableShape,
	differences: string[],
	model: ExpectedModel,
	expectedSchema: readonly string[]
): RebuildPlan {
	const expected = model.structure.tables.get(table) as TableShape;
	const scratch = scratchNameOf(table);

	// Guard 1: the same columns. A column on one side only is not a difference
	// of shape; it is a migration that has not run, or one this build has not got.
	const liveColumns = [...live.columns.keys()];
	const modelColumns = [...expected.columns.keys()];
	if ([...liveColumns].sort().join('\n') !== [...modelColumns].sort().join('\n')) {
		throw new Obstacle(
			`its columns are (${liveColumns.join(', ')}) and the model's are (${modelColumns.join(', ')})`,
			'A column on one side only is not another shape of the same table, and a rebuild never adds or drops a ' +
				'column. Either a migration that adds or removes it has not been applied to this database, or this ' +
				'build is older than the database and has no file for it, or the column was changed outside the ' +
				'migrations. The line beginning "The database differs from the model" names each such column. Start ' +
				'the build that matches the database, or supply the migration that is missing.'
		);
	}

	// Guard 2: nothing that a drop and a rename would break or silently lose.
	const mentions = naming(table);
	const objects = database.prepare('SELECT type, name, tbl_name, sql FROM sqlite_master').all() as {
		type: string;
		name: string;
		tbl_name: string;
		sql: string | null;
	}[];
	const dropIt = (object: { type: string; name: string }) =>
		'The application defines no trigger and no view, so this one came from outside it, and dropping the table ' +
		`would lose it or break it. Drop it and restart: DROP ${object.type.toUpperCase()} ${quoted(object.name)};`;
	for (const object of objects) {
		if (object.name.toLowerCase() === scratch.toLowerCase()) {
			throw new Obstacle(
				`the name ${scratch} is already in use by a ${object.type}`,
				`${scratch} is the name the new ${table} is built under before it takes the place of the old one. ` +
					'A rebuild never leaves it behind: it is renamed when the rebuild succeeds and rolled back when it ' +
					`does not. Check what this ${object.type} is and whether anything in it is wanted, rename or drop it, and restart.`
			);
		}
		if (object.type !== 'trigger' && object.type !== 'view') continue;
		if (object.tbl_name.toLowerCase() === table.toLowerCase()) {
			throw new Obstacle(`${object.type} ${object.name} belongs to it`, dropIt(object));
		}
		if (object.sql && mentions.test(object.sql)) {
			throw new Obstacle(`${object.type} ${object.name} mentions it`, dropIt(object));
		}
	}

	// Guard 3: no NULL the model's column cannot hold, and no value that would
	// be thrown away.
	const copy: RebuildPlan['copy'] = [];
	const defaulted: RebuildPlan['defaulted'] = [];
	for (const [column, wanted] of expected.columns) {
		const has = live.columns.get(column) as ColumnShape;
		if (wanted.hidden !== 0) {
			// A generated column is computed, not copied. Where the table's own
			// is an ordinary column, it holds values, and they would simply go.
			if (has.hidden === 0) {
				throw new Obstacle(
					`the model's ${table}.${column} is a generated column and the table's is an ordinary one, whose values would be discarded`,
					'A rebuild must not discard a value. This needs a migration that says what becomes of the ones stored there. Report this line.'
				);
			}
			continue;
		}
		let from = quoted(column);
		if (wanted.notNull && !has.notNull) {
			const nulls = (
				database.prepare(`SELECT COUNT(*) AS n FROM ${quoted(table)} WHERE ${quoted(column)} IS NULL`).get() as {
					n: number;
				}
			).n;
			const fallback = defaultForNull(wanted);
			if (fallback !== null) {
				// The default is worked out once, here, and copied as a literal. A
				// default such as datetime('now') would otherwise be worked out by
				// the copy and again by the check on the copy, and the two would
				// disagree whenever the clock moved between them. It is worked out
				// as the model's column stores it, which is what the copy will hold.
				const value = storedDefault(wanted.type, fallback);
				from = orDefault(quoted(column), value);
				if (nulls > 0) defaulted.push({ column, rows: nulls, value });
			} else if (nulls > 0) {
				const isNull = `${quoted(column)} IS NULL`;
				throw new Obstacle(
					`${table}.${column} is NULL in ${nulls} row(s), and the model's column is NOT NULL with no default to give them`,
					`Give ${column} a value in those rows or delete them, and restart: ` +
						`UPDATE ${quoted(table)} SET ${quoted(column)} = <a value> WHERE ${isNull}; ` +
						`or DELETE FROM ${quoted(table)} WHERE ${isNull};` +
						(wanted.primaryKey > 0
							? ` ${column} is the table's key, so no two rows can be given the same value: where there are ` +
								'several, update them one at a time, adding AND rowid = <n>.'
							: '')
				);
			}
		}
		copy.push({ column, from });
	}

	return {
		table,
		scratch,
		// One more guard: this throws for a statement it cannot rename safely.
		createScratch: scratchTableStatement(table, expectedSchema),
		copy,
		defaulted,
		differences,
		createIndexes: model.createIndexes.get(table) ?? [],
		live,
		expected,
		detachOrphans: gainsSubBoardKey(table, live, expected)
	};
}

/** What the snapshot calls the values of one foreign key column. */
const referenceLabel = (table: string, column: string) => `values in ${table}.${column}`;

const fingerprint = (count: ReferenceCount) => `${count.set} set, adding up to ${count.total}`;

/** What a rebuild must leave exactly as it found it, read before and after. */
type Snapshot = {
	/** By what it is: "rows in cards", "values in cards.column_id", "the definition of table cards". */
	facts: Map<string, string>;
	/** The "values in" facts again, as numbers, by the same label. */
	references: Map<string, ReferenceCount>;
	/** `sqlite_sequence`: the id counter of every AUTOINCREMENT table. */
	sequences: Map<string, number>;
	/** The rows behind each foreign key violation, for the message. */
	violationRows: Map<string, (number | null)[]>;
};

type Watched = {
	/** Every table in the database, SQLite's own aside. */
	tables: string[];
	/** Every column that is the child end of a foreign key, as [table, column]. */
	references: [string, string][];
};

/**
 * Decide what to watch, once, so that the snapshots before and after a rebuild
 * look at the same things: every table, and every foreign key column in every
 * table — as the database has them now, and for a table being rebuilt also as
 * the model has them, so that a column which gains a foreign key is watched too.
 */
function watch(database: Database.Database, plans: RebuildPlan[]): Watched {
	const tables = (database.prepare("SELECT name FROM sqlite_master WHERE type = 'table'").all() as { name: string }[])
		.map((row) => row.name)
		.filter((name) => !name.startsWith('sqlite_'));

	const references = new Map<string, [string, string]>();
	const add = (table: string, columns: string[]) => {
		for (const column of columns) references.set(`${table}\n${column}`, [table, column]);
	};
	for (const table of tables) {
		for (const key of foreignKeysOf(database, table).values()) add(table, key.from);
	}
	for (const plan of plans) {
		for (const key of plan.expected.foreignKeys) add(plan.table, key.from);
	}
	return { tables, references: [...references.values()] };
}

function snapshot(
	database: Database.Database,
	watched: Watched,
	/** Each table being rebuilt, with the shape the model gives it. */
	rebuilding: ReadonlyMap<string, TableShape>
): Snapshot {
	const facts = new Map<string, string>();
	const references = new Map<string, ReferenceCount>();

	// Every table, not only the ones being rebuilt: with foreign keys on, a
	// dropped table takes the rows of other tables with it.
	for (const table of watched.tables) {
		const row = database.prepare(`SELECT COUNT(*) AS n FROM ${quoted(table)}`).get() as { n: number };
		facts.set(`rows in ${table}`, String(row.n));
	}

	// How many rows have a value, and what the values add up to. A reference
	// that was cleared, or re-pointed, changes one or the other.
	for (const [table, column] of watched.references) {
		const row = database
			.prepare(`SELECT COUNT(${quoted(column)}) AS n, TOTAL(${quoted(column)}) AS total FROM ${quoted(table)}`)
			.get() as { n: number; total: number };
		const count = { set: row.n, total: row.total };
		references.set(referenceLabel(table, column), count);
		facts.set(referenceLabel(table, column), fingerprint(count));
	}

	// The stored definition of everything that is not being rebuilt. A rename
	// done in the wrong order rewrites other tables' foreign keys; this is
	// where that shows.
	const objects = database.prepare('SELECT type, name, tbl_name, sql FROM sqlite_master').all() as {
		type: string;
		name: string;
		tbl_name: string;
		sql: string | null;
	}[];
	for (const object of objects) {
		if (rebuilding.has(object.tbl_name)) continue;
		facts.set(`the definition of ${object.type} ${object.name}`, object.sql ?? '(made by SQLite)');
	}

	// Rows that break a foreign key. There may be some already; there must be
	// no more and no fewer afterwards. A rebuilt table without an INTEGER
	// PRIMARY KEY is given new rowids, so its rows are counted, not named.
	//
	// A key of a rebuilt table is named by its columns and the table it refers
	// to, in lower case, and by nothing more. The rebuild may change the key's
	// ON DELETE rule, or how its parent is written, and a row that broke the
	// key before breaks it still: named in full, that one row would be counted
	// as one violation gone and another appeared, and the whole rebuild would
	// be stopped for it. A table that is not being rebuilt cannot have its keys
	// changed, so its keys are named in full.
	//
	// A key that a rebuilt table has and the model has not is not counted at
	// all. It is gone once the table is rebuilt, which is what the rebuild is
	// for and is said in the table's own line, and a row that broke it breaks
	// nothing afterwards: counted, that would read as a violation gone, and the
	// whole rebuild would be stopped for it in the same way.
	const named = (key: ForeignKey) => `(${key.from.join(', ')}) references ${key.parent.toLowerCase()}`;
	const violationRows = new Map<string, (number | null)[]>();
	const keysOf = new Map<string, Map<number, ForeignKey>>();
	for (const violation of database.pragma('foreign_key_check') as {
		table: string;
		rowid: number | null;
		parent: string;
		fkid: number;
	}[]) {
		if (!keysOf.has(violation.table)) keysOf.set(violation.table, foreignKeysOf(database, violation.table));
		const model = rebuilding.get(violation.table);
		const rebuilt = model !== undefined;
		const found = keysOf.get(violation.table)?.get(violation.fkid);
		if (model && found && !model.foreignKeys.some((key) => named(key) === named(found))) continue;
		const key = !found ? `to ${violation.parent}` : rebuilt ? named(found) : found.description;
		const row = rebuilt ? '' : ` row ${violation.rowid}`;
		const label = `foreign key violations in ${violation.table}${row}: ${key}`;
		violationRows.set(label, [...(violationRows.get(label) ?? []), violation.rowid]);
	}
	for (const [label, rows] of violationRows) facts.set(label, String(rows.length));

	const sequences = new Map<string, number>();
	if (tableExists(database, 'sqlite_sequence')) {
		for (const row of database.prepare('SELECT name, seq FROM sqlite_sequence').all() as {
			name: string;
			seq: number;
		}[]) {
			sequences.set(row.name, Math.max(sequences.get(row.name) ?? 0, row.seq));
		}
	}

	return { facts, references, sequences, violationRows };
}

/**
 * What differs between two snapshots that a rebuild had no business changing.
 * Empty if nothing.
 *
 * `detached` is the one change a rebuild makes on purpose: the references
 * cleared from sub-boards whose card has gone. Null when there were none.
 */
function changesBetween(
	before: Snapshot,
	after: Snapshot,
	plans: RebuildPlan[],
	detached: ReferenceCount | null
): string[] {
	const changed: string[] = [];
	const brief = (value: string | undefined) =>
		value === undefined ? 'none' : value.length > 200 ? `${value.slice(0, 197)}...` : value;
	const subBoards = referenceLabel('boards', 'parent_card_id');

	for (const label of inEither(before.facts.keys(), after.facts.keys())) {
		const was = before.facts.get(label);
		const is = after.facts.get(label);

		// Exactly as many values fewer as sub-boards were detached, adding up to
		// exactly that much less. Not "at most", and not "this column is
		// excused": one more reference gone is a sub-board that has lost a card
		// it still has, and no other check here would notice, since a NULL
		// breaks no foreign key and removes no row.
		const had = detached && label === subBoards ? before.references.get(label) : undefined;
		const due =
			had && detached ? fingerprint({ set: had.set - detached.set, total: had.total - detached.total }) : was;
		if (due === is) continue;

		const rows = after.violationRows.get(label);
		const which = rows ? `; rowid ${rows.slice(0, 10).join(', ')}${rows.length > 10 ? ', ...' : ''}` : '';
		const expected =
			had && detached ? `; expected, with ${detached.set} orphaned sub-board(s) detached: ${brief(due)}` : '';
		changed.push(`${label} (before: ${brief(was)}${expected}; after: ${brief(is)}${which})`);
	}

	// An id is never reused, so a counter may stay or rise and never fall. Only
	// a rebuilt table's may move at all, and one the model gives no counter has
	// none to keep.
	const rebuilt = new Map(plans.map((plan) => [plan.table, plan]));
	for (const name of inEither(before.sequences.keys(), after.sequences.keys())) {
		const was = before.sequences.get(name);
		const is = after.sequences.get(name);
		const plan = rebuilt.get(name);
		const wrong = plan
			? plan.expected.autoincrement && was !== undefined && (is === undefined || is < was)
			: was !== is;
		if (wrong) changed.push(`the id counter of ${name} (before: ${was ?? 'none'}; after: ${is ?? 'none'})`);
	}

	return changed;
}

/** `sqlite_sequence` for one table, or null if it has no entry. */
function sequenceOf(database: Database.Database, name: string): number | null {
	// The table exists only once some AUTOINCREMENT table has been created.
	if (!tableExists(database, 'sqlite_sequence')) return null;
	return (
		database.prepare('SELECT MAX(seq) AS n FROM sqlite_sequence WHERE name = ?').get(name) as { n: number | null }
	).n;
}

/**
 * `value`, an SQL expression, written out so that two values come out the
 * same only if they are the same value of the same type.
 *
 * `quote()` is nearly that, and is what everything but text is written with.
 * It stops at the first NUL in a text value: 'a', a NUL and 'b' is written
 * 'a', and so is 'a', a NUL and 'c'. So text is written as its bytes.
 */
const exactly = (value: string) =>
	`CASE typeof(${value}) WHEN 'text' THEN 'text:' || hex(${value}) ELSE quote(${value}) END`;

/** How many rows the SELECT `inThis` returns that the SELECT `notInThat` does not. */
const rowsOnlyIn = (database: Database.Database, inThis: string, notInThat: string) =>
	(database.prepare(`SELECT COUNT(*) AS n FROM (${inThis} EXCEPT ${notInThat})`).get() as { n: number }).n;

/**
 * True if what the copy holds in `column` is exactly what the table's own
 * values become in a column of the model's type.
 *
 * Asked only of a column the copy has changed and whose type is not the
 * model's, to tell the two causes apart: the type, which is a fact about the
 * table's values, or a copy that went wrong, which is a fault in the rebuild.
 * The copy cannot be asked about itself. So the table's values are put
 * through a column of the model's type that the copy had no part in, the one
 * column of a TEMP table, and what comes out is compared with the copy's
 * column, each distinct value with how many times it occurs.
 *
 * The answer decides whether the rebuild is done again without this table, so
 * anything short of yes is no. If the probe cannot be made or read, that is a
 * no as well and nothing is thrown: this must not become one more way for a
 * rebuild to fail. Its table is dropped again here, and would go with the
 * rebuild's transaction if it were not: the copy has been found to differ by
 * the time this runs, and that always rolls the transaction back.
 */
function storedSoByItsType(
	database: Database.Database,
	plan: RebuildPlan,
	column: string,
	from: string,
	type: string
): boolean {
	const probe = `temp.${quoted(`${plan.scratch}_probe`)}`;
	const dropProbe = `DROP TABLE IF EXISTS ${probe}`;
	try {
		database.prepare(dropProbe).run();
		database.prepare(`CREATE TABLE ${probe} (v ${type})`).run();
		database.prepare(`INSERT INTO ${probe} (v) SELECT ${from} FROM ${quoted(plan.table)}`).run();
		// GROUP BY 1: by the value, which is the one column of each result.
		const through = `SELECT ${exactly('v')}, COUNT(*) FROM ${probe} GROUP BY 1`;
		const copied = `SELECT ${exactly(quoted(column))}, COUNT(*) FROM ${quoted(plan.scratch)} GROUP BY 1`;
		return rowsOnlyIn(database, through, copied) === 0 && rowsOnlyIn(database, copied, through) === 0;
	} catch {
		return false;
	} finally {
		try {
			database.prepare(dropProbe).run();
		} catch {
			// Left for the rollback, which takes it.
		}
	}
}

/**
 * Check that the copy of a table holds the table's rows, value for value, and
 * throw if it does not. Runs after the copy and before the drop: the last
 * moment at which both sets of rows exist.
 *
 * The snapshot of the whole database cannot do this. It counts rows and adds
 * up foreign key columns, so a copy that blanked every `title`, or put each
 * row's values in another row, would pass it.
 *
 * The rows of the old table, read through the same expressions the copy used
 * (the default for a NULL included), must be the rows of the new one: nothing
 * in either that is not in the other. Each distinct row is compared together
 * with how many times it occurs, so a row lost and another doubled is a
 * difference too, in a table that has no key to prevent it.
 *
 * Each value is compared by its type as well as its content: '007' the text,
 * 7 the integer and 7.0 the real are three different things here. Text is
 * compared byte for byte and everything else as `quote()` writes it (see
 * `exactly`); the values shown in the message are all as `quote()` writes
 * them, which can be read. The type matters where the table's column and the
 * model's have different types. Copied into an INTEGER column, the text '007'
 * is stored as the integer 7, without an error, and a rebuild must not change
 * a value. So that is a difference, it is found here, and nothing is dropped.
 *
 * A difference is one of two things, and what is thrown says which. Where
 * every column that differs has another type in the model, and the copy holds
 * in it exactly what that type makes of the table's values
 * (`storedSoByItsType`), the table's own values are in the way: the `Obstacle`
 * names the table, and the rebuild can be done again without it. Anything
 * else is a fault in the copy, which is a fault in the rebuild.
 */
function checkTheCopy(database: Database.Database, plan: RebuildPlan): void {
	const { table, scratch } = plan;
	const asCopied = plan.copy.map((c) => exactly(c.from)).join(', ');
	const asKept = plan.copy.map((c) => exactly(quoted(c.column))).join(', ');
	// GROUP BY 1, 2, ...: by every column of the result.
	const everyColumn = plan.copy.map((_, index) => index + 1).join(', ');
	const old = `SELECT ${asCopied}, COUNT(*) FROM ${quoted(table)} GROUP BY ${everyColumn}`;
	const copy = `SELECT ${asKept}, COUNT(*) FROM ${quoted(scratch)} GROUP BY ${everyColumn}`;

	const missing = rowsOnlyIn(database, old, copy);
	const strange = rowsOnlyIn(database, copy, old);
	if (missing === 0 && strange === 0) return;

	// Which columns, with one value from each side, so that the line can be
	// acted on. A value in the table that the copy holds nowhere in that column
	// is a value that was changed on the way. The values are compared here as
	// the rows were, so that the two passes agree, and `v` is only what is shown.
	const brief = (value: string) => (value.length > 60 ? `${value.slice(0, 57)}...` : value);
	const found: string[] = [];
	let everyOneOwedToItsType = true;
	for (const { column, from } of plan.copy) {
		const inOld = `SELECT ${exactly(from)} AS e, quote(${from}) AS v FROM ${quoted(table)}`;
		const inCopy = `SELECT ${exactly(quoted(column))} AS e, quote(${quoted(column)}) AS v FROM ${quoted(scratch)}`;
		const example = (inThis: string, notInThat: string) =>
			database.prepare(`SELECT COUNT(*) AS n, MIN(v) AS v FROM (${inThis} EXCEPT ${notInThat})`).get() as {
				n: number;
				v: string | null;
			};
		const was = example(inOld, inCopy);
		const is = example(inCopy, inOld);
		if (was.n === 0 && is.n === 0) continue;

		const has = plan.live.columns.get(column)?.type ?? '';
		const wants = plan.expected.columns.get(column)?.type ?? '';
		// That the two types have different names does not make the type the
		// cause: a copy that went wrong in such a column differs as well.
		if (everyOneOwedToItsType && (has === wants || !storedSoByItsType(database, plan, column, from, wants))) {
			everyOneOwedToItsType = false;
		}
		found.push(
			`${table}.${column}: ${was.n} value(s) in the table are not in the copy` +
				(was.v !== null ? `, such as ${brief(was.v)}` : '') +
				(is.v !== null ? `, and the copy has ${is.n} that the table has not, such as ${brief(is.v)}` : '') +
				(has !== wants ? `; the table's column is ${has || '(no type)'} and the model's is ${wants || '(no type)'}` : '')
		);
	}

	const what =
		found.length > 0
			? found.join('; ')
			: `${missing} row(s) of the table are not in the copy as they are, and ${strange} row(s) of the copy are not rows of the table`;
	// Values that a column of another type would store differently are a fact
	// about this table and not a fault in the rebuild, so this is the one check
	// that names its table: the rebuild can be done again without it.
	const itsOwnValues = found.length > 0 && everyOneOwedToItsType;
	throw new Obstacle(
		`the copy of ${table} would not hold its rows as they are: ${what}`,
		itsOwnValues
			? "The table's column and the model's have different types, and SQLite stores such a value differently in " +
				"the model's. A rebuild must not change a value, so it will not do this one: the table needs a " +
				'migration that says what each value is to become. Report this line.'
			: A_FAULT_IN_THE_REBUILD,
		itsOwnValues ? table : undefined
	);
}

/** Rebuild one table. Runs inside the rebuild's transaction, with foreign keys off. */
function rebuildTable(database: Database.Database, plan: RebuildPlan): RebuiltTable {
	const { table, scratch } = plan;
	const count = (name: string) =>
		(database.prepare(`SELECT COUNT(*) AS n FROM ${quoted(name)}`).get() as { n: number }).n;

	database.exec(plan.createScratch);
	const sequenceBefore = sequenceOf(database, table);

	// An explicit column list on both sides: the two tables have the same
	// columns but not always in the same order.
	const columns = plan.copy.map((c) => quoted(c.column)).join(', ');
	const values = plan.copy.map((c) => c.from).join(', ');
	database.prepare(`INSERT INTO ${quoted(scratch)} (${columns}) SELECT ${values} FROM ${quoted(table)}`).run();

	const rows = count(table);
	const carried = count(scratch);
	if (carried !== rows) {
		// Never drop the original unless every row is accounted for.
		throw new Obstacle(`${table} has ${rows} row(s) and ${carried} were copied`, A_FAULT_IN_THE_REBUILD);
	}
	// Nor unless every row is what it was.
	checkTheCopy(database, plan);

	// The last moment at which stopping costs nothing. With foreign keys on,
	// DROP TABLE deletes the table's rows first and every ON DELETE action fires.
	if (foreignKeysOn(database)) {
		throw new Obstacle(
			`foreign keys are on inside the rebuild; dropping ${table} would delete or clear every row that refers to it`,
			A_FAULT_IN_THE_REBUILD
		);
	}
	// Drop, then rename: never the other way round. Renaming the old table out
	// of the way rewrites every other table's foreign key to follow it, and the
	// drop then leaves them all pointing at a table that is gone.
	database.prepare(`DROP TABLE ${quoted(table)}`).run();
	database.prepare(`ALTER TABLE ${quoted(scratch)} RENAME TO ${quoted(table)}`).run();

	// An id is never reused: keep the larger of the old counter and the new.
	// The drop removed the old counter. The rename carried over the scratch
	// table's, which is only the highest id copied — nothing at all if there
	// were no rows — and so forgets any row created and deleted before now.
	if (plan.expected.autoincrement) {
		const copied = Math.max(sequenceOf(database, table) ?? 0, sequenceOf(database, scratch) ?? 0);
		if (sequenceBefore !== null || copied > 0) {
			database.prepare('DELETE FROM sqlite_sequence WHERE name IN (?, ?)').run(table, scratch);
			database
				.prepare('INSERT INTO sqlite_sequence (name, seq) VALUES (?, ?)')
				.run(table, Math.max(sequenceBefore ?? 0, copied));
		}
	}

	// DROP TABLE took the table's indexes with it.
	for (const statement of plan.createIndexes) database.exec(statement);

	return { table, rows, defaulted: plan.defaulted, differences: plan.differences };
}

/**
 * The body of the rebuild: one transaction, with foreign keys off.
 *
 * Throws if any step fails or if a check finds anything, which rolls back
 * every table in it. The message says what was found; the caller says that it
 * was rolled back. A check that fails throws an `Obstacle`, which says what to
 * do as well; anything else thrown here is SQLite refusing a statement.
 */
function rebuildTables(
	database: Database.Database,
	plans: RebuildPlan[]
): { rebuilt: RebuiltTable[]; detached: DetachedSubBoard[] } {
	const rebuilding = new Map(plans.map((plan) => [plan.table, plan.expected]));

	const watched = watch(database, plans);
	const before = snapshot(database, watched, rebuilding);

	const rebuilt: RebuiltTable[] = [];
	let detached: DetachedSubBoard[] = [];
	let cleared: ReferenceCount | null = null;
	for (const plan of plans) {
		// After the snapshot, so that the snapshot is what checks it; before the
		// copy, so that no row goes into the new table breaking its foreign key.
		if (plan.detachOrphans) {
			const orphans = detachOrphanedSubBoards(database);
			detached = orphans.boards;
			cleared = orphans.boards.length > 0 ? orphans.cleared : null;
		}
		rebuilt.push(rebuildTable(database, plan));
	}

	// Each table's own rows were checked against its copy before it was
	// dropped. That alone proves little: in the ways a rebuild goes badly
	// wrong, the table it rebuilt comes out with the right rows, and the damage
	// is in the tables that refer to it.
	const changed = changesBetween(before, snapshot(database, watched, rebuilding), plans, cleared);
	if (changed.length > 0) {
		const more = changed.length > 10 ? `; and ${changed.length - 10} more` : '';
		throw new Obstacle(
			`it changed what it must leave alone: ${changed.slice(0, 10).join('; ')}${more}`,
			A_FAULT_IN_THE_REBUILD
		);
	}
	for (const plan of plans) {
		const left = tableDifferences(plan.table, describeTable(database, plan.table), plan.expected);
		if (left.length > 0) {
			throw new Obstacle(
				`${plan.table} would still differ from the model afterwards: ${left.join('; ')}`,
				A_FAULT_IN_THE_REBUILD
			);
		}
	}

	return { rebuilt, detached };
}

/**
 * Rebuild, in the model's shape, each of the six reconciled tables that a
 * database has in another.
 *
 * Runs on every start and does nothing unless one of them exists and differs.
 * A table is rebuilt the only way SQLite allows: a new one is created from the
 * model's own statement, the rows are copied, the old one is dropped and the
 * new one takes its name. All the tables that pass their guards are done in
 * one transaction, so those end up all rebuilt or all as they were. There is
 * one exception, a table stopped by its own values: it is left as it was and
 * the transaction is done again for the rest, as described below.
 *
 * Two things here are not optional, and neither announces itself when wrong:
 *
 * - `PRAGMA foreign_keys = OFF` is ignored inside a transaction, without an
 *   error. With foreign keys still on, `DROP TABLE columns` deletes its rows
 *   first and every card goes with them; dropping `boards` would empty the
 *   database. So the pragma is set before the transaction opens and read back,
 *   and read back again immediately before each drop.
 * - The order is create, copy, drop, rename. See `rebuildTable`.
 *
 * Because neither failure shows in the table being rebuilt, the whole database
 * is compared with a snapshot taken at the start of the transaction, and any
 * change that a rebuild has no business making rolls it back.
 *
 * What it does when something is in the way (decision 12): a table that
 * cannot be rebuilt has been running in the shape it has, so leaving it there
 * breaks nothing that was working, and stopping the server over it would.
 *
 * - A table that cannot be compared with the model, or that fails a guard, is
 *   left as it is. The others go ahead.
 * - If the rebuild cannot be begun, throws or fails a check, nothing of it
 *   remains: it is rolled back as a whole, foreign keys are switched back on,
 *   and every table in it is as it was.
 * - One check is about a table's own rows and not about the rebuild: a value
 *   that the model's column type would store differently. The rebuild is
 *   rolled back as a whole for that too, then done again without that table,
 *   so the others are not kept waiting on a migration that only it needs.
 *
 * None of these throws. Each is returned in `leftAlone`, table by table, with
 * the reason and what to do about it, and it is the caller's job to log each
 * at ERROR: nothing is logged here, because a line written inside the
 * rebuild's transaction would be rolled back with it. Neither part is dropped
 * on the way.
 *
 * It throws in one case only: foreign keys cannot be read back as on
 * afterwards. That is this connection with every cascade and every constraint
 * silently off, and nothing should be served from it. By then the rebuild may
 * have been committed, and what is thrown says which.
 */
export function reconcileSchema(
	database: Database.Database = sqlite,
	expectedSchema: readonly string[] = EXPECTED_SCHEMA
): Reconciliation {
	const outcome: Reconciliation = { rebuilt: [], leftAlone: [], detached: [] };
	const leaveAlone = (table: string, stage: TableLeftAlone['stage'], reason: string, whatToDo: string) => {
		outcome.leftAlone.push({ table, stage, reason, whatToDo });
	};

	let model: ExpectedModel;
	try {
		model = expectedModel(expectedSchema);
	} catch (err) {
		// No shape to bring any table to. The schema check will say the same of
		// the whole database.
		for (const table of RECONCILED_TABLES) {
			leaveAlone(table, 'compare', `the model could not be read: ${messageOf(err)}`, THE_MODEL_IS_UNREADABLE);
		}
		return outcome;
	}

	const differing: { table: string; live: TableShape; differences: string[] }[] = [];
	for (const table of RECONCILED_TABLES) {
		try {
			const expected = model.structure.tables.get(table);
			if (!expected || !tableExists(database, table)) continue;
			const live = describeTable(database, table);
			const differences = tableDifferences(table, live, expected);
			if (differences.length > 0) differing.push({ table, live, differences });
		} catch (err) {
			leaveAlone(table, 'compare', `its structure could not be read: ${messageOf(err)}`, A_FAILURE_TO_READ);
		}
	}
	if (differing.length === 0) return outcome;

	// Guard 4. SQLite ignores the pragma inside a transaction, so there must
	// not be one. It is the same for every table: none can be rebuilt.
	if (database.inTransaction) {
		for (const { table } of differing) {
			leaveAlone(
				table,
				'guard',
				'a transaction is open on this connection, and foreign keys cannot be switched off inside one',
				START_AGAIN_AND_REPORT
			);
		}
		return outcome;
	}

	// Guards 1 to 3, for every table, before anything is changed. A table that
	// fails is left out of the rebuild; it does not stop the rebuild of the rest.
	const plans: RebuildPlan[] = [];
	for (const { table, live, differences } of differing) {
		try {
			plans.push(planRebuild(database, table, live, differences, model, expectedSchema));
		} catch (err) {
			// A guard says what to do. Anything else thrown while a rebuild was
			// being planned is the database refusing to be read.
			if (err instanceof Obstacle) leaveAlone(table, 'guard', err.message, err.whatToDo);
			else {
				leaveAlone(table, 'guard', `reading it to plan a rebuild failed: ${messageOf(err)}`, A_FAILURE_TO_READ_IT_FURTHER);
			}
		}
	}
	if (plans.length === 0) return outcome;

	/** The tables still to be rebuilt together. Shrinks only as described below. */
	let remaining = plans;
	let done: ReturnType<typeof rebuildTables> | null = null;
	/** Why no table in `remaining` was rebuilt, and what to do. Null if they all were. */
	let failure: { reason: string; whatToDo: string } | null = null;
	const notSwitchedOff = 'foreign keys could not be switched off, so the rebuild was not started';

	try {
		database.pragma('foreign_keys = OFF');
		if (foreignKeysOn(database)) failure = { reason: notSwitchedOff, whatToDo: START_AGAIN_AND_REPORT };
	} catch (err) {
		failure = { reason: `${notSwitchedOff}: ${messageOf(err)}`, whatToDo: START_AGAIN_AND_REPORT };
	}
	// One attempt, as a rule. There is another only where what stopped the last
	// was one table's own rows (`Obstacle.table`): that table is left as it is
	// and the rest are done again without it, so that one table's values do not
	// keep the others in a shape that is not the model's. Each attempt is a
	// transaction of its own and the one before it was rolled back whole, so the
	// plans made above still describe the database. It ends: every further
	// attempt has one table fewer.
	while (failure === null && done === null && remaining.length > 0) {
		// Whether the transaction was ever opened. BEGIN IMMEDIATE fails if
		// another connection holds the write lock, and that is not a rollback:
		// nothing had been done that could be rolled back.
		let begun = false;
		const attempt = remaining;
		try {
			done = database
				.transaction(() => {
					begun = true;
					return rebuildTables(database, attempt);
				})
				.immediate();
		} catch (err) {
			// better-sqlite3 has rolled the transaction back by the time this
			// runs, if it was opened. If the rollback itself failed, what is thrown
			// is that failure and the transaction is still open: foreign keys will
			// not come back on with it open, and that is the halt further down.
			const rolledBack = begun && !database.inTransaction;
			const its = rolledBack && err instanceof Obstacle ? attempt.find((plan) => plan.table === err.table) : undefined;
			if (its && err instanceof Obstacle) {
				leaveAlone(
					its.table,
					'rebuild',
					attempt.length > 1
						? `the rebuild was rolled back because of it, and tried again without it: ${err.message}`
						: `the rebuild was rolled back: ${err.message}`,
					err.whatToDo
				);
				remaining = attempt.filter((plan) => plan !== its);
				continue;
			}
			failure = !begun
				? { reason: `the rebuild could not be started: ${messageOf(err)}`, whatToDo: COULD_NOT_BEGIN }
				: database.inTransaction
					? {
							reason: `the rebuild failed and its transaction could not be rolled back: ${messageOf(err)}`,
							whatToDo: REFUSED_BY_SQLITE
						}
					: {
							reason: `the rebuild was rolled back: ${messageOf(err)}`,
							whatToDo: err instanceof Obstacle ? err.whatToDo : REFUSED_BY_SQLITE
						};
		}
	}
	const names = remaining.map((plan) => plan.table).join(', ');

	// This is the application's only connection: it must not be left with
	// foreign keys off, whatever happened above. Inside a transaction this
	// pragma is ignored too, so a rollback that did not happen shows up here.
	let on = false;
	let switching: unknown = null;
	try {
		database.pragma('foreign_keys = ON');
		on = foreignKeysOn(database);
	} catch (err) {
		switching = err;
	}
	if (!on) {
		// The only way out of here by throwing, and the caller stops for it. So
		// everything known goes into the one message: there will be no report,
		// and none of the lines that would have followed a rebuild.
		const carried = (table: RebuiltTable) =>
			`${table.table} rebuilt with ${table.rows} row(s) carried across` +
			table.defaulted.map((d) => ` and ${d.rows} NULL ${d.column} value(s) given the default ${d.value}`).join('');
		const known = [
			done
				? `the rebuild had been committed: ${done.rebuilt.map(carried).join(', ')}`
				: remaining.length > 0
					? `no rebuild of ${names} had been committed: ${failure?.reason ?? 'the rebuild did not complete'}`
					: 'no rebuild had been committed',
			...outcome.leftAlone.map((left) =>
				left.stage === 'compare'
					? `${left.table} had not been compared with the model: ${left.reason}`
					: `${left.table} had been left in the shape it has: ${left.reason}`
			),
			...(done?.detached ?? []).map(
				(board) => `sub-board ${board.id} (${board.name}) had been detached from card ${board.parentCardId}`
			)
		];
		if (database.inTransaction) known.push('a transaction is still open on the connection');
		if (switching) known.push(`switching them on failed with: ${messageOf(switching)}`);
		throw new ForeignKeysStayedOff(
			'foreign keys could not be switched back on after the rebuild was attempted, and this connection must not ' +
				`be used with them off (${known.join('; ')})`,
			done ? AFTER_A_COMMITTED_REBUILD : database.inTransaction ? WITH_THE_REBUILD_STILL_OPEN : AFTER_NO_REBUILD,
			switching
		);
	}

	if (done) {
		outcome.rebuilt = done.rebuilt;
		outcome.detached = done.detached;
	} else {
		for (const plan of remaining) {
			leaveAlone(
				plan.table,
				'rebuild',
				failure?.reason ?? 'the rebuild did not complete',
				failure?.whatToDo ?? A_FAULT_IN_THE_REBUILD
			);
		}
	}
	return outcome;
}

// ─── Backfills ───────────────────────────────────────────────────────────────

/**
 * 0057's statement (card 2155), which `runBackfills` repeats: every card in a
 * milestone that belongs to a board other than the card's, archived cards
 * included, taken out of it. A goal across boards keeps its cards, and so does
 * a card on a column that is not there. `updated_at` is left as it is, since
 * nobody edited the cards. The text is 0057's own, and a test holds the two
 * to it, so that a restore is repaired exactly as the deploy was.
 */
export const CARDS_LEAVE_OTHER_BOARDS_MILESTONES = [
	'UPDATE `cards` SET `milestone_id` = NULL',
	'WHERE `milestone_id` IN (SELECT `id` FROM `milestones` WHERE `board_id` IS NOT NULL)',
	'  AND (SELECT `board_id` FROM `milestones` WHERE `id` = `cards`.`milestone_id`)',
	'      <> (SELECT `board_id` FROM `columns` WHERE `id` = `cards`.`column_id`);'
].join('\n');

/** How many of the cards it takes out the backfill names. */
const RELEASED_NAMED = 50;

/**
 * The cards the statement above takes out, read just before it runs, by its
 * own `WHERE` (its text from `WHERE` to the `;`, so the two cannot drift):
 * the first 50 by id, with the milestone each is in.
 */
const CARDS_LEAVING_OTHER_BOARDS_MILESTONES =
	'SELECT `id` AS cardId, `milestone_id` AS milestoneId FROM `cards`\n' +
	CARDS_LEAVE_OTHER_BOARDS_MILESTONES.slice(CARDS_LEAVE_OTHER_BOARDS_MILESTONES.indexOf('WHERE'), -1) +
	`\nORDER BY \`id\` LIMIT ${RELEASED_NAMED}`;

/**
 * The cards the backfill took out, as the start's WARN line and the restore's
 * "Filled in" name them: `card 12 left milestone 3, card 14 left milestone 3`,
 * and `; and 7 more` past the first 50 (review of card 2179). By id: a card's
 * title and a goal's name are for the readers of their boards.
 */
export function releasedCardsList(backfill: Pick<Backfill, 'releasedFromMilestones' | 'released'>): string {
	const named = backfill.released.map((r) => `card ${r.cardId} left milestone ${r.milestoneId}`).join(', ');
	const more = backfill.releasedFromMilestones - backfill.released.length;
	return more > 0 ? `${named}; and ${more} more` : named;
}

/**
 * Every board filed under a dashboard grouping that no longer exists, taken
 * out of it (card 2293). `boards.category_id` has no foreign key, and until
 * card 2293 deleting a grouping left its boards holding its id: every page
 * showed them as uncategorised, the API answered the dead id, and a grouping
 * given that id again (a restore onto another server can do that) would have
 * had them filed under it. A board under a grouping that is there, and a board
 * under none, are left alone, and so is `updated_at`: nobody edited the boards.
 */
export const BOARDS_LEAVE_DELETED_GROUPINGS = [
	'UPDATE `boards` SET `category_id` = NULL',
	'WHERE `category_id` IS NOT NULL',
	'  AND NOT EXISTS (SELECT 1 FROM `board_categories` WHERE `id` = `boards`.`category_id`);'
].join('\n');

/** How many of the boards it takes out the backfill names. */
const UNFILED_NAMED = 50;

/** The statement's own `WHERE`: its text from the first `WHERE`, the outer one, to the `;`. */
const UNDER_A_DELETED_GROUPING = BOARDS_LEAVE_DELETED_GROUPINGS.slice(BOARDS_LEAVE_DELETED_GROUPINGS.indexOf('WHERE'), -1);

/**
 * The boards the statement above takes out, read just before it runs, by its
 * own `WHERE`, so the two cannot drift: the first 50 by id, with the grouping
 * id each named.
 */
export const BOARDS_LEAVING_DELETED_GROUPINGS =
	'SELECT `id` AS boardId, `category_id` AS groupingId FROM `boards`\n' +
	UNDER_A_DELETED_GROUPING +
	`\nORDER BY \`id\` LIMIT ${UNFILED_NAMED}`;

/**
 * Every board the statement would take out, by id, with the grouping id each
 * names, by the same `WHERE`: what a restore asks before it commits, treating
 * `boards.category_id` as a foreign key that `PRAGMA foreign_key_check` cannot
 * see (`strandedBy` in restore.ts).
 */
export const BOARDS_UNDER_DELETED_GROUPINGS =
	'SELECT `id`, `category_id` AS groupingId FROM `boards`\n' + UNDER_A_DELETED_GROUPING + '\nORDER BY `id`';

/**
 * The boards the backfill took out, as the start's WARN line and the
 * restore's "Filled in" name them: `board 3 (grouping 7), board 4 (grouping
 * 7)`, and `; and 2 more` past the first 50. By id, as `releasedCardsList`
 * names cards: a board's name is for its readers.
 */
export function unfiledBoardsList(backfill: Pick<Backfill, 'unfiledBoards' | 'unfiled'>): string {
	const named = backfill.unfiled.map((u) => `board ${u.boardId} (grouping ${u.groupingId})`).join(', ');
	const more = backfill.unfiledBoards - backfill.unfiled.length;
	return more > 0 ? `${named}; and ${more} more` : named;
}

/**
 * Fill in the two values that 0050 and 0051 filled in once, and take out of
 * their milestones the cards 0057 took out once.
 *
 * Those files run once per database, but rows without the values can arrive
 * afterwards: a restore copies an older backup's rows into the current tables,
 * and its cards have no `first_completed_at` and its requests no
 * `access_token`. So the same two statements run on every start and after
 * every restore. Each touches only rows that lack the value, so a second run
 * changes nothing.
 *
 * The same holds for 0057 (card 2179). Once a move to another board takes a
 * card out of its board's milestone (card 2155), and a milestone is given to
 * another board only when every card in it is there (card 2179), no write
 * makes a card in a milestone of another board. A backup taken before those
 * two can still hold one, and a restore runs no migration, so the statement is
 * repeated here. A count at a start that follows no restore and no return from
 * an older image means some write still makes such rows.
 *
 * And boards filed under a dashboard grouping that no longer exists are taken
 * out of it (card 2293). Production holds such boards from before deleting a
 * grouping cleared them, so the first start of the image that clears them is
 * the one-off; a restore brings a backup's back. A restore that left grouping
 * rows out while boards point at them is refused before it gets here
 * (`strandedBy` in restore.ts), so this never unfiles a board because a
 * restore failed to copy its grouping.
 *
 * A table or column that is not there is skipped. After the migration loop
 * all of them always exist; they are missing only when the runner is driven
 * against some other set of files, as the tests do, and then there is nothing
 * to fill.
 */
export function runBackfills(database: Database.Database = sqlite): Backfill {
	const fill = database.transaction(() => {
		const result: Backfill = {
			firstCompletedAt: 0,
			accessTokens: 0,
			releasedFromMilestones: 0,
			released: [],
			unfiledBoards: 0,
			unfiled: []
		};

		if (hasColumn(database, 'cards', 'first_completed_at') && hasColumn(database, 'cards', 'completed_at')) {
			// A card that is complete has been completed at least once.
			result.firstCompletedAt = database
				.prepare(
					'UPDATE cards SET first_completed_at = completed_at WHERE first_completed_at IS NULL AND completed_at IS NOT NULL'
				)
				.run().changes;
		}

		if (hasColumn(database, 'task_requests', 'access_token')) {
			// Same form as newRequestToken() in request-tokens.ts: 32 random bytes, hex.
			result.accessTokens = database
				.prepare('UPDATE task_requests SET access_token = lower(hex(randomblob(32))) WHERE access_token IS NULL')
				.run().changes;
		}

		if (
			hasColumn(database, 'cards', 'milestone_id') &&
			hasColumn(database, 'milestones', 'board_id') &&
			hasColumn(database, 'columns', 'board_id')
		) {
			// Which cards first: once they are out, nothing records the goal each was in.
			result.released = database.prepare(CARDS_LEAVING_OTHER_BOARDS_MILESTONES).all() as ReleasedCard[];
			result.releasedFromMilestones = database.prepare(CARDS_LEAVE_OTHER_BOARDS_MILESTONES).run().changes;
		}

		if (hasColumn(database, 'boards', 'category_id') && tableExists(database, 'board_categories')) {
			// Which boards first, with the id each named: once cleared, nothing records it.
			result.unfiled = database.prepare(BOARDS_LEAVING_DELETED_GROUPINGS).all() as UnfiledBoard[];
			result.unfiledBoards = database.prepare(BOARDS_LEAVE_DELETED_GROUPINGS).run().changes;
		}

		return result;
	});
	// Take the write lock at the start, as every other transaction here does,
	// rather than part-way through at the first UPDATE.
	return fill.immediate();
}

// ─── The runner ──────────────────────────────────────────────────────────────

/**
 * Bring a database up to date, or throw.
 *
 * Each file not yet recorded in `__drizzle_migrations` runs in one transaction
 * together with the row that records it, so a file is either wholly applied and
 * recorded or not applied at all. The first failure stops the run: the failing
 * file is rolled back, no later file is attempted, and the error names the
 * file, the block of SQL that failed, what SQLite said and which files had
 * already been committed. A migration is recorded by its file name, so editing
 * a file that a database has recorded never runs it there again.
 *
 * Then the six reconciled tables are brought to the model's shape, the
 * backfills are repeated, every timestamp is brought to the stored form, and
 * the whole database is compared with the model.
 * A table that cannot be brought to it is left as it was and reported, in the
 * log and in what this returns; that does not throw. See `reconcileSchema`.
 *
 * Tests pass `database`, `migrationsDir` and sometimes `expectedSchema` to
 * drive it against a separate in-memory database, a temporary directory and a
 * made-up model. The application calls it bare.
 */
export function runMigrations(options: MigrationOptions = {}): MigrationReport {
	const database = options.database ?? sqlite;
	const migrationsDir = options.migrationsDir ?? join(process.cwd(), 'drizzle');
	const expectedSchema = options.expectedSchema ?? EXPECTED_SCHEMA;
	const applied: string[] = [];
	const tolerated: ToleratedError[] = [];

	// Log the failure, then throw it.
	//
	// Every call is made after this runner's own transaction has been committed
	// or rolled back, so the log row is not undone with the work it describes.
	// That is all it promises. Called because somebody else's transaction is
	// open, the row goes into that transaction and lasts only if its owner
	// commits. The row is written on the application's connection, which is not
	// `database` when a test passes its own. And the row may not be written at
	// all: the logger never throws, whatever happens to its insert. The console
	// line is printed in every case.
	//
	// One halt can find a transaction of this runner's own still open: the one
	// for foreign keys that could not be switched back on, when the reason is a
	// rollback that itself failed. Its message says so.
	//
	// The sentence is the whole account, and it ends with what to do. The file,
	// the statement, the reason and what had been committed are all in it, so
	// they are not repeated after it as data, where they would bury that ending.
	// The one thing passed besides is the failure's own code, SQLite's or the
	// file system's, where it has one, because the sentence does not have it.
	function halt(detail: Omit<MigrationErrorDetail, 'committed'>): never {
		const error = new MigrationError({ ...detail, committed: applied });
		const code = (detail.cause as { code?: unknown } | null | undefined)?.code;
		log.critical(error.message, typeof code === 'string' ? { code } : undefined);
		throw error;
	}

	// Before the first transaction: see ensureSystemLogsTable.
	ensureSystemLogsTable();

	if (database.inTransaction) {
		// Every guarantee below is "this commits or rolls back as one". Inside
		// someone else's transaction none of them would hold.
		halt({ stage: 'start-up', reason: 'a transaction is already open on this connection' });
	}

	const recordedNames = () =>
		(database.prepare('SELECT hash FROM __drizzle_migrations ORDER BY id').all() as { hash: string }[]).map(
			(r) => r.hash
		);

	try {
		database.exec(`
			CREATE TABLE IF NOT EXISTS __drizzle_migrations (
				id INTEGER PRIMARY KEY AUTOINCREMENT,
				hash TEXT NOT NULL UNIQUE,
				created_at TEXT DEFAULT (datetime('now'))
			)
		`);
	} catch (err) {
		halt({ stage: 'creating the migration record', reason: messageOf(err), cause: err });
	}

	// Must precede the migration loop: 0042 indexes columns this guarantees.
	let converted: number | null = null;
	try {
		converted = repairLegacyCardDependencies(database);
	} catch (err) {
		halt({ stage: 'card_dependencies repair', reason: messageOf(err), cause: err });
	}
	if (converted !== null) {
		log.warn(`card_dependencies converted from the legacy shape — ${converted} row(s) preserved`);
	}

	let files: string[] = [];
	try {
		files = listMigrationFiles(migrationsDir);
	} catch (err) {
		halt({ stage: 'reading the migrations directory', reason: messageOf(err), cause: err });
	}

	let recorded = new Set<string>();
	try {
		recorded = new Set(recordedNames());
	} catch (err) {
		halt({ stage: 'reading the migration record', reason: messageOf(err), cause: err });
	}

	for (const file of files) {
		if (recorded.has(file)) continue;

		let blocks: Block[] = [];
		try {
			blocks = splitBlocks(readFileSync(join(migrationsDir, file), 'utf-8'));
		} catch (err) {
			halt({ file, refused: true, reason: `it could not be read: ${messageOf(err)}`, cause: err });
		}

		// A file with nothing to run is a mistake, not a migration: recorded, it
		// could never be given its SQL afterwards, because a recorded name is
		// never run again.
		if (!blocks.some((block) => block.statements.length > 0)) {
			halt({ file, refused: true, reason: 'it contains no SQL statement' });
		}

		const unsafe = findUnsafeStatement(blocks);
		if (unsafe) {
			halt({
				file,
				statementNumber: unsafe.index + 1,
				statementCount: blocks.length,
				statement: firstLine(unsafe.statement.text),
				refused: true,
				reason: `it contains a ${unsafe.statement.keyword} statement, which the runner cannot honour inside the file's transaction`
			});
		}

		const tolerant = tolerantFiles.has(file);
		const skipped: ToleratedError[] = [];

		const applyFile = database.transaction(() => {
			blocks.forEach((block, index) => {
				try {
					database.exec(block.sql);
				} catch (err) {
					const message = messageOf(err);
					if (tolerant && isAlreadyApplied(message) && database.inTransaction) {
						// SQLite stops a block at its first error. Where the block is
						// one statement, skipping it skips nothing else. Where it is
						// several, the ones after the failure have not run either, and
						// recording the file would leave them never run.
						if (block.statements.length === 1) {
							skipped.push({ file, statement: index + 1, of: blocks.length, message });
							return;
						}
						throw new StatementFailure(
							index,
							`${message} (not skipped as already applied: the block holds ${block.statements.length} statements, and the rest of them would have been skipped with it)`,
							err
						);
					}
					throw new StatementFailure(index, message, err);
				}
			});
			try {
				database.prepare('INSERT INTO __drizzle_migrations (hash) VALUES (?)').run(file);
			} catch (err) {
				throw new RecordFailure(messageOf(err), { cause: err });
			}
		});

		try {
			applyFile.immediate();
		} catch (err) {
			// The transaction has been rolled back by the time control is here.
			if (err instanceof StatementFailure) {
				// Outside the tolerant files this is a halt, and the usual cause
				// is not a fault in the file: it was applied here once already.
				const appliedBefore = !tolerant && isAlreadyApplied(err.message);
				halt({
					file,
					statementNumber: err.index + 1,
					statementCount: blocks.length,
					statement: firstLine(blocks[err.index].sql),
					blockOf: blocks[err.index].statements.length,
					reason: err.message,
					hint: appliedBefore
						? 'This usually means the file was applied here before and its record in __drizzle_migrations has ' +
							'been lost, which is what Import Backup does when it is used under an older image. If what the ' +
							'file adds is already in the database, record the file ' +
							`(INSERT INTO __drizzle_migrations (hash) VALUES ('${file.replace(/'/g, "''")}');) and start again: ` +
							'see docs/deployment.md, "Going Back to the Previous Image".'
						: undefined,
					cause: err.cause
				});
			}
			if (err instanceof RecordFailure) {
				halt({
					file,
					reason: `its statements succeeded, but its name could not be written to __drizzle_migrations: ${err.message}`,
					outcome:
						'A file is applied and recorded together or not at all, so its statements were rolled back with ' +
						'the record of it, and it is not recorded.',
					cause: err.cause
				});
			}
			// Neither a statement nor the record: what is left is the BEGIN or the COMMIT.
			halt({ file, reason: `its transaction could not be started or committed: ${messageOf(err)}`, cause: err });
		}

		applied.push(file);
		tolerated.push(...skipped);
		for (const skip of skipped) {
			log.warn(`Skipped in ${file}, statement ${skip.statement} of ${skip.of} (already applied): ${skip.message}`);
		}
		log.warn(`Applied migration: ${file}`);
	}

	// A name recorded with no file behind it. Every name this run recorded has
	// a file, so these are the names that were there before it began, and the
	// record does not have to be read a second time to find them.
	//
	// It must still start: going back to the previous image is the way out of a
	// bad deploy, and this is what the previous image finds. But it must not
	// reshape anything. Reconciliation brings tables to the shape *this* build's
	// model has, and if the database is the newer of the two, a later build may
	// have changed one of the six on purpose. So it is not attempted at all, the
	// tables are not even compared, and one line says both things: what was
	// found and what was therefore not done. The schema check below reports
	// whatever differs, as it always does.
	const onDisk = new Set(files);
	const missingFromDisk = [...recorded].filter((name) => !onDisk.has(name));
	let reconciliationSkipped: string | null = null;

	// After the loop, not before it: on a new database none of these tables
	// exists until the files have run.
	let reconciled: Reconciliation = { rebuilt: [], leftAlone: [], detached: [] };
	if (missingFromDisk.length > 0) {
		reconciliationSkipped =
			`the database records ${missingFromDisk.length} migration(s) this build has no file for ` +
			`(${missingFromDisk.join(', ')}), so it may be newer than this build`;
		log.error(
			`${missingFromDisk.length} migration(s) are recorded as applied but have no file in ${migrationsDir}: ` +
				`${missingFromDisk.join(', ')}. Either this build is older than the database, ` +
				'or a migration file has been renamed or removed. Schema reconciliation was skipped because of it: ' +
				`none of ${RECONCILED_TABLES.join(', ')} was compared or reshaped, and no timestamp was converted to ` +
				'the stored form, since a build must not reshape a database that may be newer than it is. ' +
				'Starting anyway. This is expected after going back to the ' +
				'previous image on purpose, and is reported at every start until the newer image is started again. ' +
				'If that is not what was done, this image is missing a migration file: build it again from a ' +
				'complete checkout.'
		);
	} else {
		try {
			reconciled = reconcileSchema(database, expectedSchema);
		} catch (err) {
			// Foreign keys that could not be switched back on, which says for
			// itself how the halt must end. Nothing else is expected to throw, and
			// if something does, nothing is claimed about what it left behind.
			halt({
				stage: 'schema reconciliation',
				reason: messageOf(err),
				next: err instanceof ForeignKeysStayedOff ? err.next : AFTER_THE_UNEXPECTED,
				cause: err
			});
		}
	}

	// Everything below is logged with the rebuild's transaction over, whichever
	// way it ended. The first two kinds of line are about one that was
	// committed. A line about a table left alone is about one that was never
	// begun, or was rolled back, and it can follow a committed one all the
	// same: one failure, a table's own values, is retried without that table,
	// and the retry may be committed.
	//
	// What differed is in each line because it is what the rebuild changed. A
	// foreign key that the table had and the model has not is gone, and a model
	// that is wrong takes a constraint away just as quietly as one that is
	// right: this line is where that can be seen.
	for (const table of reconciled.rebuilt) {
		const defaulted = table.defaulted
			.map((d) => `; ${d.rows} NULL ${d.column} value(s) became the default, ${d.value}`)
			.join('');
		log.warn(
			`${table.table} rebuilt in the model's shape — ${table.rows} row(s) carried across${defaulted}. ` +
				`What differed, and no longer does: ${table.differences.join('; ')}`
		);
	}
	for (const board of reconciled.detached) {
		log.warn(
			`Sub-board ${board.id} (${board.name}) detached while boards was rebuilt: its card, ${board.parentCardId}, ` +
				'no longer exists, so its parent_card_id was cleared and it is now an ordinary board. Nothing was deleted.'
		);
	}

	// A table left alone is in the shape it has been running in, so this does
	// not stop start-up. It is an ERROR all the same, at this start and at every
	// one after it until the cause is dealt with, and it says what to do.
	for (const left of reconciled.leftAlone.filter((l) => l.stage !== 'rebuild')) {
		log.error(leftAloneLine([left.table], left));
	}
	// The tables of a rebuild that did not complete share one transaction and
	// one reason, so they share one line. A table that was left out of the
	// rebuild for its own rows has a reason of its own, and a line of its own.
	const undone = new Map<string, TableLeftAlone[]>();
	for (const left of reconciled.leftAlone.filter((l) => l.stage === 'rebuild')) {
		const sameReason = `${left.reason}\n${left.whatToDo}`;
		undone.set(sameReason, [...(undone.get(sameReason) ?? []), left]);
	}
	for (const together of undone.values()) {
		log.error(
			leftAloneLine(
				together.map((l) => l.table),
				together[0]
			)
		);
	}

	let backfilled: Backfill = {
		firstCompletedAt: 0,
		accessTokens: 0,
		releasedFromMilestones: 0,
		released: [],
		unfiledBoards: 0,
		unfiled: []
	};
	try {
		backfilled = runBackfills(database);
	} catch (err) {
		halt({
			stage: 'backfilling cards.first_completed_at, task_requests.access_token, cards.milestone_id and boards.category_id',
			reason: messageOf(err),
			cause: err
		});
	}
	if (backfilled.firstCompletedAt > 0 || backfilled.accessTokens > 0) {
		log.warn(
			`Backfilled first_completed_at on ${backfilled.firstCompletedAt} card(s) and access_token on ${backfilled.accessTokens} request(s)`
		);
	}
	// After a restore of an older backup, or a return from an older image, this
	// can find cards. At any other start it finds none, and a count means some
	// write still puts a card in a milestone of another board (card 2179).
	if (backfilled.releasedFromMilestones > 0) {
		log.warn(
			`Took ${backfilled.releasedFromMilestones} card(s) out of a milestone that belongs to another board: ` +
				releasedCardsList(backfilled)
		);
	}
	// The first start of the image with card 2293 clears what production holds,
	// and a restore can bring more. At any other start it finds none, and a
	// count means some write still leaves a board under a deleted grouping.
	if (backfilled.unfiledBoards > 0) {
		log.warn(
			`Took ${backfilled.unfiledBoards} board(s) out of a grouping that no longer exists: ` + unfiledBoardsList(backfilled)
		);
	}

	// Every timestamp in one form (card 2095). Not on a database that may be
	// newer than this build, for the reason reconciliation is not: a later
	// build may have chosen otherwise. The ERROR line above says so.
	let timestamps: TimestampNormalisation | null = null;
	if (missingFromDisk.length === 0) {
		timestamps = normaliseTimestamps(database);
		reportTimestamps(timestamps);
	}

	// Whatever still differs from the model is reported and nothing more. It is
	// not rebuilt, because only the six reconciled tables ever are, and it does
	// not stop start-up, because an older build started against a newer database
	// differs in exactly this way and has to start. On a database that matches,
	// this says nothing at all.
	//
	// A comparison that could not be made is not a difference, and is not
	// reported as one: it has a line of its own, which says whether it was the
	// model or the database that could not be read. It is in the report all the
	// same, where a difference would be.
	let differences: string[] = [];
	let uncompared: string | null = null;
	try {
		expectedModel(expectedSchema);
		try {
			differences = schemaDifferences(database, expectedSchema);
		} catch (err) {
			differences = [`the comparison could not be made: ${messageOf(err)}`];
			uncompared =
				`The database could not be compared with the model: ${messageOf(err)}. Nothing was changed and ` +
				'start-up continues. This is a failure to read the database, not a difference found in it. Check the ' +
				`disk and the database file. ${UNTIL_DEALT_WITH}`;
		}
	} catch (err) {
		differences = [`the comparison could not be made: ${messageOf(err)}`];
		uncompared =
			`The database could not be compared with the model, because the model could not be read: ${messageOf(err)}. ` +
			`Nothing was changed and start-up continues. ${THE_MODEL_IS_UNREADABLE} ${UNTIL_DEALT_WITH}`;
	}
	if (uncompared !== null) {
		log.error(uncompared);
	} else if (differences.length > 0) {
		// A table the model has never heard of stays in this line for good unless
		// somebody ends it, so the line says how, for the case where that is safe.
		const strays = differences
			.filter((difference) => difference.endsWith(NOT_IN_THE_MODEL))
			.map((difference) => difference.slice(0, -NOT_IN_THE_MODEL.length));
		const leftovers =
			strays.length === 0
				? ''
				: ' A table that is in the database and not in the model stays in this line until it is gone. If it ' +
					'is a leftover, which is usually a __new_<name> table that drizzle-kit push left behind, check that ' +
					'nothing in it is wanted (SELECT COUNT(*) FROM "<table>";) and drop it (DROP TABLE "<table>";). ' +
					`Here: ${strays.join(', ')}.`;
		// No data after the sentence: it would only say the same again.
		log.error(
			`The database differs from the model in ${differences.length} place(s): ${differences.join('; ')}. ` +
				'Nothing was changed for these and start-up continues. That is expected when an older build is ' +
				`started against a newer database, and when one of ${RECONCILED_TABLES.join(', ')} was left in the ` +
				'shape it has, which has a line of its own above; otherwise the model has a change that no migration ' +
				`makes, or the database was changed outside the migrations.${leftovers}`
		);
	}

	return {
		applied,
		tolerated,
		rebuilt: reconciled.rebuilt,
		leftAlone: reconciled.leftAlone,
		detachedSubBoards: reconciled.detached,
		reconciliationSkipped,
		backfilled,
		timestamps,
		schemaDifferences: differences,
		missingFromDisk
	};
}

/**
 * Say what `normaliseTimestamps` did at a start, with its transaction over.
 *
 * - Values converted: one WARN line naming each column and its count. It is
 *   expected once, at the first start of the build that brings card 2095, and
 *   after an import; at any other start it means something still writes
 *   another form.
 * - Values it could not read: one ERROR line, at every start until they are
 *   corrected or cleared.
 * - A failure: one ERROR line. Nothing was changed, and the next start tries
 *   again.
 */
function reportTimestamps(done: TimestampNormalisation): void {
	if (done.failed !== null) {
		log.error(
			`Timestamps could not be brought to the stored form (YYYY-MM-DD HH:MM:SS, UTC), and none was changed: ` +
				`${done.failed}. Start-up continues on the values as they are, and the next start tries again.`
		);
		return;
	}
	const converted = totalConverted(done.converted);
	if (converted > 0) {
		log.warn(
			`${converted} timestamp(s) converted to the stored form (YYYY-MM-DD HH:MM:SS, UTC), each still naming the ` +
				`same moment to the second: ${convertedList(done.converted)}. Expected once after the update that ` +
				'brings card 2095, and after an import of an older backup; at any other start something still writes ' +
				'another form.'
		);
	}
	if (Object.keys(done.unreadable).length > 0) {
		log.error(
			`Timestamp column(s) hold values in no form this build can read, and they were left as they are: ` +
				`${unreadableList(done.unreadable)}. Anything that reads them, a report or a comparison with now, ` +
				'reads them as text. Correct each one to YYYY-MM-DD HH:MM:SS in UTC, or clear it where the column ' +
				'allows NULL. This is reported at every start until then.'
		);
	}
}
