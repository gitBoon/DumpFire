/**
 * The migration runner, and the databases it leaves behind.
 *
 * Every other suite uses the application's own connection, which
 * `tests/setup.ts` has already migrated. That proves a new database can be
 * built and nothing more. These tests drive the runner against separate
 * in-memory databases and temporary directories of `.sql` files, so they can
 * ask what it does when a migration fails, what it does to a database in the
 * shape production has, and whether what it leaves is what `schema.ts` says.
 *
 * Every database a test here builds is in memory. `dumpfire.db` holds real
 * data and nothing here goes near it. A few tests call the restore route, which
 * writes its upload to a file before reading it; each of those points the route
 * at a temporary directory first, and empties the application's own in-memory
 * database again afterwards.
 */
import { afterEach, beforeAll, describe, expect, it, vi } from 'vitest';
import Database from 'better-sqlite3';
import { execFileSync } from 'node:child_process';
import { existsSync, mkdirSync, mkdtempSync, readFileSync, readdirSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { sqlite } from '$lib/server/db';
import { EXPECTED_SCHEMA } from '$lib/server/db/expected-schema';
import {
	MigrationError,
	RECONCILED_TABLES,
	TOLERANT_FILES,
	leadingKeywords,
	reconcileSchema,
	runMigrations,
	schemaDifferences,
	scratchNameOf,
	scratchTableStatement,
	sqlStatements,
	type MigrationOptions,
	type MigrationReport
} from '$lib/server/db/migrate';
import { RestoreError, restoreFromBackup } from '$lib/server/db/restore';
import { generateBackupData } from '$lib/server/backup';
import { buildActivityReport } from '$lib/server/activity-report';
import { api, routeMethods } from './helpers/api';
import { makeBoard, makeCard, makeSession, makeUser, resetDb } from './helpers/fixtures';
import { afterEachTimestampCheck } from './helpers/timestamps';
import production from './fixtures/production-schema-2026-10-12.json';
import { compare, stateOf, type Findings, type State } from './rehearsal/compare';
import { ONE_OFFS, ONE_OFFS_FROM, type OneOff } from './rehearsal/one-offs';

const ROOT = process.cwd();
const REAL_MIGRATIONS = join(ROOT, 'drizzle');
const realFiles = readdirSync(REAL_MIGRATIONS)
	.filter((f) => f.endsWith('.sql'))
	.sort();

/** How every halt ends but one (card 2006, R8). */
const WHAT_NEXT =
	'The database is as it was before the failing step. Fix the cause and start again, or start the previous image.';

/*
 * How the one other halt ends: foreign keys that could not be switched back on
 * after a rebuild. `WHAT_NEXT` would be false of it once the rebuild has been
 * committed, so it has endings of its own, by what had happened.
 */
const AFTER_A_COMMITTED_REBUILD =
	'The rebuild was committed before this and is not undone, so the database is not as it was: the tables named ' +
	"as rebuilt are in the model's shape and stay so. Nothing needs restoring. Start again: a new process opens a " +
	'new connection with foreign keys on, and has nothing left to do for those tables. If it stops here again, ' +
	'start the previous image.';
const AFTER_NO_REBUILD =
	'No table was changed. Start again: a new process opens a new connection with foreign keys on, the rebuild is ' +
	'attempted again, and what stops it, if anything does, is reported. If it stops here again, start the previous image.';

/** How every line about something that was left as it was ends (card 2006, decision 12). None of them is a halt. */
const UNTIL_DEALT_WITH = 'It is reported at every start until the cause is dealt with.';

/** The line for one table that differs from the model and was turned away by a guard. */
const leftAloneLine = (table: string, reason: string, whatToDo: string) =>
	`[ERROR] [DB] ${table} was left in the shape it has, which is not the model's: ${reason}. Nothing in it was ` +
	`changed, and the application runs on that shape as it has until now. ${whatToDo} ${UNTIL_DEALT_WITH}`;

/** The one line for the tables of a rebuild that did not complete, or for the one table of it. */
const notRebuiltLine = (tables: string[], reason: string, whatToDo: string) => {
	const one = tables.length === 1;
	return (
		`[ERROR] [DB] ${tables.join(', ')} ` +
		`${one ? 'was left in the shape it has, which is' : 'were left in the shapes they have, which are'} ` +
		`not the model's: ${reason}. Nothing in ${one ? 'it' : 'them'} was changed, and the application runs on ` +
		`${one ? 'that shape' : 'those shapes'} as it has until now. A rebuild switches foreign keys off while it ` +
		`works; they have been read back as on. ${whatToDo} ${UNTIL_DEALT_WITH}`
	);
};

/** The line for a table that could not be compared with the model at all. */
const notComparedLine = (table: string, reason: string, whatToDo: string) =>
	`[ERROR] [DB] ${table} was not compared with the model: ${reason}. Nothing in it was changed, and the application ` +
	`runs on the table as it has until now. ${whatToDo} ${UNTIL_DEALT_WITH}`;

/* What to do, as the lines above say it. Each is checked in full once, where it is first used. */
const A_FAULT_IN_THE_REBUILD =
	'This is a fault in the rebuild, not in the data: one of its own checks failed, and everything it had done was undone. Report this line.';
const REFUSED_BY_SQLITE =
	"SQLite refused one of the rebuild's statements, or its commit, for the reason it gave. If that names something in " +
	'the database, such as a view that no longer works, put that right and restart; if it does not, report this line.';
const VALUES_OF_ANOTHER_TYPE =
	"The table's column and the model's have different types, and SQLite stores such a value differently in " +
	"the model's. A rebuild must not change a value, so it will not do this one: the table needs a " +
	'migration that says what each value is to become. Report this line.';
const START_AGAIN_AND_REPORT = 'Nothing in start-up should cause this. Restart, and report this line if it appears again.';
const A_FAILURE_TO_READ =
	'This is a failure to read the table, not a difference found in it. Check the disk and the database file.';
const THE_MODEL_IS_UNREADABLE =
	'This is a fault in this build, not in the database: its copy of the model (expected-schema.ts) does not run ' +
	'as SQL. Regenerate it (npm run schema:expected), build the image again and start that, or start the previous image.';

// ─── Helpers ─────────────────────────────────────────────────────────────────

const opened: Database.Database[] = [];
const tempDirs: string[] = [];
const logLevel = process.env.LOG_LEVEL;

afterEach(() => {
	for (const database of opened.splice(0)) database.close();
	for (const dir of tempDirs.splice(0)) rmSync(dir, { recursive: true, force: true });
	vi.restoreAllMocks();
	if (logLevel === undefined) delete process.env.LOG_LEVEL;
	else process.env.LOG_LEVEL = logLevel;
});

/** A separate, empty in-memory database with foreign keys on, as the application's has. */
function memoryDb(): Database.Database {
	const database = new Database(':memory:');
	database.pragma('foreign_keys = ON');
	opened.push(database);
	return database;
}

/** A temporary directory holding the given migration files. */
function migrationsDir(files: Record<string, string>): string {
	const dir = mkdtempSync(join(tmpdir(), 'dumpfire-migrations-'));
	tempDirs.push(dir);
	for (const [name, sql] of Object.entries(files)) writeFileSync(join(dir, name), sql);
	return dir;
}

/** Statements joined the way drizzle-kit writes them. */
const statements = (...sql: string[]) => sql.join('\n--> statement-breakpoint\n');

/**
 * Run the runner expecting it to halt, and return what it threw and what it
 * logged. The logger prints errors to the console; they are captured here
 * rather than printed, so a passing run stays quiet.
 */
function halted(
	options: MigrationOptions,
	ending: string = WHAT_NEXT
): { error: MigrationError; logged: string[] } {
	const printed = vi.spyOn(console, 'error').mockImplementation(() => {});
	try {
		runMigrations(options);
	} catch (error) {
		if (!(error instanceof MigrationError)) throw error;
		// Every halt, whatever caused it, says what state the database is in and
		// what to do next. Checked here so that no halt in this file escapes it.
		// All but one end the same way; a test of that one says which of its
		// endings it expects.
		expect(error.message.endsWith(` ${ending}`)).toBe(true);
		const logged = printed.mock.calls.map((call) => String(call[0]));
		// The sentence ends the line, or all but: nothing follows it except the
		// failure's own code, where it has one. The parts of the sentence are not
		// said a second time as data, which would bury what to do.
		const line = logged.find((l) => l.includes('[CRITICAL] [DB]')) ?? '';
		expect(line).toMatch(/^\[[^\]]+\] \[CRITICAL\] \[DB\] /);
		expect(line.replace(/^\[[^\]]+\] \[CRITICAL\] \[DB\] /, '').replace(/ \| \{"code":"[A-Z0-9_]+"\}$/, '')).toBe(
			error.message
		);
		return { error, logged };
	}
	throw new Error('Expected the runner to halt, but it returned');
}

/**
 * Run the runner over made-up migration files.
 *
 * A database built from them is nothing like the model, and the runner says so
 * at ERROR on every run. That line is expected in these tests and is kept off
 * the console; the report is returned as usual.
 */
function synthetic(options: MigrationOptions): MigrationReport {
	const printed = vi.spyOn(console, 'error').mockImplementation(() => {});
	try {
		return runMigrations(options);
	} finally {
		printed.mockRestore();
	}
}

/**
 * Run the runner where something is in its way that must not stop it: it has
 * to return, and what it logged at ERROR comes back with its report, without
 * the timestamp and off the console.
 *
 * Every test that uses this also checks, here, that none of those lines was
 * written while a transaction was open. A line written inside one is rolled
 * back with it when the work fails, which is exactly when it is wanted.
 */
function reporting(options: MigrationOptions & { database: Database.Database }): {
	report: MigrationReport;
	errors: string[];
} {
	const errors: string[] = [];
	const insideATransaction: string[] = [];
	const printed = vi.spyOn(console, 'error').mockImplementation((line) => {
		errors.push(String(line).replace(/^\[[^\]]+\] /, ''));
		if (options.database.inTransaction) insideATransaction.push(String(line));
	});
	try {
		const report = runMigrations(options);
		expect(insideATransaction).toEqual([]);
		// "rebuilt" is the word the lines for a table that was rebuilt are found
		// by. A line about one that was not must not turn up in that search.
		for (const line of errors) expect(line).not.toContain('rebuilt');
		// And none of them repeats itself as data after the sentence.
		for (const line of errors) expect(line).not.toContain(' | {');
		return { report, errors };
	} finally {
		printed.mockRestore();
	}
}

/** What the schema check says about one table, and about nothing else. */
const about = (table: string) => (difference: string) =>
	difference.startsWith(`${table}.`) || difference.startsWith(`${table}:`);

/** Every way one table differs from the model: what a rebuild of it is for, and what its log line lists. */
const differencesOf = (database: Database.Database, table: string, model?: readonly string[]) =>
	schemaDifferences(database, model).filter(about(table));

/** A model with no tables: nothing for the runner to bring any table to. */
const NO_MODEL: readonly string[] = Object.freeze([]);

/**
 * Apply migration files and stop there, as the runner did before card 2006.
 *
 * With an empty model none of the six reconciled tables has a shape to be
 * brought to, so the files are applied and recorded and nothing is rebuilt.
 * What is left is a database with every migration applied and its tables still
 * in whatever shape their history gave them.
 */
function applyFilesOnly(database: Database.Database, dir: string = REAL_MIGRATIONS): MigrationReport {
	return synthetic({ database, migrationsDir: dir, expectedSchema: NO_MODEL });
}

const tablesOf = (database: Database.Database) =>
	(
		database
			.prepare("SELECT name FROM sqlite_master WHERE type = 'table' ORDER BY name")
			.all() as { name: string }[]
	)
		.map((t) => t.name)
		.filter((name) => !name.startsWith('sqlite_'));

const recordedIn = (database: Database.Database) =>
	(database.prepare('SELECT hash FROM __drizzle_migrations ORDER BY id').all() as { hash: string }[]).map(
		(r) => r.hash
	);

const foreignKeysOn = (database: Database.Database) =>
	database.pragma('foreign_keys', { simple: true }) === 1;

const columnsOf = (database: Database.Database, table: string) =>
	(database.prepare(`PRAGMA table_info("${table}")`).all() as { name: string }[]).map((c) => c.name);

/**
 * Everything `sqlite_master` holds, root pages included. A table that has been
 * dropped and recreated has a new entry even if it looks the same, so two equal
 * readings mean nothing was rebuilt in between.
 */
const masterOf = (database: Database.Database) =>
	database.prepare('SELECT type, name, tbl_name, rootpage, sql FROM sqlite_master ORDER BY type, name').all();

/**
 * Every row of every table, `sqlite_sequence` (the id counters) included.
 *
 * Rows are compared as sets: a rebuilt table without an INTEGER PRIMARY KEY
 * gets new rowids, and with them a new order.
 */
function contentsOf(database: Database.Database): Record<string, string[]> {
	const names = (
		database.prepare("SELECT name FROM sqlite_master WHERE type = 'table' ORDER BY name").all() as { name: string }[]
	).map((t) => t.name);
	const contents: Record<string, string[]> = {};
	for (const name of names) {
		contents[name] = (database.prepare(`SELECT * FROM "${name}"`).all() as Record<string, unknown>[])
			// Keys sorted: a rebuilt table has the model's column order, not its old one.
			.map((row) => JSON.stringify(Object.fromEntries(Object.entries(row).sort(([a], [b]) => a.localeCompare(b)))))
			.sort();
	}
	return contents;
}

/** The id counter of one table, or null if it has none. */
const sequenceIn = (database: Database.Database, table: string) =>
	(
		database.prepare('SELECT MAX(seq) AS seq FROM sqlite_sequence WHERE name = ?').get(table) as {
			seq: number | null;
		}
	).seq;

/** The name of every index in the database, SQLite's own included. */
const indexesOf = (database: Database.Database) =>
	(database.prepare("SELECT name FROM sqlite_master WHERE type = 'index' ORDER BY name").all() as { name: string }[]).map(
		(index) => index.name
	);

/**
 * Every foreign key column that is the first column of no index, as
 * `table.column`, sorted.
 *
 * Deleting a row makes SQLite look up the rows that refer to it in each child
 * table, and with no index on the column each look-up reads the whole table
 * (card 2106). A primary key or a UNIQUE constraint counts, as SQLite indexes
 * it; so does an INTEGER PRIMARY KEY on its own, which is the rowid itself.
 */
function unindexedForeignKeys(database: Database.Database): string[] {
	const found = new Set<string>();
	for (const table of tablesOf(database)) {
		const quoted = `"${table.replaceAll('"', '""')}"`;
		const leading = new Set<string>();
		for (const index of database.prepare(`PRAGMA index_list(${quoted})`).all() as { name: string }[]) {
			const columns = database.prepare(`PRAGMA index_info("${index.name.replaceAll('"', '""')}")`).all() as {
				seqno: number;
				name: string | null;
			}[];
			const first = columns.find((column) => column.seqno === 0)?.name;
			if (first) leading.add(first);
		}
		const keyColumns = (database.prepare(`PRAGMA table_info(${quoted})`).all() as { name: string; type: string; pk: number }[]).filter(
			(column) => column.pk > 0
		);
		if (keyColumns.length === 1 && keyColumns[0].type.toUpperCase() === 'INTEGER') leading.add(keyColumns[0].name);

		for (const key of database.prepare(`PRAGMA foreign_key_list(${quoted})`).all() as { seq: number; from: string }[]) {
			if (key.seq === 0 && !leading.has(key.from)) found.add(`${table}.${key.from}`);
		}
	}
	return [...found].sort();
}

/** The file of card 2106: an index on each foreign key column that had none, and every session ended once. */
const FILE_0053 = '0053_index_foreign_keys_end_sessions.sql';

/** The indexes 0053 creates, read from the file itself. */
const INDEXES_0053 = [
	...readFileSync(join(REAL_MIGRATIONS, FILE_0053), 'utf-8').matchAll(
		/^CREATE INDEX IF NOT EXISTS `(\w+)` ON `(\w+)` \(`(\w+)`\);$/gm
	)
].map(([, name, table, column]) => ({ name, table, column }));

/**
 * The file of the P6 review: activity_log's index on user_id made one on
 * user_id and created_at, and every unused invite ended once.
 */
const FILE_0054 = '0054_index_user_time_end_unused_invites.sql';

/** The file of card 2158: every task request given a new link, once. */
const FILE_0055 = '0055_replace_request_links.sql';

/** The file of card 2168: who last set each webhook's address or secret. */
const FILE_0056 = '0056_add_webhook_set_by.sql';

/**
 * The indexes the model declares that a database from before 0053 lacks:
 * 0053's 39, with 0054's index on user_id and created_at in place of 0053's on
 * user_id alone.
 */
const INDEXES_FROM_0053 = INDEXES_0053.map((index) =>
	index.name === 'idx_activity_log_user_id'
		? { name: 'idx_activity_log_user_id_created_at', table: 'activity_log', column: 'user_id, created_at' }
		: index
);

/**
 * A database with the structure production had on 2026-10-12: every table and
 * index as `sqlite_master` reported it, and the 55 migration files it had
 * recorded. No rows.
 *
 * Five of the six reconciled tables are in an older shape here: `categories`
 * (`board_id NOT NULL`, `ON DELETE CASCADE`), `columns` (`wip_limit`
 * nullable), and `settings`, `user_xp` and `invite_tokens` (a `TEXT PRIMARY
 * KEY` with no `NOT NULL`). `boards` already has the model's shape.
 */
function productionDatabase(): Database.Database {
	const database = memoryDb();
	for (const object of production.schema.filter((o) => o.type === 'table')) database.exec(object.sql);
	for (const object of production.schema.filter((o) => o.type === 'index')) database.exec(object.sql);
	const record = database.prepare('INSERT INTO __drizzle_migrations (hash) VALUES (?)');
	for (const name of production.recorded) record.run(name);
	return database;
}

/**
 * A directory holding the migrations as they were before card 2006.
 *
 * The card corrected three statements in the two `0001` files. Put back, they
 * give a new database `boards` with no foreign key on `parent_card_id` and no
 * `ON DELETE` on `created_by`, and `categories` in its older shape: what any
 * database created from the repository before the card has. Each replacement
 * must find its text exactly once, so this fails loudly if the files change.
 */
function preCardMigrations(): string {
	const corrected: Record<string, [string, string][]> = {
		'0001_add_categories.sql': [
			['\t`board_id` integer,\n', '\t`board_id` integer NOT NULL,\n'],
			[
				'FOREIGN KEY (`board_id`) REFERENCES `boards`(`id`) ON UPDATE no action ON DELETE set null',
				'FOREIGN KEY (`board_id`) REFERENCES `boards`(`id`) ON UPDATE no action ON DELETE cascade'
			]
		],
		'0001_dear_pandemic.sql': [
			[
				'ALTER TABLE `boards` ADD `parent_card_id` integer REFERENCES cards(id) ON DELETE CASCADE;',
				'ALTER TABLE `boards` ADD `parent_card_id` integer;'
			],
			[
				'ALTER TABLE `boards` ADD `created_by` integer REFERENCES users(id) ON DELETE SET NULL;',
				'ALTER TABLE `boards` ADD `created_by` integer REFERENCES users(id);'
			]
		]
	};

	const files: Record<string, string> = {};
	// 0052 is the card's own file, and 0053 (card 2106) came after it; a
	// database from before the card never ran either.
	for (const file of realFiles.filter((f) => f < '0052_drop_time_entries.sql')) {
		let sql = readFileSync(join(REAL_MIGRATIONS, file), 'utf-8').replace(/\r\n/g, '\n');
		for (const [now, before] of corrected[file] ?? []) {
			expect(sql.split(now)).toHaveLength(2);
			sql = sql.replace(now, before);
		}
		files[file] = sql;
	}
	return migrationsDir(files);
}

/** A database built by the migrations as they were before card 2006. No rows. */
function preCardDatabase(): Database.Database {
	const database = memoryDb();
	applyFilesOnly(database, preCardMigrations());
	return database;
}

/**
 * Rows in each of the six reconciled tables, and in the tables that refer to
 * them.
 *
 *   boards         1 and 2, each created by a user; 3 is a sub-board of card 1
 *   columns        1 and 2 on board 1, 4 on board 2
 *   categories     1 and 2 on board 1, 5 on board 2
 *   cards          1, 2 and 5 on board 1, 3 and 4 on board 2; four categorised
 *   settings, user_xp, invite_tokens   two rows each
 *
 * In `boards`, `columns` and `categories` a row has been created and deleted,
 * so each id counter is ahead of the highest id in use. An id is never reused,
 * and a rebuild that forgot the counter would reuse one.
 */
function seed(database: Database.Database): void {
	database.exec(`
		INSERT INTO users (id, username, email, password_hash) VALUES
			(1, 'ann', 'ann@example.test', 'x'),
			(2, 'bob', 'bob@example.test', 'x');
		INSERT INTO boards (id, name, created_by) VALUES (1, 'A', 1), (2, 'B', 2), (3, 'Sub', 1), (8, 'Deleted', 1);
		DELETE FROM boards WHERE id = 8;
		INSERT INTO columns (id, board_id, title, wip_limit) VALUES
			(1, 1, 'To Do', 0),
			(2, 1, 'Doing', 3),
			(4, 2, 'To Do', 0),
			(7, 2, 'Deleted', 0);
		DELETE FROM columns WHERE id = 7;
		INSERT INTO categories (id, board_id, name, color) VALUES
			(1, 1, 'Bug', '#ff0000'),
			(2, 1, 'Feature', '#00ff00'),
			(5, 2, 'Chore', '#0000ff'),
			(9, 2, 'Deleted', '#000000');
		DELETE FROM categories WHERE id = 9;
		INSERT INTO cards (id, column_id, title, category_id) VALUES
			(1, 1, 'One', 1),
			(2, 1, 'Two', 2),
			(3, 4, 'Three', 5),
			(4, 4, 'Four', NULL),
			(5, 2, 'Five', 1);
		UPDATE boards SET parent_card_id = 1 WHERE id = 3;
		INSERT INTO labels (id, board_id, name) VALUES (1, 1, 'urgent'), (2, 2, 'later');
		INSERT INTO board_members (board_id, user_id, role) VALUES (1, 1, 'owner'), (2, 2, 'owner');
		INSERT INTO daily_snapshots (board_id, column_id, date, card_count) VALUES
			(1, 1, '2026-10-01', 2),
			(1, 2, '2026-10-01', 1),
			(2, 4, '2026-10-01', 2);
		INSERT INTO activity_log (board_id, card_id, user_id, action) VALUES (1, 1, 1, 'card.created');
		INSERT INTO settings (key, value) VALUES ('smtp_host', 'mail.example.test'), ('theme', 'dark');
		INSERT INTO user_xp (name, xp, emoji) VALUES ('ann', 120, '🔥'), ('bob', 5, '👤');
		INSERT INTO invite_tokens (token, user_id, expires_at, used) VALUES
			('token-for-ann', 1, '2026-12-01 00:00:00', 0),
			('token-for-bob', 2, '2026-12-01 00:00:00', 1);
	`);
}

/**
 * Production's structure with every migration applied, nothing yet rebuilt,
 * and rows in it. Two columns have no WIP limit recorded at all, which
 * production's nullable `wip_limit` allows and the model's does not.
 */
function productionWithRows(): Database.Database {
	const database = productionDatabase();
	applyFilesOnly(database);
	seed(database);
	database.exec('UPDATE columns SET wip_limit = NULL WHERE id IN (1, 4)');
	return database;
}

/**
 * A database from before card 2006 with every migration applied, nothing yet
 * rebuilt, and rows in it.
 */
function preCardWithRows(): Database.Database {
	const database = preCardDatabase();
	// 0052 and 0053, the files such a database has not had.
	applyFilesOnly(database);
	seed(database);
	return database;
}

/**
 * Make `database` do the work of a transaction and then fail, as it would if
 * the COMMIT could not be written: the work is rolled back and the caller gets
 * the error.
 */
function failAtCommit(database: Database.Database, message: string): void {
	const real = database.transaction.bind(database) as (fn: (...args: unknown[]) => unknown) => unknown;
	vi.spyOn(database, 'transaction').mockImplementation(((fn: (...args: unknown[]) => unknown) =>
		real((...args: unknown[]) => {
			fn(...args);
			throw new Error(message);
		})) as unknown as typeof database.transaction);
}

// ─── A migration that fails ──────────────────────────────────────────────────

describe('a migration that fails', () => {
	const failing = () =>
		migrationsDir({
			'0001_first.sql': 'CREATE TABLE first (id INTEGER PRIMARY KEY);',
			'0002_second.sql': statements(
				'CREATE TABLE second (id INTEGER PRIMARY KEY);',
				'INSERT INTO second (id) VALUES (1);',
				'-- the fault\nINSERT INTO deliberately_missing_table (id) VALUES (1);',
				'CREATE TABLE after_the_fault (id INTEGER PRIMARY KEY);'
			),
			'0003_third.sql': 'CREATE TABLE third (id INTEGER PRIMARY KEY);'
		});

	it('rolls its file back, records nothing, and runs no later file', () => {
		const database = memoryDb();

		halted({ database, migrationsDir: failing() });

		// `second` was created and filled before the fault, and is gone: the file
		// is all or nothing. `third` was never attempted.
		expect(tablesOf(database)).toEqual(['__drizzle_migrations', 'first']);
		expect(recordedIn(database)).toEqual(['0001_first.sql']);
		expect(database.inTransaction).toBe(false);
	});

	it('names the file, the statement and what SQLite said', () => {
		const { error, logged } = halted({ database: memoryDb(), migrationsDir: failing() });

		expect(error.file).toBe('0002_second.sql');
		expect(error.statementNumber).toBe(3);
		expect(error.statementCount).toBe(4);
		expect(error.statement).toBe('INSERT INTO deliberately_missing_table (id) VALUES (1);');
		expect(error.reason).toBe('no such table: deliberately_missing_table');
		expect(error.committed).toEqual(['0001_first.sql']);

		expect(error.message).toBe(
			'Migration 0002_second.sql failed at statement 3 of 4 ' +
				'(INSERT INTO deliberately_missing_table (id) VALUES (1);): ' +
				'no such table: deliberately_missing_table. ' +
				'The file was rolled back and not recorded. ' +
				'Committed earlier in this start: 0001_first.sql. ' +
				WHAT_NEXT
		);
		// The whole of it, once, and after it only what the sentence has not got:
		// the code SQLite gave the failure.
		expect(logged).toHaveLength(1);
		expect(logged[0].replace(/^\[[^\]]+\] /, '')).toBe(`[CRITICAL] [DB] ${error.message} | {"code":"SQLITE_ERROR"}`);
	});

	it('says "in this start", and that nothing had been committed, when the first file is the one that fails', () => {
		const { error } = halted({
			database: memoryDb(),
			migrationsDir: migrationsDir({ '0001_only.sql': 'SELECT * FROM deliberately_missing_table;' })
		});

		expect(error.message).toBe(
			'Migration 0001_only.sql failed at statement 1 of 1 (SELECT * FROM deliberately_missing_table;): ' +
				'no such table: deliberately_missing_table. The file was rolled back and not recorded. ' +
				`No migration was committed earlier in this start. ${WHAT_NEXT}`
		);
	});

	it('says that the statements succeeded and the record of them did not, when a file cannot be recorded', () => {
		// The file's own SQL is at fault here only in that it removes the table
		// its name is recorded in. Every statement in it succeeds; the INSERT
		// that records it is what fails. "Its SQL ran ... the file was rolled
		// back" read as a contradiction, and this is neither.
		const database = memoryDb();

		const { error } = halted({
			database,
			migrationsDir: migrationsDir({
				'0001_first.sql': 'CREATE TABLE first (id INTEGER PRIMARY KEY);',
				'0002_loses_the_record.sql': statements(
					'CREATE TABLE second (id INTEGER PRIMARY KEY);',
					'ALTER TABLE __drizzle_migrations RENAME TO somewhere_else;'
				)
			})
		});

		expect(error.message).toBe(
			'Migration 0002_loses_the_record.sql failed: its statements succeeded, but its name could not be written ' +
				'to __drizzle_migrations: no such table: __drizzle_migrations. A file is applied and recorded together ' +
				'or not at all, so its statements were rolled back with the record of it, and it is not recorded. ' +
				`Committed earlier in this start: 0001_first.sql. ${WHAT_NEXT}`
		);
		// As it says: `second` is gone, and the record is where it was.
		expect(tablesOf(database)).toEqual(['__drizzle_migrations', 'first']);
		expect(recordedIn(database)).toEqual(['0001_first.sql']);
	});

	it('is applied in full on the next start, once the file is put right', () => {
		const database = memoryDb();
		const dir = failing();
		halted({ database, migrationsDir: dir });

		writeFileSync(join(dir, '0002_second.sql'), 'CREATE TABLE second (id INTEGER PRIMARY KEY);');
		const report = synthetic({ database, migrationsDir: dir });

		expect(report.applied).toEqual(['0002_second.sql', '0003_third.sql']);
		expect(tablesOf(database)).toEqual(['__drizzle_migrations', 'first', 'second', 'third']);
	});

	it('says so, and not that the file could not be recorded, when the transaction itself fails', () => {
		// A BEGIN that cannot take the lock, or a COMMIT that cannot be written.
		// The file's SQL is not at fault and neither is the record of it.
		const database = memoryDb();
		failAtCommit(database, 'disk I/O error');

		const { error } = halted({ database, migrationsDir: failing() });

		expect(error.file).toBe('0001_first.sql');
		expect(error.reason).toBe('its transaction could not be started or committed: disk I/O error');
		expect(tablesOf(database)).toEqual(['__drizzle_migrations']);
		expect(recordedIn(database)).toEqual([]);
	});

	it('leaves a log entry that survives the rollback', () => {
		// The application's own connection this time, because that is where the
		// logger writes. A log row written inside the file's transaction would be
		// rolled back with it, and the failure would be the one thing not on record.
		const dir = migrationsDir({
			'9999_deliberate_failure.sql': 'SELECT * FROM deliberately_missing_table;'
		});

		halted({ migrationsDir: dir });

		const entry = sqlite
			.prepare("SELECT level, message FROM system_logs WHERE message LIKE '%9999_deliberate_failure.sql%'")
			.get() as { level: string; message: string } | undefined;
		expect(entry?.level).toBe('CRITICAL');
		expect(entry?.message).toContain('no such table: deliberately_missing_table');
		expect(recordedIn(sqlite)).not.toContain('9999_deliberate_failure.sql');
	});

	it('refuses to start inside a transaction somebody else opened', () => {
		const database = memoryDb();
		database.exec('BEGIN');

		const { error } = halted({ database, migrationsDir: failing() });

		expect(error.reason).toContain('transaction is already open');
		database.exec('ROLLBACK');
		expect(tablesOf(database)).toEqual([]);
	});
});

// ─── What the runner tolerates, and what it refuses ──────────────────────────

describe('errors the runner tolerates', () => {
	it('are exactly 25 on a new database, all in the 19 listed files', () => {
		const report = runMigrations({ database: memoryDb(), migrationsDir: REAL_MIGRATIONS });

		expect(report.applied).toEqual(realFiles);
		expect(report.tolerated.map((t) => `${t.file} #${t.statement}: ${t.message}`)).toEqual([
			'0001_dear_pandemic.sql #6: table `categories` already exists',
			'0001_dear_pandemic.sql #21: duplicate column name: category_id',
			'0002_add_subtasks.sql #1: table `subtasks` already exists',
			'0003_add_detail_fields.sql #1: duplicate column name: due_date',
			'0003_add_detail_fields.sql #2: duplicate column name: description',
			'0003_add_detail_fields.sql #3: duplicate column name: priority',
			'0003_add_detail_fields.sql #4: duplicate column name: color_tag',
			'0003_add_detail_fields.sql #5: duplicate column name: due_date',
			'0005_add_on_hold_note.sql #1: duplicate column name: on_hold_note',
			'0006_add_completed_at.sql #1: duplicate column name: completed_at',
			'0009_add_pinned_field.sql #1: duplicate column name: pinned',
			'0010_add_sub_boards.sql #1: duplicate column name: parent_card_id',
			'0011_add_user_management.sql #9: duplicate column name: created_by',
			'0011_add_user_management.sql #10: duplicate column name: user_id',
			'0012_add_public_boards.sql #1: duplicate column name: is_public',
			'0017_add_board_categories.sql #2: duplicate column name: show_add_card',
			'0022_add_notification_prefs.sql #1: duplicate column name: notification_prefs',
			'0023_add_wip_limits.sql #1: duplicate column name: wip_limit',
			'0025_add_card_archive.sql #1: duplicate column name: archived_at',
			'0026_add_card_covers.sql #1: duplicate column name: cover_url',
			'0031_add_card_recurrence.sql #1: duplicate column name: recurrence_rule',
			'0034_reports_email.sql #1: duplicate column name: recipients',
			'0035_add_report_period_days.sql #1: duplicate column name: period_days',
			'0036_add_webhooks_and_deps.sql #1: duplicate column name: next_recurrence',
			'0037_add_report_detail_level.sql #1: duplicate column name: detail_level'
		]);

		expect(TOLERANT_FILES).toHaveLength(19);
		expect([...new Set(report.tolerated.map((t) => t.file))]).toEqual([...TOLERANT_FILES]);
	});

	it('are a frozen list: nothing can be added to it at run time', () => {
		expect(Object.isFrozen(TOLERANT_FILES)).toBe(true);
	});

	const base = 'CREATE TABLE things (id INTEGER PRIMARY KEY, name TEXT);';

	it.each([
		['duplicate column', 'ALTER TABLE things ADD COLUMN name TEXT;', 'duplicate column name: name'],
		['already exists', 'CREATE TABLE things (id INTEGER PRIMARY KEY);', 'table things already exists']
	])('skips "%s" in a listed file and halts on it in any other', (_kind, repeat, message) => {
		// The same statement, under a name on the list and under one that is not.
		const listed = synthetic({
			database: memoryDb(),
			migrationsDir: migrationsDir({ '0001_base.sql': base, '0006_add_completed_at.sql': repeat })
		});
		expect(listed.tolerated).toEqual([
			{ file: '0006_add_completed_at.sql', statement: 1, of: 1, message }
		]);

		const database = memoryDb();
		const { error } = halted({
			database,
			migrationsDir: migrationsDir({ '0001_base.sql': base, '0099_new_work.sql': repeat })
		});
		expect(error.file).toBe('0099_new_work.sql');
		expect(error.reason).toBe(message);
		expect(recordedIn(database)).toEqual(['0001_base.sql']);

		// In a new file this error is rarely a fault in the file. It is what a
		// file says when it has run here before and the record of that is gone,
		// and the halt says so, with the statement that puts the record back.
		expect(error.message).toContain(
			`: ${message}. This usually means the file was applied here before and its record in __drizzle_migrations ` +
				'has been lost, which is what Import Backup does when it is used under an older image. If what the ' +
				'file adds is already in the database, record the file ' +
				"(INSERT INTO __drizzle_migrations (hash) VALUES ('0099_new_work.sql');) and start again: " +
				'see docs/deployment.md, "Going Back to the Previous Image". The file was rolled back and not recorded.'
		);
		// The statement it gives is the one that works.
		database.exec("INSERT INTO __drizzle_migrations (hash) VALUES ('0099_new_work.sql');");
		const after = synthetic({
			database,
			migrationsDir: migrationsDir({ '0001_base.sql': base, '0099_new_work.sql': repeat })
		});
		expect(after.applied).toEqual([]);
	});

	it('does not have the newest migration on the list', () => {
		// 0052 drops a table that a new database has and some older ones have
		// lost. It copes with that itself (IF EXISTS), not by being tolerated.
		expect(realFiles).toContain('0052_drop_time_entries.sql');
		expect(TOLERANT_FILES).not.toContain('0052_drop_time_entries.sql');
		expect(TOLERANT_FILES.filter((file) => file > '0037_add_report_detail_level.sql')).toEqual([]);
	});

	it('halts on any other error, even in a listed file', () => {
		const { error } = halted({
			database: memoryDb(),
			migrationsDir: migrationsDir({
				'0006_add_completed_at.sql': 'ALTER TABLE no_such_table ADD COLUMN name TEXT;'
			})
		});

		expect(error.file).toBe('0006_add_completed_at.sql');
		expect(error.reason).toBe('no such table: no_such_table');
		// Nothing about a lost record: that is said of the two errors it explains.
		expect(error.message).not.toContain('This usually means');
	});

	it('carries on with the rest of the file after a tolerated error', () => {
		const database = memoryDb();

		synthetic({
			database,
			migrationsDir: migrationsDir({
				'0001_base.sql': base,
				'0006_add_completed_at.sql': statements(
					'ALTER TABLE things ADD COLUMN name TEXT;',
					'ALTER TABLE things ADD COLUMN colour TEXT;'
				)
			})
		});

		expect(columnsOf(database, 'things')).toEqual(['id', 'name', 'colour']);
	});

	it('halts when the error is one of several statements in a block, rather than skip the rest of the block', () => {
		// The same two statements as above, with no breakpoint between them.
		// SQLite stops a block at its first error, so skipping the "duplicate
		// column" would skip the second statement too: `colour` would never be
		// added, and the file would be recorded as applied all the same.
		const database = memoryDb();

		const { error } = halted({
			database,
			migrationsDir: migrationsDir({
				'0001_base.sql': base,
				'0006_add_completed_at.sql':
					'ALTER TABLE things ADD COLUMN name TEXT;\nALTER TABLE things ADD COLUMN colour TEXT;'
			})
		});

		expect(error.file).toBe('0006_add_completed_at.sql');
		expect(error.statementNumber).toBe(1);
		expect(error.reason).toContain('duplicate column name: name');
		expect(error.reason).toContain('the block holds 2 statements');
		// Which of the two failed is not something SQLite says, and the message does not pretend to know.
		expect(error.message).toContain(
			'(one of the 2 statements in the block beginning: ALTER TABLE things ADD COLUMN name TEXT;)'
		);
		// A listed file is one whose statements are known to repeat. Its record is not what is missing.
		expect(error.message).not.toContain('This usually means');
		expect(recordedIn(database)).toEqual(['0001_base.sql']);
		expect(columnsOf(database, 'things')).toEqual(['id', 'name']);
	});
});

describe('statements the runner refuses', () => {
	it.each([
		'PRAGMA foreign_keys = OFF',
		'BEGIN',
		'COMMIT',
		'END',
		'ROLLBACK',
		'SAVEPOINT before_change',
		'RELEASE before_change',
		'VACUUM',
		"ATTACH DATABASE ':memory:' AS other",
		'DETACH DATABASE other'
	])('refuses a file containing %s, before any of it runs', (unsafe) => {
		const database = memoryDb();
		const keyword = unsafe.split(' ')[0];

		// Second statement of the second block, behind a comment: where a check
		// on how the file or the block begins would not find it.
		const { error } = halted({
			database,
			migrationsDir: migrationsDir({
				'0001_first.sql': 'CREATE TABLE first (id INTEGER PRIMARY KEY);',
				'0002_unsafe.sql': statements(
					'CREATE TABLE second (id INTEGER PRIMARY KEY);',
					`-- a comment first\nINSERT INTO second (id) VALUES (1);\n${unsafe.toLowerCase()};`
				)
			})
		});

		expect(error.file).toBe('0002_unsafe.sql');
		expect(error.statementNumber).toBe(2);
		expect(error.reason).toContain(`a ${keyword} statement`);
		expect(error.message).toContain('refused');
		// The statement it objects to, not the first line of the block that holds it.
		expect(error.statement).toBe(`${unsafe.toLowerCase()};`);
		// `second` would exist if the file had been started.
		expect(tablesOf(database)).toEqual(['__drizzle_migrations', 'first']);
		expect(recordedIn(database)).toEqual(['0001_first.sql']);
	});

	it('is not fooled by a keyword inside a comment, a string or a quoted name', () => {
		expect(
			leadingKeywords(`
				-- PRAGMA foreign_keys = OFF;
				/* BEGIN; COMMIT; */
				CREATE TABLE t (a TEXT DEFAULT 'VACUUM; it''s; ATTACH', "END; x" TEXT, \`ROLLBACK;\` TEXT, [DETACH;] TEXT);
				INSERT INTO t (a) VALUES ('RELEASE; SAVEPOINT');
			`)
		).toEqual(['CREATE', 'INSERT']);
	});

	it('reads a trigger as one statement, so its BEGIN and END are not refused', () => {
		const trigger = `
			CREATE TRIGGER things_audit AFTER INSERT ON things BEGIN
				INSERT INTO audit (note) VALUES (CASE WHEN new.name IS NULL THEN 'unnamed' ELSE new.name END);
				UPDATE things SET name = 'END' WHERE id = new.id AND name IS NULL;
			END;`;
		expect(leadingKeywords(`${trigger} COMMIT;`)).toEqual(['CREATE', 'COMMIT']);

		const database = memoryDb();
		synthetic({
			database,
			migrationsDir: migrationsDir({
				'0001_trigger.sql': statements(
					'CREATE TABLE things (id INTEGER PRIMARY KEY, name TEXT);\nCREATE TABLE audit (note TEXT);',
					trigger,
					"INSERT INTO things (name) VALUES ('first');"
				)
			})
		});
		expect(database.prepare('SELECT note FROM audit').all()).toEqual([{ note: 'first' }]);
	});

	it('reads a trigger as one statement when a column is called `end`', () => {
		// `end` is a legal column name. Counting the word END to find where the
		// trigger stops ended it at the first statement of its body, read the
		// real END as a statement of its own, and refused the file.
		const trigger = `
			CREATE TRIGGER spans_close AFTER INSERT ON spans BEGIN
				UPDATE spans SET end = start + 1 WHERE id = new.id AND end IS NULL;
				INSERT INTO audit (note) SELECT 'closed at ' || end FROM spans WHERE id = new.id;
			END;`;
		expect(leadingKeywords(`${trigger} COMMIT;`)).toEqual(['CREATE', 'COMMIT']);

		const database = memoryDb();
		synthetic({
			database,
			migrationsDir: migrationsDir({
				'0001_trigger.sql': statements(
					'CREATE TABLE spans (id INTEGER PRIMARY KEY, start INTEGER, end INTEGER);\nCREATE TABLE audit (note TEXT);',
					trigger,
					'INSERT INTO spans (start) VALUES (41);'
				)
			})
		});
		expect(database.prepare('SELECT end FROM spans').all()).toEqual([{ end: 42 }]);
		expect(database.prepare('SELECT note FROM audit').all()).toEqual([{ note: 'closed at 42' }]);
	});
});

// ─── The migrations directory ────────────────────────────────────────────────

describe('the migrations directory', () => {
	it('must exist', () => {
		const dir = join(migrationsDir({}), 'not-here');

		const { error } = halted({ database: memoryDb(), migrationsDir: dir });

		expect(error.file).toBeNull();
		expect(error.reason).toContain('does not exist');
	});

	it.each<[string, Record<string, string>]>([
		['is empty', {}],
		['holds only other files', { 'README.txt': 'not a migration' }]
	])('must hold at least one .sql file: halts if it %s', (_state, files) => {
		// What an image built without its migrations would look like. Starting
		// with nothing to run is not "up to date"; it is a broken build.
		const database = memoryDb();

		const { error } = halted({ database, migrationsDir: migrationsDir(files) });

		expect(error.file).toBeNull();
		expect(error.reason).toContain('has no .sql files');
	});

	it('reports a recorded migration that has no file, and starts anyway', () => {
		// Older code against a newer database: the previous image, started after
		// a newer one has run a migration it does not have. That has to start.
		const database = memoryDb();
		const first = 'CREATE TABLE first (id INTEGER PRIMARY KEY);';
		const second = 'CREATE TABLE second (id INTEGER PRIMARY KEY);';
		synthetic({
			database,
			migrationsDir: migrationsDir({ '0001_first.sql': first, '0002_second.sql': second })
		});

		const printed = vi.spyOn(console, 'error').mockImplementation(() => {});
		const report = runMigrations({ database, migrationsDir: migrationsDir({ '0001_first.sql': first }) });

		expect(report.missingFromDisk).toEqual(['0002_second.sql']);
		expect(report.applied).toEqual([]);
		const line = printed.mock.calls.map((call) => String(call[0])).find((l) => l.includes('0002_second.sql'));
		expect(line).toContain('[ERROR]');
		// It cannot tell which of the two it is looking at, and says both.
		expect(line).toContain('Either this build is older than the database, or a migration file has been renamed or removed');
		expect(line).toContain('Starting anyway');
		expect(tablesOf(database)).toEqual(['__drizzle_migrations', 'first', 'second']);
	});

	it.each([
		['is empty', ''],
		['holds only white space', '\n\n   \n'],
		['holds only comments', '-- to be written\n/* nothing yet */\n'],
		['holds only breakpoints and empty statements', ';\n--> statement-breakpoint\n-- nothing\n;']
	])('halts on a file that %s, rather than record it as applied', (_state, sql) => {
		// Recorded, the file could never be given its SQL afterwards: a recorded
		// name is not run again.
		const database = memoryDb();

		const { error } = halted({
			database,
			migrationsDir: migrationsDir({
				'0001_first.sql': 'CREATE TABLE first (id INTEGER PRIMARY KEY);',
				'0002_nothing.sql': sql,
				'0003_third.sql': 'CREATE TABLE third (id INTEGER PRIMARY KEY);'
			})
		});

		expect(error.file).toBe('0002_nothing.sql');
		expect(error.reason).toBe('it contains no SQL statement');
		expect(error.message).toContain('was refused');
		expect(recordedIn(database)).toEqual(['0001_first.sql']);
		expect(tablesOf(database)).toEqual(['__drizzle_migrations', 'first']);
	});

	it('halts with its usual account when a listed file cannot be read', () => {
		// A directory with a name that ends in .sql is listed like a file and
		// cannot be read like one. The error used to escape as it was thrown: no
		// file name in a MigrationError, and no line in the log.
		const database = memoryDb();
		const dir = migrationsDir({ '0001_first.sql': 'CREATE TABLE first (id INTEGER PRIMARY KEY);' });
		mkdirSync(join(dir, '0002_unreadable.sql'));

		const { error, logged } = halted({ database, migrationsDir: dir });

		expect(error.file).toBe('0002_unreadable.sql');
		expect(error.reason).toContain('it could not be read');
		expect(error.committed).toEqual(['0001_first.sql']);
		expect(logged.some((line) => line.includes('[CRITICAL]') && line.includes('0002_unreadable.sql'))).toBe(true);
		expect(recordedIn(database)).toEqual(['0001_first.sql']);
	});

	it('has no two migrations sharing a number from 0006 onward', () => {
		// The ten files numbered 0001 to 0005 come in pairs, from two lineages
		// that were merged, and keep their names because every database has
		// recorded them. Nothing after them may repeat the mistake: two files
		// with one number run in an order nobody chose.
		const byNumber = new Map<string, string[]>();
		for (const file of realFiles) {
			expect(file).toMatch(/^\d{4}_.+\.sql$/);
			const number = file.slice(0, 4);
			byNumber.set(number, [...(byNumber.get(number) ?? []), file]);
		}
		const shared = [...byNumber].filter(([, files]) => files.length > 1).map(([number]) => number);

		expect(shared).toEqual(['0001', '0002', '0003', '0004', '0005']);
	});
});

// ─── The backfills ───────────────────────────────────────────────────────────

describe('the backfills, repeated at every start', () => {
	it('stop start-up if they fail, in a halt that names what they were filling in', () => {
		// "Migrations halted (backfills)" named a word from the code. What was
		// being filled in is two columns, and whoever reads the halt can look at them.
		const database = memoryDb();
		runMigrations({ database, migrationsDir: REAL_MIGRATIONS });
		seed(database);
		database.exec(`
			UPDATE cards SET completed_at = '2026-09-01 10:00:00', first_completed_at = NULL WHERE id = 1;
			CREATE TRIGGER first_completion_frozen BEFORE UPDATE OF first_completed_at ON cards
			BEGIN SELECT RAISE(ABORT, 'first completion is frozen'); END;
		`);

		const { error } = halted({ database, migrationsDir: REAL_MIGRATIONS });

		expect(error.message).toBe(
			'Migrations halted (backfilling cards.first_completed_at and task_requests.access_token): ' +
				`first completion is frozen. No migration was committed earlier in this start. ${WHAT_NEXT}`
		);
		// As it says: the card is as it was before the step that failed.
		expect(database.prepare('SELECT first_completed_at FROM cards WHERE id = 1').get()).toEqual({
			first_completed_at: null
		});
		expect(database.inTransaction).toBe(false);
	});
});

// ─── card_dependencies in the legacy shape ───────────────────────────────────

describe('card_dependencies in the legacy shape', () => {
	const legacy = () => {
		const database = memoryDb();
		database.exec(`
			CREATE TABLE cards (id INTEGER PRIMARY KEY);
			INSERT INTO cards (id) VALUES (1), (2), (3);
			CREATE TABLE card_dependencies (
				blocker_card_id INTEGER NOT NULL REFERENCES cards(id) ON DELETE CASCADE,
				blocked_card_id INTEGER NOT NULL REFERENCES cards(id) ON DELETE CASCADE,
				created_at TEXT NOT NULL DEFAULT (datetime('now')),
				PRIMARY KEY (blocker_card_id, blocked_card_id)
			);
			INSERT INTO card_dependencies (blocker_card_id, blocked_card_id, created_at) VALUES
				(1, 2, '2026-01-01 00:00:00'),
				(2, 3, '2026-01-02 00:00:00');
		`);
		return database;
	};
	const anyFile = () => migrationsDir({ '0001_first.sql': 'CREATE TABLE first (id INTEGER PRIMARY KEY);' });

	it('is converted before the first file runs, with every row and its direction kept', () => {
		const database = legacy();

		synthetic({ database, migrationsDir: anyFile() });

		expect(
			database.prepare('SELECT card_id, depends_on_card_id, created_at FROM card_dependencies ORDER BY id').all()
		).toEqual([
			{ card_id: 2, depends_on_card_id: 1, created_at: '2026-01-01 00:00:00' },
			{ card_id: 3, depends_on_card_id: 2, created_at: '2026-01-02 00:00:00' }
		]);
	});

	it('halts start-up if the conversion fails, leaving the table as it was', () => {
		const database = legacy();
		// Something the conversion cannot carry across: its own scratch name,
		// taken by a view, which DROP TABLE IF EXISTS refuses to drop.
		database.exec('CREATE VIEW card_dependencies_v2 AS SELECT 1 AS n');

		const { error } = halted({ database, migrationsDir: anyFile() });

		expect(error.message).toContain('card_dependencies repair');
		expect(database.prepare('SELECT COUNT(*) AS n FROM card_dependencies').get()).toEqual({ n: 2 });
		expect(
			(database.prepare('PRAGMA table_info(card_dependencies)').all() as { name: string }[]).map((c) => c.name)
		).toContain('blocker_card_id');
		// It halted before the loop: the file was never reached.
		expect(tablesOf(database)).not.toContain('first');
	});
});

// ─── The six reconciled tables ───────────────────────────────────────────────

/*
 * `boards`, `columns`, `categories`, `settings`, `user_xp` and `invite_tokens`
 * each reached databases in two shapes. Production has five of them in the
 * older one. A database created from the repository before card 2006 has
 * `boards` and `categories` in it. The runner rebuilds whichever it finds.
 *
 * Where it cannot, it says so and starts anyway (decision 12). A table that
 * fails a guard is left as it is and the others are rebuilt; a rebuild that
 * fails its checks is rolled back as a whole. Neither is a halt, and neither
 * is silent: each is in the report and in the log at ERROR. One thing in all
 * of it still stops the server, which is foreign keys that will not come back
 * on.
 *
 * `productionWithRows()` and `preCardWithRows()` have every migration applied
 * already, so that a reading taken before the runner and one taken after
 * differ by the rebuild and by nothing else.
 */

/** A database in which `table` still has its older shape, with rows in it. */
const olderShapeOf = (table: string) => (table === 'boards' ? preCardWithRows() : productionWithRows());

/** The five that `productionWithRows()` has in the older shape, in the order they are rebuilt. */
const OLDER_ON_PRODUCTION = ['columns', 'categories', 'settings', 'user_xp', 'invite_tokens'];

/** What `reconcileSchema` returns when there was nothing for it to do. */
const NOTHING_TO_DO = { rebuilt: [], leftAlone: [], detached: [] };

/**
 * What `sqlite_master` holds for one table and everything that belongs to it,
 * root page included. Unchanged, the table was not dropped and made again.
 */
const entriesFor = (database: Database.Database, table: string) =>
	database
		.prepare('SELECT type, name, tbl_name, rootpage, sql FROM sqlite_master WHERE tbl_name = ? ORDER BY type, name')
		.all(table);

const scratchTablesIn = (database: Database.Database) =>
	tablesOf(database).filter((name) => name.includes('_rebuild_'));

/**
 * Make `database` ignore one of the two pragmas that switch foreign keys, as
 * SQLite itself ignores both, without an error, while a transaction is open.
 * Nothing is faked beyond that: every reading of the setting is a true one.
 * Returns the real `pragma`, for reading it without going through the spy.
 */
function ignoringPragma(database: Database.Database, setting: 'ON' | 'OFF'): Database.Database['pragma'] {
	const real = database.pragma.bind(database) as Database.Database['pragma'];
	const ignored = new RegExp(`^foreign_keys\\s*=\\s*${setting}$`, 'i');
	vi.spyOn(database, 'pragma').mockImplementation(((source: string, options?: Database.PragmaOptions) =>
		ignored.test(source) ? [] : real(source, options)) as typeof database.pragma);
	return real;
}

/**
 * Have `database` prepare something else in place of a statement the rebuild
 * makes. `instead` is given each statement as it is prepared, with the real
 * `prepare`, and returns what is to be run in its place, or nothing to leave
 * the statement alone. Returns a count of the statements replaced.
 *
 * This is the only way to see one of the rebuild's checks from outside: the
 * rebuild does not do the things the checks are there to catch, so a test has
 * to do one for it. Nothing about the check is faked. What it reads, it reads
 * from the database, after a statement that really ran.
 */
function replacing(
	database: Database.Database,
	instead: (source: string, real: Database.Database['prepare']) => unknown
): () => number {
	const real = database.prepare.bind(database) as Database.Database['prepare'];
	let replaced = 0;
	vi.spyOn(database, 'prepare').mockImplementation(((source: string) => {
		const other = instead(source, real);
		if (other === undefined) return real(source);
		replaced++;
		return other;
	}) as typeof database.prepare);
	return () => replaced;
}

/** What a rebuild makes of `before`: the same rows, with a WIP limit that was missing now 0. */
function afterRebuild(before: Record<string, string[]>): Record<string, string[]> {
	return {
		...before,
		columns: before.columns.map((row) => row.replace('"wip_limit":null', '"wip_limit":0')).sort()
	};
}

const idsIn = (database: Database.Database, table: string) =>
	(database.prepare(`SELECT id FROM "${table}" ORDER BY id`).all() as { id: number }[]).map((r) => r.id);

/**
 * After the rebuild: does the table behave as the model says, and does what
 * referred to it still refer to it? Reading the DDL shows what a foreign key
 * says; only using it shows that it reaches the right table.
 */
const BEHAVES: Record<string, (database: Database.Database) => void> = {
	boards: (database) => {
		// An id is never reused, even one that was deleted before the rebuild.
		expect(database.prepare("INSERT INTO boards (name) VALUES ('New')").run().lastInsertRowid).toBe(9);

		// The two foreign keys the older shape lacked. A sub-board goes with its card...
		database.prepare('DELETE FROM cards WHERE id = 1').run();
		expect(idsIn(database, 'boards')).toEqual([1, 2, 9]);
		// ...and a board outlives the user who created it.
		database.prepare('DELETE FROM users WHERE id = 2').run();
		expect(database.prepare('SELECT created_by FROM boards WHERE id = 2').get()).toEqual({ created_by: null });

		// What referred to `boards` still does: its columns and their cards go with it.
		database.prepare('DELETE FROM boards WHERE id = 2').run();
		expect(idsIn(database, 'columns')).toEqual([1, 2]);
		expect(idsIn(database, 'cards')).toEqual([2, 5]);
		expect(idsIn(database, 'labels')).toEqual([1]);
	},
	columns: (database) => {
		expect(database.prepare("INSERT INTO columns (board_id, title) VALUES (1, 'New')").run().lastInsertRowid).toBe(8);
		expect(() =>
			database.prepare("INSERT INTO columns (board_id, title, wip_limit) VALUES (1, 'No limit', NULL)").run()
		).toThrow(/NOT NULL constraint failed: columns.wip_limit/);

		// cards.column_id and daily_snapshots.column_id still point at `columns`.
		database.prepare('DELETE FROM columns WHERE id = 1').run();
		expect(idsIn(database, 'cards')).toEqual([3, 4, 5]);
		expect(database.prepare('SELECT column_id FROM daily_snapshots ORDER BY column_id').all()).toEqual([
			{ column_id: 2 },
			{ column_id: 4 }
		]);
	},
	categories: (database) => {
		expect(
			database.prepare("INSERT INTO categories (board_id, name) VALUES (1, 'New')").run().lastInsertRowid
		).toBe(10);

		// cards.category_id still points at `categories`: deleting one clears it.
		database.prepare('DELETE FROM categories WHERE id = 1').run();
		expect(database.prepare('SELECT id, category_id FROM cards ORDER BY id').all()).toEqual([
			{ id: 1, category_id: null },
			{ id: 2, category_id: 2 },
			{ id: 3, category_id: 5 },
			{ id: 4, category_id: null },
			{ id: 5, category_id: null }
		]);

		// And the point of the rebuild: a category outlives its board, and can have none.
		database.prepare('DELETE FROM boards WHERE id = 2').run();
		expect(database.prepare('SELECT id, board_id FROM categories WHERE id = 5').get()).toEqual({
			id: 5,
			board_id: null
		});
		expect(() => database.prepare("INSERT INTO categories (name) VALUES ('Shared')").run()).not.toThrow();
	},
	// Nothing refers to the three below. Each is checked for what the rebuild
	// was for, a key that can no longer be NULL, and for still being a key.
	settings: (database) => {
		expect(() => database.prepare("INSERT INTO settings (key, value) VALUES (NULL, 'x')").run()).toThrow(
			/NOT NULL constraint failed: settings.key/
		);
		expect(() => database.prepare("INSERT INTO settings (key, value) VALUES ('theme', 'light')").run()).toThrow(
			/UNIQUE constraint failed: settings.key/
		);
	},
	user_xp: (database) => {
		expect(() => database.prepare('INSERT INTO user_xp (name, xp) VALUES (NULL, 1)').run()).toThrow(
			/NOT NULL constraint failed: user_xp.name/
		);
		expect(() => database.prepare("INSERT INTO user_xp (name, xp) VALUES ('ann', 1)").run()).toThrow(
			/UNIQUE constraint failed: user_xp.name/
		);
	},
	invite_tokens: (database) => {
		expect(() =>
			database.prepare("INSERT INTO invite_tokens (token, user_id, expires_at) VALUES (NULL, 1, '2027-01-01')").run()
		).toThrow(/NOT NULL constraint failed: invite_tokens.token/);
		expect(() =>
			database
				.prepare("INSERT INTO invite_tokens (token, user_id, expires_at) VALUES ('token-for-ann', 1, '2027-01-01')")
				.run()
		).toThrow(/UNIQUE constraint failed: invite_tokens.token/);

		// Its own reference, to `users`, came across with it.
		database.prepare('DELETE FROM users WHERE id = 2').run();
		expect(database.prepare('SELECT token FROM invite_tokens').all()).toEqual([{ token: 'token-for-ann' }]);
	}
};

describe('the six reconciled tables', () => {
	it('are a fixed list, which nothing can add to at run time', () => {
		expect([...RECONCILED_TABLES]).toEqual(['boards', 'columns', 'categories', 'settings', 'user_xp', 'invite_tokens']);
		expect(Object.isFrozen(RECONCILED_TABLES)).toBe(true);
	});

	it.each([...RECONCILED_TABLES])(
		'%s: rebuilt from its older shape with every row, every reference and every id counter intact, and not a second time',
		(table) => {
			const database = olderShapeOf(table);
			const isAbout = (difference: string) => difference.startsWith(`${table}.`) || difference.startsWith(`${table}:`);
			expect(schemaDifferences(database).filter(isAbout)).not.toEqual([]);
			const before = contentsOf(database);
			expect(before[table].length).toBeGreaterThan(0);

			const report = runMigrations({ database, migrationsDir: REAL_MIGRATIONS });

			expect(report.applied).toEqual([]);
			expect(report.rebuilt.find((r) => r.table === table)?.rows).toBe(before[table].length);
			expect(report.schemaDifferences).toEqual([]);
			// The one that matters. Done carelessly, a rebuild keeps every row of
			// the table it rebuilds and loses rows, or references, somewhere else.
			// This is every row of every table, and every id counter.
			expect(contentsOf(database)).toEqual(afterRebuild(before));
			expect(foreignKeysOn(database)).toBe(true);
			expect(database.pragma('foreign_key_check')).toEqual([]);
			expect(database.inTransaction).toBe(false);
			expect(tablesOf(database).filter((name) => name.includes('_rebuild_'))).toEqual([]);

			// The start after that has nothing to do, and does nothing.
			const master = masterOf(database);
			const again = runMigrations({ database, migrationsDir: REAL_MIGRATIONS });
			expect(again.applied).toEqual([]);
			expect(again.rebuilt).toEqual([]);
			expect(again.schemaDifferences).toEqual([]);
			expect(masterOf(database)).toEqual(master);
			expect(contentsOf(database)).toEqual(afterRebuild(before));

			BEHAVES[table](database);
		}
	);

	it('rebuilds all that need it in one start, and reports each one once the work is committed', () => {
		const database = productionWithRows();
		process.env.LOG_LEVEL = 'WARN';
		// What the logger prints, and whether a transaction was open when it did:
		// a line written inside one is rolled back with it if the work fails.
		const lines: { line: string; inTransaction: boolean }[] = [];
		vi.spyOn(console, 'warn').mockImplementation((line) => {
			lines.push({ line: String(line), inTransaction: database.inTransaction });
		});

		const report = runMigrations({ database, migrationsDir: REAL_MIGRATIONS });

		// `boards` already has the model's shape on production and is left alone.
		// Each of the others comes with what was different about it, which is
		// what the rebuild changed.
		expect(report.rebuilt).toEqual([
			{
				table: 'columns',
				rows: 3,
				defaulted: [{ column: 'wip_limit', rows: 2, value: '0' }],
				differences: ['columns.wip_limit: is nullable; the model has it NOT NULL']
			},
			{
				table: 'categories',
				rows: 3,
				defaulted: [],
				differences: [
					'categories.board_id: is NOT NULL; the model has it nullable',
					'categories: foreign key in the database but not in the model: (board_id) references boards(id), on update NO ACTION, on delete CASCADE',
					'categories: foreign key in the model but not in the database: (board_id) references boards(id), on update NO ACTION, on delete SET NULL'
				]
			},
			{
				table: 'settings',
				rows: 2,
				defaulted: [],
				differences: ['settings.key: is nullable; the model has it NOT NULL']
			},
			{
				table: 'user_xp',
				rows: 2,
				defaulted: [],
				differences: ['user_xp.name: is nullable; the model has it NOT NULL']
			},
			{
				table: 'invite_tokens',
				rows: 2,
				defaulted: [],
				differences: ['invite_tokens.token: is nullable; the model has it NOT NULL']
			}
		]);
		// The line says it too. A rebuild that takes a foreign key off a table
		// does so because the model said to, and a model that was wrong would
		// take it off just as quietly: here is where that can be read.
		const rebuilt = lines.filter((entry) => entry.line.includes('rebuilt'));
		expect(rebuilt.map((entry) => entry.line.replace(/^\[[^\]]+\] /, ''))).toEqual([
			"[WARN] [DB] columns rebuilt in the model's shape — 3 row(s) carried across; 2 NULL wip_limit value(s) became the default, 0. " +
				'What differed, and no longer does: columns.wip_limit: is nullable; the model has it NOT NULL',
			"[WARN] [DB] categories rebuilt in the model's shape — 3 row(s) carried across. " +
				'What differed, and no longer does: categories.board_id: is NOT NULL; the model has it nullable; ' +
				'categories: foreign key in the database but not in the model: (board_id) references boards(id), on update NO ACTION, on delete CASCADE; ' +
				'categories: foreign key in the model but not in the database: (board_id) references boards(id), on update NO ACTION, on delete SET NULL',
			"[WARN] [DB] settings rebuilt in the model's shape — 2 row(s) carried across. " +
				'What differed, and no longer does: settings.key: is nullable; the model has it NOT NULL',
			"[WARN] [DB] user_xp rebuilt in the model's shape — 2 row(s) carried across. " +
				'What differed, and no longer does: user_xp.name: is nullable; the model has it NOT NULL',
			"[WARN] [DB] invite_tokens rebuilt in the model's shape — 2 row(s) carried across. " +
				'What differed, and no longer does: invite_tokens.token: is nullable; the model has it NOT NULL'
		]);
		expect(lines.filter((entry) => entry.inTransaction)).toEqual([]);
	});

	it('says in the line for a table it rebuilds that a foreign key the model has not got is gone', () => {
		// What a stale copy of the model would do. `settings` here has a foreign
		// key and the model given to the runner has none, as an out-of-date
		// expected-schema.ts would have none for a key added since. The rebuild
		// does what the model says, and the constraint is removed. Nothing can
		// stop that at run time; it can only be said, and it is.
		const model = [
			'CREATE TABLE `users` (\n\t`id` integer PRIMARY KEY AUTOINCREMENT NOT NULL\n);',
			'CREATE TABLE `settings` (\n\t`key` text PRIMARY KEY NOT NULL,\n\t`owner` integer\n);'
		];
		const database = memoryDb();
		database.exec(`
			CREATE TABLE users (id INTEGER PRIMARY KEY AUTOINCREMENT NOT NULL);
			CREATE TABLE settings (key TEXT PRIMARY KEY NOT NULL, owner INTEGER REFERENCES users(id) ON DELETE CASCADE);
			INSERT INTO users (id) VALUES (1);
			INSERT INTO settings (key, owner) VALUES ('theme', 1);
		`);
		process.env.LOG_LEVEL = 'WARN';
		const lines: string[] = [];
		vi.spyOn(console, 'warn').mockImplementation((line) => {
			lines.push(String(line).replace(/^\[[^\]]+\] /, ''));
		});

		const report = runMigrations({
			database,
			migrationsDir: migrationsDir({ '0001_nothing_new.sql': 'SELECT 1;' }),
			expectedSchema: model
		});

		const gone =
			'settings: foreign key in the database but not in the model: (owner) references users(id), on update NO ACTION, on delete CASCADE';
		expect(report.rebuilt).toEqual([{ table: 'settings', rows: 1, defaulted: [], differences: [gone] }]);
		expect(lines).toContain(
			`[WARN] [DB] settings rebuilt in the model's shape — 1 row(s) carried across. What differed, and no longer does: ${gone}`
		);
		expect(database.prepare('PRAGMA foreign_key_list(settings)').all()).toEqual([]);
	});

	it('gives a column with no WIP limit the limit of 0, which is the default and means none', () => {
		const database = productionWithRows();
		const limits = () => database.prepare('SELECT id, wip_limit FROM columns ORDER BY id').all();
		expect(limits()).toEqual([
			{ id: 1, wip_limit: null },
			{ id: 2, wip_limit: 3 },
			{ id: 4, wip_limit: null }
		]);

		runMigrations({ database, migrationsDir: REAL_MIGRATIONS });

		expect(limits()).toEqual([
			{ id: 1, wip_limit: 0 },
			{ id: 2, wip_limit: 3 },
			{ id: 4, wip_limit: 0 }
		]);
	});

	it('gives a NULL the default as the model’s column stores it, where that is not as the default is written', () => {
		// `position real DEFAULT 0`: the default is written 0 and a REAL column
		// stores it as 0.0. The rebuild works the default out once and copies it
		// as a literal. Worked out as it is written, that literal was 0, the copy
		// held 0.0, and the check on the copy called it a fault in the rebuild.
		//
		// Production's `columns` with `position` nullable, which the model's is
		// not, and one column that has no position.
		const database = productionWithRows();
		const strict = (
			database.prepare("SELECT sql FROM sqlite_master WHERE type = 'table' AND name = 'columns'").get() as { sql: string }
		).sql;
		const loose = strict
			.replace('CREATE TABLE `columns`', 'CREATE TABLE `columns_loose`')
			.replace('`position` real DEFAULT 0 NOT NULL', '`position` real DEFAULT 0');
		expect(loose).toContain('CREATE TABLE `columns_loose`');
		expect(loose).toContain('`position` real DEFAULT 0,');
		database.pragma('foreign_keys = OFF');
		database.exec(loose);
		database.exec(`
			INSERT INTO columns_loose SELECT * FROM columns;
			DROP TABLE columns;
			ALTER TABLE columns_loose RENAME TO columns;
			UPDATE columns SET position = NULL WHERE id = 2;
		`);
		database.pragma('foreign_keys = ON');
		const positions = () =>
			database.prepare('SELECT id, quote(position) AS written, typeof(position) AS stored FROM columns ORDER BY id').all();
		expect(positions()).toEqual([
			{ id: 1, written: '0.0', stored: 'real' },
			{ id: 2, written: 'NULL', stored: 'null' },
			{ id: 4, written: '0.0', stored: 'real' }
		]);

		const { report, errors } = reporting({ database, migrationsDir: REAL_MIGRATIONS });

		// First, so that if the rebuild was rolled back this says why.
		expect(report.leftAlone).toEqual([]);
		expect(errors).toEqual([]);
		expect(report.rebuilt.find((table) => table.table === 'columns')).toEqual({
			table: 'columns',
			rows: 3,
			// As it is stored, which is what the row now holds.
			defaulted: [
				{ column: 'position', rows: 1, value: '0.0' },
				{ column: 'wip_limit', rows: 2, value: '0' }
			],
			differences: [
				'columns.position: is nullable; the model has it NOT NULL',
				'columns.wip_limit: is nullable; the model has it NOT NULL',
				// 0053 made it, and it went with the table this test replaced.
				'columns: index in the model but not in the database: index idx_columns_board_id on (board_id)'
			]
		});
		expect(positions()).toEqual([
			{ id: 1, written: '0.0', stored: 'real' },
			{ id: 2, written: '0.0', stored: 'real' },
			{ id: 4, written: '0.0', stored: 'real' }
		]);
		expect(report.schemaDifferences).toEqual([]);
	});

	it.each([
		['settings', 'key', "INSERT INTO settings (key, value) VALUES (NULL, 'a'), (NULL, 'b')", 2],
		['user_xp', 'name', 'INSERT INTO user_xp (name, xp) VALUES (NULL, 1)', 1],
		[
			'invite_tokens',
			'token',
			"INSERT INTO invite_tokens (token, user_id, expires_at) VALUES (NULL, 1, '2027-01-01 00:00:00'), (NULL, 2, '2027-01-01 00:00:00'), (NULL, 1, '2027-02-01 00:00:00')",
			3
		]
	])(
		'leaves %s alone when %s holds a NULL, says where and how many, and rebuilds the others in the same start',
		(table, column, insert, count) => {
			// A TEXT PRIMARY KEY written without NOT NULL accepts NULL, any number
			// of times. The model's column does not, and has no default to put
			// there, so there is no rebuilt table these rows could go into. That
			// table has been running in the shape it has, and stays in it. The
			// four others were waiting to be rebuilt too, and are.
			const database = productionWithRows();
			database.exec(insert);
			const untouched = entriesFor(database, table);
			const before = contentsOf(database);

			const { report, errors } = reporting({ database, migrationsDir: REAL_MIGRATIONS });

			const reason = `${table}.${column} is NULL in ${count} row(s), and the model's column is NOT NULL with no default to give them`;
			// What to do, with the SQL that does it. Each of the three is the
			// table's key, where one statement cannot give two rows a value.
			const whatToDo =
				`Give ${column} a value in those rows or delete them, and restart: ` +
				`UPDATE "${table}" SET "${column}" = <a value> WHERE "${column}" IS NULL; ` +
				`or DELETE FROM "${table}" WHERE "${column}" IS NULL; ` +
				`${column} is the table's key, so no two rows can be given the same value: where there are several, ` +
				'update them one at a time, adding AND rowid = <n>.';
			expect(report.leftAlone).toEqual([{ table, stage: 'guard', reason, whatToDo }]);
			expect(report.rebuilt.map((r) => r.table)).toEqual(OLDER_ON_PRODUCTION.filter((other) => other !== table));
			expect(entriesFor(database, table)).toEqual(untouched);
			// Every row of every table, the NULL keys included, and every id counter.
			expect(contentsOf(database)).toEqual(afterRebuild(before));

			// The log says what the report says and what to do about it, and the
			// schema check that follows has this one table left to report.
			expect(errors).toHaveLength(2);
			expect(errors[0]).toBe(leftAloneLine(table, reason, whatToDo));
			expect(errors[1]).toContain('[ERROR] [DB] The database differs from the model in 1 place(s)');
			expect(report.schemaDifferences).toEqual([`${table}.${column}: is nullable; the model has it NOT NULL`]);

			expect(foreignKeysOn(database)).toBe(true);
			expect(database.pragma('foreign_key_check')).toEqual([]);
			expect(database.inTransaction).toBe(false);
			expect(scratchTablesIn(database)).toEqual([]);

			// The next start finds it as it was and says so again. It is not
			// something that is mentioned once and then forgotten.
			const again = reporting({ database, migrationsDir: REAL_MIGRATIONS });
			expect(again.report.leftAlone).toEqual(report.leftAlone);
			expect(again.report.rebuilt).toEqual([]);
			expect(again.errors).toEqual(errors);

			// And once the rows are dealt with, the start after that rebuilds it.
			database.exec(`DELETE FROM ${table} WHERE ${column} IS NULL`);
			const dealtWith = runMigrations({ database, migrationsDir: REAL_MIGRATIONS });
			expect(dealtWith.rebuilt.map((r) => r.table)).toEqual([table]);
			expect(dealtWith.leftAlone).toEqual([]);
			expect(dealtWith.schemaDifferences).toEqual([]);
		}
	);

	it('rolls the whole rebuild back when it fails part-way, reports it, and lets start-up continue', () => {
		const database = productionWithRows();
		// A view over a table that does not exist. It mentions none of the six,
		// so every guard passes; and SQLite checks every view when a table is
		// renamed, so the rename fails, by which point foreign keys are off, the
		// transaction is open and the old table has been dropped.
		database.exec('CREATE VIEW broken AS SELECT * FROM no_such_table');
		const master = masterOf(database);
		const before = contentsOf(database);

		const { report, errors } = reporting({ database, migrationsDir: REAL_MIGRATIONS });

		// One transaction, so one outcome and one reason for all five. SQLite
		// refused a statement, and what to do says so: its reason names the view.
		expect(report.rebuilt).toEqual([]);
		const reason = report.leftAlone[0].reason;
		expect(reason).toContain('the rebuild was rolled back: error in view broken');
		expect(report.leftAlone).toEqual(
			OLDER_ON_PRODUCTION.map((table) => ({ table, stage: 'rebuild', reason, whatToDo: REFUSED_BY_SQLITE }))
		);
		expect(errors[0]).toBe(notRebuiltLine(OLDER_ON_PRODUCTION, reason, REFUSED_BY_SQLITE));
		// The old shapes, with no scratch table left behind...
		expect(masterOf(database)).toEqual(master);
		expect(scratchTablesIn(database)).toEqual([]);
		// ...every row, every reference to them, and every id counter...
		expect(contentsOf(database)).toEqual(before);
		// ...and the connection as the application needs it.
		expect(foreignKeysOn(database)).toBe(true);
		expect(database.inTransaction).toBe(false);
		// Start-up went on to the schema check, which found the view and the five.
		expect(report.schemaDifferences).toContain('view broken: in the database but not in the model');
		expect(report.schemaDifferences).toContain('columns.wip_limit: is nullable; the model has it NOT NULL');
		expect(errors).toHaveLength(2);
	});

	it('rolls back when a drop takes rows from other tables with it, reports it, and lets start-up continue', () => {
		// The failure the whole-database comparison exists for. SQLite ignores
		// `PRAGMA foreign_keys = OFF` inside a transaction and says nothing; with
		// foreign keys on, DROP TABLE deletes the table's rows first and every
		// ON DELETE CASCADE fires. Here the pragma is ignored outright and every
		// reading of it answers "off", so the checks made before the drop pass.
		// `columns` is rebuilt with all its rows, and every card is gone.
		const database = productionWithRows();
		const master = masterOf(database);
		const before = contentsOf(database);
		const real = database.pragma.bind(database);
		let pretending = false;
		vi.spyOn(database, 'pragma').mockImplementation(((source: string, options?: Database.PragmaOptions) => {
			if (/^foreign_keys\s*=\s*OFF$/i.test(source)) {
				pretending = true;
				return [];
			}
			if (/^foreign_keys\s*=\s*ON$/i.test(source)) pretending = false;
			if (source === 'foreign_keys' && pretending) return 0;
			return real(source, options);
		}) as typeof database.pragma);

		const { report, errors } = reporting({ database, migrationsDir: REAL_MIGRATIONS });

		expect(report.rebuilt).toEqual([]);
		const reason = report.leftAlone[0].reason;
		// One of the rebuild's own checks failed. That is a fault in the rebuild
		// and not in anybody's data, and the line says so.
		expect(report.leftAlone).toEqual(
			OLDER_ON_PRODUCTION.map((table) => ({ table, stage: 'rebuild', reason, whatToDo: A_FAULT_IN_THE_REBUILD }))
		);
		expect(reason).toContain('the rebuild was rolled back: it changed what it must leave alone');
		// Tables the rebuild never touched: this is what a check on `columns` alone would miss.
		expect(reason).toContain('rows in cards (before: 5; after: 0)');
		expect(reason).toContain('rows in daily_snapshots (before: 3; after: 0)');
		// What differed is in the log, not only in the report.
		expect(errors[0]).toBe(notRebuiltLine(OLDER_ON_PRODUCTION, reason, A_FAULT_IN_THE_REBUILD));
		expect(masterOf(database)).toEqual(master);
		expect(scratchTablesIn(database)).toEqual([]);
		expect(contentsOf(database)).toEqual(before);
		expect(real('foreign_keys', { simple: true })).toBe(1);
		expect(database.inTransaction).toBe(false);
	});

	it('does not start a rebuild if foreign keys cannot be switched off, and reports that', () => {
		const database = productionWithRows();
		const master = masterOf(database);
		const before = contentsOf(database);
		const real = ignoringPragma(database, 'OFF');

		const { report, errors } = reporting({ database, migrationsDir: REAL_MIGRATIONS });

		const reason = 'foreign keys could not be switched off, so the rebuild was not started';
		expect(report.rebuilt).toEqual([]);
		expect(report.leftAlone).toEqual(
			OLDER_ON_PRODUCTION.map((table) => ({ table, stage: 'rebuild', reason, whatToDo: START_AGAIN_AND_REPORT }))
		);
		// The line says why it mentions foreign keys at all, in words that are
		// true here too, where they were never off.
		expect(errors[0]).toBe(notRebuiltLine(OLDER_ON_PRODUCTION, reason, START_AGAIN_AND_REPORT));
		expect(masterOf(database)).toEqual(master);
		expect(contentsOf(database)).toEqual(before);
		expect(real('foreign_keys', { simple: true })).toBe(1);
		expect(database.inTransaction).toBe(false);
	});

	it('does not call it a rollback when the rebuild could not so much as begin', () => {
		// BEGIN IMMEDIATE fails if another connection holds the write lock. By
		// then foreign keys are off and nothing else has happened: there is
		// nothing to roll back, and the cause is outside this database.
		const database = productionWithRows();
		const master = masterOf(database);
		const before = contentsOf(database);
		vi.spyOn(database, 'transaction').mockImplementation(((fn: () => unknown) =>
			Object.assign(() => fn(), {
				immediate: () => {
					// As better-sqlite3 does when BEGIN fails: throw, and never call `fn`.
					throw new Error('database is locked');
				}
			})) as unknown as typeof database.transaction);

		const outcome = reconcileSchema(database);

		const reason = 'the rebuild could not be started: database is locked';
		const whatToDo =
			'The transaction for it could not be opened, which usually means another process has the database file open ' +
			'and was writing to it. Make sure nothing else is using the file, and restart.';
		expect(outcome).toEqual({
			...NOTHING_TO_DO,
			leftAlone: OLDER_ON_PRODUCTION.map((table) => ({ table, stage: 'rebuild', reason, whatToDo }))
		});
		expect(reason).not.toContain('rolled back');
		vi.restoreAllMocks();
		expect(masterOf(database)).toEqual(master);
		expect(contentsOf(database)).toEqual(before);
		expect(foreignKeysOn(database)).toBe(true);
		expect(database.inTransaction).toBe(false);
	});

	it.each<[string, string | null, string, string]>([
		[
			'a rebuild that was committed',
			null,
			// Each table with its rows, and the NULLs that were given a default:
			// the lines that would have said so come after the point of the halt.
			'the rebuild had been committed: ' +
				'columns rebuilt with 3 row(s) carried across and 2 NULL wip_limit value(s) given the default 0, ' +
				'categories rebuilt with 3 row(s) carried across, ' +
				'user_xp rebuilt with 2 row(s) carried across, ' +
				'invite_tokens rebuilt with 2 row(s) carried across',
			AFTER_A_COMMITTED_REBUILD
		],
		[
			'a rebuild that was rolled back',
			'CREATE VIEW broken AS SELECT * FROM no_such_table',
			'no rebuild of columns, categories, user_xp, invite_tokens had been committed: the rebuild was rolled back: ' +
				'error in view broken: no such table: main.no_such_table',
			AFTER_NO_REBUILD
		]
	])('still stops start-up when foreign keys cannot be switched back on after %s', (_what, obstacle, known, ending) => {
		// The one thing in reconciliation that is fatal. With foreign keys off,
		// no cascade fires and no constraint is checked, on the application's
		// only connection, and nothing says so.
		//
		// It is brought about by having the connection ignore `PRAGMA
		// foreign_keys = ON`, which is what SQLite does with it when a
		// transaction is open. They then really are off, and are read as off.
		const database = productionWithRows();
		if (obstacle) database.exec(obstacle);
		// One table that a guard turns away first, to see that it is not lost.
		database.exec("INSERT INTO settings (key, value) VALUES (NULL, 'kept out of the rebuild')");
		const before = contentsOf(database);
		const real = ignoringPragma(database, 'ON');

		// It ends in its own way. After a committed rebuild, "the database is as
		// it was before the failing step" would be false in the same breath as
		// saying four tables had been rebuilt.
		const { error, logged } = halted({ database, migrationsDir: REAL_MIGRATIONS }, ending);

		// There is no report to read after a halt, so the message carries what
		// the report would have: what became of the rebuild, and of the table
		// that was never in it.
		expect(error.message).toBe(
			'Migrations halted (schema reconciliation): foreign keys could not be switched back on after the rebuild ' +
				`was attempted, and this connection must not be used with them off (${known}; ` +
				'settings had been left in the shape it has: settings.key is NULL in 1 row(s), ' +
				"and the model's column is NOT NULL with no default to give them). " +
				`No migration was committed earlier in this start. ${ending}`
		);
		expect(error.message).not.toContain('The database is as it was before the failing step');
		expect(logged.some((line) => line.includes('[CRITICAL]') && line.includes('could not be switched back on'))).toBe(
			true
		);
		// And it is true. Committed: four tables are in the model's shape. Not
		// committed: every row and every definition is what it was.
		const rebuiltNow = OLDER_ON_PRODUCTION.filter((table) => differencesOf(database, table).length === 0);
		expect(rebuiltNow).toEqual(obstacle ? [] : ['columns', 'categories', 'user_xp', 'invite_tokens']);
		expect(contentsOf(database)).toEqual(obstacle ? before : afterRebuild(before));
		// Not a pretence: they are off.
		expect(real('foreign_keys', { simple: true })).toBe(0);
		expect(database.inTransaction).toBe(false);
	});

	it('does not say the rebuild was rolled back, in that halt, when it was the rollback that failed', () => {
		// Why foreign keys will not come back on, when it happens for real: the
		// rebuild failed, its rollback failed too, and SQLite ignores the pragma
		// while the transaction is open. Nothing is faked here but the failure to
		// roll back: the transaction really is open and they really are off.
		const database = productionWithRows();
		vi.spyOn(database, 'transaction').mockImplementation(((fn: () => unknown) =>
			Object.assign(() => fn(), {
				immediate: () => {
					database.exec('BEGIN IMMEDIATE');
					fn();
					throw new Error('cannot rollback - disk I/O error');
				}
			})) as unknown as typeof database.transaction);

		const ending =
			"Nothing was committed: the rebuild's transaction is still open on this connection and is discarded when the " +
			'process ends, so no table is changed. Start again: a new process opens a new connection with foreign keys on, ' +
			'the rebuild is attempted again, and what stops it, if anything does, is reported. If it stops here again, ' +
			'start the previous image.';
		const { error } = halted({ database, migrationsDir: REAL_MIGRATIONS }, ending);

		expect(error.reason).toContain(
			'no rebuild of columns, categories, settings, user_xp, invite_tokens had been committed: the rebuild failed ' +
				'and its transaction could not be rolled back: cannot rollback - disk I/O error; ' +
				'a transaction is still open on the connection'
		);
		expect(error.message).not.toContain('was rolled back');
		expect(error.message).not.toContain('The database is as it was before the failing step');
		expect(database.inTransaction).toBe(true);
		expect(foreignKeysOn(database)).toBe(false);

		// And what it says of the tables is true: the process ending is a
		// rollback, after which every one of them is as it was.
		vi.restoreAllMocks();
		database.exec('ROLLBACK');
		expect(differencesOf(database, 'columns')).toEqual(['columns.wip_limit: is nullable; the model has it NOT NULL']);
		expect(scratchTablesIn(database)).toEqual([]);
	});

	it('leaves alone a table the model has no usable statement for, and says the build is at fault', () => {
		// The model's tables are found by how drizzle-kit writes them. One
		// written any other way is not edited by guesswork, and the fault is in
		// the copy of the model this build was given, not in the database.
		const model = ['CREATE TABLE settings (key text PRIMARY KEY NOT NULL, value text);'];
		const database = memoryDb();
		database.exec(`
			CREATE TABLE settings (key TEXT PRIMARY KEY, value TEXT);
			INSERT INTO settings (key, value) VALUES ('theme', 'dark');
		`);
		const untouched = entriesFor(database, 'settings');

		expect(reconcileSchema(database, model)).toEqual({
			...NOTHING_TO_DO,
			leftAlone: [
				{
					table: 'settings',
					stage: 'guard',
					reason: 'the model has 0 statements beginning "CREATE TABLE `settings` (", and a rebuild needs exactly one',
					whatToDo:
						'This is a fault in this build, not in the database: its copy of the model (expected-schema.ts) is ' +
						'not one a rebuild can be made from. Report this line.'
				}
			]
		});
		expect(entriesFor(database, 'settings')).toEqual(untouched);
	});

	it('says in that halt which sub-boards had been detached, since no other line will', () => {
		// The detaching was committed with the rebuild, and the lines that would
		// have recorded it come after the point where start-up stops. The card a
		// sub-board belonged to is by then recorded nowhere but here.
		const database = preCardWithRows();
		database.exec("INSERT INTO boards (id, name, parent_card_id) VALUES (6, 'Left behind', 99)");
		ignoringPragma(database, 'ON');

		const { error } = halted({ database, migrationsDir: REAL_MIGRATIONS }, AFTER_A_COMMITTED_REBUILD);

		expect(error.reason).toContain(
			'the rebuild had been committed: boards rebuilt with 4 row(s) carried across, categories rebuilt with 3 row(s) carried across'
		);
		expect(error.reason).toContain('sub-board 6 (Left behind) had been detached from card 99');
	});

	it('leaves alone a table it cannot so much as read, says so, and rebuilds the others', () => {
		const database = productionWithRows();
		const real = database.prepare.bind(database);
		vi.spyOn(database, 'prepare').mockImplementation(((source: string) => {
			if (source === 'PRAGMA table_xinfo("settings")') throw new Error('disk I/O error');
			return real(source);
		}) as typeof database.prepare);

		const { report, errors } = reporting({ database, migrationsDir: REAL_MIGRATIONS });

		// Whether it differs is not known, and nothing here says it does: it was
		// not compared, which is a stage of its own.
		const reason = 'its structure could not be read: disk I/O error';
		expect(report.leftAlone).toEqual([{ table: 'settings', stage: 'compare', reason, whatToDo: A_FAILURE_TO_READ }]);
		expect(report.rebuilt.map((r) => r.table)).toEqual(['columns', 'categories', 'user_xp', 'invite_tokens']);
		expect(errors[0]).toBe(notComparedLine('settings', reason, A_FAILURE_TO_READ));

		// The schema check reads every table, and cannot read this one either.
		// That is not a difference, and the line does not count it as one: it
		// used to say the database "differs from the model in 1 place(s)".
		expect(errors).toHaveLength(2);
		expect(errors[1]).toBe(
			'[ERROR] [DB] The database could not be compared with the model: disk I/O error. Nothing was changed and ' +
				'start-up continues. This is a failure to read the database, not a difference found in it. Check the ' +
				`disk and the database file. ${UNTIL_DEALT_WITH}`
		);
		// It is in the report all the same, where a difference would be.
		expect(report.schemaDifferences).toEqual(['the comparison could not be made: disk I/O error']);
	});

	it('leaves alone a table it cannot read while planning its rebuild, and does not call that a fault in the table', () => {
		// It was compared, and it differs. Then the count of its NULL keys, which
		// a guard needs, cannot be read. Nothing was found in the table: the
		// database would not answer.
		const database = productionWithRows();
		const real = database.prepare.bind(database);
		vi.spyOn(database, 'prepare').mockImplementation(((source: string) => {
			if (source === 'SELECT COUNT(*) AS n FROM "settings" WHERE "key" IS NULL') throw new Error('disk I/O error');
			return real(source);
		}) as typeof database.prepare);

		const { report, errors } = reporting({ database, migrationsDir: REAL_MIGRATIONS });

		const reason = 'reading it to plan a rebuild failed: disk I/O error';
		const whatToDo =
			'This is a failure to read the database, not something found in the table. Check the disk and the database file.';
		expect(report.leftAlone).toEqual([{ table: 'settings', stage: 'guard', reason, whatToDo }]);
		expect(errors[0]).toBe(leftAloneLine('settings', reason, whatToDo));
		expect(report.rebuilt.map((r) => r.table)).toEqual(['columns', 'categories', 'user_xp', 'invite_tokens']);
	});

	it('makes an ordinary board of a sub-board whose card has gone, deletes nothing, and rebuilds boards', () => {
		// A database from before card 2006 had no foreign key on
		// boards.parent_card_id, so nothing removed a sub-board when its card was
		// deleted. One left behind like that would break the key the model
		// declares. It is detached (decision 14): boards 1 and 2 are ordinary,
		// board 3 is the sub-board of card 1, which exists, and board 6 was the
		// sub-board of card 99, which does not.
		const database = preCardWithRows();
		database.exec(
			"INSERT INTO boards (id, name, emoji, parent_card_id, is_public, created_by) VALUES (6, 'Left behind', '🧹', 99, 1, 2)"
		);
		const board = (id: number) => database.prepare('SELECT * FROM boards WHERE id = ?').get(id) as Record<string, unknown>;
		const orphan = board(6);
		const before = contentsOf(database);
		const differed = { boards: differencesOf(database, 'boards'), categories: differencesOf(database, 'categories') };
		process.env.LOG_LEVEL = 'WARN';
		const lines: { line: string; inTransaction: boolean }[] = [];
		vi.spyOn(console, 'warn').mockImplementation((line) => {
			lines.push({ line: String(line).replace(/^\[[^\]]+\] /, ''), inTransaction: database.inTransaction });
		});

		const { report, errors } = reporting({ database, migrationsDir: REAL_MIGRATIONS });

		// First, so that if the rebuild was rolled back this says why.
		expect(report.leftAlone).toEqual([]);
		expect(report.detachedSubBoards).toEqual([{ id: 6, name: 'Left behind', parentCardId: 99 }]);
		expect(report.rebuilt).toEqual([
			{ table: 'boards', rows: 4, defaulted: [], differences: differed.boards },
			{ table: 'categories', rows: 3, defaulted: [], differences: differed.categories }
		]);
		// The key `boards` gains is the reason anything was detached at all.
		expect(differed.boards).toContain(
			'boards: foreign key in the model but not in the database: (parent_card_id) references cards(id), on update NO ACTION, on delete CASCADE'
		);
		// `boards` has the model's shape, and so has everything else.
		expect(report.schemaDifferences).toEqual([]);
		expect(errors).toEqual([]);

		// The orphan is still a board, the same in every way but the one.
		expect(board(6)).toEqual({ ...orphan, parent_card_id: null });
		// The sub-board whose card exists still belongs to it.
		expect(board(3).parent_card_id).toBe(1);
		// Every board is still there, and so is every row of every other table:
		// the whole database differs by one value.
		expect(idsIn(database, 'boards')).toEqual([1, 2, 3, 6]);
		expect(contentsOf(database)).toEqual({
			...before,
			boards: before.boards.map((row) => row.replace('"parent_card_id":99', '"parent_card_id":null')).sort()
		});
		expect(database.pragma('foreign_key_check')).toEqual([]);
		expect(foreignKeysOn(database)).toBe(true);

		// Logged by id and by name, with the card it had, which is now recorded
		// nowhere else. After the commit: none of it from inside the transaction.
		expect(lines.map((entry) => entry.line).filter((line) => line.includes('detached'))).toEqual([
			'[WARN] [DB] Sub-board 6 (Left behind) detached while boards was rebuilt: its card, 99, no longer exists, ' +
				'so its parent_card_id was cleared and it is now an ordinary board. Nothing was deleted.'
		]);
		expect(lines.filter((entry) => entry.inTransaction)).toEqual([]);

		// The key it was all for now works: a sub-board goes with its card, and
		// the board that was detached is nobody's sub-board and stays.
		database.prepare('DELETE FROM cards WHERE id = 1').run();
		expect(idsIn(database, 'boards')).toEqual([1, 2, 6]);

		// And the next start has nothing to detach and nothing to rebuild.
		const again = runMigrations({ database, migrationsDir: REAL_MIGRATIONS });
		expect(again.detachedSubBoards).toEqual([]);
		expect(again.rebuilt).toEqual([]);
		expect(again.schemaDifferences).toEqual([]);
	});

	it.each([
		[
			'clears nothing',
			'UPDATE "boards" SET "parent_card_id" = NULL WHERE 0',
			'after: 2 set, adding up to 100'
		],
		[
			'clears the card of a sub-board that still has one, as well',
			'UPDATE "boards" SET "parent_card_id" = NULL',
			'after: 0 set, adding up to 0'
		],
		[
			'clears the right number of boards and the wrong one',
			'UPDATE "boards" SET "parent_card_id" = NULL WHERE "id" = 3',
			'after: 1 set, adding up to 99'
		]
	])('rolls the rebuild back if the detaching %s, rather than let it pass', (_what, instead, found) => {
		// The rebuild's check is told to expect the references of the orphaned
		// sub-boards to have gone: here one of them, adding up to 99. It has to
		// be exactly that. The second case is the one no other check would see:
		// board 3 loses the card it still has, and a NULL breaks no foreign key
		// and removes no row. If the check merely excused this column, or allowed
		// "up to" so many, the rebuild would succeed and say nothing.
		//
		// The statement that does the detaching is swapped for another as it is
		// prepared, which is the only way to see the check from outside.
		const database = preCardWithRows();
		database.exec("INSERT INTO boards (id, name, parent_card_id) VALUES (6, 'Left behind', 99)");
		const master = masterOf(database);
		const before = contentsOf(database);
		const real = database.prepare.bind(database);
		let swapped = 0;
		vi.spyOn(database, 'prepare').mockImplementation(((source: string) => {
			if (!/^UPDATE "boards" SET "parent_card_id" = NULL/.test(source)) return real(source);
			swapped++;
			return real(instead);
		}) as typeof database.prepare);

		const { report, errors } = reporting({ database, migrationsDir: REAL_MIGRATIONS });

		expect(swapped).toBe(1);
		expect(report.rebuilt).toEqual([]);
		expect(report.detachedSubBoards).toEqual([]);
		const reason = report.leftAlone[0].reason;
		expect(report.leftAlone).toEqual([
			{ table: 'boards', stage: 'rebuild', reason, whatToDo: A_FAULT_IN_THE_REBUILD },
			{ table: 'categories', stage: 'rebuild', reason, whatToDo: A_FAULT_IN_THE_REBUILD }
		]);
		expect(reason).toContain(
			'the rebuild was rolled back: it changed what it must leave alone: values in boards.parent_card_id ' +
				'(before: 2 set, adding up to 100; expected, with 1 orphaned sub-board(s) detached: 1 set, adding up to 1; ' +
				`${found})`
		);
		expect(errors[0]).toBe(notRebuiltLine(['boards', 'categories'], reason, A_FAULT_IN_THE_REBUILD));
		// Nothing detached after all, nothing rebuilt, nothing lost.
		expect(masterOf(database)).toEqual(master);
		expect(contentsOf(database)).toEqual(before);
		expect(foreignKeysOn(database)).toBe(true);
		expect(database.inTransaction).toBe(false);
		expect(scratchTablesIn(database)).toEqual([]);
	});

	it('detaches nothing where boards already has a key to cards, and changes no reference there', () => {
		// Detaching is for one case: `boards` is about to gain the key. Here it
		// has the key already, as production's does, and is rebuilt for another
		// reason, the rule on `created_by`. A board that breaks the key all the
		// same (put there with foreign keys off) is not this rebuild's to judge.
		// It is carried across as it is, like every other row.
		const database = memoryDb();
		runMigrations({ database, migrationsDir: REAL_MIGRATIONS });
		seed(database);
		database.pragma('foreign_keys = OFF');
		database.exec(`
			CREATE TABLE boards_older (
				id INTEGER PRIMARY KEY AUTOINCREMENT NOT NULL,
				name TEXT NOT NULL,
				emoji TEXT DEFAULT '📋',
				parent_card_id INTEGER REFERENCES cards(id) ON DELETE CASCADE,
				category_id INTEGER,
				is_public INTEGER DEFAULT false NOT NULL,
				created_by INTEGER REFERENCES users(id),
				created_at TEXT DEFAULT (datetime('now')) NOT NULL,
				updated_at TEXT DEFAULT (datetime('now')) NOT NULL
			);
			INSERT INTO boards_older (id, name, emoji, parent_card_id, category_id, is_public, created_by, created_at, updated_at)
				SELECT id, name, emoji, parent_card_id, category_id, is_public, created_by, created_at, updated_at FROM boards;
			DROP TABLE boards;
			ALTER TABLE boards_older RENAME TO boards;
			INSERT INTO boards (id, name, parent_card_id) VALUES (6, 'Left behind', 99);
		`);
		database.pragma('foreign_keys = ON');
		const boards = () => database.prepare('SELECT id, parent_card_id FROM boards ORDER BY id').all();
		const before = boards();
		expect(before).toContainEqual({ id: 6, parent_card_id: 99 });

		const report = runMigrations({ database, migrationsDir: REAL_MIGRATIONS });

		expect(report.rebuilt).toEqual([
			{
				table: 'boards',
				rows: 4,
				defaulted: [],
				differences: [
					'boards: foreign key in the database but not in the model: (created_by) references users(id), on update NO ACTION, on delete NO ACTION',
					'boards: foreign key in the model but not in the database: (created_by) references users(id), on update NO ACTION, on delete SET NULL',
					// 0053 made these, and they went with the table this test replaced.
					'boards: index in the model but not in the database: index idx_boards_created_by on (created_by)',
					'boards: index in the model but not in the database: index idx_boards_parent_card_id on (parent_card_id)'
				]
			}
		]);
		expect(report.leftAlone).toEqual([]);
		expect(report.detachedSubBoards).toEqual([]);
		expect(report.schemaDifferences).toEqual([]);
		expect(boards()).toEqual(before);
	});

	it('rebuilds a table one of whose rows already broke a foreign key, where the rebuild changes that key’s rule', () => {
		// A board created by a user who does not exist, put there with foreign
		// keys off. `boards` is as it was before card 2006, where the key on
		// `created_by` has no ON DELETE rule, and the model's has SET NULL. The
		// row breaks the key before the rebuild and breaks it afterwards: one
		// violation, the same one. Named with its rule, it used to be counted as
		// one violation gone and another appeared, and for that one row all six
		// tables were left alone, as a fault in the rebuild.
		//
		// The other five are in production's shape, so that all six are to be
		// rebuilt together.
		const database = productionWithRows();
		const older = (
			preCardDatabase().prepare("SELECT sql FROM sqlite_master WHERE type = 'table' AND name = 'boards'").get() as {
				sql: string;
			}
		).sql;
		database.pragma('foreign_keys = OFF');
		database.exec(`
			CREATE TEMP TABLE boards_kept AS SELECT * FROM boards;
			DROP TABLE boards;
			${older};
			INSERT INTO boards (id, name, emoji, parent_card_id, category_id, is_public, created_by, created_at, updated_at)
				SELECT id, name, emoji, parent_card_id, category_id, is_public, created_by, created_at, updated_at FROM boards_kept;
			DROP TABLE boards_kept;
			INSERT INTO boards (id, name, created_by) VALUES (6, 'By nobody', 99);
		`);
		database.pragma('foreign_keys = ON');
		const differed = differencesOf(database, 'boards');
		expect(differed).toContain(
			'boards: foreign key in the database but not in the model: (created_by) references users(id), on update NO ACTION, on delete NO ACTION'
		);
		expect(differed).toContain(
			'boards: foreign key in the model but not in the database: (created_by) references users(id), on update NO ACTION, on delete SET NULL'
		);
		const broken = () =>
			(database.pragma('foreign_key_check') as { table: string; rowid: number; parent: string }[]).map(
				({ table, rowid, parent }) => ({ table, rowid, parent })
			);
		expect(broken()).toEqual([{ table: 'boards', rowid: 6, parent: 'users' }]);
		const before = contentsOf(database);

		const { report, errors } = reporting({ database, migrationsDir: REAL_MIGRATIONS });

		// First, so that if the rebuild was rolled back this says why.
		expect(report.leftAlone).toEqual([]);
		expect(errors).toEqual([]);
		expect(report.rebuilt.map((table) => table.table)).toEqual(['boards', ...OLDER_ON_PRODUCTION]);
		expect(report.detachedSubBoards).toEqual([]);
		expect(report.schemaDifferences).toEqual([]);
		// The row is not this rebuild's to judge. It is carried across as it is,
		// and it breaks the key as it did: once, and nothing else breaks one.
		expect(database.prepare('SELECT id, name, created_by FROM boards WHERE id = 6').get()).toEqual({
			id: 6,
			name: 'By nobody',
			created_by: 99
		});
		expect(broken()).toEqual([{ table: 'boards', rowid: 6, parent: 'users' }]);
		expect(contentsOf(database)).toEqual(afterRebuild(before));
		expect(foreignKeysOn(database)).toBe(true);
	});

	it('rebuilds a table one of whose rows broke a foreign key that the model does not have', () => {
		// The other way a broken key can read as a change. The table has a key
		// the model has not, and a row that breaks it. Rebuilt, the table has no
		// such key, so nothing breaks it: one violation before and none after,
		// and no row was touched. The key going is what the rebuild is for, and
		// its line says so.
		const model = ['CREATE TABLE `invite_tokens` (\n\t`token` text PRIMARY KEY NOT NULL,\n\t`user_id` integer\n);'];
		const database = memoryDb();
		database.pragma('foreign_keys = OFF');
		database.exec(`
			CREATE TABLE users (id INTEGER PRIMARY KEY);
			INSERT INTO users (id) VALUES (1);
			CREATE TABLE invite_tokens (token TEXT PRIMARY KEY NOT NULL, user_id INTEGER REFERENCES users(id));
			INSERT INTO invite_tokens (token, user_id) VALUES ('for-ann', 1), ('for-nobody', 99);
		`);
		database.pragma('foreign_keys = ON');
		const broken = () =>
			(database.pragma('foreign_key_check') as { table: string; parent: string }[]).map(({ table, parent }) => ({
				table,
				parent
			}));
		expect(broken()).toEqual([{ table: 'invite_tokens', parent: 'users' }]);

		const outcome = reconcileSchema(database, model);

		expect(outcome.leftAlone).toEqual([]);
		expect(outcome.rebuilt.map((table) => [table.table, table.rows])).toEqual([['invite_tokens', 2]]);
		expect(outcome.rebuilt[0].differences).toEqual([
			'invite_tokens: foreign key in the database but not in the model: (user_id) references users(id), on update NO ACTION, on delete NO ACTION'
		]);
		expect(database.prepare('SELECT token, user_id FROM invite_tokens ORDER BY token').all()).toEqual([
			{ token: 'for-ann', user_id: 1 },
			{ token: 'for-nobody', user_id: 99 }
		]);
		expect(broken()).toEqual([]);
		expect(foreignKeysOn(database)).toBe(true);
	});

	/*
	 * The rebuild's own checks, one test for each. The rebuild never does the
	 * thing a check is there to catch, so each test does it instead, by having
	 * the database prepare another statement in place of one of the rebuild's.
	 * In every one of them the rebuild must be rolled back and the reason must
	 * name what the check found: delete the check and the test fails, because
	 * either the rebuild goes through or the reason no longer mentions it.
	 */

	/** Asserts what is the same for every rebuild that one of its own checks stopped. */
	function expectRolledBack(
		database: Database.Database,
		was: { master: unknown; contents: Record<string, string[]> },
		outcome: { report: MigrationReport; errors: string[] },
		whatToDo: string = A_FAULT_IN_THE_REBUILD
	): string {
		const { report, errors } = outcome;
		expect(report.rebuilt).toEqual([]);
		const reason = report.leftAlone[0].reason;
		expect(report.leftAlone).toEqual(
			OLDER_ON_PRODUCTION.map((table) => ({ table, stage: 'rebuild', reason, whatToDo }))
		);
		expect(reason.startsWith('the rebuild was rolled back: ')).toBe(true);
		expect(errors[0]).toBe(notRebuiltLine(OLDER_ON_PRODUCTION, reason, whatToDo));
		// Nothing of it is left: the old shapes, every row, every id counter.
		vi.restoreAllMocks();
		expect(masterOf(database)).toEqual(was.master);
		expect(contentsOf(database)).toEqual(was.contents);
		expect(scratchTablesIn(database)).toEqual([]);
		expect(foreignKeysOn(database)).toBe(true);
		expect(database.inTransaction).toBe(false);
		return reason;
	}

	it('rolls the rebuild back if the copy changes a value that is not a key, which no other check would notice', () => {
		// The whole-database comparison counts rows and adds up foreign key
		// columns. A title is neither. Here the copy of `columns` carries every
		// row, every id and every board_id, and blanks every title: before the
		// copy was compared with the table, that rebuild was committed.
		const database = productionWithRows();
		const was = { master: masterOf(database), contents: contentsOf(database) };
		const replaced = replacing(database, (source, real) => {
			if (!source.startsWith('INSERT INTO "columns_rebuild_2006"')) return undefined;
			const [into, from] = source.split(' SELECT ');
			expect(from).toContain('"title"');
			return real(`${into} SELECT ${from.replace('"title"', "''")}`);
		});

		const outcome = reporting({ database, migrationsDir: REAL_MIGRATIONS });

		expect(replaced()).toBe(1);
		const reason = expectRolledBack(database, was, outcome);
		// Which column, and a value from each side, so that the line can be acted on.
		expect(reason).toBe(
			'the rebuild was rolled back: the copy of columns would not hold its rows as they are: ' +
				"columns.title: 2 value(s) in the table are not in the copy, such as 'Doing', " +
				"and the copy has 1 that the table has not, such as ''"
		);
		expect(database.prepare('SELECT title FROM columns ORDER BY id').all()).toEqual([
			{ title: 'To Do' },
			{ title: 'Doing' },
			{ title: 'To Do' }
		]);
	});

	it('rolls the rebuild back if the old table is renamed out of the way and dropped afterwards', () => {
		// The order that looks harmless and is not. Renaming `columns` away
		// rewrites the foreign keys of `cards` and `daily_snapshots` to follow
		// it, and dropping it then leaves them pointing at a table that is gone.
		// `columns` itself comes out perfect. What shows it is the definition of
		// the tables that were never meant to be touched.
		const database = productionWithRows();
		const was = { master: masterOf(database), contents: contentsOf(database) };
		const replaced = replacing(database, (source, real) => {
			if (source === 'DROP TABLE "columns"') return real('ALTER TABLE "columns" RENAME TO "columns_out_of_the_way"');
			if (source === 'ALTER TABLE "columns_rebuild_2006" RENAME TO "columns"') {
				return {
					run: () => {
						real(source).run();
						return real('DROP TABLE "columns_out_of_the_way"').run();
					}
				};
			}
			return undefined;
		});

		const outcome = reporting({ database, migrationsDir: REAL_MIGRATIONS });

		expect(replaced()).toBe(2);
		const reason = expectRolledBack(database, was, outcome);
		expect(reason).toContain('it changed what it must leave alone: ');
		expect(reason).toContain('the definition of table cards (before: ');
		expect(reason).toContain('the definition of table daily_snapshots (before: ');
	});

	it('rolls the rebuild back if a table loses its id counter, so that an id could be given out twice', () => {
		// `columns` has had a column 7, since deleted, and its highest id in use
		// is 4. Dropped and made again, it would count from 4, and the next
		// column would be given an id that something may still remember. Nothing
		// about the rows shows that. Only the counter does.
		const database = productionWithRows();
		expect(sequenceIn(database, 'columns')).toBe(7);
		expect(sequenceIn(database, 'categories')).toBe(9);
		const was = { master: masterOf(database), contents: contentsOf(database) };
		const replaced = replacing(database, (source, real) =>
			// In place of writing the counter back: nothing, with the same two parameters.
			source === 'INSERT INTO sqlite_sequence (name, seq) VALUES (?, ?)' ? real('SELECT ?, ?') : undefined
		);

		const outcome = reporting({ database, migrationsDir: REAL_MIGRATIONS });

		// The two of the five that have a counter.
		expect(replaced()).toBe(2);
		const reason = expectRolledBack(database, was, outcome);
		expect(reason).toContain('the id counter of columns (before: 7; after: none)');
		expect(reason).toContain('the id counter of categories (before: 9; after: none)');
		expect(sequenceIn(database, 'columns')).toBe(7);
	});

	it('rolls the rebuild back if a foreign key column comes out different, though every row is there', () => {
		// Every column moved to board 1. No row is lost, no row breaks a foreign
		// key, and one board has lost its columns. It is done to the new table
		// after the copy has been checked against the old one, which is as late
		// as a value can go wrong; what catches it is the count and the sum of
		// every foreign key column, taken before and after.
		const database = productionWithRows();
		const was = { master: masterOf(database), contents: contentsOf(database) };
		const replaced = replacing(database, (source, real) =>
			source === 'DROP TABLE "columns"'
				? {
						run: () => {
							real('UPDATE "columns_rebuild_2006" SET "board_id" = 1').run();
							return real(source).run();
						}
					}
				: undefined
		);

		const outcome = reporting({ database, migrationsDir: REAL_MIGRATIONS });

		expect(replaced()).toBe(1);
		const reason = expectRolledBack(database, was, outcome);
		expect(reason).toBe(
			'the rebuild was rolled back: it changed what it must leave alone: ' +
				'values in columns.board_id (before: 3 set, adding up to 4; after: 3 set, adding up to 3)'
		);
	});

	it('rolls the rebuild back if the rows come out with other ids, which breaks every key that pointed at them', () => {
		// The damage here is in tables the rebuild never touches, and not in
		// their rows or their definitions: every card still has the column_id it
		// had, and no column has that id any more. Only a check of the foreign
		// keys themselves, before and after, finds it.
		const database = productionWithRows();
		const was = { master: masterOf(database), contents: contentsOf(database) };
		const replaced = replacing(database, (source, real) =>
			source === 'DROP TABLE "columns"'
				? {
						run: () => {
							real('UPDATE "columns_rebuild_2006" SET "id" = "id" + 100').run();
							return real(source).run();
						}
					}
				: undefined
		);

		const outcome = reporting({ database, migrationsDir: REAL_MIGRATIONS });

		expect(replaced()).toBe(1);
		const reason = expectRolledBack(database, was, outcome);
		expect(reason).toContain('it changed what it must leave alone: ');
		expect(reason).toContain(
			'foreign key violations in cards row 1: (column_id) references columns(id), on update NO ACTION, on delete CASCADE ' +
				'(before: none; after: 1; rowid 1)'
		);
		expect(reason).toContain('foreign key violations in daily_snapshots row ');
		// Nothing else had changed: it was the keys, and only the keys.
		expect(reason).not.toContain('rows in ');
		expect(reason).not.toContain('values in ');
		expect(reason).not.toContain('the definition of ');
	});

	it('leaves alone a value that the model’s column type would store differently, and says which', () => {
		// A column that is TEXT here and INTEGER in the model. Copied into the
		// model's table, the text '007' is stored as the integer 7, without an
		// error and without a word. A rebuild must not change a value, so this
		// is found before anything is dropped, and the table stays as it is.
		const model = ['CREATE TABLE `settings` (\n\t`key` text PRIMARY KEY NOT NULL,\n\t`value` integer\n);'];
		const database = memoryDb();
		database.exec(`
			CREATE TABLE settings (key TEXT PRIMARY KEY NOT NULL, value TEXT);
			INSERT INTO settings (key, value) VALUES ('code', '007'), ('note', 'not a number'), ('unset', NULL);
		`);
		const stored = () => database.prepare('SELECT key, value, typeof(value) AS stored FROM settings ORDER BY key').all();
		const asItWas = stored();
		expect(asItWas).toContainEqual({ key: 'code', value: '007', stored: 'text' });
		const untouched = entriesFor(database, 'settings');

		const { report, errors } = reporting({
			database,
			migrationsDir: migrationsDir({ '0001_nothing_new.sql': 'SELECT 1;' }),
			expectedSchema: model
		});

		const reason =
			'the rebuild was rolled back: the copy of settings would not hold its rows as they are: ' +
			"settings.value: 1 value(s) in the table are not in the copy, such as '007', " +
			'and the copy has 1 that the table has not, such as 7; ' +
			"the table's column is TEXT and the model's is INTEGER";
		// Not a fault in the rebuild this time, and it does not say so: it is the
		// column and its values that do not agree, and that takes a migration.
		const whatToDo =
			"The table's column and the model's have different types, and SQLite stores such a value differently in " +
			"the model's. A rebuild must not change a value, so it will not do this one: the table needs a " +
			'migration that says what each value is to become. Report this line.';
		expect(report.rebuilt).toEqual([]);
		expect(report.leftAlone).toEqual([{ table: 'settings', stage: 'rebuild', reason, whatToDo }]);
		expect(errors[0]).toBe(notRebuiltLine(['settings'], reason, whatToDo));
		// Not converted: the same values, of the same types, in the same table.
		expect(stored()).toEqual(asItWas);
		expect(entriesFor(database, 'settings')).toEqual(untouched);
		expect(scratchTablesIn(database)).toEqual([]);
		expect(foreignKeysOn(database)).toBe(true);
		expect(report.schemaDifferences).toEqual(['settings.value: type is TEXT; the model has INTEGER']);

		// It is the value that is refused, not the difference in type. Text that
		// is not a number is text in either column, and a NULL is a NULL: with
		// the one value gone that would have changed, the table is rebuilt.
		database.exec("DELETE FROM settings WHERE key = 'code'");
		const after = reconcileSchema(database, model);
		expect(after.leftAlone).toEqual([]);
		expect(after.rebuilt.map((table) => table.table)).toEqual(['settings']);
		expect(stored()).toEqual([
			{ key: 'note', value: 'not a number', stored: 'text' },
			{ key: 'unset', value: null, stored: 'null' }
		]);
	});

	it('leaves out a table whose values would change in the copy, and rebuilds the others in the same start', () => {
		// The copy is checked inside the rebuild's transaction, so finding this
		// rolls back every table in it. It is one table's values that are in the
		// way and not the rebuild, so the rebuild is done again without that
		// table: the others are not left waiting on a migration only it needs.
		//
		// The table in the way is the last of the three, so the first attempt
		// has dropped two tables and put their copies in their place by the time
		// it finds this. That is what has to be undone before it tries again.
		const model = [
			'CREATE TABLE `settings` (\n\t`key` text PRIMARY KEY NOT NULL,\n\t`value` text\n);',
			'CREATE TABLE `user_xp` (\n\t`name` text PRIMARY KEY NOT NULL,\n\t`xp` integer\n);',
			'CREATE TABLE `invite_tokens` (\n\t`token` text PRIMARY KEY NOT NULL,\n\t`uses` integer\n);'
		];
		const database = memoryDb();
		database.exec(`
			CREATE TABLE settings (key TEXT PRIMARY KEY, value TEXT);
			INSERT INTO settings (key, value) VALUES ('theme', 'dark');
			CREATE TABLE user_xp (name TEXT PRIMARY KEY, xp INTEGER);
			INSERT INTO user_xp (name, xp) VALUES ('ann', 120);
			CREATE TABLE invite_tokens (token TEXT PRIMARY KEY NOT NULL, uses TEXT);
			INSERT INTO invite_tokens (token, uses) VALUES ('abc', '007');
		`);
		const untouched = entriesFor(database, 'invite_tokens');
		// Every table dropped, in order, with nothing replaced.
		const dropped: string[] = [];
		replacing(database, (source) => {
			if (/^DROP TABLE "/.test(source)) dropped.push(source);
			return undefined;
		});
		const options = {
			database,
			migrationsDir: migrationsDir({ '0001_nothing_new.sql': 'SELECT 1;' }),
			expectedSchema: model
		};

		const { report, errors } = reporting(options);

		// Two in the attempt that was rolled back, and the same two in the next.
		expect(dropped).toEqual([
			'DROP TABLE "settings"',
			'DROP TABLE "user_xp"',
			'DROP TABLE "settings"',
			'DROP TABLE "user_xp"'
		]);
		const found =
			'the copy of invite_tokens would not hold its rows as they are: ' +
			"invite_tokens.uses: 1 value(s) in the table are not in the copy, such as '007', " +
			'and the copy has 1 that the table has not, such as 7; ' +
			"the table's column is TEXT and the model's is INTEGER";
		const reason = `the rebuild was rolled back because of it, and tried again without it: ${found}`;
		expect(report.leftAlone).toEqual([
			{ table: 'invite_tokens', stage: 'rebuild', reason, whatToDo: VALUES_OF_ANOTHER_TYPE }
		]);
		// One line, about the one table: the two that went ahead are not in it.
		// Then the schema check, which has that table's one difference to report.
		const stillDiffers =
			'[ERROR] [DB] The database differs from the model in 1 place(s): invite_tokens.uses: type is TEXT; the model ' +
			'has INTEGER. Nothing was changed for these and start-up continues. That is expected when an older build is ' +
			'started against a newer database, and when one of boards, columns, categories, settings, user_xp, ' +
			'invite_tokens was left in the shape it has, which has a line of its own above; otherwise the model has a ' +
			'change that no migration makes, or the database was changed outside the migrations.';
		expect(errors).toEqual([notRebuiltLine(['invite_tokens'], reason, VALUES_OF_ANOTHER_TYPE), stillDiffers]);
		expect(report.rebuilt.map((table) => table.table)).toEqual(['settings', 'user_xp']);
		expect(database.prepare('SELECT key, value FROM settings').all()).toEqual([{ key: 'theme', value: 'dark' }]);
		expect(database.prepare('SELECT name, xp FROM user_xp').all()).toEqual([{ name: 'ann', xp: 120 }]);
		// The one left out is exactly as it was, value and type.
		const leftOut = () => database.prepare('SELECT token, uses, typeof(uses) AS stored FROM invite_tokens').all();
		expect(leftOut()).toEqual([{ token: 'abc', uses: '007', stored: 'text' }]);
		expect(entriesFor(database, 'invite_tokens')).toEqual(untouched);
		expect(scratchTablesIn(database)).toEqual([]);
		expect(foreignKeysOn(database)).toBe(true);
		expect(database.inTransaction).toBe(false);
		expect(report.schemaDifferences).toEqual(['invite_tokens.uses: type is TEXT; the model has INTEGER']);

		// The next start has the one table left to look at. It rebuilds nothing,
		// and says of that table what it said before: this time the rebuild held
		// no other table, so there was none to try again with.
		const master = masterOf(database);
		const again = reporting(options);
		expect(again.report.rebuilt).toEqual([]);
		const reasonAgain = `the rebuild was rolled back: ${found}`;
		expect(again.report.leftAlone).toEqual([
			{ table: 'invite_tokens', stage: 'rebuild', reason: reasonAgain, whatToDo: VALUES_OF_ANOTHER_TYPE }
		]);
		expect(again.errors).toEqual([
			notRebuiltLine(['invite_tokens'], reasonAgain, VALUES_OF_ANOTHER_TYPE),
			stillDiffers
		]);
		expect(dropped).toHaveLength(4);
		expect(masterOf(database)).toEqual(master);
		expect(leftOut()).toEqual([{ token: 'abc', uses: '007', stored: 'text' }]);
	});

	it('does not try again after a failure that is the rebuild’s own, whichever table it shows in', () => {
		// Only a table's own values earn a second attempt. A check that means the
		// rebuild went wrong says nothing good about the rest of it either, so
		// every table in it stays as it was, the one above included.
		//
		// Three tables, and the third has nothing wrong with it. With two, the
		// attempt that fails holds one table, and leaving it alone looks the
		// same as trying again with nothing left. With three, trying again would
		// rebuild invite_tokens, and it must not.
		const model = [
			'CREATE TABLE `settings` (\n\t`key` text PRIMARY KEY NOT NULL,\n\t`value` integer\n);',
			'CREATE TABLE `user_xp` (\n\t`name` text PRIMARY KEY NOT NULL,\n\t`xp` integer\n);',
			'CREATE TABLE `invite_tokens` (\n\t`token` text PRIMARY KEY NOT NULL,\n\t`uses` integer\n);'
		];
		const database = memoryDb();
		database.exec(`
			CREATE TABLE settings (key TEXT PRIMARY KEY NOT NULL, value TEXT);
			INSERT INTO settings (key, value) VALUES ('code', '007');
			CREATE TABLE user_xp (name TEXT PRIMARY KEY, xp INTEGER);
			INSERT INTO user_xp (name, xp) VALUES ('ann', 120);
			CREATE TABLE invite_tokens (token TEXT PRIMARY KEY, uses INTEGER);
			INSERT INTO invite_tokens (token, uses) VALUES ('abc', 2);
		`);
		const was = masterOf(database);
		// The second attempt, the one without settings, loses a row on the way.
		const replaced = replacing(database, (source, real) =>
			source === 'DROP TABLE "user_xp"'
				? {
						run: () => {
							real('DELETE FROM "user_xp_rebuild_2006"').run();
							return real(source).run();
						}
					}
				: undefined
		);

		const outcome = reconcileSchema(database, model);

		expect(replaced()).toBe(1);
		vi.restoreAllMocks();
		expect(outcome.rebuilt).toEqual([]);
		const reason = outcome.leftAlone[1]?.reason;
		expect(reason).toBe(
			'the rebuild was rolled back: it changed what it must leave alone: rows in user_xp (before: 1; after: 0)'
		);
		expect(outcome.leftAlone).toEqual([
			{
				table: 'settings',
				stage: 'rebuild',
				reason: expect.stringMatching(/^the rebuild was rolled back because of it, and tried again without it: /),
				whatToDo: VALUES_OF_ANOTHER_TYPE
			},
			{ table: 'user_xp', stage: 'rebuild', reason, whatToDo: A_FAULT_IN_THE_REBUILD },
			{ table: 'invite_tokens', stage: 'rebuild', reason, whatToDo: A_FAULT_IN_THE_REBUILD }
		]);
		expect(masterOf(database)).toEqual(was);
		expect(database.prepare('SELECT name, xp FROM user_xp').all()).toEqual([{ name: 'ann', xp: 120 }]);
		expect(database.prepare('SELECT token, uses FROM invite_tokens').all()).toEqual([{ token: 'abc', uses: 2 }]);
		expect(scratchTablesIn(database)).toEqual([]);
		expect(foreignKeysOn(database)).toBe(true);
	});

	/** Three tables to be rebuilt together. `settings.value` is TEXT here and INTEGER in the model. */
	const withAColumnOfAnotherType = (value: string) => {
		const model = [
			'CREATE TABLE `settings` (\n\t`key` text PRIMARY KEY NOT NULL,\n\t`value` integer\n);',
			'CREATE TABLE `user_xp` (\n\t`name` text PRIMARY KEY NOT NULL,\n\t`xp` integer\n);',
			'CREATE TABLE `invite_tokens` (\n\t`token` text PRIMARY KEY NOT NULL,\n\t`uses` integer\n);'
		];
		const database = memoryDb();
		database.exec(`
			CREATE TABLE settings (key TEXT PRIMARY KEY NOT NULL, value TEXT);
			CREATE TABLE user_xp (name TEXT PRIMARY KEY, xp INTEGER);
			INSERT INTO user_xp (name, xp) VALUES ('ann', 120);
			CREATE TABLE invite_tokens (token TEXT PRIMARY KEY, uses INTEGER);
			INSERT INTO invite_tokens (token, uses) VALUES ('abc', 2);
		`);
		database.prepare("INSERT INTO settings (key, value) VALUES ('note', ?)").run(value);
		return { database, model, tables: ['settings', 'user_xp', 'invite_tokens'] };
	};

	const temporaryTablesIn = (database: Database.Database) =>
		database.prepare('SELECT name FROM sqlite_temp_master').all();

	it('does not take a fault in the copy for a table’s own values because the column’s type is another', () => {
		// What `settings.value` holds is text in a TEXT column and text in an
		// INTEGER one: the difference in type changes nothing here. The copy is
		// made to write another value all the same. That the two types have
		// different names used to be enough for this to be called the table's
		// own values, so settings was left out and the other two were rebuilt,
		// by a rebuild that had just been seen to go wrong.
		const { database, model, tables } = withAColumnOfAnotherType('not a number');
		// The one file is applied first, so that the readings below differ from
		// the ones taken afterwards by the rebuild and by nothing else.
		const dir = migrationsDir({ '0001_nothing_new.sql': 'SELECT 1;' });
		applyFilesOnly(database, dir);
		const was = { master: masterOf(database), contents: contentsOf(database) };
		const replaced = replacing(database, (source, real) => {
			if (!source.startsWith('INSERT INTO "settings_rebuild_2006"')) return undefined;
			const [into, from] = source.split(' SELECT ');
			expect(from).toContain('"value"');
			return real(`${into} SELECT ${from.replace('"value"', "'something else'")}`);
		});

		const { report, errors } = reporting({ database, migrationsDir: dir, expectedSchema: model });

		expect(replaced()).toBe(1);
		vi.restoreAllMocks();
		expect(report.rebuilt).toEqual([]);
		const reason =
			'the rebuild was rolled back: the copy of settings would not hold its rows as they are: ' +
			"settings.value: 1 value(s) in the table are not in the copy, such as 'not a number', " +
			"and the copy has 1 that the table has not, such as 'something else'; " +
			"the table's column is TEXT and the model's is INTEGER";
		expect(report.leftAlone).toEqual(
			tables.map((table) => ({ table, stage: 'rebuild', reason, whatToDo: A_FAULT_IN_THE_REBUILD }))
		);
		expect(errors[0]).toBe(notRebuiltLine(tables, reason, A_FAULT_IN_THE_REBUILD));
		// Nothing of it is left, the table it was worked out in included.
		expect(masterOf(database)).toEqual(was.master);
		expect(contentsOf(database)).toEqual(was.contents);
		expect(scratchTablesIn(database)).toEqual([]);
		expect(temporaryTablesIn(database)).toEqual([]);
		expect(foreignKeysOn(database)).toBe(true);
		expect(database.inTransaction).toBe(false);
	});

	it('calls it a fault in the rebuild, and fails in no new way, when it cannot find out which of the two it is', () => {
		// These are the table's own values: '007' is stored as 7 in the model's
		// column. To know that, the values are put through a column of that type
		// in a table of their own, and here that cannot be done. Whether to try
		// again without the table depends on the answer, so with no answer it is
		// not tried. And what is reported is still what the check on the copy
		// found, not the failure to find out more.
		const { database, model, tables } = withAColumnOfAnotherType('007');
		const was = { master: masterOf(database), contents: contentsOf(database) };
		const replaced = replacing(database, (source) =>
			source.startsWith('INSERT INTO temp."settings_rebuild_2006_probe"')
				? {
						run: () => {
							throw new Error('disk I/O error');
						}
					}
				: undefined
		);

		const outcome = reconcileSchema(database, model);

		expect(replaced()).toBe(1);
		vi.restoreAllMocks();
		expect(outcome.rebuilt).toEqual([]);
		const reason =
			'the rebuild was rolled back: the copy of settings would not hold its rows as they are: ' +
			"settings.value: 1 value(s) in the table are not in the copy, such as '007', " +
			'and the copy has 1 that the table has not, such as 7; ' +
			"the table's column is TEXT and the model's is INTEGER";
		expect(outcome.leftAlone).toEqual(
			tables.map((table) => ({ table, stage: 'rebuild', reason, whatToDo: A_FAULT_IN_THE_REBUILD }))
		);
		expect(masterOf(database)).toEqual(was.master);
		expect(contentsOf(database)).toEqual(was.contents);
		expect(scratchTablesIn(database)).toEqual([]);
		expect(temporaryTablesIn(database)).toEqual([]);
		expect(foreignKeysOn(database)).toBe(true);
		expect(database.inTransaction).toBe(false);
	});

	it('finds a value the copy changed after a NUL character, which is as far as quote() writes it', () => {
		// Text can hold a NUL, and quote() writes such a value up to the NUL and
		// no further: 'a', a NUL and 'b' is written 'a', and so is 'a', a NUL and
		// 'c'. Compared as quote() writes them, those were one value, and a copy
		// that turned the first into the second was committed.
		const model = ['CREATE TABLE `settings` (\n\t`key` text PRIMARY KEY NOT NULL,\n\t`value` text\n);'];
		const database = memoryDb();
		database.exec(`
			CREATE TABLE settings (key TEXT PRIMARY KEY, value TEXT);
			INSERT INTO settings (key, value) VALUES ('note', 'a' || char(0) || 'b');
		`);
		const stored = () =>
			database
				.prepare('SELECT key, hex(value) AS bytes, quote(value) AS written, typeof(value) AS stored FROM settings')
				.all();
		const asItWas = [{ key: 'note', bytes: '610062', written: "'a'", stored: 'text' }];
		expect(stored()).toEqual(asItWas);
		const untouched = entriesFor(database, 'settings');
		const replaced = replacing(database, (source, real) => {
			if (!source.startsWith('INSERT INTO "settings_rebuild_2006"')) return undefined;
			const [into, from] = source.split(' SELECT ');
			expect(from).toContain('"value"');
			return real(`${into} SELECT ${from.replace('"value"', "'a' || char(0) || 'c'")}`);
		});

		const outcome = reconcileSchema(database, model);

		expect(replaced()).toBe(1);
		vi.restoreAllMocks();
		expect(outcome.rebuilt).toEqual([]);
		expect(outcome.leftAlone).toEqual([
			{
				table: 'settings',
				stage: 'rebuild',
				// Each value is shown as quote() writes it, which for these two is
				// the same. That one is not the other is what the line says.
				reason:
					'the rebuild was rolled back: the copy of settings would not hold its rows as they are: ' +
					"settings.value: 1 value(s) in the table are not in the copy, such as 'a', " +
					"and the copy has 1 that the table has not, such as 'a'",
				whatToDo: A_FAULT_IN_THE_REBUILD
			}
		]);
		expect(stored()).toEqual(asItWas);
		expect(entriesFor(database, 'settings')).toEqual(untouched);
		expect(scratchTablesIn(database)).toEqual([]);
		expect(foreignKeysOn(database)).toBe(true);
	});

	it('leaves alone a table whose column the model generates and the database stores, and rebuilds the others', () => {
		// A generated column is computed, so a rebuild does not copy it. Where
		// the table's own column is an ordinary one, it holds values somebody
		// put there, and a rebuild would drop them with the table.
		const model = [
			'CREATE TABLE `settings` (\n\t`key` text PRIMARY KEY NOT NULL,\n\t`value` text,\n\t`shout` text GENERATED ALWAYS AS (upper(`value`)) VIRTUAL\n);',
			'CREATE TABLE `user_xp` (\n\t`name` text PRIMARY KEY NOT NULL,\n\t`xp` integer\n);'
		];
		const database = memoryDb();
		database.exec(`
			CREATE TABLE settings (key TEXT PRIMARY KEY NOT NULL, value TEXT, shout TEXT);
			INSERT INTO settings (key, value, shout) VALUES ('theme', 'dark', 'written by hand');
			CREATE TABLE user_xp (name TEXT PRIMARY KEY, xp INTEGER);
			INSERT INTO user_xp (name, xp) VALUES ('ann', 120);
		`);
		const untouched = entriesFor(database, 'settings');

		const outcome = reconcileSchema(database, model);

		expect(outcome.leftAlone).toEqual([
			{
				table: 'settings',
				stage: 'guard',
				reason:
					"the model's settings.shout is a generated column and the table's is an ordinary one, whose values would be discarded",
				whatToDo:
					'A rebuild must not discard a value. This needs a migration that says what becomes of the ones stored there. Report this line.'
			}
		]);
		expect(outcome.rebuilt.map((table) => table.table)).toEqual(['user_xp']);
		expect(entriesFor(database, 'settings')).toEqual(untouched);
		expect(database.prepare('SELECT shout FROM settings').all()).toEqual([{ shout: 'written by hand' }]);
	});

	it('leaves alone a table whose statement in the model names it twice, and rebuilds the others', () => {
		// drizzle-kit writes a CHECK constraint with the table's own name in it.
		// The table a rebuild builds has another name until the old one is
		// dropped, so such a statement cannot be used as it is: SQLite refuses
		// to create it, inside the rebuild's transaction, and every table in the
		// rebuild used to be rolled back with it. Now that one table is turned
		// away before anything begins.
		const model = [
			[
				'CREATE TABLE `settings` (',
				'\t`key` text PRIMARY KEY NOT NULL,',
				'\t`value` text,',
				'\tCONSTRAINT "settings_has_a_value" CHECK("settings"."value" IS NOT NULL)',
				');'
			].join('\n'),
			'CREATE TABLE `user_xp` (\n\t`name` text PRIMARY KEY NOT NULL,\n\t`xp` integer\n);'
		];
		const database = memoryDb();
		database.exec(`
			CREATE TABLE settings (key TEXT PRIMARY KEY, value TEXT);
			INSERT INTO settings (key, value) VALUES ('theme', 'dark');
			CREATE TABLE user_xp (name TEXT PRIMARY KEY, xp INTEGER);
			INSERT INTO user_xp (name, xp) VALUES ('ann', 120);
		`);
		const untouched = entriesFor(database, 'settings');

		const outcome = reconcileSchema(database, model);

		expect(outcome.leftAlone).toEqual([
			{
				table: 'settings',
				stage: 'guard',
				reason:
					'the model\'s statement for it names settings again after "CREATE TABLE `settings` (", as a CHECK ' +
					'constraint written by drizzle-kit does, and a rebuild renames only that opening',
				whatToDo:
					'This is a limit of the rebuild, not a fault in the database: it cannot build this table under another ' +
					'name. The table needs a migration of its own. Report this line.'
			}
		]);
		// The other one went ahead, in the same call.
		expect(outcome.rebuilt.map((table) => table.table)).toEqual(['user_xp']);
		expect(entriesFor(database, 'settings')).toEqual(untouched);
		expect(scratchTablesIn(database)).toEqual([]);
		expect(foreignKeysOn(database)).toBe(true);
	});

	it('reports a sub-board’s card as it was read, when what was there is not a whole number', () => {
		// The column is declared INTEGER, which does not stop it holding text.
		// There is no card with such an id, so the sub-board is detached like any
		// other, and what it pointed at is reported as it was: the log line is
		// the only record of it once it has been cleared.
		const database = preCardWithRows();
		database.exec("INSERT INTO boards (id, name, parent_card_id) VALUES (6, 'Left behind', 'card-99')");
		expect(database.prepare('SELECT typeof(parent_card_id) AS stored FROM boards WHERE id = 6').get()).toEqual({
			stored: 'text'
		});

		const { report, errors } = reporting({ database, migrationsDir: REAL_MIGRATIONS });

		expect(errors).toEqual([]);
		expect(report.detachedSubBoards).toEqual([{ id: 6, name: 'Left behind', parentCardId: 'card-99' }]);
		expect(report.rebuilt.map((table) => table.table)).toEqual(['boards', 'categories']);
		expect(database.prepare('SELECT parent_card_id FROM boards WHERE id = 6').get()).toEqual({ parent_card_id: null });
	});

	/** What the line says to do about a trigger or a view, which ends with the statement that does it. */
	const dropIt = (statement: string) =>
		'The application defines no trigger and no view, so this one came from outside it, and dropping the table ' +
		`would lose it or break it. Drop it and restart: ${statement}`;
	/** What it says to do about a table whose columns are not the model's. A rebuild is not the answer to that. */
	const COLUMNS_DIFFER =
		'A column on one side only is not another shape of the same table, and a rebuild never adds or drops a ' +
		'column. Either a migration that adds or removes it has not been applied to this database, or this ' +
		'build is older than the database and has no file for it, or the column was changed outside the ' +
		'migrations. The line beginning "The database differs from the model" names each such column. Start ' +
		'the build that matches the database, or supply the migration that is missing.';

	it.each<[string, string, string, string, string | null]>([
		[
			'a trigger on it',
			"CREATE TRIGGER categories_named AFTER INSERT ON categories BEGIN SELECT RAISE(ABORT, 'no') WHERE new.name = ''; END",
			'trigger categories_named belongs to it',
			dropIt('DROP TRIGGER "categories_named";'),
			'DROP TRIGGER "categories_named";'
		],
		[
			'a trigger on another table that mentions it',
			"CREATE TRIGGER cards_categorised AFTER INSERT ON cards BEGIN SELECT RAISE(ABORT, 'no') WHERE new.category_id NOT IN (SELECT id FROM categories); END",
			'trigger cards_categorised mentions it',
			dropIt('DROP TRIGGER "cards_categorised";'),
			'DROP TRIGGER "cards_categorised";'
		],
		[
			'a view that mentions it',
			'CREATE VIEW category_names AS SELECT name FROM categories',
			'view category_names mentions it',
			dropIt('DROP VIEW "category_names";'),
			'DROP VIEW "category_names";'
		],
		[
			'a column the model does not have',
			'ALTER TABLE categories ADD COLUMN icon TEXT',
			"its columns are (id, board_id, name, color, icon) and the model's are (id, board_id, name, color)",
			COLUMNS_DIFFER,
			null
		],
		[
			'a column of the model missing',
			'ALTER TABLE categories DROP COLUMN color',
			"its columns are (id, board_id, name) and the model's are (id, board_id, name, color)",
			COLUMNS_DIFFER,
			null
		],
		[
			'its scratch name in use',
			'CREATE TABLE categories_rebuild_2006 (id INTEGER)',
			'the name categories_rebuild_2006 is already in use by a table',
			'categories_rebuild_2006 is the name the new categories is built under before it takes the place of the old ' +
				'one. A rebuild never leaves it behind: it is renamed when the rebuild succeeds and rolled back when it ' +
				'does not. Check what this table is and whether anything in it is wanted, rename or drop it, and restart.',
			'DROP TABLE categories_rebuild_2006;'
		]
	])('leaves a table with %s as it is, says why and what to do, and rebuilds the others in the same start', (_what, addition, reason, whatToDo, remedy) => {
		const database = productionWithRows();
		database.exec(addition);
		const untouched = entriesFor(database, 'categories');
		const before = contentsOf(database);

		const { report, errors } = reporting({ database, migrationsDir: REAL_MIGRATIONS });

		expect(report.leftAlone).toEqual([{ table: 'categories', stage: 'guard', reason, whatToDo }]);
		expect(errors[0]).toBe(leftAloneLine('categories', reason, whatToDo));
		expect(entriesFor(database, 'categories')).toEqual(untouched);
		// The four that nothing was in the way of.
		expect(report.rebuilt.map((r) => r.table)).toEqual(['columns', 'settings', 'user_xp', 'invite_tokens']);
		expect(contentsOf(database)).toEqual(afterRebuild(before));
		// What the schema check still finds is about `categories`, or is the
		// thing that was put in its way, and is about none of those four.
		expect(report.schemaDifferences.filter(about('categories'))).not.toEqual([]);
		for (const table of report.rebuilt.map((r) => r.table)) {
			expect(report.schemaDifferences.filter(about(table))).toEqual([]);
		}
		expect(errors).toHaveLength(2);
		expect(foreignKeysOn(database)).toBe(true);
		expect(database.pragma('foreign_key_check')).toEqual([]);
		expect(database.inTransaction).toBe(false);

		// What the line says to do is what works: with that done, the next start
		// rebuilds the table and has nothing left to report. A table whose
		// columns are not the model's has no such remedy in SQL, and is told so.
		if (remedy) {
			if (/^DROP (TRIGGER|VIEW)/.test(remedy)) expect(whatToDo.endsWith(remedy)).toBe(true);
			database.exec(remedy);
			const after = runMigrations({ database, migrationsDir: REAL_MIGRATIONS });
			expect(after.rebuilt.map((r) => r.table)).toEqual(['categories']);
			expect(after.leftAlone).toEqual([]);
			expect(after.schemaDifferences).toEqual([]);
		}
	});

	it('rebuilds a table that another table refers to, and drops an index the model does not declare', () => {
		const database = productionWithRows();
		database.exec(`
			CREATE INDEX idx_categories_board ON categories (board_id);
			CREATE TABLE category_notes (
				id INTEGER PRIMARY KEY,
				category_id INTEGER REFERENCES categories(id) ON DELETE CASCADE,
				note TEXT
			);
			INSERT INTO category_notes (category_id, note) VALUES (1, 'first'), (5, 'second');
		`);
		const notes = () =>
			database.prepare("SELECT type, name, tbl_name, rootpage, sql FROM sqlite_master WHERE name = 'category_notes'").get();
		const notesBefore = notes();

		// `category_notes` is not in the model, and the schema check says so.
		const report = synthetic({ database, migrationsDir: REAL_MIGRATIONS });

		expect(report.rebuilt.map((r) => r.table)).toContain('categories');
		expect(report.schemaDifferences).toEqual(['category_notes: the table is in the database but not in the model']);
		// The index went with the old table. The model does not declare it, and
		// the rebuilt table is the model's, with the one index the model does
		// declare for it (0053, card 2106).
		expect(
			(database.prepare('PRAGMA index_list(categories)').all() as { name: string }[]).map((index) => index.name)
		).toEqual(['idx_categories_board_id']);
		// The other table was not touched, and still refers to `categories`.
		expect(notes()).toEqual(notesBefore);
		database.prepare('DELETE FROM categories WHERE id = 1').run();
		expect(database.prepare('SELECT category_id, note FROM category_notes').all()).toEqual([
			{ category_id: 5, note: 'second' }
		]);
	});

	it('recreates the indexes the model declares for a table it rebuilds', () => {
		// A made-up model in which `settings` has two indexes, one of them
		// unique. DROP TABLE removes a table's indexes with it, and the rebuild
		// has to put back the ones the model declares: four of the six have one
		// since 0053 (card 2106), and the production test below finds them.
		const model = [
			'CREATE TABLE `settings` (\n\t`key` text PRIMARY KEY NOT NULL,\n\t`value` text NOT NULL\n);',
			'CREATE INDEX `idx_settings_value` ON `settings` (`value`);',
			'CREATE UNIQUE INDEX `idx_settings_pair` ON `settings` (`value`,`key`);'
		];
		const database = memoryDb();
		database.exec(`
			CREATE TABLE settings (key TEXT PRIMARY KEY, value TEXT NOT NULL);
			CREATE INDEX idx_settings_old ON settings (value);
			INSERT INTO settings (key, value) VALUES ('smtp_host', 'mail.example.test'), ('theme', 'dark');
		`);
		const indexes = () =>
			(database.prepare('PRAGMA index_list(settings)').all() as { name: string; unique: number; origin: string }[])
				.map((index) => `${index.name}${index.unique ? ' (unique)' : ''}`)
				.sort();
		expect(indexes()).toEqual(['idx_settings_old', 'sqlite_autoindex_settings_1 (unique)']);
		const differed = differencesOf(database, 'settings', model);
		expect(differed).toEqual([
			'settings.key: is nullable; the model has it NOT NULL',
			'settings: index in the database but not in the model: index idx_settings_old on (value)',
			'settings: index in the model but not in the database: unique index idx_settings_pair on (value, key)',
			'settings: index in the model but not in the database: index idx_settings_value on (value)'
		]);

		expect(reconcileSchema(database, model)).toEqual({
			...NOTHING_TO_DO,
			rebuilt: [{ table: 'settings', rows: 2, defaulted: [], differences: differed }]
		});

		expect(indexes()).toEqual([
			'idx_settings_pair (unique)',
			'idx_settings_value',
			'sqlite_autoindex_settings_1 (unique)'
		]);
		expect(database.prepare('PRAGMA index_info(idx_settings_pair)').all()).toMatchObject([
			{ name: 'value' },
			{ name: 'key' }
		]);
		expect(database.prepare('SELECT key, value FROM settings ORDER BY key').all()).toEqual([
			{ key: 'smtp_host', value: 'mail.example.test' },
			{ key: 'theme', value: 'dark' }
		]);
		expect(schemaDifferences(database, model)).toEqual([]);
		expect(reconcileSchema(database, model)).toEqual(NOTHING_TO_DO);
	});

	it('leaves all six alone on a database that already has the model’s shapes', () => {
		const database = memoryDb();
		runMigrations({ database, migrationsDir: REAL_MIGRATIONS });
		const master = masterOf(database);

		expect(reconcileSchema(database)).toEqual(NOTHING_TO_DO);

		expect(masterOf(database)).toEqual(master);
		// A rebuilt table is stored under a double-quoted name; none of these ever was.
		for (const table of RECONCILED_TABLES) {
			const stored = database.prepare("SELECT sql FROM sqlite_master WHERE type = 'table' AND name = ?").get(table) as {
				sql: string;
			};
			expect(stored.sql.startsWith(`CREATE TABLE \`${table}\``)).toBe(true);
		}
	});

	it('touches nothing if a transaction is open, and says that is why', () => {
		// SQLite ignores `PRAGMA foreign_keys = OFF` inside a transaction, so a
		// rebuild started in one would drop its tables with foreign keys on. The
		// runner never gets this far with one open; this is the function alone.
		const database = productionWithRows();
		const master = masterOf(database);
		const before = contentsOf(database);

		database.exec('BEGIN');
		const outcome = reconcileSchema(database);
		expect(database.inTransaction).toBe(true);
		database.exec('ROLLBACK');

		const reason = 'a transaction is open on this connection, and foreign keys cannot be switched off inside one';
		expect(outcome).toEqual({
			...NOTHING_TO_DO,
			leftAlone: OLDER_ON_PRODUCTION.map((table) => ({
				table,
				stage: 'guard',
				reason,
				whatToDo: START_AGAIN_AND_REPORT
			}))
		});
		expect(masterOf(database)).toEqual(master);
		expect(contentsOf(database)).toEqual(before);
		expect(foreignKeysOn(database)).toBe(true);
	});

	it('reports and starts when the model itself cannot be read', () => {
		// A broken build, not a broken database: there is no shape to bring any
		// table to. The database is what it was yesterday, and it starts.
		const database = productionWithRows();
		const master = masterOf(database);

		const { report, errors } = reporting({
			database,
			migrationsDir: REAL_MIGRATIONS,
			expectedSchema: ['CREATE TABLE `settings` (']
		});

		const reason = 'the model could not be read: incomplete input';
		expect(report.rebuilt).toEqual([]);
		expect(report.leftAlone).toEqual(
			RECONCILED_TABLES.map((table) => ({ table, stage: 'compare', reason, whatToDo: THE_MODEL_IS_UNREADABLE }))
		);
		expect(report.schemaDifferences).toEqual(['the comparison could not be made: incomplete input']);
		// One line for each of the six, and the schema check's. None of them
		// sends anyone to look at the disk: it is the build that is at fault,
		// and every one says so and says what to do about a build.
		expect(errors).toHaveLength(7);
		expect(errors.slice(0, 6)).toEqual(
			RECONCILED_TABLES.map((table) => notComparedLine(table, reason, THE_MODEL_IS_UNREADABLE))
		);
		expect(errors[6]).toBe(
			'[ERROR] [DB] The database could not be compared with the model, because the model could not be read: ' +
				`incomplete input. Nothing was changed and start-up continues. ${THE_MODEL_IS_UNREADABLE} ${UNTIL_DEALT_WITH}`
		);
		expect(errors[6]).not.toContain('differs from the model');
		expect(masterOf(database)).toEqual(master);
	});

	it('does not reconcile at all a database that records a migration this build has no file for', () => {
		// The previous image, started after a newer one has been at the database.
		// A later card may have changed one of the six on purpose, and to this
		// build that would look like an older shape to be put right. So it puts
		// nothing right: here five tables are in an older shape and stay in it.
		const database = productionWithRows();
		database.prepare('INSERT INTO __drizzle_migrations (hash) VALUES (?)').run('0099_from_a_newer_build.sql');
		// Nor are its timestamps converted (card 2095, R5): a later build may
		// have chosen another form. This one is in the form before card 2095.
		database.prepare("UPDATE users SET created_at = '2026-10-14T08:00:00.000Z' WHERE id = 1").run();
		const master = masterOf(database);
		const before = contentsOf(database);

		const { report, errors } = reporting({ database, migrationsDir: REAL_MIGRATIONS });

		expect(report.missingFromDisk).toEqual(['0099_from_a_newer_build.sql']);
		expect(report.reconciliationSkipped).toBe(
			'the database records 1 migration(s) this build has no file for (0099_from_a_newer_build.sql), ' +
				'so it may be newer than this build'
		);
		// Not rebuilt, and not looked at either: nothing is "left alone".
		expect(report.rebuilt).toEqual([]);
		expect(report.leftAlone).toEqual([]);
		expect(report.detachedSubBoards).toEqual([]);
		expect(report.timestamps).toBeNull();
		expect(masterOf(database)).toEqual(master);
		expect(contentsOf(database)).toEqual(before);

		// One line says it, and says it once: what was found and what was
		// therefore not done. The schema check then reports the older shapes.
		expect(errors).toHaveLength(2);
		expect(errors[0]).toContain('[ERROR] [DB] 1 migration(s) are recorded as applied but have no file in');
		expect(errors[0]).toContain('0099_from_a_newer_build.sql');
		// It ends with what to do, which depends on how the database came to be
		// newer: on purpose, or because this image was built without a file.
		expect(
			errors[0].endsWith(
				'Schema reconciliation was skipped because of it: none of boards, columns, categories, settings, user_xp, ' +
					'invite_tokens was compared or reshaped, and no timestamp was converted to the stored form, since a build ' +
					'must not reshape a database that may be newer than it is. ' +
					'Starting anyway. This is expected after going back to the previous image on purpose, and is reported at ' +
					'every start until the newer image is started again. If that is not what was done, this image is missing ' +
					'a migration file: build it again from a complete checkout.'
			)
		).toBe(true);
		expect(report.schemaDifferences).toEqual([
			'categories.board_id: is NOT NULL; the model has it nullable',
			'categories: foreign key in the database but not in the model: (board_id) references boards(id), on update NO ACTION, on delete CASCADE',
			'categories: foreign key in the model but not in the database: (board_id) references boards(id), on update NO ACTION, on delete SET NULL',
			'columns.wip_limit: is nullable; the model has it NOT NULL',
			'invite_tokens.token: is nullable; the model has it NOT NULL',
			'settings.key: is nullable; the model has it NOT NULL',
			'user_xp.name: is nullable; the model has it NOT NULL'
		]);
		expect(errors[1]).toContain('[ERROR] [DB] The database differs from the model in 7 place(s)');
		expect(errors[1]).not.toContain('0099_from_a_newer_build.sql');

		// It is the record that held it back and nothing else: with the name
		// gone, the same database is reconciled at the next start.
		database.prepare('DELETE FROM __drizzle_migrations WHERE hash = ?').run('0099_from_a_newer_build.sql');
		const after = runMigrations({ database, migrationsDir: REAL_MIGRATIONS });
		expect(after.reconciliationSkipped).toBeNull();
		expect(after.rebuilt.map((r) => r.table)).toEqual(OLDER_ON_PRODUCTION);
		expect(after.schemaDifferences).toEqual([]);
		expect(after.timestamps?.converted).toEqual({ 'users.created_at': 1 });
	});
});

// ─── Timestamps at every start (card 2095) ──────────────────────────────────

describe('timestamps brought to the stored form at every start (card 2095)', () => {
	/** A migrated database holding a session expiry in ISO and an API key expiry nobody can read. */
	function mixed(): Database.Database {
		const database = memoryDb();
		runMigrations({ database, migrationsDir: REAL_MIGRATIONS });
		database.exec(`
			INSERT INTO users (id, username, email, password_hash) VALUES (1, 'ann', 'ann@example.test', 'x');
			INSERT INTO sessions (id, user_id, expires_at) VALUES ('s', 1, '2026-10-21T09:00:00.000+01:00');
			INSERT INTO api_keys (user_id, name, key_hash, key_prefix, expires_at) VALUES (1, 'k', 'h', 'df_1', 'zzz');
		`);
		return database;
	}

	it('converts what it can read, says so in one WARN line, and reports the rest at ERROR at every start', () => {
		const database = mixed();
		process.env.LOG_LEVEL = 'DEBUG';
		const warned: string[] = [];
		vi.spyOn(console, 'warn').mockImplementation((line) => warned.push(String(line).replace(/^\[[^\]]+\] /, '')));
		vi.spyOn(console, 'log').mockImplementation(() => {});

		const { report, errors } = reporting({ database, migrationsDir: REAL_MIGRATIONS });

		expect(report.timestamps).toEqual({
			converted: { 'sessions.expires_at': 1 },
			unreadable: { 'api_keys.expires_at': { count: 1, example: 'zzz' } },
			failed: null
		});
		expect(database.prepare('SELECT expires_at FROM sessions').pluck().get()).toBe('2026-10-21 08:00:00');
		expect(warned).toEqual([
			'[WARN] [DB] 1 timestamp(s) converted to the stored form (YYYY-MM-DD HH:MM:SS, UTC), each still naming the ' +
				'same moment to the second: sessions.expires_at 1. Expected once after the update that brings card 2095, ' +
				'and after an import of an older backup; at any other start something still writes another form.'
		]);
		const unreadable =
			'[ERROR] [DB] Timestamp column(s) hold values in no form this build can read, and they were left as they are: ' +
			'api_keys.expires_at 1 (such as "zzz"). Anything that reads them, a report or a comparison with now, reads ' +
			'them as text. Correct each one to YYYY-MM-DD HH:MM:SS in UTC, or clear it where the column allows NULL. ' +
			'This is reported at every start until then.';
		expect(errors).toEqual([unreadable]);

		// The next start converts nothing and says nothing of it, and says the rest again.
		warned.length = 0;
		const next = reporting({ database, migrationsDir: REAL_MIGRATIONS });
		expect(next.report.timestamps?.converted).toEqual({});
		expect(warned).toEqual([]);
		expect(next.errors).toEqual([unreadable]);
	});

	it('rolls a failure back, logs it at ERROR, and starts', () => {
		const database = mixed();
		database.exec(`CREATE TRIGGER refuse BEFORE UPDATE ON sessions BEGIN SELECT RAISE(ABORT, 'refused by a trigger'); END`);

		const { report, errors } = reporting({ database, migrationsDir: REAL_MIGRATIONS });

		expect(report.timestamps).toEqual({ converted: {}, unreadable: {}, failed: 'refused by a trigger' });
		expect(database.prepare('SELECT expires_at FROM sessions').pluck().get()).toBe('2026-10-21T09:00:00.000+01:00');
		// The schema check then reports the test's trigger, which the model has not.
		expect(errors[0]).toBe(
			'[ERROR] [DB] Timestamps could not be brought to the stored form (YYYY-MM-DD HH:MM:SS, UTC), and none was ' +
				'changed: refused by a trigger. Start-up continues on the values as they are, and the next start tries again.'
		);
		expect(errors).toHaveLength(2);
	});
});

// ─── The start-up schema check ───────────────────────────────────────────────

describe('the start-up schema check', () => {
	it('says nothing at all on a database that matches the model, at any log level', () => {
		const database = memoryDb();
		runMigrations({ database, migrationsDir: REAL_MIGRATIONS });

		process.env.LOG_LEVEL = 'DEBUG';
		const printed = [
			vi.spyOn(console, 'log').mockImplementation(() => {}),
			vi.spyOn(console, 'warn').mockImplementation(() => {}),
			vi.spyOn(console, 'error').mockImplementation(() => {})
		];
		const logRows = () => (sqlite.prepare('SELECT COUNT(*) AS n FROM system_logs').get() as { n: number }).n;
		const rowsBefore = logRows();
		const master = masterOf(database);

		// Every start of a healthy server is this.
		const report = runMigrations({ database, migrationsDir: REAL_MIGRATIONS });

		expect(report).toEqual({
			applied: [],
			tolerated: [],
			rebuilt: [],
			leftAlone: [],
			detachedSubBoards: [],
			reconciliationSkipped: null,
			backfilled: { firstCompletedAt: 0, accessTokens: 0 },
			timestamps: { converted: {}, unreadable: {}, failed: null },
			schemaDifferences: [],
			missingFromDisk: []
		});
		for (const spy of printed) expect(spy).not.toHaveBeenCalled();
		expect(logRows()).toBe(rowsBefore);
		expect(masterOf(database)).toEqual(master);
	});

	it('finds nothing in the application’s own database', () => {
		// The one `tests/setup.ts` migrated, as a server does at start-up. Its
		// `system_logs` was made by the logger, before any migration ran, and has
		// to come out the same as the one migration 0039 would have made.
		expect(schemaDifferences(sqlite)).toEqual([]);
	});

	it('reports a difference in a table outside the six, changes nothing, and lets start-up continue', () => {
		// A column no migration added: the sign of a database altered by hand, or
		// of an older build started against a newer database. Not something to
		// rebuild, and not something to stop for.
		const database = memoryDb();
		runMigrations({ database, migrationsDir: REAL_MIGRATIONS });
		database.exec(`
			ALTER TABLE labels ADD COLUMN icon TEXT;
			DROP INDEX idx_cards_milestone;
		`);
		const master = masterOf(database);
		const printed = vi.spyOn(console, 'error').mockImplementation(() => {});

		const report = runMigrations({ database, migrationsDir: REAL_MIGRATIONS });

		const expected = [
			'cards: index in the model but not in the database: index idx_cards_milestone on (milestone_id)',
			'labels.icon: the column is in the database but not in the model'
		];
		expect(report.schemaDifferences).toEqual(expected);
		expect(report.rebuilt).toEqual([]);
		expect(masterOf(database)).toEqual(master);
		// One line, at ERROR, listing them all, and then nothing: the list is not
		// given a second time as data after the sentence.
		const lines = printed.mock.calls.map((call) => String(call[0]).replace(/^\[[^\]]+\] /, ''));
		expect(lines).toEqual([
			`[ERROR] [DB] The database differs from the model in 2 place(s): ${expected.join('; ')}. ` +
				'Nothing was changed for these and start-up continues. That is expected when an older build is started ' +
				'against a newer database, and when one of boards, columns, categories, settings, user_xp, invite_tokens ' +
				'was left in the shape it has, which has a line of its own above; otherwise the model has a change that ' +
				'no migration makes, or the database was changed outside the migrations.'
		]);
	});

	it('reports a table that only one side has, and drops nothing', () => {
		// The development database has a `__new_report_schedules` that
		// `drizzle-kit push` left behind. It is reported; whether to drop it is
		// not the runner's decision.
		const database = memoryDb();
		runMigrations({ database, migrationsDir: REAL_MIGRATIONS });
		database.exec(`
			CREATE TABLE __new_report_schedules (id INTEGER PRIMARY KEY, name TEXT);
			INSERT INTO __new_report_schedules (name) VALUES ('kept');
			DROP TABLE webhooks;
		`);

		const { report, errors } = reporting({ database, migrationsDir: REAL_MIGRATIONS });

		expect(report.schemaDifferences).toEqual([
			'__new_report_schedules: the table is in the database but not in the model',
			'webhooks: the table is in the model but not in the database'
		]);
		expect(database.prepare('SELECT name FROM __new_report_schedules').all()).toEqual([{ name: 'kept' }]);
		expect(tablesOf(database)).not.toContain('webhooks');

		// A table the model has never heard of would be in this line for ever.
		// The line says how to end that, for the case where it is safe to, and
		// names the table. It says nothing of the kind about `webhooks`, which
		// is missing and not left over.
		expect(errors).toHaveLength(1);
		expect(
			errors[0].endsWith(
				'or the database was changed outside the migrations. A table that is in the database and not in the ' +
					'model stays in this line until it is gone. If it is a leftover, which is usually a __new_<name> table ' +
					'that drizzle-kit push left behind, check that nothing in it is wanted (SELECT COUNT(*) FROM "<table>";) ' +
					'and drop it (DROP TABLE "<table>";). Here: __new_report_schedules.'
			)
		).toBe(true);

		// Done as it says, the table is out of the line, and the advice with it.
		expect(database.prepare('SELECT COUNT(*) AS n FROM "__new_report_schedules";').get()).toEqual({ n: 1 });
		database.exec('DROP TABLE "__new_report_schedules";');
		const after = reporting({ database, migrationsDir: REAL_MIGRATIONS });
		expect(after.report.schemaDifferences).toEqual(['webhooks: the table is in the model but not in the database']);
		expect(after.errors[0]).not.toContain('leftover');
	});

	it('sees each kind of difference it is there to see', () => {
		// One of each, in a table the runner does not rebuild.
		const model = [
			'CREATE TABLE `parents` (\n\t`id` integer PRIMARY KEY AUTOINCREMENT NOT NULL\n);',
			[
				'CREATE TABLE `things` (',
				'\t`id` integer PRIMARY KEY AUTOINCREMENT NOT NULL,',
				'\t`name` text NOT NULL,',
				"\t`kind` text DEFAULT 'plain' NOT NULL,",
				'\t`done` integer DEFAULT false NOT NULL,',
				'\t`note` text,',
				'\t`parent_id` integer,',
				'\tFOREIGN KEY (`parent_id`) REFERENCES `parents`(`id`) ON UPDATE no action ON DELETE cascade',
				');'
			].join('\n'),
			'CREATE UNIQUE INDEX `things_name` ON `things` (`name`);'
		];
		const database = memoryDb();
		database.exec(`
			CREATE TABLE parents (id INTEGER PRIMARY KEY AUTOINCREMENT);
			CREATE TABLE things (
				id INTEGER PRIMARY KEY,
				name TEXT,
				kind TEXT NOT NULL DEFAULT 'fancy',
				done INTEGER NOT NULL DEFAULT 0,
				note INTEGER DEFAULT NULL,
				parent_id INTEGER REFERENCES parents(id) ON DELETE SET NULL
			);
			CREATE INDEX things_name ON things (name);
			CREATE VIEW thing_names AS SELECT name FROM things;
		`);

		expect(schemaDifferences(database, model)).toEqual([
			// `parents` differs only in spelling: INTEGER for integer, and NOT NULL
			// left off an INTEGER PRIMARY KEY. Neither is a difference.
			'things.name: is nullable; the model has it NOT NULL',
			"things.kind: default is 'fancy'; the model has 'plain'",
			// `done` differs only in spelling too: 0 for false.
			'things.note: type is INTEGER; the model has TEXT',
			'things: foreign key in the database but not in the model: (parent_id) references parents(id), on update NO ACTION, on delete SET NULL',
			'things: foreign key in the model but not in the database: (parent_id) references parents(id), on update NO ACTION, on delete CASCADE',
			'things: index in the database but not in the model: index things_name on (name)',
			'things: index in the model but not in the database: unique index things_name on (name)',
			'things: is not AUTOINCREMENT; in the model it is AUTOINCREMENT',
			'view thing_names: in the database but not in the model'
		]);
	});

	it('takes two spellings of one foreign key for the same key', () => {
		// SQLite matches a table's name whatever its case, and `REFERENCES
		// parents` with no column means the parent's primary key. Written either
		// way it is one key, and it used to be reported as two that differed.
		const model = [
			'CREATE TABLE `parents` (\n\t`id` integer PRIMARY KEY AUTOINCREMENT NOT NULL,\n\t`code` text\n);',
			'CREATE TABLE `pairs` (\n\t`a` integer NOT NULL,\n\t`b` integer NOT NULL,\n\tPRIMARY KEY(`a`, `b`)\n);',
			[
				'CREATE TABLE `things` (',
				'\t`id` integer PRIMARY KEY AUTOINCREMENT NOT NULL,',
				'\t`parent_id` integer,',
				'\t`a` integer,',
				'\t`b` integer,',
				'\tFOREIGN KEY (`parent_id`) REFERENCES `parents`(`id`) ON UPDATE no action ON DELETE cascade,',
				'\tFOREIGN KEY (`a`,`b`) REFERENCES `pairs`(`a`,`b`) ON UPDATE no action ON DELETE no action',
				');'
			].join('\n')
		];
		const things = (parent: string) => `
			CREATE TABLE things (
				id INTEGER PRIMARY KEY AUTOINCREMENT NOT NULL,
				parent_id INTEGER REFERENCES ${parent},
				a INTEGER,
				b INTEGER,
				FOREIGN KEY (a, b) REFERENCES PAIRS
			);`;
		const database = memoryDb();
		database.exec(`
			CREATE TABLE parents (id INTEGER PRIMARY KEY AUTOINCREMENT NOT NULL, code TEXT);
			CREATE TABLE pairs (a INTEGER NOT NULL, b INTEGER NOT NULL, PRIMARY KEY (a, b));
			${things('Parents ON DELETE CASCADE')}
		`);

		// Another case, and no column named: on a single key and on a composite one.
		expect(schemaDifferences(database, model)).toEqual([]);

		// What the key does is still compared, and each side is reported as it is written.
		database.exec(`DROP TABLE things; ${things('Parents ON DELETE SET NULL')}`);
		expect(schemaDifferences(database, model)).toEqual([
			'things: foreign key in the database but not in the model: (parent_id) references Parents, on update NO ACTION, on delete SET NULL',
			'things: foreign key in the model but not in the database: (parent_id) references parents(id), on update NO ACTION, on delete CASCADE'
		]);

		// And so is where it points: a column that is not the parent's primary key is another key.
		database.exec(`DROP TABLE things; ${things('parents(code) ON DELETE CASCADE')}`);
		expect(schemaDifferences(database, model)).toEqual([
			'things: foreign key in the database but not in the model: (parent_id) references parents(code), on update NO ACTION, on delete CASCADE',
			'things: foreign key in the model but not in the database: (parent_id) references parents(id), on update NO ACTION, on delete CASCADE'
		]);
	});

	it('cannot see what the pragmas do not report, which is a list and not a guess', () => {
		// Two tables that differ in seven ways, and a comparison that finds
		// none of them. Nothing here is a fault to fix: it is what the comment
		// in migrate.ts says the comparison is blind to, shown to be so. If
		// SQLite or the comparison ever starts to see one of these, this fails,
		// and the list is to be shortened.
		const model = [
			'CREATE TABLE `parents` (\n\t`id` integer PRIMARY KEY NOT NULL\n);',
			[
				'CREATE TABLE `things` (',
				'\t`id` integer PRIMARY KEY NOT NULL,',
				'\t`name` text,',
				'\t`note` text,',
				'\t`parent_id` integer,',
				'\t`next` integer GENERATED ALWAYS AS (`id` + 1) VIRTUAL,',
				'\tFOREIGN KEY (`parent_id`) REFERENCES `parents`(`id`) ON UPDATE no action ON DELETE no action',
				');'
			].join('\n'),
			'CREATE INDEX `things_noted` ON `things` (`note`) WHERE `note` IS NOT NULL;',
			'CREATE TABLE `keyed` (\n\t`k` text PRIMARY KEY NOT NULL,\n\t`v` text\n);'
		];
		const database = memoryDb();
		database.exec(`
			CREATE TABLE parents (id INTEGER PRIMARY KEY NOT NULL);
			CREATE TABLE things (
				id INTEGER PRIMARY KEY NOT NULL,
				name TEXT COLLATE NOCASE,
				note TEXT,
				parent_id INTEGER,
				next INTEGER GENERATED ALWAYS AS (id + 2) VIRTUAL,
				CHECK (id > 0),
				FOREIGN KEY (parent_id) REFERENCES parents(id) DEFERRABLE INITIALLY DEFERRED
			) STRICT;
			CREATE INDEX things_noted ON things (note) WHERE note <> '';
			CREATE TABLE keyed (k TEXT PRIMARY KEY NOT NULL, v TEXT) WITHOUT ROWID;
		`);

		// CHECK, COLLATE on a column, DEFERRABLE, STRICT, the expression of a
		// generated column, the WHERE of a partial index, and WITHOUT ROWID.
		expect(schemaDifferences(database, model)).toEqual([]);

		// An ON CONFLICT clause is the eighth, on a constraint of its own.
		const conflict = ['CREATE TABLE `things` (\n\t`id` integer PRIMARY KEY NOT NULL,\n\t`code` text,\n\tUNIQUE(`code`)\n);'];
		const other = memoryDb();
		other.exec('CREATE TABLE things (id INTEGER PRIMARY KEY NOT NULL, code TEXT, UNIQUE (code) ON CONFLICT REPLACE);');
		expect(schemaDifferences(other, conflict)).toEqual([]);
	});

	it('takes no notice of the order of a table’s columns, and does not rebuild a table for it', () => {
		// Column order is not part of the schema (decision 13). A column added by
		// ALTER TABLE goes on the end, so a table that grew over the years has
		// its columns in another order than the model's, and nothing reads a
		// column by its position. `settings` is one of the six, which are rebuilt
		// for any difference that is one.
		const model = [
			'CREATE TABLE `settings` (\n\t`key` text PRIMARY KEY NOT NULL,\n\t`value` text NOT NULL,\n\t`note` text\n);',
			'CREATE TABLE `pairs` (\n\t`a` integer NOT NULL,\n\t`b` integer NOT NULL,\n\tPRIMARY KEY(`a`, `b`)\n);'
		];
		const database = memoryDb();
		database.exec(`
			CREATE TABLE settings (note TEXT, value TEXT NOT NULL, key TEXT PRIMARY KEY NOT NULL);
			INSERT INTO settings (key, value) VALUES ('theme', 'dark');
			CREATE TABLE pairs (b INTEGER NOT NULL, a INTEGER NOT NULL, PRIMARY KEY (a, b));
		`);
		const master = masterOf(database);

		expect(schemaDifferences(database, model)).toEqual([]);
		expect(reconcileSchema(database, model)).toEqual(NOTHING_TO_DO);
		expect(masterOf(database)).toEqual(master);

		// Order inside a primary key is not the order of the table's columns. It
		// decides what the key does, and it is compared.
		database.exec('DROP TABLE pairs; CREATE TABLE pairs (a INTEGER NOT NULL, b INTEGER NOT NULL, PRIMARY KEY (b, a));');
		expect(schemaDifferences(database, model)).toEqual([
			'pairs.a: primary key position is 2; the model has 1',
			'pairs.b: primary key position is 1; the model has 2',
			'pairs: index in the database but not in the model: unique index for a primary key on (b, a)',
			'pairs: index in the model but not in the database: unique index for a primary key on (a, b)'
		]);
	});
});

// ─── time_entries ────────────────────────────────────────────────────────────

describe('time_entries, which nothing ever used', () => {
	it('is gone from a database in production’s shape once the runner has been over it', () => {
		const database = productionDatabase();
		expect(tablesOf(database)).toContain('time_entries');

		const report = runMigrations({ database, migrationsDir: REAL_MIGRATIONS });

		expect(report.applied).toContain('0052_drop_time_entries.sql');
		expect(tablesOf(database)).not.toContain('time_entries');
		expect(database.prepare("SELECT name FROM sqlite_sequence WHERE name = 'time_entries'").all()).toEqual([]);
	});

	it('is created and then dropped on a new database, with no error tolerated for it', () => {
		const database = memoryDb();

		const report = runMigrations({ database, migrationsDir: REAL_MIGRATIONS });

		expect(report.applied).toContain('0028_add_time_entries.sql');
		expect(report.applied).toContain('0052_drop_time_entries.sql');
		expect(report.tolerated.filter((t) => t.file === '0052_drop_time_entries.sql')).toEqual([]);
		expect(tablesOf(database)).not.toContain('time_entries');
	});

	it('is no obstacle where it has already gone', () => {
		// The development database lost it to `drizzle-kit push`.
		const database = productionDatabase();
		database.exec('DROP TABLE time_entries');

		const report = runMigrations({ database, migrationsDir: REAL_MIGRATIONS });

		expect(report.applied).toContain('0052_drop_time_entries.sql');
		expect(report.schemaDifferences).toEqual([]);
	});
});

// ─── The restore ─────────────────────────────────────────────────────────────

describe('restoring a backup taken before the latest migrations', () => {
	/**
	 * A current database, and a backup in production's shape with 55 files
	 * recorded.
	 *
	 * Two of the backup's three columns have no WIP limit at all, as
	 * production's nullable `wip_limit` allowed, and both have cards on them.
	 * Every backup that existed when card 2006 was deployed is like that, and
	 * the running database's `wip_limit` is NOT NULL.
	 */
	const liveAndBackup = () => {
		const live = memoryDb();
		runMigrations({ database: live, migrationsDir: REAL_MIGRATIONS });
		live.exec(`
			INSERT INTO boards (id, name) VALUES (7, 'Replaced by the restore');
		`);

		const backup = productionDatabase();
		seed(backup);
		// A restore is never committed with users and no superadmin among them:
		// see restoreFromBackup. Ann is production's.
		backup.exec(`
			UPDATE users SET role = 'superadmin' WHERE id = 1;
			UPDATE columns SET wip_limit = NULL WHERE id IN (1, 4);
			UPDATE cards SET completed_at = '2026-09-01 10:00:00' WHERE id IN (1, 2);
			INSERT INTO task_requests (id, target_id, title) VALUES (1, 1, 'First'), (2, 1, 'Second');
		`);
		return { live, backup };
	};

	const columnsIn = (database: Database.Database) =>
		database.prepare('SELECT id, board_id, title, wip_limit FROM columns ORDER BY id').all();

	const cardColumnsIn = (database: Database.Database) =>
		database.prepare('SELECT id, column_id FROM cards ORDER BY id').all();

	const cardCategoriesIn = (database: Database.Database) =>
		database.prepare('SELECT id, category_id FROM cards ORDER BY id').all();

	const workDependenciesIn = (database: Database.Database) =>
		database
			.prepare(
				'SELECT blocked_type, blocked_id, blocker_type, blocker_id, created_by_user_id, created_at FROM work_dependencies ORDER BY blocked_id'
			)
			.all();

	/** Two card dependencies, recorded in the table that `work_dependencies` replaced. */
	const recordCardDependencies = (database: Database.Database) =>
		database.exec(`
			INSERT INTO card_dependencies (card_id, depends_on_card_id, created_by_user_id, created_at) VALUES
				(2, 1, 1, '2026-03-01 09:00:00'),
				(3, 2, NULL, '2026-03-02 09:00:00');
		`);

	it('replaces the rows and keeps the migration record of the running database', () => {
		const { live, backup } = liveAndBackup();
		expect(recordedIn(backup)).toHaveLength(55);

		const result = restoreFromBackup(live, backup);

		expect(result.errors).toEqual([]);
		expect(live.prepare('SELECT id, name FROM boards ORDER BY id').all()).toEqual([
			{ id: 1, name: 'A' },
			{ id: 2, name: 'B' },
			{ id: 3, name: 'Sub' }
		]);
		expect(cardCategoriesIn(live)).toEqual(cardCategoriesIn(backup));
		// The record describes the structure of this database, which the restore
		// did not change. It used to be overwritten with the backup's.
		expect(recordedIn(live)).toEqual(realFiles);
		expect(foreignKeysOn(live)).toBe(true);
	});

	it('gives a column with no WIP limit the limit of 0, and keeps every column and every card on it', () => {
		// The restore that every backup taken before this card would get. The
		// backup's `wip_limit` is NULL on two columns and the running database's
		// column is NOT NULL. Inserted as they are, those two rows are refused:
		// the columns are gone, the four cards on them point at nothing, and the
		// restore used to commit that and answer "restored".
		const { live, backup } = liveAndBackup();
		expect(columnsIn(backup)).toEqual([
			{ id: 1, board_id: 1, title: 'To Do', wip_limit: null },
			{ id: 2, board_id: 1, title: 'Doing', wip_limit: 3 },
			{ id: 4, board_id: 2, title: 'To Do', wip_limit: null }
		]);

		const result = restoreFromBackup(live, backup);

		expect(result.errors).toEqual([]);
		// The NULLs became the column's default, which means "no limit"; the
		// limit that was set is the limit that was set.
		expect(columnsIn(live)).toEqual([
			{ id: 1, board_id: 1, title: 'To Do', wip_limit: 0 },
			{ id: 2, board_id: 1, title: 'Doing', wip_limit: 3 },
			{ id: 4, board_id: 2, title: 'To Do', wip_limit: 0 }
		]);
		expect(result.restored['columns']).toBe(3);
		expect(result.defaulted).toEqual([{ table: 'columns', column: 'wip_limit', rows: 2, value: '0' }]);
		// Every card is there and is on the column it was on.
		expect(cardColumnsIn(live)).toEqual([
			{ id: 1, column_id: 1 },
			{ id: 2, column_id: 1 },
			{ id: 3, column_id: 4 },
			{ id: 4, column_id: 4 },
			{ id: 5, column_id: 2 }
		]);
		expect(cardColumnsIn(live)).toEqual(cardColumnsIn(backup));
		expect(live.pragma('foreign_key_check')).toEqual([]);
		// And the column that counts them still counts them.
		expect(live.prepare('SELECT column_id, card_count FROM daily_snapshots ORDER BY column_id').all()).toEqual([
			{ column_id: 1, card_count: 2 },
			{ column_id: 2, card_count: 1 },
			{ column_id: 4, card_count: 2 }
		]);
	});

	it('leaves out a row that nothing depends on, says which, and restores the rest', () => {
		// A setting with no key, which production's `settings` allowed and the
		// running database's does not. There is no default to give a key. Nothing
		// refers to a setting, so leaving it out strands nothing: it is reported,
		// and the restore is still a restore.
		const { live, backup } = liveAndBackup();
		backup.exec("INSERT INTO settings (key, value) VALUES (NULL, 'has no key')");

		const result = restoreFromBackup(live, backup);

		expect(result.errors).toEqual(['settings row (key NULL): NOT NULL constraint failed: settings.key']);
		expect(live.prepare('SELECT key, value FROM settings ORDER BY key').all()).toEqual([
			{ key: 'smtp_host', value: 'mail.example.test' },
			{ key: 'theme', value: 'dark' }
		]);
		expect(result.restored['settings']).toBe(2);
		// The rest of the backup is in, and committed.
		expect(live.prepare('SELECT id FROM boards ORDER BY id').all()).toEqual([{ id: 1 }, { id: 2 }, { id: 3 }]);
		expect(columnsIn(live)).toHaveLength(3);
		expect(cardColumnsIn(live)).toEqual(cardColumnsIn(backup));
		expect(live.pragma('foreign_key_check')).toEqual([]);
		expect(foreignKeysOn(live)).toBe(true);
		expect(live.inTransaction).toBe(false);
	});

	/**
	 * A backup one of whose columns the running database cannot take: column 1
	 * has no title, and `columns.title` is NOT NULL with no default. Cards 1
	 * and 2 are on that column, and one daily snapshot counts it.
	 */
	const backupWithAColumnThatCannotBeCopied = () => {
		const { live, backup } = liveAndBackup();
		backup.pragma('foreign_keys = OFF');
		backup.exec(`
			CREATE TABLE columns_loose AS SELECT * FROM columns;
			DROP TABLE columns;
			ALTER TABLE columns_loose RENAME TO columns;
			UPDATE columns SET title = NULL WHERE id = 1;
		`);
		backup.pragma('foreign_keys = ON');
		return { live, backup };
	};

	it('rolls the whole restore back, byte for byte, rather than commit rows that point at a row it could not copy', () => {
		const { live, backup } = backupWithAColumnThatCannotBeCopied();
		live.exec(`
			INSERT INTO users (id, username, email, password_hash) VALUES (9, 'kept', 'kept@example.test', 'x');
			INSERT INTO columns (id, board_id, title) VALUES (70, 7, 'Kept');
			INSERT INTO cards (id, column_id, title) VALUES (700, 70, 'Kept');
		`);
		const before = live.serialize();
		const contents = contentsOf(live);

		let thrown: unknown;
		try {
			restoreFromBackup(live, backup);
		} catch (error) {
			thrown = error;
		}

		// Not a restore with a problem: no restore at all.
		expect(thrown).toBeInstanceOf(RestoreError);
		const error = thrown as RestoreError;
		expect(error.committed).toBe(false);
		// Which row could not be copied, and that other rows depend on it.
		expect(error.message).toBe(
			'The restore failed and nothing was changed: rows that other rows depend on could not be copied ' +
				'(columns row (id 1): NOT NULL constraint failed: columns.title), ' +
				'and 2 row(s) of cards refer to a row of columns that would not be there, ' +
				'and 1 row(s) of daily_snapshots refer to a row of columns that would not be there'
		);
		expect(error.errors).toEqual(['columns row (id 1): NOT NULL constraint failed: columns.title']);

		// The database is the one it was, to the byte: what was there before the
		// restore is there, and nothing of the backup is.
		expect(Buffer.compare(live.serialize(), before)).toBe(0);
		expect(contentsOf(live)).toEqual(contents);
		expect(live.prepare('SELECT id FROM boards').all()).toEqual([{ id: 7 }]);
		expect(foreignKeysOn(live)).toBe(true);
		expect(live.inTransaction).toBe(false);
	});

	it('reports rows that pointed at nothing in the backup itself, and restores it all the same', () => {
		// A card on a column that does not exist, and a sub-board of a card that
		// does not: production's backup could hold either. Every column and every
		// card of the backup was copied, so neither is this restore's doing, and
		// refusing the backup would leave no way to restore it at all.
		const { live, backup } = liveAndBackup();
		backup.pragma('foreign_keys = OFF');
		backup.exec("INSERT INTO cards (id, column_id, title) VALUES (6, 99, 'On no column')");
		backup.pragma('foreign_keys = ON');

		const result = restoreFromBackup(live, backup);

		expect(result.errors).toEqual([
			'cards: 1 row(s) refer to a row of columns that is not there (rowid 6). No row of columns was left out ' +
				'by this restore, so the backup holds them that way'
		]);
		expect(result.restored['cards']).toBe(6);
		expect(cardColumnsIn(live)).toEqual(cardColumnsIn(backup));
		expect(foreignKeysOn(live)).toBe(true);
	});

	it('fills in what the backup is too old to have', () => {
		const { live, backup } = liveAndBackup();

		const result = restoreFromBackup(live, backup);

		// The links are given inside the restore, as every request's is at every
		// restore (card 2158), so the backfill after it has none to give.
		expect(result.backfilled).toEqual({ firstCompletedAt: 2, accessTokens: 0 });
		expect(result.requestLinksReplaced).toBe(2);
		expect(live.prepare('SELECT id, first_completed_at FROM cards ORDER BY id').all()).toEqual([
			{ id: 1, first_completed_at: '2026-09-01 10:00:00' },
			{ id: 2, first_completed_at: '2026-09-01 10:00:00' },
			{ id: 3, first_completed_at: null },
			{ id: 4, first_completed_at: null },
			{ id: 5, first_completed_at: null }
		]);
		const tokens = (live.prepare('SELECT access_token FROM task_requests').all() as { access_token: string }[]).map(
			(r) => r.access_token
		);
		expect(tokens).toHaveLength(2);
		for (const token of tokens) expect(token).toMatch(/^[0-9a-f]{64}$/);
		expect(new Set(tokens).size).toBe(2);
	});

	it('does not stop the next start', () => {
		// With the backup's record in place of its own, the runner would find
		// 0050 and 0051 unrecorded, run them against columns that already exist,
		// and halt on "duplicate column" at every start from then on.
		const { live, backup } = liveAndBackup();
		restoreFromBackup(live, backup);

		const report = runMigrations({ database: live, migrationsDir: REAL_MIGRATIONS });

		expect(report.applied).toEqual([]);
		expect(report.missingFromDisk).toEqual([]);
		expect(report.rebuilt).toEqual([]);
		expect(report.schemaDifferences).toEqual([]);
		expect(report.backfilled).toEqual({ firstCompletedAt: 0, accessTokens: 0 });
	});

	it('will not start inside a transaction, where foreign keys cannot be switched off', () => {
		const { live, backup } = liveAndBackup();

		live.exec('BEGIN');
		let thrown: unknown;
		try {
			restoreFromBackup(live, backup);
		} catch (error) {
			thrown = error;
		}
		live.exec('ROLLBACK');

		// It says that nothing was changed and what to do, which is all there is to know.
		expect(thrown).toBeInstanceOf(RestoreError);
		expect((thrown as RestoreError).committed).toBe(false);
		expect((thrown as RestoreError).message).toBe(
			'A restore cannot start while a transaction is open on the database connection, because foreign keys ' +
				'cannot be switched off inside one. Nothing was changed. Try again; if it repeats, restart the server.'
		);
		expect(live.prepare('SELECT id FROM boards').all()).toEqual([{ id: 7 }]);
		expect(foreignKeysOn(live)).toBe(true);
	});

	it('does not start if foreign keys cannot be switched off, and says that nothing was changed', () => {
		// With them on, clearing `boards` would delete every row that belongs to
		// a board, and a card copied in before its column would be refused and
		// left out, in a restore that then said it had worked.
		const { live, backup } = liveAndBackup();
		const before = live.serialize();
		const real = ignoringPragma(live, 'OFF');

		let thrown: unknown;
		try {
			restoreFromBackup(live, backup);
		} catch (error) {
			thrown = error;
		}

		expect(thrown).toBeInstanceOf(RestoreError);
		expect((thrown as RestoreError).committed).toBe(false);
		expect((thrown as RestoreError).message).toBe(
			'The restore was not started, because foreign keys could not be switched off. Nothing was changed. ' +
				'Try again; if it repeats, restart the server.'
		);
		expect(Buffer.compare(live.serialize(), before)).toBe(0);
		expect(real('foreign_keys', { simple: true })).toBe(1);
	});

	it.each<[string, boolean, string]>([
		[
			'a restore that committed',
			true,
			'The backup was restored and committed, but foreign keys could not be switched back on. Restart the ' +
				'server now: until it restarts, deleting a board, a card or a user leaves behind what belonged to it.'
		],
		[
			'a restore that failed',
			false,
			'The restore failed and nothing was changed (disk I/O error), and foreign keys could not be switched back ' +
				'on afterwards. Restart the server now.'
		]
	])('says which of two things happened when foreign keys cannot be switched back on after %s', (_what, committed, message) => {
		// The two are opposites, and one message used to serve for both. After a
		// commit, "restore failed" sends someone to restore again over a database
		// that has just been restored; and "nothing was changed" is untrue.
		const { live, backup } = liveAndBackup();
		const before = contentsOf(live);
		if (!committed) failAtCommit(live, 'disk I/O error');
		const real = ignoringPragma(live, 'ON');

		let thrown: unknown;
		try {
			restoreFromBackup(live, backup);
		} catch (error) {
			thrown = error;
		}

		expect(thrown).toBeInstanceOf(RestoreError);
		const error = thrown as RestoreError;
		expect(error.committed).toBe(committed);
		expect(error.message).toBe(message);
		if (committed) {
			expect(error.message).not.toMatch(/failed|nothing was changed/i);
			// As it says: the backup is in.
			expect(live.prepare('SELECT id FROM boards ORDER BY id').all()).toEqual([{ id: 1 }, { id: 2 }, { id: 3 }]);
			expect(columnsIn(live)).toHaveLength(3);
		} else {
			expect(contentsOf(live)).toEqual(before);
		}
		// Not a pretence: they are off, which is why the server is to be restarted.
		expect(real('foreign_keys', { simple: true })).toBe(0);
		expect(live.inTransaction).toBe(false);
	});

	it('does not say nothing was changed while a restore that failed is still open on the connection', () => {
		// The restore failed and so did its rollback. Nothing is committed, but
		// "nothing was changed" is not yet true of this connection, which still
		// sees the half-done restore until the server stops. It says that.
		const { live, backup } = liveAndBackup();
		vi.spyOn(live, 'transaction').mockImplementation(((fn: () => unknown) => () => {
			live.exec('BEGIN');
			fn();
			throw new Error('cannot rollback - disk I/O error');
		}) as unknown as typeof live.transaction);

		let thrown: unknown;
		try {
			restoreFromBackup(live, backup);
		} catch (error) {
			thrown = error;
		}

		expect(thrown).toBeInstanceOf(RestoreError);
		expect((thrown as RestoreError).committed).toBe(false);
		expect((thrown as RestoreError).message).toBe(
			'The restore failed (cannot rollback - disk I/O error) and its transaction could not be rolled back, so ' +
				'foreign keys could not be switched back on either. Nothing was committed, and what it had done is ' +
				'discarded when the server stops. Restart the server now.'
		);
		expect(live.inTransaction).toBe(true);
		expect(foreignKeysOn(live)).toBe(false);
		// Discarded, as it says, when the connection goes.
		vi.restoreAllMocks();
		live.exec('ROLLBACK');
		expect(live.prepare('SELECT id FROM boards').all()).toEqual([{ id: 7 }]);
	});

	it('carries card dependencies into work_dependencies when the backup is from before that table existed', () => {
		// Migration 0043 made `work_dependencies` and filled it from
		// `card_dependencies`. It is recorded here and does not run again, so a
		// backup from before it would leave the table empty: cleared by the
		// restore, with nothing in the backup to refill it.
		const { live, backup } = liveAndBackup();
		recordCardDependencies(backup);
		backup.exec('DROP TABLE work_dependencies');
		live.exec("INSERT INTO work_dependencies (blocked_type, blocked_id, blocker_type, blocker_id) VALUES ('card', 7, 'card', 8)");

		const result = restoreFromBackup(live, backup);

		expect(result.errors).toEqual([]);
		expect(result.restored['work_dependencies']).toBe(2);
		expect(workDependenciesIn(live)).toEqual([
			{
				blocked_type: 'card',
				blocked_id: 2,
				blocker_type: 'card',
				blocker_id: 1,
				created_by_user_id: 1,
				created_at: '2026-03-01 09:00:00'
			},
			{
				blocked_type: 'card',
				blocked_id: 3,
				blocker_type: 'card',
				blocker_id: 2,
				created_by_user_id: null,
				created_at: '2026-03-02 09:00:00'
			}
		]);
	});

	it('carries nothing when the backup has work_dependencies, and neither does the next start', () => {
		// `card_dependencies` is kept, and nothing removes a row from it when a
		// dependency is deleted. A backup that has `work_dependencies` says what
		// the dependencies are, even if it says there are none; copying the old
		// table over it would bring back every dependency since deleted. The
		// same goes for the runner, which must never make this copy.
		const { live, backup } = liveAndBackup();
		recordCardDependencies(backup);
		expect(workDependenciesIn(backup)).toEqual([]);

		const result = restoreFromBackup(live, backup);

		expect(result.errors).toEqual([]);
		expect(result.restored['card_dependencies']).toBe(2);
		expect(result.restored['work_dependencies']).toBeUndefined();
		expect(workDependenciesIn(live)).toEqual([]);

		runMigrations({ database: live, migrationsDir: REAL_MIGRATIONS });
		expect(workDependenciesIn(live)).toEqual([]);
	});

	it('reports a backfill that fails about a restore that succeeded', () => {
		const { live, backup } = liveAndBackup();
		// Something that stops the backfill and not the restore: the restore
		// inserts rows, and this objects only to an update.
		live.exec(`
			CREATE TRIGGER first_completion_frozen BEFORE UPDATE OF first_completed_at ON cards
			BEGIN SELECT RAISE(ABORT, 'first completion is frozen'); END
		`);

		const result = restoreFromBackup(live, backup);

		// The rows are in and committed. Saying "the restore failed" would send
		// someone to restore again over a database that has just been restored.
		expect(result.errors).toEqual(['Backfill after the restore: first completion is frozen']);
		expect(result.backfilled).toEqual({ firstCompletedAt: 0, accessTokens: 0 });
		expect(result.restored['cards']).toBe(5);
		expect(live.prepare('SELECT id FROM boards ORDER BY id').all()).toEqual([{ id: 1 }, { id: 2 }, { id: 3 }]);
		expect(foreignKeysOn(live)).toBe(true);
	});

	/** A backup with one table the running database cannot take: no column of it has the same name. */
	const backupWithAStrangeTable = () => {
		const { live, backup } = liveAndBackup();
		backup.exec(`
			DROP TABLE settings;
			CREATE TABLE settings (k TEXT, v TEXT);
			INSERT INTO settings (k, v) VALUES ('theme', 'dark');
		`);
		return { live, backup };
	};

	it('leaves everything as it was when its transaction fails, and carries out what had gone wrong by then', () => {
		const { live, backup } = backupWithAStrangeTable();
		const master = masterOf(live);
		const before = contentsOf(live);
		failAtCommit(live, 'disk I/O error');

		let thrown: unknown;
		try {
			restoreFromBackup(live, backup);
		} catch (error) {
			thrown = error;
		}

		expect(thrown).toBeInstanceOf(RestoreError);
		// It says what state the database is in, and it is true of it.
		expect((thrown as RestoreError).message).toBe('The restore failed and nothing was changed: disk I/O error');
		expect((thrown as RestoreError).committed).toBe(false);
		// Built up inside the call that threw; without this the caller never sees it.
		expect((thrown as RestoreError).errors).toEqual(['settings: no matching columns']);
		// The rows it had cleared and copied are back as they were, sequences included.
		expect(contentsOf(live)).toEqual(before);
		expect(masterOf(live)).toEqual(master);
		expect(foreignKeysOn(live)).toBe(true);
		expect(live.inTransaction).toBe(false);
	});

	describe('through the route', () => {
		/*
		 * The route restores into the application's own database, which every
		 * test in this file that uses it shares. So each test here ends by
		 * emptying it again, with foreign keys on, whatever the test did to it.
		 *
		 * The route also writes the upload and a safety copy under the working
		 * directory. Here that is a temporary one: the route module is loaded
		 * first, then the working directory is changed for the call alone.
		 */
		afterEach(() => {
			vi.restoreAllMocks();
			// The check after every test (tests/setup.ts) runs after this hook, on an
			// emptied database, so it is made here first, once nothing is mocked (card 2095).
			try {
				afterEachTimestampCheck(sqlite);
			} finally {
				sqlite.pragma('foreign_keys = ON');
				resetDb();
			}
		});

		/** Everything but the log, which is meant to gain a line about what happened. */
		const dataIn = (database: Database.Database) => {
			const { system_logs: _log, sqlite_sequence: counters, ...data } = contentsOf(database);
			return { ...data, sqlite_sequence: counters.filter((row) => !row.includes('"system_logs"')) };
		};

		/**
		 * Upload `backup` as the superadmin would, and return the route's
		 * answer with every line it logged, without the timestamp. `arrange`
		 * runs once the console is being listened to and before the upload, for
		 * whatever is to go wrong.
		 */
		const upload = async (backup: Database.Database, arrange: () => void = () => {}) => {
			await routeMethods('/api/admin/import');
			// The superadmin: an import is refused to an administrator.
			const admin = makeUser({ role: 'superadmin' });
			// And the backup has one too. The route refuses a backup that has users
			// and no superadmin among them, and the two the seed makes are ordinary.
			backup.exec("UPDATE users SET role = 'superadmin' WHERE id = 1");
			const bytes = backup.serialize();
			const workingDirectory = migrationsDir({});
			vi.spyOn(process, 'cwd').mockReturnValue(workingDirectory);
			expect(process.cwd()).toBe(workingDirectory);

			const logged: string[] = [];
			const insideATransaction: string[] = [];
			const listen = (line: unknown) => {
				logged.push(String(line).replace(/^\[[^\]]+\] /, ''));
				if (sqlite.inTransaction) insideATransaction.push(String(line));
			};
			vi.spyOn(console, 'error').mockImplementation(listen);
			vi.spyOn(console, 'warn').mockImplementation(listen);
			vi.spyOn(console, 'log').mockImplementation(listen);
			arrange();

			// As it is: these tests are about the restore itself. With no choice
			// given, a restore under the dev server is a working copy, which is
			// tested in import-working-copy.test.ts.
			const response = await api('POST', '/api/admin/import?outside=keep', {
				user: admin,
				headers: { 'content-type': 'application/octet-stream' },
				body: bytes
			});

			// The logger writes to the database being restored. A line written
			// inside the restore's transaction would be lost with a rollback.
			expect(insideATransaction).toEqual([]);
			// Written where the test pointed it, and nowhere in the repository.
			expect(existsSync(join(workingDirectory, '.pre-restore-safety.json'))).toBe(true);
			expect(existsSync(join(workingDirectory, '.restore-temp.db'))).toBe(false);
			return { response, logged, size: `${(bytes.length / 1024).toFixed(1)} KB` };
		};

		it('answers a failed restore with what had gone wrong by then, and says nothing was changed', async () => {
			const { backup } = backupWithAStrangeTable();
			let before: ReturnType<typeof dataIn> | null = null;

			const { response, logged } = await upload(backup, () => {
				// Read here, with the administrator who uploads it already made.
				before = dataIn(sqlite);
				failAtCommit(sqlite, 'disk I/O error');
			});

			expect(response.status).toBe(500);
			expect(response.body.message).toBe('The restore failed and nothing was changed: disk I/O error');
			expect(response.body.committed).toBe(false);
			// It answered `errors: []`: the list was lost with the call that threw.
			expect(response.body.errors).toEqual(['settings: no matching columns']);
			expect(logged).toEqual([
				'[CRITICAL] [IMPORT] Database restore: The restore failed and nothing was changed: disk I/O error | ' +
					'{"errors":["settings: no matching columns"]}'
			]);

			vi.restoreAllMocks();
			expect(before).not.toBeNull();
			expect(dataIn(sqlite)).toEqual(before);
			expect(foreignKeysOn(sqlite)).toBe(true);
			expect(sqlite.inTransaction).toBe(false);
		});

		it('says so, in its answer and in the log, when a restore commits with something left out', async () => {
			// What the route used to answer here was `success: true` and a message
			// that began "Database restored", with the one sign of trouble in a
			// list the page never showed.
			const { backup } = liveAndBackup();
			backup.exec("INSERT INTO settings (key, value) VALUES (NULL, 'has no key')");
			const problem = 'settings row (key NULL): NOT NULL constraint failed: settings.key';

			const { response, logged, size } = await upload(backup);

			expect(response.status).toBe(200);
			expect(response.body.success).toBe(true);
			expect(response.body.errors).toEqual([problem]);
			expect(response.body.message).toMatch(
				new RegExp(
					`^Database restored \\(${size.replace('.', '\\.')}\\), with 1 problem\\(s\\); each is given in the list\\. .*\\bcolumns: 3\\b`
				)
			);
			expect(response.body.message).toContain('settings: 2');
			// At ERROR, with the problems themselves in the line.
			expect(logged).toEqual([`[ERROR] [IMPORT] Restore committed, with 1 problem(s): ${problem}`]);
			// And it is what it says: the backup is in, without that one row.
			expect(sqlite.prepare('SELECT id FROM boards ORDER BY id').all()).toEqual([{ id: 1 }, { id: 2 }, { id: 3 }]);
			expect(sqlite.prepare('SELECT key FROM settings ORDER BY key').all()).toEqual([
				{ key: 'smtp_host' },
				{ key: 'theme' }
			]);
		});

		it('does not say anything was left out when every row was copied, and logs what it filled in all the same', async () => {
			// The list is not only of rows left out. A card on a column that does
			// not exist is in the backup that way, and it is copied like any other
			// row and reported, so that somebody knows. The answer and the log used
			// to say of this restore that what could not be copied was left out,
			// and nothing had been.
			const { backup } = liveAndBackup();
			backup.pragma('foreign_keys = OFF');
			backup.exec("INSERT INTO cards (id, column_id, title) VALUES (6, 99, 'On no column')");
			backup.pragma('foreign_keys = ON');
			const problem =
				'cards: 1 row(s) refer to a row of columns that is not there (rowid 6). No row of columns was left out ' +
				'by this restore, so the backup holds them that way';
			process.env.LOG_LEVEL = 'INFO';

			const { response, logged, size } = await upload(backup);

			expect(response.status).toBe(200);
			expect(response.body.success).toBe(true);
			expect(response.body.errors).toEqual([problem]);
			expect(response.body.message).toMatch(
				new RegExp(
					`^Database restored \\(${size.replace('.', '\\.')}\\), with 1 problem\\(s\\); each is given in the list\\. .*\\bcards: 6\\b`
				)
			);
			// Two lines. What was filled in used to be logged only for a restore
			// with nothing to report, and this one filled in as much as any.
			expect(logged).toHaveLength(2);
			expect(logged[0]).toMatch(
				new RegExp(
					`^\\[INFO\\] \\[IMPORT\\] Database restored from an uploaded backup \\(${size.replace('.', '\\.')}\\)\\. ` +
						'Rows: .*\\bcards: 6\\b.*\\. Filled in: first_completed_at on 2 card\\(s\\), access_token on 0 request\\(s\\), ' +
						'the default \\(0\\) in place of NULL in columns\\.wip_limit on 2 row\\(s\\)\\. ' +
						'2 request link\\(s\\) replaced: a link mailed before this restore no longer works, and its requester can have ' +
						'a new one sent from the page it opens\\.$'
				)
			);
			expect(logged[1]).toBe(`[ERROR] [IMPORT] Restore committed, with 1 problem(s): ${problem}`);
			// Nothing in either says that a row or a table is missing, apart from
			// the entry itself, which says that none is.
			for (const said of [response.body.message, logged[0], logged[1].replace(problem, '')]) {
				expect(said).not.toMatch(/left out|could not be copied/i);
			}
			// And none is: the card is in, on the column it had in the backup.
			expect(sqlite.prepare('SELECT id, column_id, title FROM cards WHERE id = 6').get()).toEqual({
				id: 6,
				column_id: 99,
				title: 'On no column'
			});
			expect(sqlite.prepare('SELECT COUNT(*) AS n FROM cards').get()).toEqual({ n: 6 });
			expect(foreignKeysOn(sqlite)).toBe(true);
		});

		it('says only that it restored, and logs what it filled in, when nothing was left out', async () => {
			const { backup } = liveAndBackup();
			process.env.LOG_LEVEL = 'INFO';

			const { response, logged, size } = await upload(backup);

			expect(response.status).toBe(200);
			expect(response.body.success).toBe(true);
			expect(response.body.errors).toBeUndefined();
			expect(response.body.message).toMatch(new RegExp(`^Database restored \\(${size.replace('.', '\\.')}\\)\\. `));
			expect(response.body.message).not.toContain('problem');
			// One line, at INFO: how many rows of what, and what was filled in for
			// a backup too old to have it. The NULL WIP limits are among those.
			expect(logged).toHaveLength(1);
			expect(logged[0]).toMatch(
				new RegExp(
					`^\\[INFO\\] \\[IMPORT\\] Database restored from an uploaded backup \\(${size.replace('.', '\\.')}\\)\\. ` +
						'Rows: .*\\bcards: 5\\b.*\\. Filled in: first_completed_at on 2 card\\(s\\), access_token on 0 request\\(s\\), ' +
						'the default \\(0\\) in place of NULL in columns\\.wip_limit on 2 row\\(s\\)\\. ' +
						'2 request link\\(s\\) replaced: a link mailed before this restore no longer works, and its requester can have ' +
						'a new one sent from the page it opens\\.$'
				)
			);
			expect(sqlite.prepare('SELECT id, wip_limit FROM columns ORDER BY id').all()).toEqual([
				{ id: 1, wip_limit: 0 },
				{ id: 2, wip_limit: 3 },
				{ id: 4, wip_limit: 0 }
			]);
		});

		it('refuses a backup that would leave cards on a column it could not copy, and changes nothing', async () => {
			const { backup } = backupWithAColumnThatCannotBeCopied();
			sqlite.exec("INSERT INTO boards (id, name) VALUES (7, 'Still here afterwards')");

			const { response, logged } = await upload(backup);

			expect(response.status).toBe(500);
			expect(response.body.committed).toBe(false);
			expect(response.body.message).toBe(
				'The restore failed and nothing was changed: rows that other rows depend on could not be copied ' +
					'(columns row (id 1): NOT NULL constraint failed: columns.title), ' +
					'and 2 row(s) of cards refer to a row of columns that would not be there, ' +
					'and 1 row(s) of daily_snapshots refer to a row of columns that would not be there'
			);
			expect(response.body.errors).toEqual(['columns row (id 1): NOT NULL constraint failed: columns.title']);
			expect(logged).toHaveLength(1);
			expect(logged[0]).toContain('[CRITICAL] [IMPORT] Database restore: The restore failed and nothing was changed');
			expect(sqlite.prepare('SELECT id, name FROM boards').all()).toEqual([{ id: 7, name: 'Still here afterwards' }]);
			expect(sqlite.prepare('SELECT COUNT(*) AS n FROM cards').get()).toEqual({ n: 0 });
			expect(foreignKeysOn(sqlite)).toBe(true);
		});

		it('does not call it a failed restore when the backup is in and it is the connection that is wrong', async () => {
			const { backup } = liveAndBackup();
			// Mail settings with no password, from a backup with no seal: listed to enter again (card 2169).
			backup.exec("INSERT OR REPLACE INTO settings (key, value) VALUES ('smtp_host', 'mail.example.test'), ('smtp_user', 'dumpfire')");
			backup.exec("DELETE FROM settings WHERE key = 'smtp_pass'");
			let real: Database.Database['pragma'] | null = null;

			const { response, logged } = await upload(backup, () => {
				real = ignoringPragma(sqlite, 'ON');
			});

			const toEnter =
				'To enter again, because a backup does not hold them: the mail password (Admin, 📧 Email / SMTP). None was ' +
				// No seal at all, so this reason and not the other (the second review's N7).
				'kept from this server, because this backup carries no seal this server can check.';
			const message =
				'The backup was restored and committed, but foreign keys could not be switched back on. Restart the ' +
				'server now: until it restarts, deleting a board, a card or a user leaves behind what belonged to it. ' +
				// It replaced every request's link, and listed the secrets, as a restore that succeeded does, and says so (O8).
				'2 request link(s) replaced: a link mailed before this restore no longer works, and its requester can have ' +
				`a new one sent from the page it opens. ${toEnter}`;
			expect(response.status).toBe(500);
			// The page reloads its data on this, and not on any other failure.
			expect(response.body.committed).toBe(true);
			expect(response.body.message).toBe(message);
			expect(response.body.requestLinksReplaced).toBe(2);
			expect(response.body.secretsToEnter).toBe(toEnter);
			expect(response.body).not.toHaveProperty('secretsKept');
			expect(logged).toEqual([`[CRITICAL] [IMPORT] Database restore: ${message}`]);
			expect(`${response.body.message} ${logged[0]}`).not.toMatch(/failed|nothing was changed/i);
			// Both halves of it are true.
			expect(sqlite.prepare('SELECT id FROM boards ORDER BY id').all()).toEqual([{ id: 1 }, { id: 2 }, { id: 3 }]);
			expect((real as unknown as Database.Database['pragma'])('foreign_keys', { simple: true })).toBe(0);
		});
	});
});

// ─── What the migrations build, against what the model says ──────────────────

/*
 * The model is `src/lib/server/db/schema.ts`. `drizzle-kit export` turns it
 * into the DDL for a database built from the model alone, and that database is
 * compared with one the runner has been over.
 *
 * Two comparisons are made, and both must find nothing. One is the runner's
 * own (`schemaDifferences`), which uses the checked-in copy of the model's DDL.
 * The other is written here, separately, and uses DDL exported afresh. A fault
 * in the runner's comparison would otherwise be a fault in the only thing
 * checking it.
 *
 * The comparison is of structure, as SQLite reports it — `table_info`,
 * `foreign_key_list`, `index_list` and `index_info` — and never of DDL text.
 * The same table can be written many ways, and after a rename SQLite stores
 * its name quoted, so two identical tables routinely have different text.
 *
 * There is no list of accepted differences: no table and no column is
 * excused. What is treated as the same is a short list of rules. Four are
 * things SQLite itself treats as the same:
 *
 *   - the case of a type name
 *   - NOT NULL on an INTEGER PRIMARY KEY, which is the rowid and never NULL
 *   - `false` and `true` as defaults, SQLite's names for 0 and 1
 *   - `DEFAULT NULL`, which is no default
 *
 * and the fifth is a rule of the comparison (card 2006, decision 13):
 *
 *   - the order of a table's columns, which is not part of the schema. Columns
 *     are matched by name. A column added by ALTER TABLE goes on the end, so
 *     nine of production's tables have their columns in another order than
 *     the model's, and nothing reads a column by its position.
 *
 * The runner's comparison has a sixth: two spellings of one foreign key, the
 * parent table's name in another case and its column left out, are the same
 * key.
 *
 * What the pragmas do not report is not compared, by either comparison, and a
 * difference in any of it would go unseen:
 *
 *   - CHECK constraints. There is one, on `token_usage`; the last test in
 *     this block exercises it instead
 *   - the WHERE of a partial index
 *   - COLLATE on a column that no index covers
 *   - DEFERRABLE and INITIALLY DEFERRED on a foreign key
 *   - STRICT, and WITHOUT ROWID where the key is NOT NULL either way
 *   - ON CONFLICT clauses on a constraint
 *   - the expression of a generated column
 *
 * A test in "the start-up schema check" builds two tables that differ in each
 * of these and shows that nothing is found, so that the list is a fact about
 * the code and not a hope. The migration record is the runner's own table and
 * is not part of the model.
 */

type ColumnShape = { type: string; notNull: boolean; default: string | null; primaryKey: number };
type TableShape = {
	columns: Record<string, ColumnShape>;
	foreignKeys: string[];
	indexes: string[];
	autoincrement: boolean;
};
type Structure = Record<string, TableShape>;

/** `DEFAULT NULL` is no default; `false` and `true` are how SQLite spells 0 and 1. */
function sameDefault(value: string | null): string | null {
	if (value === null || /^null$/i.test(value.trim())) return null;
	if (/^false$/i.test(value.trim())) return '0';
	if (/^true$/i.test(value.trim())) return '1';
	return value.trim();
}

function structureOf(database: Database.Database): Structure {
	const structure: Structure = {};
	// The migration record is the runner's own table, not part of the model.
	for (const table of tablesOf(database).filter((name) => name !== '__drizzle_migrations')) {
		const info = database.prepare(`PRAGMA table_info("${table}")`).all() as {
			name: string;
			type: string;
			notnull: number;
			dflt_value: string | null;
			pk: number;
		}[];
		const columns: Record<string, ColumnShape> = {};
		for (const column of info) {
			// The table's INTEGER PRIMARY KEY is an alias for the rowid.
			const isRowid =
				column.pk === 1 && column.type.toUpperCase() === 'INTEGER' && info.filter((c) => c.pk > 0).length === 1;
			columns[column.name] = {
				type: column.type.toUpperCase(),
				notNull: column.notnull === 1 || isRowid,
				default: sameDefault(column.dflt_value),
				primaryKey: column.pk
			};
		}

		// One foreign key is one id; a composite key has a row per column.
		const keys = new Map<number, { table: string; from: string[]; to: (string | null)[]; rule: string }>();
		for (const row of database.prepare(`PRAGMA foreign_key_list("${table}")`).all() as {
			id: number;
			seq: number;
			table: string;
			from: string;
			to: string | null;
			on_update: string;
			on_delete: string;
		}[]) {
			const key = keys.get(row.id) ?? {
				table: row.table.toLowerCase(),
				from: [],
				to: [],
				rule: `on update ${row.on_update}, on delete ${row.on_delete}`
			};
			key.from[row.seq] = row.from;
			key.to[row.seq] = row.to;
			keys.set(row.id, key);
		}

		// An index made by CREATE INDEX is compared by name. One SQLite made for
		// a PRIMARY KEY or UNIQUE constraint has a name nobody chose, and is
		// compared by what it covers.
		const indexes = (
			database.prepare(`PRAGMA index_list("${table}")`).all() as {
				name: string;
				unique: number;
				origin: string;
				partial: number;
			}[]
		).map((index) => {
			const covered = (
				database.prepare(`PRAGMA index_info("${index.name}")`).all() as { seqno: number; name: string | null }[]
			)
				.sort((a, b) => a.seqno - b.seqno)
				.map((c) => c.name ?? '<expression>');
			const kind = index.unique ? 'unique index' : 'index';
			const name =
				index.origin === 'c'
					? `${kind} ${index.name}`
					: `${kind} for a ${index.origin === 'pk' ? 'primary key' : 'unique constraint'}`;
			return `${name} on (${covered.join(', ')})${index.partial ? ', partial' : ''}`;
		});

		// Whether the table says AUTOINCREMENT is not something a pragma reports.
		// Comments are taken out first: some of the DDL has them.
		const stored = database.prepare("SELECT sql FROM sqlite_master WHERE type = 'table' AND name = ?").get(table) as {
			sql: string;
		};

		structure[table] = {
			columns,
			foreignKeys: [...keys.values()]
				.map((k) => `(${k.from.join(', ')}) references ${k.table}(${k.to.join(', ')}), ${k.rule}`)
				.sort(),
			indexes: indexes.sort(),
			autoincrement: /\bAUTOINCREMENT\b/i.test(stored.sql.replace(/--.*$/gm, ''))
		};
	}
	return structure;
}

const union = (a: object, b: object) => [...new Set([...Object.keys(a), ...Object.keys(b)])].sort();

/** Every difference between a database and the model, as `where: what`. Empty if they are the same. */
function differencesFromModel(database: Structure, model: Structure): string[] {
	const found: string[] = [];
	for (const table of union(database, model)) {
		const built = database[table];
		const meant = model[table];
		if (!meant) {
			found.push(`${table}: the table is not in the model`);
			continue;
		}
		if (!built) {
			found.push(`${table}: the table is in the model but not in the database`);
			continue;
		}

		for (const column of union(built.columns, meant.columns)) {
			const where = `${table}.${column}`;
			const has = built.columns[column];
			const wants = meant.columns[column];
			if (!wants) found.push(`${where}: the column is not in the model`);
			else if (!has) found.push(`${where}: the column is in the model but not in the database`);
			else {
				if (has.type !== wants.type) found.push(`${where}: type is ${has.type}; the model has ${wants.type}`);
				if (has.notNull !== wants.notNull) {
					found.push(
						`${where}: ${has.notNull ? 'is NOT NULL; the model has it nullable' : 'is nullable; the model has it NOT NULL'}`
					);
				}
				if (has.default !== wants.default) {
					found.push(`${where}: default is ${has.default}; the model has ${wants.default}`);
				}
				if (has.primaryKey !== wants.primaryKey) {
					found.push(`${where}: primary key position is ${has.primaryKey}; the model has ${wants.primaryKey}`);
				}
			}
		}

		for (const [things, builtList, meantList] of [
			['foreign key', built.foreignKeys, meant.foreignKeys],
			['index', built.indexes, meant.indexes]
		] as const) {
			for (const item of builtList) {
				if (!meantList.includes(item)) found.push(`${table}: ${things} not in the model: ${item}`);
			}
			for (const item of meantList) {
				if (!builtList.includes(item)) found.push(`${table}: ${things} in the model but not in the database: ${item}`);
			}
		}

		if (built.autoincrement !== meant.autoincrement) {
			found.push(`${table}: ${built.autoincrement ? 'is' : 'is not'} AUTOINCREMENT, unlike the model`);
		}
	}
	return found;
}

describe('the database the runner leaves, against the model', () => {
	let modelDdl = '';

	beforeAll(() => {
		// The same command a developer would run, without the shell: on Windows
		// `npx` is a .cmd file, which execFile cannot start.
		modelDdl = execFileSync(
			process.execPath,
			[
				join(ROOT, 'node_modules', 'drizzle-kit', 'bin.cjs'),
				'export',
				'--dialect',
				'sqlite',
				'--schema',
				'src/lib/server/db/schema.ts'
			],
			{ cwd: ROOT, encoding: 'utf8' }
		).replace(/\r\n/g, '\n');
		// If drizzle-kit ever prints something other than the DDL, say so here
		// rather than as a syntax error in every test below.
		expect(modelDdl).toContain('CREATE TABLE `categories`');
	}, 60_000);

	/** A database built from the model alone, exported afresh. */
	const modelDatabase = () => {
		const database = memoryDb();
		// drizzle-kit ends every statement with `;` and a newline, with no
		// statement-breakpoint markers, so the whole export runs as one script.
		database.exec(modelDdl);
		return database;
	};

	/** Both comparisons, each of which must find nothing. */
	const differencesIn = (database: Database.Database) => ({
		byThisFile: differencesFromModel(structureOf(database), structureOf(modelDatabase())),
		byTheRunner: schemaDifferences(database)
	});
	const NONE = { byThisFile: [], byTheRunner: [] };

	/**
	 * Differences less the 39 indexes 0053 creates (one of them as 0054 makes
	 * it), which must all be among them: what a database that has not had 0053
	 * lacks.
	 */
	const withoutTheIndexesOf0053 = (differences: string[]) => {
		const lacking = INDEXES_FROM_0053.map(
			({ name, table, column }) => `${table}: index in the model but not in the database: index ${name} on (${column})`
		);
		expect(differences).toEqual(expect.arrayContaining(lacking));
		return differences.filter((difference) => !lacking.includes(difference));
	};

	describe('the checked-in copy of the model', () => {
		it('is the DDL that drizzle-kit exports, statement for statement', () => {
			// The runner cannot ask drizzle-kit: it is not installed in production.
			// It has this copy instead, and a copy can go stale. Change schema.ts
			// without regenerating it, or edit it by hand, and this fails.
			//
			// drizzle-kit leaves a blank line after each CREATE TABLE; nothing
			// else separates the export from the statements joined by newlines.
			expect(EXPECTED_SCHEMA.join('\n') + '\n').toBe(modelDdl.replace(/;\n\n+/g, ';\n'));
			expect(Object.isFrozen(EXPECTED_SCHEMA)).toBe(true);
		});

		it('is exactly what its generator writes', () => {
			// The whole file this time, header and layout included, so that the
			// file in the repository is always one that `npm run schema:expected`
			// would leave untouched.
			const check = () =>
				execFileSync(process.execPath, [join(ROOT, 'scripts', 'generate-expected-schema.mjs'), '--check'], {
					cwd: ROOT,
					encoding: 'utf8',
					stdio: 'pipe'
				});
			expect(check).not.toThrow();
		}, 60_000);

		it.each([...RECONCILED_TABLES])(
			'gives %s a scratch table that is the model’s own, with only the name changed',
			(table) => {
				const opening = `CREATE TABLE \`${table}\` (`;
				const statement = EXPECTED_SCHEMA.filter((s) => s.startsWith(opening));
				expect(statement).toHaveLength(1);
				const scratchName = scratchNameOf(table);
				expect(scratchName).toBe(`${table}_rebuild_2006`);

				const scratch = scratchTableStatement(table);

				// Character for character the model's statement, but for the name it opens with.
				expect(scratch).toBe(`CREATE TABLE \`${scratchName}\` (${statement[0].slice(opening.length)}`);
				// And SQLite agrees: built beside the real one, it has the same structure.
				const database = modelDatabase();
				database.exec(scratch);
				const structure = structureOf(database);
				// Less the indexes of its own CREATE INDEX statements, which the
				// table's statement does not make: the rebuild creates those after
				// the rename. Four of the six have one since card 2106.
				const own = structure[table];
				expect(structure[scratchName]).toEqual({
					...own,
					indexes: own.indexes.filter((index) => index.includes(' for a '))
				});
			}
		);

		it('will not make a scratch table from a statement written any other way', () => {
			// Editing a statement it does not recognise would be guesswork.
			expect(() => scratchTableStatement('settings', ['CREATE TABLE settings (key text PRIMARY KEY NOT NULL);'])).toThrow(
				/a rebuild needs exactly one/
			);
			expect(() => scratchTableStatement('no_such_table')).toThrow(/a rebuild needs exactly one/);
		});

		it('will not make one from a statement that names its table a second time', () => {
			// Only the opening is renamed. `token_usage` is the one table in the
			// model with a CHECK today, and drizzle-kit wrote the table's name
			// into it: under a scratch name that is a CHECK on some other table,
			// which SQLite will not create. It is not one of the six, and this is
			// why it could not simply be made one.
			const statement = EXPECTED_SCHEMA.find((s) => s.startsWith('CREATE TABLE `token_usage` (')) ?? '';
			expect(statement).toContain('CHECK(("token_usage"."card_id" IS NULL) <> ("token_usage"."subtask_id" IS NULL))');
			expect(() => scratchTableStatement('token_usage')).toThrow(
				'the model\'s statement for it names token_usage again after "CREATE TABLE `token_usage` ("'
			);
			// What it is refusing: the statement, with only its opening renamed, does not run.
			const database = modelDatabase();
			expect(() =>
				database.exec(statement.replace('CREATE TABLE `token_usage` (', 'CREATE TABLE `token_usage_rebuild_2006` ('))
			).toThrow(/no such column: token_usage\./);

			// A name that only contains the table's is not the table's.
			expect(() =>
				scratchTableStatement('settings', [
					'CREATE TABLE `settings` (\n\t`key` text PRIMARY KEY NOT NULL,\n\t`user_settings` text,\n\t`settings_id` integer\n);'
				])
			).not.toThrow();
		});

		it.each([...RECONCILED_TABLES])('has a statement for %s that names it once, so that it can be rebuilt', (table) => {
			// The day a CHECK is added to one of the six, this fails, and the
			// table needs a migration of its own from then on.
			const opening = `CREATE TABLE \`${table}\` (`;
			const statement = EXPECTED_SCHEMA.find((s) => s.startsWith(opening)) ?? '';
			expect(statement).not.toBe('');
			expect(statement.slice(opening.length)).not.toMatch(new RegExp(`(?<![A-Za-z0-9_$])${table}(?![A-Za-z0-9_$])`, 'i'));
			expect(() => scratchTableStatement(table)).not.toThrow();
		});

		it('is checked before every build, so that a stale copy cannot be bundled', () => {
			// `npm run build` runs "prebuild" first. The tests check the same
			// thing, and building an image runs the tests too (`RUN npm run
			// verify`), but a build on a workstation does not.
			const scripts = JSON.parse(readFileSync(join(ROOT, 'package.json'), 'utf-8')).scripts as Record<string, string>;
			// It is the first step; the type check follows it (tests/harness.test.ts).
			expect(scripts.prebuild.split(' && ')[0]).toBe('node scripts/generate-expected-schema.mjs --check');
			expect(scripts.build).toBe('vite build');
		});
	});

	it('is the model exactly, for a new database', () => {
		const database = memoryDb();

		const report = runMigrations({ database, migrationsDir: REAL_MIGRATIONS });

		expect(report.applied).toEqual(realFiles);
		// Born in the model's shapes: nothing to rebuild.
		expect(report.rebuilt).toEqual([]);
		expect(report.schemaDifferences).toEqual([]);
		expect(differencesIn(database)).toEqual(NONE);
	});

	it('is the model exactly, for production', () => {
		const database = productionDatabase();
		// Measured on production: no categories, and three have existed.
		database.exec("INSERT INTO sqlite_sequence (name, seq) VALUES ('categories', 3)");
		// Where it starts. Every difference card 2006 set out to close, the 39
		// indexes of 0053 (card 2106), the column of 0056 (card 2168), and no
		// other.
		expect(withoutTheIndexesOf0053(differencesFromModel(structureOf(database), structureOf(modelDatabase())))).toEqual([
			'cards.first_completed_at: the column is in the model but not in the database',
			'categories.board_id: is NOT NULL; the model has it nullable',
			'categories: foreign key not in the model: (board_id) references boards(id), on update NO ACTION, on delete CASCADE',
			'categories: foreign key in the model but not in the database: (board_id) references boards(id), on update NO ACTION, on delete SET NULL',
			'columns.wip_limit: is nullable; the model has it NOT NULL',
			'invite_tokens.token: is nullable; the model has it NOT NULL',
			'settings.key: is nullable; the model has it NOT NULL',
			'task_requests.access_token: the column is in the model but not in the database',
			'task_requests: index in the model but not in the database: unique index task_requests_access_token_idx on (access_token)',
			'time_entries: the table is not in the model',
			'user_xp.name: is nullable; the model has it NOT NULL',
			'webhooks.set_by: the column is in the model but not in the database',
			'webhooks: foreign key in the model but not in the database: (set_by) references users(id), on update NO ACTION, on delete SET NULL',
			'webhooks: index in the model but not in the database: index idx_webhooks_set_by on (set_by)'
		]);

		const report = runMigrations({ database, migrationsDir: REAL_MIGRATIONS });

		expect(report.applied).toEqual([
			'0050_add_first_completed_at.sql',
			'0051_add_request_access_token.sql',
			'0052_drop_time_entries.sql',
			'0053_index_foreign_keys_end_sessions.sql',
			FILE_0054,
			FILE_0055,
			FILE_0056
		]);
		expect(report.tolerated).toEqual([]);
		expect(report.rebuilt.map((r) => r.table)).toEqual(['columns', 'categories', 'settings', 'user_xp', 'invite_tokens']);
		expect(report.missingFromDisk).toEqual([]);
		expect(report.schemaDifferences).toEqual([]);
		expect(recordedIn(database)).toHaveLength(62);
		expect(sequenceIn(database, 'categories')).toBe(3);
		expect(foreignKeysOn(database)).toBe(true);
		expect(differencesIn(database)).toEqual(NONE);
		// 0053 indexed columns of columns, categories and invite_tokens, and the
		// rebuilds above then dropped those tables with their indexes. Each rebuild
		// creates the model's indexes again, so all 39 are there (card 2106, R12),
		// one of them as 0054 makes it.
		expect(indexesOf(database)).toEqual(expect.arrayContaining(INDEXES_FROM_0053.map((index) => index.name)));
		expect(unindexedForeignKeys(database)).toEqual([]);

		// And the start after that has nothing left to do.
		const again = runMigrations({ database, migrationsDir: REAL_MIGRATIONS });
		expect(again.applied).toEqual([]);
		expect(again.rebuilt).toEqual([]);
		expect(again.schemaDifferences).toEqual([]);
	});

	it('is the model exactly, for a database from before card 2006, with its rows', () => {
		const database = preCardDatabase();
		seed(database);
		// Where it starts: `boards` with neither of its foreign keys right,
		// none of the 39 indexes of 0053 (card 2106), and no column of 0056
		// (card 2168).
		expect(withoutTheIndexesOf0053(differencesFromModel(structureOf(database), structureOf(modelDatabase())))).toEqual([
			'boards: foreign key not in the model: (created_by) references users(id), on update NO ACTION, on delete NO ACTION',
			'boards: foreign key in the model but not in the database: (created_by) references users(id), on update NO ACTION, on delete SET NULL',
			'boards: foreign key in the model but not in the database: (parent_card_id) references cards(id), on update NO ACTION, on delete CASCADE',
			'categories.board_id: is NOT NULL; the model has it nullable',
			'categories: foreign key not in the model: (board_id) references boards(id), on update NO ACTION, on delete CASCADE',
			'categories: foreign key in the model but not in the database: (board_id) references boards(id), on update NO ACTION, on delete SET NULL',
			'time_entries: the table is not in the model',
			'webhooks.set_by: the column is in the model but not in the database',
			'webhooks: foreign key in the model but not in the database: (set_by) references users(id), on update NO ACTION, on delete SET NULL',
			'webhooks: index in the model but not in the database: index idx_webhooks_set_by on (set_by)'
		]);
		const rowsOf = (table: string) => contentsOf(database)[table];
		const before = Object.fromEntries(['boards', 'columns', 'categories', 'cards', 'labels'].map((t) => [t, rowsOf(t)]));
		// Less the indexes of 0053, which the run creates before it rebuilds.
		const notOf0053 = (difference: string) => !INDEXES_FROM_0053.some(({ name }) => difference.includes(` index ${name} on `));
		const differed = {
			boards: differencesOf(database, 'boards').filter(notOf0053),
			categories: differencesOf(database, 'categories').filter(notOf0053)
		};
		expect(differed.boards).toHaveLength(3);
		expect(differed.categories).toHaveLength(3);

		const report = runMigrations({ database, migrationsDir: REAL_MIGRATIONS });

		expect(report.applied).toEqual(['0052_drop_time_entries.sql', '0053_index_foreign_keys_end_sessions.sql', FILE_0054, FILE_0055, FILE_0056]);
		expect(report.rebuilt).toEqual([
			{ table: 'boards', rows: 3, defaulted: [], differences: differed.boards },
			{ table: 'categories', rows: 3, defaulted: [], differences: differed.categories }
		]);
		expect(report.schemaDifferences).toEqual([]);
		expect(differencesIn(database)).toEqual(NONE);
		for (const table of Object.keys(before)) expect(rowsOf(table)).toEqual(before[table]);
		expect(sequenceIn(database, 'boards')).toBe(8);
		expect(database.pragma('foreign_key_check')).toEqual([]);
	});

	it('enforces the one CHECK constraint, which the comparison above cannot see', () => {
		const migrated = memoryDb();
		runMigrations({ database: migrated, migrationsDir: REAL_MIGRATIONS });

		for (const database of [migrated, modelDatabase()]) {
			database.pragma('foreign_keys = OFF');
			const insert = (cardId: number | null, subtaskId: number | null) =>
				database.prepare('INSERT INTO token_usage (card_id, subtask_id, tokens) VALUES (?, ?, 1)').run(cardId, subtaskId);

			expect(() => insert(null, null)).toThrow(/CHECK constraint failed/);
			expect(() => insert(1, 1)).toThrow(/CHECK constraint failed/);
			expect(() => insert(1, null)).not.toThrow();
			expect(() => insert(null, 1)).not.toThrow();
		}
	});

	describe('foreign key columns (card 2106)', () => {
		it('each lead an index: in the model, in a new database and in production once the runner has been over it', () => {
			// The message names any column that does not.
			expect(unindexedForeignKeys(modelDatabase()), 'in the model').toEqual([]);

			const fresh = memoryDb();
			runMigrations({ database: fresh, migrationsDir: REAL_MIGRATIONS });
			expect(unindexedForeignKeys(fresh), 'in a new database').toEqual([]);

			const live = productionDatabase();
			runMigrations({ database: live, migrationsDir: REAL_MIGRATIONS });
			expect(unindexedForeignKeys(live), 'in production').toEqual([]);
		});

		it('had no index before 0053 in exactly the 39 columns it indexes, each named after its table and column', () => {
			expect(INDEXES_0053).toHaveLength(39);
			for (const { name, table, column } of INDEXES_0053) expect(name).toBe(`idx_${table}_${column}`);

			const database = memoryDb();
			const before = Object.fromEntries(
				realFiles.filter((f) => f < FILE_0053).map((f) => [f, readFileSync(join(REAL_MIGRATIONS, f), 'utf-8')])
			);
			applyFilesOnly(database, migrationsDir(before));
			expect(unindexedForeignKeys(database)).toEqual(INDEXES_0053.map(({ table, column }) => `${table}.${column}`).sort());

			// And in the model, under the same names, so that the start-up check
			// compares them by name: all but the one on activity_log.user_id, which
			// 0054 made one on user_id and created_at.
			const declared = EXPECTED_SCHEMA.filter((statement) => statement.startsWith('CREATE INDEX'));
			for (const { name, table, column } of INDEXES_0053.filter(({ name }) => name !== 'idx_activity_log_user_id')) {
				expect(declared).toContain(`CREATE INDEX \`${name}\` ON \`${table}\` (\`${column}\`);`);
			}
			expect(declared).toContain(
				'CREATE INDEX `idx_activity_log_user_id_created_at` ON `activity_log` (`user_id`,`created_at`);'
			);
		});

		it('are found by the check when one has no index, whatever else the table has', () => {
			const database = memoryDb();
			database.exec(`
				CREATE TABLE parents (id INTEGER PRIMARY KEY);
				CREATE TABLE children (
					id INTEGER PRIMARY KEY,
					parent_id INTEGER REFERENCES parents(id),
					indexed_id INTEGER REFERENCES parents(id),
					second_id INTEGER REFERENCES parents(id)
				);
				CREATE INDEX idx_children_indexed ON children (indexed_id);
				CREATE INDEX idx_children_pair ON children (id, second_id);
				CREATE TABLE pairs (a INTEGER REFERENCES parents(id), b INTEGER REFERENCES parents(id), PRIMARY KEY (a, b));
				CREATE TABLE one_to_one (id INTEGER PRIMARY KEY REFERENCES parents(id));
			`);
			// second_id is in an index, but not first in it; b is second in the key.
			expect(unindexedForeignKeys(database)).toEqual(['children.parent_id', 'children.second_id', 'pairs.b']);
		});
	});
});

// ─── 0053: every session ended once ──────────────────────────────────────────

describe('0053, which ends every session once (card 2106)', () => {
	/**
	 * A database with every migration before 0053 applied, two people signed
	 * in, an API key and two invites.
	 */
	function signedIn(): Database.Database {
		const database = memoryDb();
		const before = Object.fromEntries(
			realFiles.filter((f) => f < FILE_0053).map((f) => [f, readFileSync(join(REAL_MIGRATIONS, f), 'utf-8')])
		);
		applyFilesOnly(database, migrationsDir(before));
		database.exec(`
			INSERT INTO users (id, username, email, password_hash) VALUES
				(1, 'ann', 'ann@example.test', 'x'),
				(2, 'bob', 'bob@example.test', 'x');
			INSERT INTO sessions (id, user_id, expires_at) VALUES
				('session-of-ann', 1, '2099-01-01 00:00:00'),
				('session-of-bob', 2, '2099-01-01 00:00:00');
			INSERT INTO api_keys (key_hash, key_prefix, name, user_id) VALUES ('hash-of-ann', 'df_ann', 'Ann''s key', 1);
			INSERT INTO invite_tokens (token, user_id, expires_at, used) VALUES
				('invite-unused', 2, '2099-01-01 00:00:00', 0),
				('invite-used', 1, '2099-01-01 00:00:00', 1);
		`);
		return database;
	}

	it('ends every session, and leaves users, API keys, invites and everything else as they were', () => {
		const database = signedIn();
		const before = contentsOf(database);
		expect(before.sessions).toHaveLength(2);

		const report = runMigrations({ database, migrationsDir: REAL_MIGRATIONS });

		expect(report.applied).toEqual([FILE_0053, FILE_0054, FILE_0055, FILE_0056]);
		expect(report.schemaDifferences).toEqual([]);
		const after = contentsOf(database);
		expect(after.sessions).toEqual([]);
		for (const table of Object.keys(before)) {
			// The migration record, and its id counter, gain the files; 0054 ends
			// the unused invite, which its own tests cover.
			if (['sessions', 'invite_tokens', '__drizzle_migrations', 'sqlite_sequence'].includes(table)) continue;
			expect(after[table], table).toEqual(before[table]);
		}
		expect(after.users).toHaveLength(2);
		expect(after.api_keys).toHaveLength(1);
		expect(after.invite_tokens).toEqual(before.invite_tokens.filter((row) => row.includes('"invite-used"')));
	});

	it('deletes nothing at the next start, and a session made after it survives that start', () => {
		const database = signedIn();
		runMigrations({ database, migrationsDir: REAL_MIGRATIONS });
		database.exec(
			"INSERT INTO sessions (id, user_id, expires_at) VALUES ('signed-in-again', 1, '2099-01-01 00:00:00')"
		);
		const before = contentsOf(database);

		const again = runMigrations({ database, migrationsDir: REAL_MIGRATIONS });

		expect(again.applied).toEqual([]);
		expect(contentsOf(database)).toEqual(before);
		expect(contentsOf(database).sessions).toHaveLength(1);
	});

	it('passes the rehearsal, which notes the sessions it ended as the one-off declared for them', () => {
		const database = signedIn();
		const before = stateOf(database);

		const report = runMigrations({ database, migrationsDir: REAL_MIGRATIONS });
		const found: Findings = { problems: [], notes: [] };
		compare(before, stateOf(database), report.applied, found);

		expect(found.problems).toEqual([]);
		expect(found.notes).toEqual([
			`invite_tokens had 2 row(s) and has 1: every unused invite deleted by ${FILE_0054}, a one-off declared in tests/rehearsal/one-offs.ts`,
			`sessions had 2 row(s) and has 0: every row deleted by ${FILE_0053}, a one-off declared in tests/rehearsal/one-offs.ts`
		]);
	});

	it('is in a tree whose backups hold no session, without which it must not ship (card 2135)', () => {
		// 0053 ends the sessions that backups already made hold. Sessions made
		// after it must not leave in the next backup, or the one-off is spent:
		// so card 2106's tests cannot pass without card 2135's change (R9).
		resetDb();
		try {
			const user = makeUser();
			const token = makeSession(user);
			expect(sqlite.prepare('SELECT COUNT(*) AS n FROM sessions WHERE id = ?').get(token)).toEqual({ n: 1 });

			const bytes = generateBackupData();

			expect(bytes.includes(Buffer.from(token)), 'the id of a live session').toBe(false);
			// It is a backup of this database: the user is in it.
			expect(bytes.includes(Buffer.from(user.email))).toBe(true);
		} finally {
			resetDb();
		}
	});
});

// ─── One-off changes to data ─────────────────────────────────────────────────

describe('a migration file that loses rows (card 2106, decision 3)', () => {
	/** A statement's text with its comments, strings and quoted names blanked, so that a word in one is not read. */
	const codeOf = (text: string) =>
		text.replace(/--[^\n]*|\/\*[\s\S]*?\*\/|'(?:[^']|'')*'|"(?:[^"]|"")*"|`(?:[^`]|``)*`|\[[^\]]*\]/g, ' ');

	/**
	 * The statements of a migration file that can take rows away, read as the
	 * runner reads them, so that a comment, a string or an `ON DELETE` is not
	 * one: a DELETE, a DROP TABLE, a REPLACE, any statement that opens with
	 * WITH (which can be a DELETE), an INSERT OR REPLACE and an UPDATE OR
	 * REPLACE (each deletes the rows it collides with), and a trigger whose
	 * body deletes or replaces. A DROP INDEX, VIEW or TRIGGER takes no row.
	 */
	const losingRows = (sql: string) =>
		sqlStatements(sql)
			.filter((statement) => {
				const code = codeOf(statement.text);
				if (['DELETE', 'REPLACE', 'WITH'].includes(statement.keyword)) return true;
				if (statement.keyword === 'DROP') return /^\s*DROP\s+TABLE\b/i.test(code);
				if (statement.keyword === 'INSERT' || statement.keyword === 'UPDATE') return /\bOR\s+REPLACE\b/i.test(code);
				if (statement.keyword === 'CREATE' && /^\s*CREATE\s+(TEMP\s+|TEMPORARY\s+)?TRIGGER\b/i.test(code)) {
					// After its BEGIN: the event it waits for may be a DELETE, which takes nothing.
					return /\b(DELETE|REPLACE)\b/i.test(code.slice(code.search(/\bBEGIN\b/i)));
				}
				return false;
			})
			.map((statement) => statement.text);

	/** The tables a migration file's UPDATE statements name, read as the runner reads them. */
	const updatesOf = (sql: string) =>
		sqlStatements(sql)
			.filter((statement) => statement.keyword === 'UPDATE')
			.map((statement) => /^\s*UPDATE\s+(?:OR\s+\w+\s+)?[`"[]?(\w+)/i.exec(statement.text)?.[1] ?? '');

	/** Each file from 0053 on that can lose rows and is not declared, with its first such statement. */
	function undeclared(dir: string, oneOffs: readonly OneOff[] = ONE_OFFS): string[] {
		const found: string[] = [];
		for (const file of readdirSync(dir).filter((f) => f.endsWith('.sql') && f >= ONE_OFFS_FROM).sort()) {
			const losing = losingRows(readFileSync(join(dir, file), 'utf-8'));
			if (losing.length > 0 && !oneOffs.some((oneOff) => oneOff.file === file)) {
				found.push(`${file}: ${losing[0]} — declare it in tests/rehearsal/one-offs.ts`);
			}
		}
		return found;
	}

	it('is declared to the rehearsal, every one of them from 0053 on', () => {
		expect(undeclared(REAL_MIGRATIONS)).toEqual([]);
		// The one there is, which shows the reading sees it.
		expect(losingRows(readFileSync(join(REAL_MIGRATIONS, FILE_0053), 'utf-8'))).toEqual(['DELETE FROM `sessions`;']);
	});

	it('is declared by a file in drizzle/ that loses rows, and a table in the model', () => {
		for (const oneOff of ONE_OFFS) {
			expect(realFiles, oneOff.file).toContain(oneOff.file);
			expect(oneOff.file >= ONE_OFFS_FROM).toBe(true);
			const sql = readFileSync(join(REAL_MIGRATIONS, oneOff.file), 'utf-8');
			if (oneOff.keepsRows) {
				// One that rewrites values in the rows it keeps (0055): it loses
				// none, and updates the table it names.
				expect(losingRows(sql), oneOff.file).toEqual([]);
				expect(updatesOf(sql), oneOff.file).toContain(oneOff.table);
				continue;
			}
			expect(losingRows(sql), oneOff.file).not.toEqual([]);
			expect(EXPECTED_SCHEMA.some((statement) => statement.startsWith(`CREATE TABLE \`${oneOff.table}\` (`)), oneOff.table).toBe(
				true
			);
		}
	});

	it.each([
		['a DELETE', 'DELETE FROM things WHERE id > 1;'],
		['a DROP', 'DROP TABLE things;'],
		['a REPLACE', "REPLACE INTO things (id, name) VALUES (1, 'a');"],
		['an INSERT OR REPLACE', "INSERT OR REPLACE INTO things (id, name) VALUES (1, 'a');"],
		['a DELETE that opens with WITH', 'WITH old AS (SELECT id FROM things) DELETE FROM things WHERE id IN (SELECT id FROM old);'],
		// An UPDATE OR REPLACE deletes each row its new value collides with, and
		// a trigger that deletes takes rows whenever it fires (the P6 review, N9).
		['an UPDATE OR REPLACE', "UPDATE OR REPLACE things SET name = 'a';"],
		[
			'a trigger that deletes',
			'CREATE TRIGGER prune AFTER INSERT ON things BEGIN DELETE FROM things WHERE id < NEW.id - 10; END;'
		],
		[
			'a trigger that replaces',
			"CREATE TEMP TRIGGER swap AFTER UPDATE ON things BEGIN INSERT OR REPLACE INTO things (id, name) VALUES (1, 'a'); END;"
		]
	])('fails when it holds %s and is not declared', (_kind, sql) => {
		const dir = migrationsDir({
			'0040_older.sql': 'DELETE FROM things;',
			'0054_sample.sql': statements('CREATE TABLE extra (id INTEGER PRIMARY KEY);', sql)
		});

		// The older file was written before the rule and is not read.
		expect(undeclared(dir)).toEqual([`0054_sample.sql: ${sql} — declare it in tests/rehearsal/one-offs.ts`]);
		expect(undeclared(dir, [...ONE_OFFS, { file: '0054_sample.sql', table: 'things', change: 'some rows deleted' }])).toEqual([]);
	});

	it('passes when its only DELETE is in a comment, a string or an ON DELETE', () => {
		const dir = migrationsDir({
			'0054_sample.sql': statements(
				'-- DELETE FROM sessions; DROP TABLE users;',
				'CREATE TABLE extra (id INTEGER PRIMARY KEY, user_id INTEGER REFERENCES users(id) ON DELETE cascade);',
				"INSERT INTO extra (id) SELECT id FROM users WHERE username <> 'DELETE';",
				'CREATE INDEX IF NOT EXISTS `idx_extra_user_id` ON `extra` (`user_id`);'
			)
		});
		expect(undeclared(dir)).toEqual([]);
	});

	it('passes when it drops an index, or has a trigger that fires on a delete and deletes nothing itself', () => {
		// Neither loses a row: an index holds none, and the trigger's DELETE is
		// the event it waits for, not a statement it runs.
		const dir = migrationsDir({
			'0054_sample.sql': statements(
				'DROP INDEX IF EXISTS `idx_extra_user_id`;',
				"CREATE TRIGGER noted AFTER DELETE ON extra BEGIN INSERT INTO log (what) VALUES ('-- DELETE'); END;",
				"CREATE TRIGGER /* DELETE */ also AFTER UPDATE ON extra BEGIN UPDATE extra SET note = 'DELETE' WHERE id = NEW.id; END;"
			)
		});
		expect(undeclared(dir)).toEqual([]);
	});

	describe('in the rehearsal', () => {
		const state = (sessions: number, recorded: number): State => ({
			rows: { __drizzle_migrations: recorded, sessions, users: 2 },
			sequences: {},
			violations: 0
		});
		const comparing = (applied: string[]): Findings => {
			const found: Findings = { problems: [], notes: [] };
			compare(state(5, 52), state(0, 52 + applied.length), applied, found);
			return found;
		};

		it('is a note in a run that applied the file that declares it', () => {
			expect(comparing([FILE_0053])).toEqual({
				problems: [],
				notes: [`sessions had 5 row(s) and has 0: every row deleted by ${FILE_0053}, a one-off declared in tests/rehearsal/one-offs.ts`]
			});
		});

		it('is a failure in a run that did not apply that file', () => {
			expect(comparing(['0054_something_else.sql'])).toEqual({
				problems: [`sessions had 5 row(s) and has 0, and ${FILE_0053}, which may take its rows, was not applied in this run`],
				notes: []
			});
			expect(comparing([]).problems).toHaveLength(1);
		});

		it('is a failure in a table nothing declares', () => {
			const found: Findings = { problems: [], notes: [] };
			compare(state(5, 52), { ...state(5, 53), rows: { ...state(5, 53).rows, users: 1 } }, [FILE_0053], found);
			expect(found.problems).toEqual(['users had 2 row(s) and has 1']);
		});

		// Card 2158: a one-off that rewrites values and keeps every row, as 0055 does.
		const KEEPS: OneOff = { file: '0055_sample.sql', table: 'users', change: 'every name rewritten', keepsRows: true };

		it('of a one-off that keeps its rows, excuses no loss from its table', () => {
			const found: Findings = { problems: [], notes: [] };
			compare(state(5, 52), { ...state(5, 53), rows: { ...state(5, 53).rows, users: 1 } }, ['0055_sample.sql'], found, [KEEPS]);
			expect(found.problems).toEqual(['users had 2 row(s) and has 1']);
		});

		it('of a one-off that keeps its rows, is a note of what it changed in a run that applied it, and none in a run that did not', () => {
			const ran: Findings = { problems: [], notes: [] };
			compare(state(5, 52), state(5, 53), ['0055_sample.sql'], ran, [KEEPS]);
			expect(ran).toEqual({
				problems: [],
				notes: ['users: every name rewritten in its 2 row(s) by 0055_sample.sql, a one-off declared in tests/rehearsal/one-offs.ts']
			});

			const other: Findings = { problems: [], notes: [] };
			compare(state(5, 52), state(5, 53), ['0055_other.sql'], other, [KEEPS]);
			expect(other).toEqual({ problems: [], notes: [] });
		});
	});
});

// ─── 0054: a person's log entries by person and time, and no unused invite ──

describe('0054, which indexes a person’s entries by time and ends every unused invite (the P6 review)', () => {
	/** Every statement `sqlite.prepare` was given while `run` ran, and what `run` gave. */
	async function preparedDuring<T>(run: () => T | Promise<T>): Promise<{ result: T; prepared: string[] }> {
		const prepared: string[] = [];
		const prepare = sqlite.prepare.bind(sqlite);
		const spy = vi.spyOn(sqlite, 'prepare').mockImplementation(((source: string) => {
			prepared.push(source);
			return prepare(source);
		}) as typeof sqlite.prepare);
		try {
			return { result: await run(), prepared };
		} finally {
			spy.mockRestore();
		}
	}

	/** The query plan of `source`, every `?` bound to `value`: with no statistics, a plan does not depend on the values. */
	const planOf = (source: string, value: unknown = 1) =>
		(
			sqlite
				.prepare(`EXPLAIN QUERY PLAN ${source}`)
				.all(...Array.from({ length: (source.match(/\?/g) ?? []).length }, () => value)) as { detail: string }[]
		).map((row) => row.detail);

	/**
	 * A person who has written a lot: three boards of ten cards, each card
	 * with entries and comments by them and by somebody else, as the activity
	 * report and the audit routes meet them.
	 */
	function aBusyPerson() {
		resetDb();
		const admin = makeUser({ role: 'admin' });
		const heavy = makeUser();
		const other = makeUser();
		const insertEntry = sqlite.prepare(
			"INSERT INTO activity_log (board_id, card_id, user_id, action, detail, created_at) VALUES (?, ?, ?, 'card_moved', 'moved', ?)"
		);
		const insertComment = sqlite.prepare('INSERT INTO card_comments (card_id, user_id, content, created_at) VALUES (?, ?, ?, ?)');
		for (let b = 0; b < 3; b++) {
			const { board, cols } = makeBoard({ owner: admin });
			for (let c = 0; c < 10; c++) {
				const card = makeCard(cols['To Do']);
				for (let e = 0; e < 5; e++) {
					const at = `2026-10-${String(1 + e).padStart(2, '0')} 0${b}:${String(c).padStart(2, '0')}:00`;
					insertEntry.run(board.id, card.id, e % 2 ? other.id : heavy.id, at);
					insertComment.run(card.id, e % 2 ? heavy.id : other.id, `comment ${e}`, at);
				}
			}
		}
		return { admin, heavy };
	}

	afterEach(() => {
		try {
			afterEachTimestampCheck(sqlite);
		} finally {
			resetDb();
		}
	});

	it('is the file after 0053: the composite index in place of the one on user_id, then the delete of unused invites', () => {
		expect(realFiles.filter((f) => f > FILE_0053)).toEqual([FILE_0054, FILE_0055, FILE_0056]);
		const sql = sqlStatements(readFileSync(join(REAL_MIGRATIONS, FILE_0054), 'utf-8')).map((s) => s.text);
		expect(sql).toEqual([
			'DROP INDEX IF EXISTS `idx_activity_log_user_id`;',
			'CREATE INDEX IF NOT EXISTS `idx_activity_log_user_id_created_at` ON `activity_log` (`user_id`,`created_at`);',
			'DELETE FROM `invite_tokens` WHERE `used` = 0;'
		]);
	});

	it('the activity report filtered by a person looks each card’s entries and comments up by card (B1)', async () => {
		// With an index on user_id, SQLite answered "an entry by this person on
		// this card" by the person's index, once for every card: 4,215 ms
		// against 9 ms on 2,000 cards and 60,000 entries (the P6 review).
		const { admin, heavy } = aBusyPerson();
		const { result, prepared } = await preparedDuring(() =>
			buildActivityReport({ actor: admin, userId: heavy.id, from: '2026-10-01', to: '2026-10-31' })
		);
		expect(result.totals.cards).toBe(30);

		const report = prepared.filter((source) => source.includes('FROM activity_log al2'));
		expect(report).toHaveLength(1);
		const plan = (
			sqlite
				.prepare(`EXPLAIN QUERY PLAN ${report[0]}`)
				.all({ from: '2026-10-01 00:00:00', to: '2026-10-31 23:59:59', userId: heavy.id }) as { detail: string }[]
		).map((row) => row.detail);
		expect(plan).toContain('SEARCH al2 USING INDEX idx_activity_log_card (card_id=?)');
		expect(plan).toContain('SEARCH cc2 USING INDEX idx_card_comments_card_id (card_id=?)');
		expect(plan.filter((line) => /\b(al2|cc2)\b/.test(line) && /user_id/.test(line))).toEqual([]);
	});

	it.each(['/api/audit', '/api/v1/audit-log'])(
		'%s, filtered by a person, reads their newest entries by person and time, and sorts nothing (M2)',
		async (path) => {
			const { admin, heavy } = aBusyPerson();
			for (const query of [`userId=${heavy.id}`, `userId=${heavy.id}&from=2026-10-02&to=2026-10-04`]) {
				const { result, prepared } = await preparedDuring(() => api('GET', `${path}?${query}&limit=10`, { user: admin }));
				expect(result.status, JSON.stringify(result.body)).toBe(200);
				expect(result.body.data).toHaveLength(10);

				const page = prepared.filter((source) => source.includes('from "activity_log"') && / order by /i.test(source));
				expect(page, query).toHaveLength(1);
				const plan = planOf(page[0], heavy.id);
				expect(plan, query).toEqual([
					expect.stringMatching(/^SEARCH activity_log USING INDEX idx_activity_log_user_id_created_at \(user_id=\?/)
				]);
			}
		}
	);

	it.each([
		['/api/audit', 'boardId', 'idx_activity_log_board_created (board_id=?'],
		['/api/v1/audit-log', 'boardId', 'idx_activity_log_board_created (board_id=?'],
		['/api/v1/audit-log', 'cardId', 'idx_activity_log_card (card_id=?']
	])(
		'%s, filtered by a person and a %s, reads that one’s entries by its own index, not every entry of the person’s',
		async (path, filter, index) => {
			// Asked plainly, SQLite took the person's index for its order and read
			// every entry of theirs to find the few on this board or card (the
			// second P6 review). The person is asked as `+user_id`, as the
			// activity report does.
			const { admin, heavy } = aBusyPerson();
			const where = sqlite
				.prepare('SELECT board_id AS boardId, card_id AS cardId FROM activity_log WHERE user_id = ? LIMIT 1')
				.get(heavy.id) as { boardId: number; cardId: number };
			const value = filter === 'boardId' ? where.boardId : where.cardId;
			for (const query of [
				`userId=${heavy.id}&${filter}=${value}`,
				`userId=${heavy.id}&${filter}=${value}&from=2026-10-01&to=2026-10-05`
			]) {
				const { result, prepared } = await preparedDuring(() => api('GET', `${path}?${query}&limit=10`, { user: admin }));
				expect(result.status, JSON.stringify(result.body)).toBe(200);
				expect(result.body.data).toHaveLength(filter === 'boardId' ? 10 : 3);
				expect(result.body.data.every((entry: { userId: number }) => entry.userId === heavy.id)).toBe(true);

				const reads = prepared.filter((source) => source.includes('from "activity_log"'));
				expect(reads.length, query).toBeGreaterThan(0);
				for (const source of reads) {
					const plan = planOf(source, value);
					expect(plan[0], `${query}\n${source}`).toMatch(new RegExp(`^SEARCH activity_log USING INDEX ${index.replace(/[()?]/g, '\\$&')}`));
					expect(plan.some((line) => line.includes('user_id')), query).toBe(false);
				}
			}
		}
	);

	it('GET /api/v1/me/stats counts a person’s completions by person and time (M2)', async () => {
		const { heavy } = aBusyPerson();
		const { result, prepared } = await preparedDuring(() => api('GET', '/api/v1/me/stats', { user: heavy }));
		expect(result.status, JSON.stringify(result.body)).toBe(200);

		const counts = prepared.filter((source) => /^select count\(\*\) from "activity_log"/i.test(source));
		expect(counts).toHaveLength(3);
		const [allTime, ...lately] = counts.map((source) => planOf(source, heavy.id));
		// All time: every completion of theirs, from the index.
		expect(allTime).toEqual([
			expect.stringMatching(/^SEARCH activity_log USING INDEX idx_activity_log_user_id_created_at \(user_id=\?\)$/)
		]);
		// The last 7 and 30 days: only that stretch of the index is read.
		for (const plan of lately) {
			expect(plan).toEqual([
				expect.stringMatching(/^SEARCH activity_log USING INDEX idx_activity_log_user_id_created_at \(user_id=\? AND created_at>\?\)$/)
			]);
		}
		// The streak reads the same index; what it sorts is days, one row a day at most.
		const streak = prepared.filter((source) => /select distinct date\(created_at\)/i.test(source));
		expect(streak).toHaveLength(1);
		expect(planOf(streak[0], heavy.id)[0]).toMatch(
			/^SEARCH activity_log USING INDEX idx_activity_log_user_id_created_at \(user_id=\?\)$/
		);
	});

	it('leaves the index on card_comments.user_id as it is: nothing reads a person’s comments in order of time', () => {
		// The one query by a person is the count made when an account is
		// deleted (deletes.ts), which no order helps; comments are listed by card.
		const declared = EXPECTED_SCHEMA.filter((statement) => statement.startsWith('CREATE INDEX'));
		expect(declared).toContain('CREATE INDEX `idx_card_comments_user_id` ON `card_comments` (`user_id`);');
		expect(declared).toContain('CREATE INDEX `idx_activity_log_user_id_created_at` ON `activity_log` (`user_id`,`created_at`);');
		expect(declared.some((statement) => statement.includes('`idx_activity_log_user_id`'))).toBe(false);
	});

	it('deletes every unused invite, keeps the used ones and everything else, and deletes nothing at the next start (I4)', () => {
		const database = memoryDb();
		const before0054 = Object.fromEntries(
			realFiles.filter((f) => f < FILE_0054).map((f) => [f, readFileSync(join(REAL_MIGRATIONS, f), 'utf-8')])
		);
		applyFilesOnly(database, migrationsDir(before0054));
		database.exec(`
			INSERT INTO users (id, username, email, password_hash) VALUES
				(1, 'ann', 'ann@example.test', 'x'),
				(2, 'bob', 'bob@example.test', 'x');
			INSERT INTO invite_tokens (token, user_id, expires_at, used) VALUES
				('waiting-from-an-old-backup', 2, '2099-01-01 00:00:00', 0),
				('expired-unused', 2, '2020-01-01 00:00:00', 0),
				('used-long-ago', 1, '2020-01-01 00:00:00', 1);
		`);
		const before = contentsOf(database);
		const state = stateOf(database);

		const report = runMigrations({ database, migrationsDir: REAL_MIGRATIONS });

		expect(report.applied).toEqual([FILE_0054, FILE_0055, FILE_0056]);
		expect(report.schemaDifferences).toEqual([]);
		expect((database.prepare('SELECT token FROM invite_tokens').all() as { token: string }[]).map((r) => r.token)).toEqual([
			'used-long-ago'
		]);
		const after = contentsOf(database);
		for (const table of Object.keys(before)) {
			// The migration record, and its id counter, gain the file.
			if (table === 'invite_tokens' || table === '__drizzle_migrations' || table === 'sqlite_sequence') continue;
			expect(after[table], table).toEqual(before[table]);
		}
		expect(indexesOf(database)).toContain('idx_activity_log_user_id_created_at');
		expect(indexesOf(database)).not.toContain('idx_activity_log_user_id');

		// The rehearsal notes the loss as the one-off declared for it.
		const found: Findings = { problems: [], notes: [] };
		compare(state, stateOf(database), report.applied, found);
		expect(found).toEqual({
			problems: [],
			notes: [
				`invite_tokens had 3 row(s) and has 1: every unused invite deleted by ${FILE_0054}, a one-off declared in tests/rehearsal/one-offs.ts`
			]
		});

		// An invite issued after it survives the next start.
		database.exec(
			"INSERT INTO invite_tokens (token, user_id, expires_at, used) VALUES ('issued-after', 2, '2099-01-01 00:00:00', 0)"
		);
		const later = contentsOf(database);
		expect(runMigrations({ database, migrationsDir: REAL_MIGRATIONS }).applied).toEqual([]);
		expect(contentsOf(database)).toEqual(later);
	});
});

// ─── 0055: every task request a new link ─────────────────────────────────────

describe('0055, which gives every task request a new link once (card 2158)', () => {
	/** The links mailed before the deploy: what every backup made before card 2158 holds. */
	const MAILED = ['1'.repeat(64), '2'.repeat(64), '3'.repeat(64)];

	/** A database with every migration before 0055 applied and, unless `empty`, three requests: open, settled and unconfirmed. */
	function beforeIt(empty = false): Database.Database {
		const database = memoryDb();
		const before = Object.fromEntries(
			realFiles.filter((f) => f < FILE_0055).map((f) => [f, readFileSync(join(REAL_MIGRATIONS, f), 'utf-8')])
		);
		applyFilesOnly(database, migrationsDir(before));
		database.exec("INSERT INTO users (id, username, email, password_hash) VALUES (1, 'ann', 'ann@example.test', 'x')");
		if (!empty) {
			const insert = database.prepare(
				"INSERT INTO task_requests (target_type, target_id, title, requester_name, requester_email, status, access_token) VALUES ('user', 1, ?, 'Rita', 'rita@example.test', ?, ?)"
			);
			insert.run('Open', 'pending', MAILED[0]);
			insert.run('Settled', 'accepted', MAILED[1]);
			insert.run('Unconfirmed', 'unverified', MAILED[2]);
		}
		return database;
	}

	const linksIn = (database: Database.Database) =>
		(database.prepare('SELECT access_token FROM task_requests ORDER BY id').all() as { access_token: string }[]).map((r) => r.access_token);

	it('is one UPDATE of every access_token, in the backfill’s form, after a header comment', () => {
		const sql = readFileSync(join(REAL_MIGRATIONS, FILE_0055), 'utf-8');
		expect(sqlStatements(sql).map((s) => s.text)).toEqual(['UPDATE `task_requests` SET `access_token` = lower(hex(randomblob(32)));']);
		// What it changes, why, that it runs once and what people see (card 2106, decision 3).
		for (const said of ['A one-off change to data', 'What people see:', 'Harmless where it finds nothing', 'Runs once.']) {
			expect(sql, said).toContain(said);
		}
	});

	it('replaces every request’s link, open, settled or unconfirmed, and changes nothing else', () => {
		const database = beforeIt();
		const before = contentsOf(database);
		const state = stateOf(database);

		const report = runMigrations({ database, migrationsDir: REAL_MIGRATIONS });

		expect(report.applied).toEqual([FILE_0055, FILE_0056]);
		expect(report.schemaDifferences).toEqual([]);
		const links = linksIn(database);
		expect(links).toHaveLength(3);
		for (const link of links) expect(link).toMatch(/^[0-9a-f]{64}$/);
		expect(new Set(links).size).toBe(3);
		for (const mailed of MAILED) expect(links).not.toContain(mailed);
		// Every other column of every request, and every other table, as it was.
		const without = (rows: string[]) => rows.map((row) => row.replace(/"access_token":"[0-9a-f]{64}"/, '')).sort();
		const after = contentsOf(database);
		expect(without(after.task_requests)).toEqual(without(before.task_requests));
		for (const table of Object.keys(before)) {
			// The migration record, and its id counter, gain the file.
			if (['task_requests', '__drizzle_migrations', 'sqlite_sequence'].includes(table)) continue;
			expect(after[table], table).toEqual(before[table]);
		}

		// The rehearsal: every row kept, and the change noted as the one-off declared for it.
		const found: Findings = { problems: [], notes: [] };
		compare(state, stateOf(database), report.applied, found);
		expect(found).toEqual({
			problems: [],
			notes: [
				`task_requests: every access_token replaced in its 3 row(s) by ${FILE_0055}, a one-off declared in tests/rehearsal/one-offs.ts`
			]
		});
	});

	it('is harmless on an empty table, as a new installation has', () => {
		const database = beforeIt(true);

		const report = runMigrations({ database, migrationsDir: REAL_MIGRATIONS });

		expect(report.applied).toEqual([FILE_0055, FILE_0056]);
		expect(linksIn(database)).toEqual([]);
	});

	it('is recorded once, and the next start applies nothing and replaces no link given since', () => {
		const database = beforeIt();
		runMigrations({ database, migrationsDir: REAL_MIGRATIONS });
		const given = linksIn(database);
		expect(recordedIn(database).filter((name) => name === FILE_0055)).toHaveLength(1);

		const again = runMigrations({ database, migrationsDir: REAL_MIGRATIONS });

		expect(again.applied).toEqual([]);
		expect(linksIn(database)).toEqual(given);
	});

	it('is declared to the rehearsal as a one-off that keeps every row of task_requests', () => {
		expect(ONE_OFFS).toContainEqual({
			file: FILE_0055,
			table: 'task_requests',
			change: 'every access_token replaced',
			keepsRows: true
		});
	});
});

// ─── 0056: who last set a webhook's address or secret ────────────────────────

describe("0056, which adds who last set a webhook's address or secret (card 2168)", () => {
	/** A database with every migration before 0056 applied, and a webhook made before it. */
	function beforeIt(): Database.Database {
		const database = memoryDb();
		const before = Object.fromEntries(
			realFiles.filter((f) => f < FILE_0056).map((f) => [f, readFileSync(join(REAL_MIGRATIONS, f), 'utf-8')])
		);
		applyFilesOnly(database, migrationsDir(before));
		database.exec(`
			INSERT INTO users (id, username, email, password_hash) VALUES (1, 'ann', 'ann@example.test', 'x');
			INSERT INTO boards (id, name, created_by) VALUES (1, 'A', 1);
			INSERT INTO webhooks (id, board_id, url, secret) VALUES (1, 1, 'https://hooks.example.test/x', 's3cret');
		`);
		return database;
	}

	it('is the column with its foreign key, then its index, after a header comment', () => {
		const sql = readFileSync(join(REAL_MIGRATIONS, FILE_0056), 'utf-8');
		expect(sqlStatements(sql).map((s) => s.text)).toEqual([
			'ALTER TABLE `webhooks` ADD COLUMN `set_by` integer REFERENCES `users`(`id`) ON DELETE SET NULL;',
			'CREATE INDEX IF NOT EXISTS `idx_webhooks_set_by` ON `webhooks` (`set_by`);'
		]);
		for (const said of ['Changes no row', 'Runs once.']) expect(sql, said).toContain(said);
	});

	it('gives every webhook no setter and changes no row, and the column empties when its account is deleted', () => {
		const database = beforeIt();
		const before = contentsOf(database);
		const state = stateOf(database);

		const report = runMigrations({ database, migrationsDir: REAL_MIGRATIONS });

		expect(report.applied).toEqual([FILE_0056]);
		expect(report.schemaDifferences).toEqual([]);
		expect(database.prepare('SELECT id, url, secret, active, set_by FROM webhooks').all()).toEqual([
			{ id: 1, url: 'https://hooks.example.test/x', secret: 's3cret', active: 1, set_by: null }
		]);
		const after = contentsOf(database);
		for (const table of Object.keys(before)) {
			// The migration record, and its id counter, gain the file; each webhook gains the empty column.
			if (['webhooks', '__drizzle_migrations', 'sqlite_sequence'].includes(table)) continue;
			expect(after[table], table).toEqual(before[table]);
		}
		expect(indexesOf(database)).toContain('idx_webhooks_set_by');
		expect(database.prepare('PRAGMA foreign_key_list(webhooks)').all()).toContainEqual(
			expect.objectContaining({ table: 'users', from: 'set_by', to: 'id', on_delete: 'SET NULL' })
		);
		// The rehearsal: every row kept, nothing to note.
		const found: Findings = { problems: [], notes: [] };
		compare(state, stateOf(database), report.applied, found);
		expect(found).toEqual({ problems: [], notes: [] });

		expect(foreignKeysOn(database)).toBe(true);
		database.exec("INSERT INTO users (id, username, email, password_hash) VALUES (2, 'bob', 'bob@example.test', 'x')");
		database.prepare('UPDATE webhooks SET set_by = 2').run();
		database.prepare('DELETE FROM users WHERE id = 2').run();
		expect(database.prepare('SELECT id, set_by FROM webhooks').all()).toEqual([{ id: 1, set_by: null }]);
	});

	it('declares nothing to the rehearsal: it changes no row', () => {
		expect(ONE_OFFS.filter((oneOff) => oneOff.file === FILE_0056)).toEqual([]);
	});
});
