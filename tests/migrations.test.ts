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
import { createHash } from 'node:crypto';
import { existsSync, mkdirSync, mkdtempSync, readFileSync, readdirSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { eq } from 'drizzle-orm';
import { db, sqlite } from '$lib/server/db';
import { taskRequests } from '$lib/server/db/schema';
import { cleanExpiredSessions } from '$lib/server/auth';
import { inviteTokenHash, usableInvite } from '$lib/server/invites';
import { linkCheck } from '$lib/server/request-access';
import { requestLinkHash } from '$lib/server/request-tokens';
import { holdOf } from '$lib/server/webhooks';
import { printable } from '$lib/server/logger';
import { EXPECTED_SCHEMA } from '$lib/server/db/expected-schema';
import {
	BOARDS_LEAVE_DELETED_GROUPINGS,
	BOARDS_LEAVING_DELETED_GROUPINGS,
	CARDS_LEAVE_OTHER_BOARDS_MILESTONES,
	COMMITTED_BEFORE_UPSTREAM,
	MigrationError,
	RECONCILED_TABLES,
	TOLERANT_FILES,
	leadingKeywords,
	reconcileSchema,
	runBackfills,
	runMigrations,
	schemaDifferences,
	scratchNameOf,
	scratchTableStatement,
	sqlStatements,
	type MigrationOptions,
	type MigrationReport
} from '$lib/server/db/migrate';
import { RestoreError, restoreFromBackup } from '$lib/server/db/restore';
import { accountRulings } from '$lib/server/account-endings';
import { generateBackupData } from '$lib/server/backup';
import { backupSealKey, sealCopy } from '$lib/server/backup-secrets';
import { buildActivityReport } from '$lib/server/activity-report';
import { api, routeMethods } from './helpers/api';
import { importConfirmation, makeBoard, makeCard, makeSession, makeUser, makeWebhook, resetDb, sessionHashOf } from './helpers/fixtures';
import { afterEachTimestampCheck } from './helpers/timestamps';
import { readOpened } from './helpers/reads';
import { stamp, toStamp } from '$lib/timestamps';
import { ACCESS_KIND, accessCeiling } from '$lib/server/access-changes';
import production from './fixtures/production-schema-2026-10-12.json';
import { compare, stateOf, type Findings, type State } from './rehearsal/compare';
import { ONE_OFFS, ONE_OFFS_FROM, type OneOff } from './rehearsal/one-offs';

/**
 * Card 3009: what an import says of a backup's superadmin given the importer's password, the backup's seal not verifying
 * and the importer not in it: the route's importer holds no authenticator, so none was carried and the host's reset is named.
 */
const GIVEN_YOURS_NO_FACTOR =
	"The backup's superadmin is not the account you imported with, and the backup's seal did not verify, so its password in the backup was " +
	'not taken: it was given the password you confirmed this import with, but none of your authenticators, as no MFA key is loaded or none ' +
	"of yours could be moved: it cannot sign in until the server's host resets its two-step sign-in with scripts/mfa-reset.mjs. Then sign " +
	'in as it, the superadmin that now holds your email address, with that password.';
/**
 * What the answer says an unsealed backup's accounts not the same here were kept from (card 3012, R6): their notification
 * mail switched off, `count` of them, the carried superadmin among them.
 */
const NOTIFICATIONS_OFF = (count: number) =>
	"The backup's seal did not verify, so what it would send outside was not taken as the file has it: " +
	`${count} account(s) not the same here have their notification mail switched off until each signs in and switches it on.`;
/** Card 3009: and of one account in it not the same here, its password not taken. */
const ONE_PASSWORD_NOT_TAKEN =
	"1 account(s) in the backup are not on this server as the same account, and the backup's seal did not verify, so the password each " +
	'holds in it was not taken: each needs its password set (🔑) or an invite (📧) before it can sign in, and its report schedules were ' +
	"paused. The backup's App URL and mail host, where they differ from this server's, are held for review. Before sending an invite, " +
	"check each one's email address and role, and the App URL and the mail host: in a backup whose seal did not verify they are only the " +
	"file's word. Or set its password with 🔑, which mails nothing.";
/** `text` as a regular expression matches it, word for word. */
const literally = (text: string) => text.replace(/[.*+?^${}()|[\]\\]/g, '\\$&');

/** Card 3009 (R4): what an import says of a backup's mail settings held for review, its seal not verifying. */
const HELD_MAIL_UNSEALED =
	"The backup's seal did not verify, so the mail settings it brought in, at places this server did not hold, were held " +
	"for the superadmin's review: nothing is sent through them, and no link begins with the App URL, until the superadmin checks each and " +
	'keeps or removes it under Settings held for review.';

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

/**
 * The one line for the tables of a rebuild that did not complete, or for the
 * one table of it. The reason can quote a table's definition, line breaks and
 * all, and the logger writes each as a space (card 2214), as `printable` does.
 */
const notRebuiltLine = (tables: string[], reason: string, whatToDo: string) => {
	const one = tables.length === 1;
	return printable(
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

/** The real files up to and including `last`, or before it with `before`, as a migrations directory. */
const filesTo = (last: string, { before = false }: { before?: boolean } = {}) =>
	migrationsDir(
		Object.fromEntries(
			realFiles.filter((f) => (before ? f < last : f <= last)).map((f) => [f, readFileSync(join(REAL_MIGRATIONS, f), 'utf-8')])
		)
	);

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

/** The file of card 2155: every card in a milestone of another board taken out of it, once. */
const FILE_0057 = '0057_cards_leave_other_boards_milestones.sql';

/** The file of card 2159: the time zone a report schedule's time is read in. */
const FILE_0058 = '0058_add_report_schedule_time_zone.sql';

/** The file of card 2397: who last changed the mail settings, the App URL and each backup destination. */
const FILE_0059 = '0059_add_setting_setters.sql';

/** The file of milestone 22: the Options role, the ideas kind, and each card's commitment and discard. */
const FILE_0060 = '0060_add_upstream_options.sql';

/** The file of card 2673: the decision records model, and a Product Owner on each board. */
const FILE_0061 = '0061_add_decision_records.sql';

/** The file of card 2701: each session's count of wrong current passwords. */
const FILE_0062 = '0062_add_session_wrong_password_count.sql';

/** The file of card 2685: one closing-date reminder per participant per round. */
const FILE_0063 = '0063_add_decision_reminder_once.sql';

/** The file of card 2681: the record of every change to the people directory and its groups. */
const FILE_0064 = '0064_add_people_changes.sql';

/** How the model check reports 0064's table in a database that has not got it. */
const TABLE_OF_0064 = 'people_changes: the table is in the model but not in the database';

/** The file of card 2768: where two-step sign-in keeps its second factors. */
const FILE_0065 = '0065_add_mfa_storage.sql';

/** The four tables 0065 creates, in name order. */
const TABLES_OF_0065 = ['enrolment_links', 'mfa_factors', 'mfa_recovery_codes', 'sign_in_challenges'];

/** The eleven columns 0065 adds to users, each with the value it gives every account there already. */
const COLUMNS_OF_0065: Record<string, number | null> = {
	mfa_known_wrong: 0,
	mfa_other_wrong: 0,
	mfa_known_resumes_at: null,
	mfa_other_resumes_at: null,
	mfa_recovery_wrong: 0,
	mfa_recovery_resumes_at: null,
	last_sign_in_at: null,
	last_sign_in_from: null,
	failed_codes_since_sign_in: 0,
	security_banner: null,
	security_banner_at: null
};

/** How the model check reports 0065's users columns in a database that has not got them, in name order. */
const USERS_COLUMNS_OF_0065 = Object.keys(COLUMNS_OF_0065)
	.sort()
	.map((column) => `users.${column}: the column is in the model but not in the database`);

/** The file of card 2769: what the release of two-step sign-in needs stored first. */
const FILE_0066 = '0066_add_mfa_password_enrol.sql';

/** The file of card 2769: every session ended once, and the remembered-browser secret deleted. */
const FILE_0067 = '0067_end_sessions_for_two_step.sql';

/** The file of card 2849: every invite held in plain ended once, as invite tokens are stored as hashes. */
const FILE_0068 = '0068_end_plain_invite_tokens.sql';

/** The file of card 2772: a deadline for every API key made before it. */
const FILE_0069 = '0069_add_api_key_deadline.sql';

/** The file of card 2870: requester links kept as hashes, and every one held in plain ended. */
const FILE_0070 = '0070_add_request_links.sql';
const FILE_0071 = '0071_add_webhook_holds.sql';
/** The file of card 2671: when an account was disabled, and by whom. */
const FILE_0072 = '0072_add_account_disabled.sql';
/** The file of card 2928: the receiver a webhook's sealed address sends to, in plain. */
const FILE_0073 = '0073_add_webhook_receiver.sql';
/** The file of card 2922: the settings held for the superadmin's review. */
const FILE_0074 = '0074_add_setting_holds.sql';
/** The file of card 2947: which API key was given which webhook's secret. */
const FILE_0075 = '0075_add_webhook_reveals.sql';
/** The file of card 2995: every API key ended on this server, its watermark and its once-only seed. */
const FILE_0076 = '0076_add_api_key_revocations.sql';
/** The file of card 2996: every ending of an account on this server, its watermark and its once-only seed. */
const FILE_0077 = '0077_add_account_endings.sql';
/** The file of card 3020: a request's requester mail held, and its last release. */
const FILE_0078 = '0078_hold_request_mail.sql';
/** The file of card 3002: every change of access to a board, a team or a person here, and its once-only seed. */
const FILE_0079 = '0079_add_access_changes.sql';
/** The file of card 3033: every decision role in the record of changes of access, seeded once. */
const FILE_0080 = '0080_add_decision_role_changes.sql';
/** The file of card 3004: every change of where this server sends, its table and indexes only, no seed. */
const FILE_0081 = '0081_add_outbound_changes.sql';
/** The file of card 2683: a decision's survey questions, and the answers given with a response. */
const FILE_0082 = '0082_add_decision_survey_questions.sql';
/** The file of card 2684: a participant's objections and requests to talk, and the decider's replies. */
const FILE_0083 = '0083_add_decision_flags.sql';
/** The file of card 3064: the compatibility release, which keeps what a server from before two-step sign-in holds. */
const FILE_0084 = '0084_compatibility_release.sql';

/** How the model check reports 0069's api_keys column in a database that has not got it. */
const COLUMN_OF_0069 = 'api_keys.deadline_at: the column is in the model but not in the database';

/** How the model check reports 0069's users column (card 2772's code review, CS1) in a database that has not got it. */
const USERS_COLUMN_OF_0069 = 'users.security_signal_last_at: the column is in the model but not in the database';

/** The setting 0069 writes, as `contentsOf` gives it: 60 days from the moment the file ran, in the stored form of a moment. */
const DEADLINE_ROW = expect.stringMatching(/^\{"key":"api_key_deadline","value":"\d{4}-\d{2}-\d{2} \d{2}:\d{2}:\d{2}"\}$/);

/** The four columns 0066 adds, as the model check reports them in a database that has not got them, in name order. */
const COLUMNS_OF_0066 = [
	'sessions.two_step: the column is in the model but not in the database',
	'sign_in_challenges.enrol_grant: the column is in the model but not in the database',
	'sign_in_challenges.enrolment_link_hash: the column is in the model but not in the database',
	'users.mfa_password_enrol: the column is in the model but not in the database'
];

/**
 * What the rehearsal notes of a run that applies 0066, 0067, 0069, 0071 and
 * 0084 to a database with no remembered-browser secret: `settings`, which held
 * `had` rows, has ten more, the moment keys began to be recorded on webhooks
 * (card 2752), and 0084's release moment, six first-run flags, one-shot leave
 * to keep a plain seal key and scrub marker (card 3064 and its code review,
 * CS-M2 and CS-L4), 0084 having taken back 0066's moment of the release and
 * 0069's API key deadline (card 2772); and every one of `accounts` accounts was
 * given leave to set up on its password, the one-off declared for users.
 */
const SETTINGS_NOTE_OF_0066 = (had: number) => `settings had ${had} row(s) and has ${had + 10}: a migration put the others there`;
const USERS_NOTE_OF_0066 = (accounts: number) =>
	`users: mfa_password_enrol set to 1 for every account with no second factor and no enrolment link in its ${accounts} row(s) by ${FILE_0066}, ` +
	'a one-off declared in tests/rehearsal/one-offs.ts';

/**
 * What the rehearsal notes of a run that applies 0084 (card 3064): the one-off declared for each table whose rows it
 * keeps, for each such table holding rows after the run (`rows`, by table), in the order they are declared.
 */
const NOTES_OF_0084 = (rows: Record<string, number>) =>
	ONE_OFFS.filter((oneOff) => oneOff.file === FILE_0084 && oneOff.keepsRows && (rows[oneOff.table] ?? 0) > 0).map(
		(oneOff) => `${oneOff.table}: ${oneOff.change} in its ${rows[oneOff.table]} row(s) by ${FILE_0084}, a one-off declared in tests/rehearsal/one-offs.ts`
	);

/** How the model check reports 0066's sessions column in a database that has not got it. */
const SESSIONS_COLUMN_OF_0066 = COLUMNS_OF_0066[0];

/** The users columns of 0065 and of 0066 together, in name order: a database from before both has none of them. */
const USERS_COLUMNS_OF_0065_AND_0066 = [...USERS_COLUMNS_OF_0065, COLUMNS_OF_0066[3]].sort();

/** The setting 0066 writes, as `contentsOf` gives it: the moment the file ran, in the stored form of a moment. */
const RELEASED_AT_ROW = expect.stringMatching(/^\{"key":"two_step_released_at","value":"\d{4}-\d{2}-\d{2} \d{2}:\d{2}:\d{2}"\}$/);

/** The four columns 0071 adds to every webhook, each NULL (card 2752). */
const WEBHOOK_COLUMNS_OF_0071 = { held_because: null, held_at: null, set_by_key: null, set_with_key: null };

/** How the runner's check reports 0071's columns, key and index in a database that has not got them, in the model's order (card 2752). */
const MODEL_LINES_OF_0071 = [
	'webhooks.held_because: the column is in the model but not in the database',
	'webhooks.held_at: the column is in the model but not in the database',
	'webhooks.set_by_key: the column is in the model but not in the database',
	'webhooks.set_with_key: the column is in the model but not in the database',
	'webhooks: foreign key in the model but not in the database: (set_by_key) references api_keys(id), on update NO ACTION, on delete SET NULL',
	'webhooks: index in the model but not in the database: index idx_webhooks_set_by_key on (set_by_key)'
];

/** The two columns 0072 adds to every account, each NULL: every account stored is enabled (card 2671). */
const USERS_COLUMNS_OF_0072 = { disabled_at: null, disabled_by: null };

/** How the runner's check reports 0072's columns, key and index in a database that has not got them, in the model's order (card 2671). */
const MODEL_LINES_OF_0072 = [
	'users.disabled_at: the column is in the model but not in the database',
	'users.disabled_by: the column is in the model but not in the database',
	'users: foreign key in the model but not in the database: (disabled_by) references users(id), on update NO ACTION, on delete SET NULL',
	'users: index in the model but not in the database: index idx_users_disabled_by on (disabled_by)'
];

/** The column 0073 adds to every webhook, '' until the first start seals its address (card 2928). */
const WEBHOOK_COLUMNS_OF_0073 = { receiver: '' };

/** How the runner's check reports 0073's column in a database that has not got it (card 2928). */
const MODEL_LINE_OF_0073 = 'webhooks.receiver: the column is in the model but not in the database';

/** 0071's lines with 0073's, in the model's order: `receiver` is the table's last column, before 0071's key and index (card 2928). */
const MODEL_LINES_OF_0071_AND_0073 = [...MODEL_LINES_OF_0071.slice(0, 4), MODEL_LINE_OF_0073, ...MODEL_LINES_OF_0071.slice(4)];

/** The columns 0078 adds to every request, all NULL: no request's mail is held, and none was released (card 3020). */
const TASK_REQUEST_COLUMNS_OF_0078 = { mail_held_because: null, mail_released_at: null, mail_released_by: null, mail_released_by_name: null };

/** `rows` as `contentsOf` gives them, each with `columns` added and its keys sorted again. */
const withColumns = (rows: string[], columns: Record<string, unknown>) =>
	rows
		.map((json) =>
			JSON.stringify(
				Object.fromEntries(Object.entries({ ...JSON.parse(json), ...columns }).sort(([a], [b]) => a.localeCompare(b)))
			)
		)
		.sort();

/**
 * Rows of `table` read, as `contentsOf` gives them, before 0065, as 0065,
 * 0066 and 0067 leave them. 0065: every account gains the eleven columns at
 * their defaults. 0066: every account gains `mfa_password_enrol` 1, since a
 * database from before 0065 can hold no second factor and no enrolment link;
 * a pending sign-in gains its two columns NULL; and `settings` gains
 * `two_step_released_at`, the moment it ran, unless it was there. 0067: every
 * session is deleted, and the remembered-browser secret. 0068: every unused
 * invite is deleted, and every used one's token is 32 random bytes, a BLOB
 * (card 2849). 0069: every API key with no expiry, or one later than the
 * deadline, gains `deadline_at`, the deadline; any other `deadline_at` NULL;
 * and `settings` gains `api_key_deadline`, 60 days from the moment it ran,
 * unless it was there (card 2772). 0070: every request's `access_token` is
 * NULL (card 2870). 0071: every webhook gains its four columns NULL, and
 * `settings` gains `webhook_keys_recorded_at`, the moment it ran, unless it
 * was there (card 2752). 0072: every account gains its two columns NULL (card
 * 2671). 0073: every webhook gains `receiver` '' (card 2928).
 *
 * And as 0084, the compatibility release, leaves them (card 3064), 0067, 0068
 * and 0070 having lost their deletes to it: every session is kept, its id
 * hashed (a 32-byte BLOB), marked `kept_at_release` 1, dated at the release
 * and its expiry capped at 30 days from now, two_step 0 and
 * wrong_password_count 0 as 0066 and 0062 add them; every request's token is
 * moved into request_links,
 * and `access_token` is NULL; every `deadline_at` is NULL; every
 * `mfa_password_enrol` 0; every webhook's `set_with_key` 0; and `settings`
 * loses `two_step_released_at` and `api_key_deadline` and gains
 * `compatibility_release_at` and the six first-run flags, each the moment it
 * ran, unless it was there. Any other table's rows are as they were.
 */
function afterRelease(table: string, rows: string[]): unknown[] {
	const escaped = (text: string) => text.replace(/[.*+?^${}()|[\]\\]/g, '\\$&');
	if (table === 'users') return withColumns(rows, { ...COLUMNS_OF_0065, mfa_password_enrol: 0, security_signal_last_at: null, ...USERS_COLUMNS_OF_0072 });
	if (table === 'task_requests') return withColumns(rows, { access_token: null, ...TASK_REQUEST_COLUMNS_OF_0078 });
	if (table === 'webhooks') return withColumns(rows, { ...WEBHOOK_COLUMNS_OF_0071, set_with_key: 0, ...WEBHOOK_COLUMNS_OF_0073 });
	if (table === 'api_keys') return withColumns(rows, { deadline_at: null });
	const digest = (text: string) => ({ type: 'Buffer', data: [...createHash('sha256').update(text).digest()] });
	if (table === 'invite_tokens') {
		// Each used row as it was, whatever 32 bytes its token is now (a BLOB, which JSON writes as a Buffer's type and
		// data). No unused one: every database these rows are read from that holds one is from before 0054, which deletes
		// them (one after it keeps them, hashed by 0084: card 3064's own cases).
		return rows
			.filter((json) => (JSON.parse(json) as { used: number }).used !== 0)
			.map((json) => {
				const [before, after] = JSON.stringify({ ...JSON.parse(json), token: '@' }).split('"@"');
				return expect.stringMatching(new RegExp(`^${escaped(before)}\\{"type":"Buffer","data":\\[(\\d+,){31}\\d+\\]\\}${escaped(after)}$`));
			});
	}
	if (table === 'sessions') {
		// The release moment is the run's, and so is a capped expiry: each matched as a moment in the stored form.
		const cap = stamp(new Date(Date.now() + 30 * 86_400_000));
		return rows
			.map((json) => {
				const row = JSON.parse(json) as { id: string; expires_at: string; wrong_password_count?: number };
				const expiry = toStamp(row.expires_at);
				const capped = expiry !== null && expiry > cap;
				const kept = JSON.stringify(
					Object.fromEntries(
						Object.entries({
							...row,
							id: digest(row.id),
							created_at: '@',
							expires_at: capped ? '@' : (expiry ?? row.expires_at),
							wrong_password_count: row.wrong_password_count ?? 0,
							two_step: 0,
							kept_at_release: 1
						}).sort(([a], [b]) => a.localeCompare(b))
					)
				);
				const stored = '"\\d{4}-\\d{2}-\\d{2} \\d{2}:\\d{2}:\\d{2}"';
				return { order: kept, value: expect.stringMatching(new RegExp(`^${kept.split('"@"').map(escaped).join(stored)}$`)) };
			})
			.sort((a, b) => a.order.localeCompare(b.order))
			.map((p) => p.value);
	}
	if (table === 'sign_in_challenges') return withColumns(rows, { enrol_grant: null, enrolment_link_hash: null });
	if (table !== 'settings') return rows;
	return settingsLeft(rows, ['known_browser_secret'], ['webhook_keys_recorded_at']);
}

/**
 * The settings 0084 writes, each unless it is there (card 3064): the release moment, the six first-run flags and the
 * one-shot leave to keep a plain seal key (its code review, CS-M2), each a moment in the stored form; and the scrub's
 * marker (CS-L4), an ISO time.
 */
const SETTINGS_OF_0084 = [
	'compatibility_release_at',
	'webhooks_already_off_held',
	'webhooks_readable_by_disabled_held',
	'webhook_reveals_seeded',
	'webhooks_before_keys_announced',
	'report_schedules_announced',
	'stored_images_rechecked',
	'backup_seal_key_keep_once',
	'secrets_scrub_pending'
];

/** Of `SETTINGS_OF_0084`, the one written as an ISO time (CS-L4). */
const ISO_SETTING_OF_0084 = 'secrets_scrub_pending';

/**
 * Rows of `settings`, as `contentsOf` gives them, without the keys `taken` and 0084's two (0066's moment of the release
 * and 0069's API key deadline), and with each of `written` and 0084's own that is not there, as a moment in the stored
 * form (the scrub's marker as an ISO time), each in the place its key sorts to (card 3064).
 */
function settingsLeft(rows: string[], taken: readonly string[], written: readonly string[]): unknown[] {
	const keyOf = (json: string) => (JSON.parse(json) as { key: string }).key;
	const kept = rows.filter((json) => ![...taken, 'two_step_released_at', 'api_key_deadline'].includes(keyOf(json)));
	const added = [...written, ...SETTINGS_OF_0084].filter((key) => !kept.some((json) => keyOf(json) === key)).map((key) => JSON.stringify({ key, value: '' }));
	const moment = (key: string) => (key === ISO_SETTING_OF_0084 ? '\\d{4}-\\d{2}-\\d{2}T\\d{2}:\\d{2}:\\d{2}\\.\\d{3}Z' : '\\d{4}-\\d{2}-\\d{2} \\d{2}:\\d{2}:\\d{2}');
	return [...kept, ...added]
		.sort()
		.map((json) => (added.includes(json) ? expect.stringMatching(new RegExp(`^\\{"key":"${keyOf(json)}","value":"${moment(keyOf(json))}"\\}$`)) : json));
}

/**
 * Rows of `table` read, as `contentsOf` gives them, from a database at 0071 or later, as 0084 leaves them (card 3064):
 * `settings` as `settingsLeft` gives it; every `mfa_password_enrol` 0, every `deadline_at` NULL, every `set_with_key`
 * NULL made 0 and every `access_token` NULL. No test that uses this holds a session or an invite in plain: card 3064's
 * own cases do. Any other table's rows are as they were.
 */
function as0084Leaves(table: string, rows: string[]): unknown[] {
	const set = (column: string, value: (was: unknown) => unknown) =>
		rows
			.map((json) => {
				const row = JSON.parse(json) as Record<string, unknown>;
				return JSON.stringify({ ...row, [column]: value(row[column]) });
			})
			.sort();
	if (table === 'settings') return settingsLeft(rows, [], []);
	if (table === 'users') return set('mfa_password_enrol', () => 0);
	if (table === 'api_keys') return set('deadline_at', () => null);
	if (table === 'webhooks') return set('set_with_key', (was) => was ?? 0);
	if (table === 'task_requests') return set('access_token', () => null);
	return rows;
}

/** The partial unique index 0063 makes on decision_events. */
const INDEX_OF_0063 = 'idx_decision_events_participant_id_version_number_reminded';

/** How the model check reports 0062's column in a database that has not got it. */
const COLUMN_OF_0062 = 'sessions.wrong_password_count: the column is in the model but not in the database';

/** The twelve tables 0061 creates, in name order. */
const TABLES_OF_0061 = [
	'decision_card_links',
	'decision_events',
	'decision_options',
	'decision_participants',
	'decision_questions',
	'decision_responses',
	'decision_rulings',
	'decision_versions',
	'decisions',
	'people',
	'people_group_members',
	'people_groups'
];

/** The tables of 0061 and of 0065 together, in name order: a database from before both has none of them. */
const TABLES_OF_0061_AND_0065 = [...TABLES_OF_0061, ...TABLES_OF_0065].sort();

/**
 * Those, 0082's table (card 2683) and 0083's (card 2684), in name order: a database from before 0061 has none of them, and
 * 0082's column is in its table's line.
 */
const TABLES_OF_0061_0065_0082_AND_0083 = [...TABLES_OF_0061_AND_0065, 'decision_survey_questions', 'decision_flags'].sort();

/** How the model check reports a table of the model that a database has not got. */
const notInTheDatabase = (table: string) => `${table}: the table is in the model but not in the database`;

/** How the runner's check reports 0074's table in a database that has not got it (card 2922). */
const TABLE_OF_0074 = notInTheDatabase('setting_holds');

/** How the runner's check reports 0075's table in a database that has not got it (card 2947). */
const TABLE_OF_0075 = notInTheDatabase('webhook_reveals');

/** How the runner's check reports 0076's table in a database that has not got it (card 2995). */
const TABLE_OF_0076 = notInTheDatabase('api_key_revocations');

/** How the runner's check reports 0077's table in a database that has not got it (card 2996). */
const TABLE_OF_0077 = notInTheDatabase('account_endings');

/** How the runner's check reports 0079's table in a database that has not got it (card 3002). */
const TABLE_OF_0079 = notInTheDatabase('access_changes');

/** How the runner's check reports 0081's table in a database that has not got it (card 3004). */
const TABLE_OF_0081 = notInTheDatabase('outbound_changes');

/** How the runner's check reports 0082's table in a database that has not got it (card 2683). */
const TABLE_OF_0082 = notInTheDatabase('decision_survey_questions');

/** How the runner's check reports 0082's decision_responses column in a database that has not got it (card 2683). */
const COLUMN_OF_0082 = 'decision_responses.answers: the column is in the model but not in the database';

/** The index 0082 makes on its table (card 2683). */
const INDEX_OF_0082 = 'idx_decision_survey_questions_decision_id';

/** How the runner's check reports 0083's table in a database that has not got it (card 2684). */
const TABLE_OF_0083 = notInTheDatabase('decision_flags');

/** How the runner's check reports 0084's sessions column in a database that has not got it (card 3064). */
const COLUMN_OF_0084 = 'sessions.kept_at_release: the column is in the model but not in the database';

/** The three indexes 0083 makes on its table (card 2684), in name order. */
const INDEXES_OF_0083 = ['idx_decision_flags_decision_id', 'idx_decision_flags_participant_id', 'idx_decision_flags_replied_by'];

/** The three indexes 0081 makes on its table (card 3004), in name order. */
const INDEXES_OF_0081 = ['outbound_changes_changed', 'outbound_changes_item', 'outbound_changes_union'];

/** How the runner's check reports 0078's four task_requests columns, key and index in a database that has not got them (card 3020). */
const MODEL_LINES_OF_0078 = [
	'task_requests.mail_held_because: the column is in the model but not in the database',
	'task_requests.mail_released_at: the column is in the model but not in the database',
	'task_requests.mail_released_by: the column is in the model but not in the database',
	'task_requests.mail_released_by_name: the column is in the model but not in the database',
	'task_requests: foreign key in the model but not in the database: (mail_released_by) references users(id), on update NO ACTION, on delete SET NULL',
	'task_requests: index in the model but not in the database: index idx_task_requests_mail_released_by on (mail_released_by)'
];

/** The tables 0060 changes the rows of: each gains its new columns, and cards are committed. */
const TABLES_OF_0060 = ['boards', 'columns', 'cards'];

/**
 * Rows of `table` read, as `contentsOf` gives them, before 0060, as 0060
 * leaves them: every board gains `kind` 'delivery', every column `role` NULL,
 * and every card the commitment and discard columns, committed when and by
 * whom it was created, unless its id is in `uncommitted` (a card on a column
 * or a board that is not there). Any other table's rows are as they were.
 * And as 0061, which every run that applies 0060 applies after it, leaves
 * them: every board gains `product_owner_user_id` NULL. And as 0065 to 0084
 * leave them (`afterRelease`): every account gains its two-step sign-in
 * columns, every session is kept and hashed, and the compatibility release is
 * recorded in settings (card 3064).
 */
function after0060(table: string, rows: string[], uncommitted: readonly number[] = []): unknown[] {
	if (!TABLES_OF_0060.includes(table)) return afterRelease(table, rows);
	return rows
		.map((json) => {
			const row = JSON.parse(json) as Record<string, unknown>;
			if (table === 'boards') Object.assign(row, { kind: 'delivery', product_owner_user_id: null });
			if (table === 'columns') row.role = null;
			if (table === 'cards') {
				const committed = !uncommitted.includes(row.id as number);
				Object.assign(row, {
					committed_at: committed ? row.created_at : null,
					committed_by: committed ? row.created_by : null,
					discarded_at: null,
					discarded_by: null
				});
			}
			return JSON.stringify(Object.fromEntries(Object.entries(row).sort(([a], [b]) => a.localeCompare(b))));
		})
		.sort();
}

/**
 * `rows` of `table`, as `contentsOf` gives them, less the Options columns a
 * start gives every delivery board that has none (card 2527). A database from
 * before 0060 has no Options column, so each of its boards is given one by the
 * backfill after the run; `optionsGiven` names them.
 */
function lessOptionsGiven(table: string, rows: string[]): string[] {
	if (table !== 'columns') return rows;
	return rows.filter((json) => (JSON.parse(json) as { role: unknown }).role !== 'options');
}

/** The Options columns among `rows` of `columns`, as [board, title, position, colour], by board. */
function optionsGiven(rows: string[]): [number, string, number, string][] {
	return rows
		.map((json) => JSON.parse(json) as { board_id: number; title: string; position: number; color: string; role: unknown })
		.filter((row) => row.role === 'options')
		.map((row): [number, string, number, string] => [row.board_id, row.title, row.position, row.color])
		.sort((a, b) => a[0] - b[0]);
}

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
 *   columns        1 and 2 on board 1, 4 on board 2; on a database with
 *                  0060's columns, each board's Options column too (3, 5, 6)
 *   categories     1 and 2 on board 1, 5 on board 2
 *   cards          1, 2 and 5 on board 1, 3 and 4 on board 2; four categorised
 *   settings, user_xp, invite_tokens   two rows each
 *
 * In `boards`, `columns` and `categories` a row has been created and deleted,
 * so each id counter is ahead of the highest id in use. An id is never reused,
 * and a rebuild that forgot the counter would reuse one.
 *
 * On a database that has 0060's columns, every card is committed when it was
 * created, as every write commits a card created in a committed column
 * (milestone 22), so the backfills find nothing to fill in. On an older one
 * there is nothing to set, and the backfills commit them once 0060 is there.
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
		-- In plain, on purpose: a database from before 0068 (card 2849) holds its invites as mailed.
		INSERT INTO invite_tokens (token, user_id, expires_at, used) VALUES
			('token-for-ann', 1, '2026-12-01 00:00:00', 0),
			('token-for-bob', 2, '2026-12-01 00:00:00', 1);
	`);
	if (database.prepare("SELECT 1 FROM pragma_table_info('cards') WHERE name = 'committed_at'").get()) {
		database.exec('UPDATE cards SET committed_at = created_at, committed_by = created_by');
	}
	// Every delivery board has its Options column (card 2527), as every board
	// made since has, so the backfills find nothing to add. At ids no row has
	// used, so the column counter stays at 7.
	if (database.prepare("SELECT 1 FROM pragma_table_info('columns') WHERE name = 'role'").get()) {
		database.exec(`
			INSERT INTO columns (id, board_id, title, position, color, role) VALUES
				(3, 1, 'Options', -1, '#8b5cf6', 'options'),
				(5, 2, 'Options', -1, '#8b5cf6', 'options'),
				(6, 3, 'Options', 0, '#8b5cf6', 'options');
		`);
	}
}

/**
 * Give board `boardId`, put in by a test, the Options column every delivery
 * board has (card 2527), so that the backfills add none and the database is
 * left as the test means it to be.
 */
function giveOptions(database: Database.Database, boardId: number): void {
	database.prepare("INSERT INTO columns (board_id, title, position, color, role) VALUES (?, 'Options', 0, '#8b5cf6', 'options')").run(boardId);
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
 * the error. With `restoreOnly`, only a transaction begun with foreign keys
 * off fails, which is the restore's: the import route asks who is calling in
 * a transaction of its own first (card 2253), and that one is let through.
 */
function failAtCommit(database: Database.Database, message: string, { restoreOnly = false }: { restoreOnly?: boolean } = {}): void {
	const real = database.transaction.bind(database) as (fn: (...args: unknown[]) => unknown) => unknown;
	vi.spyOn(database, 'transaction').mockImplementation(((fn: (...args: unknown[]) => unknown) =>
		restoreOnly && database.pragma('foreign_keys', { simple: true }) !== 0
			? real(fn)
			: real((...args: unknown[]) => {
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
			"Migrations halted (backfilling each delivery board's Options column (columns.role), cards.first_completed_at, " +
				'cards.milestone_id, boards.category_id, cards.committed_at and cards.discarded_at): ' +
				`first completion is frozen. No migration was committed earlier in this start. ${WHAT_NEXT}`
		);
		// As it says: the card is as it was before the step that failed.
		expect(database.prepare('SELECT first_completed_at FROM cards WHERE id = 1').get()).toEqual({
			first_completed_at: null
		});
		expect(database.inTransaction).toBe(false);
	});

	it("repeats 0057's statement, the same text, for a restored older backup (card 2179)", () => {
		const words = (sql: string) => sql.replace(/\s+/g, ' ').trim();
		const file = readFileSync(join(REAL_MIGRATIONS, FILE_0057), 'utf-8');
		expect(sqlStatements(file).map((s) => words(s.text))).toEqual([words(CARDS_LEAVE_OTHER_BOARDS_MILESTONES)]);
	});

	it('takes out every card in a milestone of another board, archived ones included, and nothing else, once (card 2179)', () => {
		const STAMP = '2026-10-01 09:00:00';
		const database = memoryDb();
		runMigrations({ database, migrationsDir: REAL_MIGRATIONS });
		// Boards A (1) and B (2), and a board 3 deleted with foreign keys off, as a
		// restore runs, so that its milestone is left. Milestones: 1 of A, 2 across
		// boards, 3 of the deleted board. Cards 6 and 8 name a milestone and a
		// column that are not there.
		database.exec(`
			INSERT INTO users (id, username, email, password_hash) VALUES (1, 'ann', 'ann@example.test', 'x');
			INSERT INTO boards (id, name, created_by) VALUES (1, 'A', 1), (2, 'B', 1), (3, 'Gone', 1);
			INSERT INTO columns (id, board_id, title) VALUES (1, 1, 'To Do'), (2, 2, 'To Do');
			INSERT INTO milestones (id, name, board_id, status) VALUES (1, 'Goal of A', 1, 'open'), (2, 'Across', NULL, 'open'), (3, 'Goal of Gone', 3, 'closed');
			PRAGMA foreign_keys = OFF;
			INSERT INTO cards (id, column_id, title, milestone_id, archived_at, created_at, updated_at) VALUES
				(1, 2, 'On B, in A''s', 1, NULL, '${STAMP}', '${STAMP}'),
				(2, 1, 'On A, in A''s', 1, NULL, '${STAMP}', '${STAMP}'),
				(3, 2, 'Archived on B, in A''s', 1, '${STAMP}', '${STAMP}', '${STAMP}'),
				(4, 2, 'On B, in the goal across', 2, NULL, '${STAMP}', '${STAMP}'),
				(5, 1, 'In the deleted board''s', 3, NULL, '${STAMP}', '${STAMP}'),
				(6, 1, 'In a milestone gone', 99, NULL, '${STAMP}', '${STAMP}'),
				(7, 1, 'In none', NULL, NULL, '${STAMP}', '${STAMP}'),
				(8, 99, 'On a column gone, in A''s', 1, NULL, '${STAMP}', '${STAMP}');
			DELETE FROM boards WHERE id = 3;
			PRAGMA foreign_keys = ON;
		`);
		const milestonesOf = () =>
			database.prepare('SELECT id, milestone_id, updated_at FROM cards ORDER BY id').all() as {
				id: number;
				milestone_id: number | null;
				updated_at: string;
			}[];

		expect(runBackfills(database)).toEqual({
			firstCompletedAt: 0,
			releasedFromMilestones: 3,
			released: [
				{ cardId: 1, milestoneId: 1 },
				{ cardId: 3, milestoneId: 1 },
				{ cardId: 5, milestoneId: 3 }
			],
			unfiledBoards: 0,
			unfiled: [],
			// Cards 1 to 7, on a column of a board that is there, were inserted
			// with no commitment; card 8 is on a column that is not.
			committedFilled: 7,
			upstreamCleared: 0,
			discardedCleared: 0,
			// Boards A and B, made here with no Options column (card 2527).
			optionsAdded: 2,
			optionsMoved: 0,
			optionsRenamed: 0,
			optionsDemoted: 0
		});

		expect(milestonesOf().map((card) => [card.id, card.milestone_id])).toEqual([
			[1, null],
			[2, 1],
			[3, null],
			[4, 2],
			[5, null],
			[6, 99],
			[7, null],
			[8, 1]
		]);
		// Nobody edited the cards.
		expect(milestonesOf().map((card) => card.updated_at)).toEqual(Array(8).fill(STAMP));
		expect(runBackfills(database)).toEqual({
			firstCompletedAt: 0,
			releasedFromMilestones: 0,
			released: [],
			unfiledBoards: 0,
			unfiled: [],
			committedFilled: 0,
			upstreamCleared: 0,
			discardedCleared: 0,
			optionsAdded: 0,
			optionsMoved: 0,
			optionsRenamed: 0,
			optionsDemoted: 0
		});
	});

	it('names the cards it takes out at a start, the first 50 by card and milestone, in its WARN line (review of card 2179)', () => {
		const database = memoryDb();
		runMigrations({ database, migrationsDir: REAL_MIGRATIONS });
		// Card 1 is on board A in B's milestone; cards 2 to 54 are on board B in A's.
		const onB = Array.from({ length: 53 }, (_, i) => `(${i + 2}, 2, 'On B', 1)`).join(', ');
		database.exec(`
			INSERT INTO users (id, username, email, password_hash) VALUES (1, 'ann', 'ann@example.test', 'x');
			INSERT INTO boards (id, name, created_by) VALUES (1, 'A', 1), (2, 'B', 1);
			INSERT INTO columns (id, board_id, title) VALUES (1, 1, 'To Do'), (2, 2, 'To Do');
			INSERT INTO milestones (id, name, board_id, status) VALUES (1, 'Goal of A', 1, 'open'), (2, 'Goal of B', 2, 'open');
			INSERT INTO cards (id, column_id, title, milestone_id) VALUES (1, 1, 'On A', 2), ${onB};
		`);
		process.env.LOG_LEVEL = 'WARN';
		const lines: string[] = [];
		vi.spyOn(console, 'warn').mockImplementation((line) => {
			lines.push(String(line).replace(/^\[[^\]]+\] /, ''));
		});

		const report = runMigrations({ database, migrationsDir: REAL_MIGRATIONS });

		const named = ['card 1 left milestone 2', ...Array.from({ length: 49 }, (_, i) => `card ${i + 2} left milestone 1`)];
		expect(report.backfilled.releasedFromMilestones).toBe(54);
		expect(report.backfilled.released).toHaveLength(50);
		expect(lines.filter((line) => line.includes('Took '))).toEqual([
			`[WARN] [DB] Took 54 card(s) out of a milestone that belongs to another board: ${named.join(', ')}; and 4 more`
		]);
		expect(database.prepare('SELECT COUNT(*) AS n FROM cards WHERE milestone_id IS NOT NULL').get()).toEqual({ n: 0 });
	});

	it('takes out of its grouping every board filed under one that no longer exists, and nothing else, once (card 2293)', () => {
		const STAMP = '2026-10-01 09:00:00';
		const database = memoryDb();
		runMigrations({ database, migrationsDir: REAL_MIGRATIONS });
		// Board 1 is filed under a grouping that exists, board 2 under grouping 7,
		// deleted as `deleteBoardGrouping` deleted one before this card, and board
		// 3 under none. `boards.category_id` has no foreign key.
		database.exec(`
			INSERT INTO users (id, username, email, password_hash) VALUES (1, 'ann', 'ann@example.test', 'x');
			INSERT INTO board_categories (id, name) VALUES (1, 'Clients'), (7, 'Deleted');
			INSERT INTO boards (id, name, created_by, category_id, created_at, updated_at) VALUES
				(1, 'Filed', 1, 1, '${STAMP}', '${STAMP}'),
				(2, 'Under a grouping gone', 1, 7, '${STAMP}', '${STAMP}'),
				(3, 'In none', 1, NULL, '${STAMP}', '${STAMP}');
			DELETE FROM board_categories WHERE id = 7;
		`);
		const groupingsOf = () =>
			database.prepare('SELECT id, category_id, updated_at FROM boards ORDER BY id').all() as {
				id: number;
				category_id: number | null;
				updated_at: string;
			}[];

		expect(runBackfills(database)).toEqual({
			firstCompletedAt: 0,
			releasedFromMilestones: 0,
			released: [],
			unfiledBoards: 1,
			unfiled: [{ boardId: 2, groupingId: 7 }],
			committedFilled: 0,
			upstreamCleared: 0,
			discardedCleared: 0,
			// The three boards, made here with no Options column (card 2527).
			optionsAdded: 3,
			optionsMoved: 0,
			optionsRenamed: 0,
			optionsDemoted: 0
		});

		expect(groupingsOf().map((board) => [board.id, board.category_id])).toEqual([
			[1, 1],
			[2, null],
			[3, null]
		]);
		// Nobody edited the boards.
		expect(groupingsOf().map((board) => board.updated_at)).toEqual(Array(3).fill(STAMP));
		expect(runBackfills(database)).toEqual({
			firstCompletedAt: 0,
			releasedFromMilestones: 0,
			released: [],
			unfiledBoards: 0,
			unfiled: [],
			committedFilled: 0,
			upstreamCleared: 0,
			discardedCleared: 0,
			optionsAdded: 0,
			optionsMoved: 0,
			optionsRenamed: 0,
			optionsDemoted: 0
		});
	});

	it("names the boards it takes out by the statement's own WHERE, so the two cannot drift (card 2293)", () => {
		const words = (sql: string) => sql.replace(/\s+/g, ' ').trim();
		expect(words(BOARDS_LEAVE_DELETED_GROUPINGS)).toBe(
			'UPDATE `boards` SET `category_id` = NULL WHERE `category_id` IS NOT NULL ' +
				'AND NOT EXISTS (SELECT 1 FROM `board_categories` WHERE `id` = `boards`.`category_id`);'
		);
		// From the first WHERE, the outer one, to the statement's end without its `;`.
		const where = BOARDS_LEAVE_DELETED_GROUPINGS.slice(BOARDS_LEAVE_DELETED_GROUPINGS.indexOf('WHERE'), -1);
		expect(where.startsWith('WHERE `category_id` IS NOT NULL')).toBe(true);
		expect(BOARDS_LEAVING_DELETED_GROUPINGS).toBe(
			'SELECT `id` AS boardId, `category_id` AS groupingId FROM `boards`\n' + where + '\nORDER BY `id` LIMIT 50'
		);
	});

	it('names the boards it takes out at a start, the first 50 by board and grouping, in its WARN line (card 2293)', () => {
		const database = memoryDb();
		runMigrations({ database, migrationsDir: REAL_MIGRATIONS });
		// Boards 1 to 52 are filed under grouping 7, which is gone; board 53 under grouping 1, which is not.
		const gone = Array.from({ length: 52 }, (_, i) => `(${i + 1}, 'Gone', 7)`).join(', ');
		database.exec(`
			INSERT INTO board_categories (id, name) VALUES (1, 'Clients');
			INSERT INTO boards (id, name, category_id) VALUES ${gone}, (53, 'Filed', 1);
		`);
		process.env.LOG_LEVEL = 'WARN';
		const lines: string[] = [];
		vi.spyOn(console, 'warn').mockImplementation((line) => {
			lines.push(String(line).replace(/^\[[^\]]+\] /, ''));
		});

		const report = runMigrations({ database, migrationsDir: REAL_MIGRATIONS });

		const named = Array.from({ length: 50 }, (_, i) => `board ${i + 1} (grouping 7)`);
		expect(report.backfilled.unfiledBoards).toBe(52);
		expect(report.backfilled.unfiled).toHaveLength(50);
		expect(lines.filter((line) => line.includes('grouping that no longer exists'))).toEqual([
			`[WARN] [DB] Took 52 board(s) out of a grouping that no longer exists: ${named.join(', ')}; and 2 more`
		]);
		expect(database.prepare('SELECT COUNT(*) AS n FROM boards WHERE category_id IS NOT NULL').get()).toEqual({ n: 1 });
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
		// Board 1's, its Options column 3 among them.
		expect(idsIn(database, 'columns')).toEqual([1, 2, 3]);
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
				// The seed's three and its boards' three Options columns.
				rows: 6,
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
				// The seed's two, webhook_keys_recorded_at, which 0071 wrote (card
				// 2752), and 0084's release moment, six first-run flags, one-shot
				// leave to keep a plain seal key and scrub marker (card 3064 and
				// its code review, CS-M2 and CS-L4), which took back 0066's
				// two_step_released_at and 0069's api_key_deadline (card 2772).
				rows: 12,
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
			"[WARN] [DB] columns rebuilt in the model's shape — 6 row(s) carried across; 2 NULL wip_limit value(s) became the default, 0. " +
				'What differed, and no longer does: columns.wip_limit: is nullable; the model has it NOT NULL',
			"[WARN] [DB] categories rebuilt in the model's shape — 3 row(s) carried across. " +
				'What differed, and no longer does: categories.board_id: is NOT NULL; the model has it nullable; ' +
				'categories: foreign key in the database but not in the model: (board_id) references boards(id), on update NO ACTION, on delete CASCADE; ' +
				'categories: foreign key in the model but not in the database: (board_id) references boards(id), on update NO ACTION, on delete SET NULL',
			"[WARN] [DB] settings rebuilt in the model's shape — 12 row(s) carried across. " +
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
			{ id: 3, wip_limit: 0 },
			{ id: 4, wip_limit: null },
			{ id: 5, wip_limit: 0 },
			{ id: 6, wip_limit: 0 }
		]);

		runMigrations({ database, migrationsDir: REAL_MIGRATIONS });

		expect(limits()).toEqual([
			{ id: 1, wip_limit: 0 },
			{ id: 2, wip_limit: 3 },
			{ id: 3, wip_limit: 0 },
			{ id: 4, wip_limit: 0 },
			{ id: 5, wip_limit: 0 },
			{ id: 6, wip_limit: 0 }
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
			{ id: 3, written: '-1.0', stored: 'real' },
			{ id: 4, written: '0.0', stored: 'real' },
			{ id: 5, written: '-1.0', stored: 'real' },
			{ id: 6, written: '0.0', stored: 'real' }
		]);

		const { report, errors } = reporting({ database, migrationsDir: REAL_MIGRATIONS });

		// First, so that if the rebuild was rolled back this says why.
		expect(report.leftAlone).toEqual([]);
		expect(errors).toEqual([]);
		expect(report.rebuilt.find((table) => table.table === 'columns')).toEqual({
			table: 'columns',
			rows: 6,
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
			{ id: 3, written: '-1.0', stored: 'real' },
			{ id: 4, written: '0.0', stored: 'real' },
			{ id: 5, written: '-1.0', stored: 'real' },
			{ id: 6, written: '0.0', stored: 'real' }
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
				'columns rebuilt with 6 row(s) carried across and 2 NULL wip_limit value(s) given the default 0, ' +
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
		giveOptions(database, 6);
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
		giveOptions(database, 6);
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
				updated_at TEXT DEFAULT (datetime('now')) NOT NULL,
				kind TEXT DEFAULT 'delivery' NOT NULL,
				product_owner_user_id INTEGER REFERENCES users(id) ON DELETE SET NULL
			);
			INSERT INTO boards_older (id, name, emoji, parent_card_id, category_id, is_public, created_by, created_at, updated_at, kind, product_owner_user_id)
				SELECT id, name, emoji, parent_card_id, category_id, is_public, created_by, created_at, updated_at, kind, product_owner_user_id FROM boards;
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
					// 0053 and 0061 made these, and they went with the table this test replaced.
					'boards: index in the model but not in the database: index idx_boards_product_owner_user_id on (product_owner_user_id)',
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
			-- As 0060 and 0061 add them to such a table.
			ALTER TABLE boards ADD COLUMN kind text DEFAULT 'delivery' NOT NULL;
			ALTER TABLE boards ADD COLUMN product_owner_user_id integer REFERENCES users(id) ON DELETE SET NULL;
			INSERT INTO boards (id, name, emoji, parent_card_id, category_id, is_public, created_by, created_at, updated_at, kind, product_owner_user_id)
				SELECT id, name, emoji, parent_card_id, category_id, is_public, created_by, created_at, updated_at, kind, product_owner_user_id FROM boards_kept;
			DROP TABLE boards_kept;
			INSERT INTO boards (id, name, created_by) VALUES (6, 'By nobody', 99);
		`);
		giveOptions(database, 6);
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
				"columns.title: 3 value(s) in the table are not in the copy, such as 'Doing', " +
				"and the copy has 1 that the table has not, such as ''"
		);
		expect(database.prepare('SELECT title FROM columns ORDER BY id').all()).toEqual([
			{ title: 'To Do' },
			{ title: 'Doing' },
			{ title: 'Options' },
			{ title: 'To Do' },
			{ title: 'Options' },
			{ title: 'Options' }
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
				// Columns 1, 2 and 3 on board 1, 4 and 5 on board 2, 6 on board 3.
				'values in columns.board_id (before: 6 set, adding up to 10; after: 6 set, adding up to 6)'
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
			-- In plain, on purpose: a database from before card 2775, which these migrations meet.
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
			backfilled: {
				firstCompletedAt: 0,
				releasedFromMilestones: 0,
				released: [],
				unfiledBoards: 0,
				unfiled: [],
				committedFilled: 0,
				upstreamCleared: 0,
				discardedCleared: 0,
				optionsAdded: 0,
				optionsMoved: 0,
				optionsRenamed: 0,
				optionsDemoted: 0
			},
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
		// And each board, from a backup made before card 2527, is given its
		// Options column by the backfill that follows the restore.
		expect(columnsIn(live)).toEqual([
			{ id: 1, board_id: 1, title: 'To Do', wip_limit: 0 },
			{ id: 2, board_id: 1, title: 'Doing', wip_limit: 3 },
			{ id: 4, board_id: 2, title: 'To Do', wip_limit: 0 },
			{ id: 5, board_id: 1, title: 'Options', wip_limit: 0 },
			{ id: 6, board_id: 2, title: 'Options', wip_limit: 0 },
			{ id: 7, board_id: 3, title: 'Options', wip_limit: 0 }
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
		// Card 3064: no API key deadline, as this server has none (R18); and this server's release moment and first-run
		// flags, kept (R1, R24); and this server's one-shot leave to keep a plain seal key, written by its 0084 and not yet
		// spent by a start (its code review, CS-M2).
		expect(live.prepare('SELECT key, value FROM settings ORDER BY key').all()).toEqual([
			{ key: 'backup_seal_key_keep_once', value: expect.stringMatching(/^\d{4}-\d{2}-\d{2} \d{2}:\d{2}:\d{2}$/) },
			{ key: 'compatibility_release_at', value: expect.stringMatching(/^\d{4}-\d{2}-\d{2} \d{2}:\d{2}:\d{2}$/) },
			// Mail set up in the backup, recorded (card 2922's code review, C4).
			{ key: 'mail_ever_configured_at', value: expect.stringMatching(/^\d{4}-\d{2}-\d{2} \d{2}:\d{2}:\d{2}$/) },
			// Recorded with the form key, sealed (card 2898, S2).
			{ key: 'mfa_key_check', value: expect.stringMatching(/^[0-9a-f]{64}$/) },
			{ key: 'report_schedules_announced', value: expect.stringMatching(/^\d{4}-\d{2}-\d{2} \d{2}:\d{2}:\d{2}$/) },
			// Made in the restore's transaction (card 2750), sealed (card 2898).
			{ key: 'request_form_secret', value: expect.stringMatching(/^dfsealed:1:/) },
			// The scrub every restore marks pending (card 2898's code review, S1).
			{ key: 'secrets_scrub_pending', value: expect.stringMatching(/^\d{4}-\d\d-\d\dT/) },
			{ key: 'smtp_host', value: 'mail.example.test' },
			{ key: 'stored_images_rechecked', value: expect.stringMatching(/^\d{4}-\d{2}-\d{2} \d{2}:\d{2}:\d{2}$/) },
			{ key: 'theme', value: 'dark' },
			// This server's moment keys began to be recorded on webhooks, kept by a restore (card 2752).
			{ key: 'webhook_keys_recorded_at', value: expect.stringMatching(/^\d{4}-\d{2}-\d{2} \d{2}:\d{2}:\d{2}$/) },
			// The once-only seed's flag, which the restore writes for a backup holding none, before it leaves out the
			// keys ended here (card 2995, R3).
			{ key: 'webhook_reveals_seeded', value: expect.stringMatching(/^\d{4}-\d{2}-\d{2} \d{2}:\d{2}:\d{2}$/) },
			{ key: 'webhooks_already_off_held', value: expect.stringMatching(/^\d{4}-\d{2}-\d{2} \d{2}:\d{2}:\d{2}$/) },
			{ key: 'webhooks_before_keys_announced', value: expect.stringMatching(/^\d{4}-\d{2}-\d{2} \d{2}:\d{2}:\d{2}$/) },
			// The moment the restore's own run of the readable pass covered, for a backup with none (card 2935, P12).
			{ key: 'webhooks_readable_by_disabled_held', value: expect.stringMatching(/^\d{4}-\d{2}-\d{2} \d{2}:\d{2}:\d{2}$/) }
		]);
		expect(result.restored['settings']).toBe(2);
		// The form key opens to `v2:` and 32 random bytes as hex (cards 2898 and 2943).
		expect(readOpened('settings', 'request_form_secret', live)).toMatch(/^v2:[0-9a-f]{64}$/);
		// The rest of the backup is in, and committed.
		expect(live.prepare('SELECT id FROM boards ORDER BY id').all()).toEqual([{ id: 1 }, { id: 2 }, { id: 3 }]);
		// The backup's three, and each board's Options column, which it was made before.
		expect(columnsIn(live)).toHaveLength(6);
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
		// Bob raised card 3; the others were raised before authorship was recorded.
		backup.exec('UPDATE cards SET created_by = 2 WHERE id = 3');

		const result = restoreFromBackup(live, backup);

		// The links are given inside the restore, as every request's is at every
		// restore (card 2158), so the backfill after it has none to give. The
		// backup is older than 0060, so every card, none of them upstream, is
		// committed when and by whom it was created (milestone 22), and each of
		// its three boards, all delivery boards, is given its Options column (card 2527).
		expect(result.backfilled).toEqual({
			firstCompletedAt: 2,
			releasedFromMilestones: 0,
			released: [],
			unfiledBoards: 0,
			unfiled: [],
			committedFilled: 5,
			upstreamCleared: 0,
			discardedCleared: 0,
			optionsAdded: 3,
			optionsMoved: 0,
			optionsRenamed: 0,
			optionsDemoted: 0
		});
		const cardsIn = live
			.prepare('SELECT id, created_at, committed_at, committed_by, discarded_at, discarded_by FROM cards ORDER BY id')
			.all() as { id: number; created_at: string; committed_at: string | null; committed_by: number | null }[];
		expect(cardsIn.map((card) => [card.id, card.committed_at === card.created_at, card.committed_by])).toEqual([
			[1, true, null],
			[2, true, null],
			[3, true, 2],
			[4, true, null],
			[5, true, null]
		]);
		expect(cardsIn.every((card) => card.committed_at !== null)).toBe(true);
		expect(live.prepare('SELECT COUNT(*) AS n FROM cards WHERE discarded_at IS NOT NULL OR discarded_by IS NOT NULL').get()).toEqual({ n: 0 });
		// Every board a delivery board, and each given its Options column (card 2527).
		expect(live.prepare('SELECT DISTINCT kind FROM boards').all()).toEqual([{ kind: 'delivery' }]);
		expect(live.prepare("SELECT board_id AS boardId FROM columns WHERE role IS 'options' AND title = 'Options' ORDER BY board_id").all()).toEqual([
			{ boardId: 1 },
			{ boardId: 2 },
			{ boardId: 3 }
		]);
		expect(result.requestLinksReplaced).toBe(2);
		expect(live.prepare('SELECT id, first_completed_at FROM cards ORDER BY id').all()).toEqual([
			{ id: 1, first_completed_at: '2026-09-01 10:00:00' },
			{ id: 2, first_completed_at: '2026-09-01 10:00:00' },
			{ id: 3, first_completed_at: null },
			{ id: 4, first_completed_at: null },
			{ id: 5, first_completed_at: null }
		]);
		// Every link ended: the retired column read as NULL, and none kept or brought in (card 2870).
		const tokens = (live.prepare('SELECT access_token FROM task_requests').all() as { access_token: string | null }[]).map(
			(r) => r.access_token
		);
		expect(tokens).toEqual([null, null]);
		expect(live.prepare('SELECT COUNT(*) AS n FROM request_links').get()).toEqual({ n: 0 });
	});

	it('takes out of a milestone a card the backup holds in a milestone of another board (card 2179)', () => {
		const { live, backup } = liveAndBackup();
		// Card 1 is on board A (1), card 3 on board B (2): both in a milestone of board A.
		backup.exec(`
			INSERT INTO milestones (id, name, board_id) VALUES (1, 'Goal of A', 1);
			UPDATE cards SET milestone_id = 1 WHERE id IN (1, 3);
		`);

		const result = restoreFromBackup(live, backup);

		expect(result.errors).toEqual([]);
		expect(result.backfilled.releasedFromMilestones).toBe(1);
		expect(result.backfilled.released).toEqual([{ cardId: 3, milestoneId: 1 }]);
		expect(live.prepare('SELECT id, milestone_id FROM cards WHERE id IN (1, 3) ORDER BY id').all()).toEqual([
			{ id: 1, milestone_id: 1 },
			{ id: 3, milestone_id: null }
		]);
	});

	it('restores a board the backup holds under a grouping it does not hold, says so, and takes it out of the grouping (card 2293)', () => {
		// Board A is filed under grouping 1, which the backup holds; board B under
		// grouping 9, which it does not. Every grouping row was copied, so B's is
		// the backup's own state, reported as a stranded row of a real foreign key
		// is, and the backfill after the commit clears it.
		const { live, backup } = liveAndBackup();
		backup.exec(`
			INSERT INTO board_categories (id, name) VALUES (1, 'Clients');
			UPDATE boards SET category_id = 1 WHERE id = 1;
			UPDATE boards SET category_id = 9 WHERE id = 2;
		`);

		const result = restoreFromBackup(live, backup);

		expect(result.errors).toEqual([
			'boards: 1 row(s) refer to a row of board_categories that is not there (rowid 2). No row of board_categories ' +
				'was left out by this restore, so the backup holds them that way'
		]);
		expect(result.backfilled.unfiledBoards).toBe(1);
		expect(result.backfilled.unfiled).toEqual([{ boardId: 2, groupingId: 9 }]);
		expect(live.prepare('SELECT id, category_id FROM boards ORDER BY id').all()).toEqual([
			{ id: 1, category_id: 1 },
			{ id: 2, category_id: null },
			{ id: 3, category_id: null }
		]);
		expect(foreignKeysOn(live)).toBe(true);
	});

	it('rolls the restore back rather than commit boards filed under a grouping it could not copy, as for a foreign key (card 2293)', () => {
		// Grouping 2 has no name, and `board_categories.name` is NOT NULL with no
		// default, so its row cannot be copied. Board B is filed under it. With
		// no foreign key on `boards.category_id` the restore committed, and the
		// backfill would then have taken B out of a grouping the backup holds.
		const { live, backup } = liveAndBackup();
		backup.exec(`
			CREATE TABLE board_categories_loose AS SELECT * FROM board_categories;
			DROP TABLE board_categories;
			ALTER TABLE board_categories_loose RENAME TO board_categories;
			INSERT INTO board_categories (id, name, color) VALUES (1, 'Clients', '#6366f1'), (2, NULL, '#6366f1');
			UPDATE boards SET category_id = 1 WHERE id = 1;
			UPDATE boards SET category_id = 2 WHERE id = 2;
		`);
		const before = live.serialize();

		let thrown: unknown;
		try {
			restoreFromBackup(live, backup);
		} catch (error) {
			thrown = error;
		}

		expect(thrown).toBeInstanceOf(RestoreError);
		const error = thrown as RestoreError;
		expect(error.committed).toBe(false);
		expect(error.message).toBe(
			'The restore failed and nothing was changed: rows that other rows depend on could not be copied ' +
				'(board_categories row (id 2): NOT NULL constraint failed: board_categories.name), ' +
				'and 1 row(s) of boards refer to a row of board_categories that would not be there'
		);
		expect(Buffer.compare(live.serialize(), before)).toBe(0);
		expect(foreignKeysOn(live)).toBe(true);
		expect(live.inTransaction).toBe(false);
	});

	it('commits a board under a grouping the backup never held, though another grouping could not be copied, and takes it out (review of card 2293)', () => {
		// Grouping 3 has no name and cannot be copied; no board is filed under
		// it. Board B is filed under grouping 9, which the backup does not hold
		// at all: the backup's own state, not this restore's doing. Sorting the
		// boards by table alone refused the whole restore.
		const { live, backup } = liveAndBackup();
		backup.exec(`
			CREATE TABLE board_categories_loose AS SELECT * FROM board_categories;
			DROP TABLE board_categories;
			ALTER TABLE board_categories_loose RENAME TO board_categories;
			INSERT INTO board_categories (id, name, color) VALUES (1, 'Clients', '#6366f1'), (3, NULL, '#6366f1');
			UPDATE boards SET category_id = 1 WHERE id = 1;
			UPDATE boards SET category_id = 9 WHERE id = 2;
		`);

		const result = restoreFromBackup(live, backup);

		expect(result.errors).toEqual([
			'board_categories row (id 3): NOT NULL constraint failed: board_categories.name',
			'boards: 1 row(s) refer to a row of board_categories that is not there (rowid 2). The backup holds no row of ' +
				'board_categories they refer to, so the backup holds them that way'
		]);
		expect(result.backfilled.unfiled).toEqual([{ boardId: 2, groupingId: 9 }]);
		expect(live.prepare('SELECT id, category_id FROM boards ORDER BY id').all()).toEqual([
			{ id: 1, category_id: 1 },
			{ id: 2, category_id: null },
			{ id: 3, category_id: null }
		]);
		expect(foreignKeysOn(live)).toBe(true);
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
		expect(report.backfilled).toEqual({
			firstCompletedAt: 0,
			releasedFromMilestones: 0,
			released: [],
			unfiledBoards: 0,
			unfiled: [],
			committedFilled: 0,
			upstreamCleared: 0,
			discardedCleared: 0,
			optionsAdded: 0,
			optionsMoved: 0,
			optionsRenamed: 0,
			optionsDemoted: 0
		});
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
		expect(result.backfilled).toEqual({
			firstCompletedAt: 0,
			releasedFromMilestones: 0,
			released: [],
			unfiledBoards: 0,
			unfiled: [],
			committedFilled: 0,
			upstreamCleared: 0,
			discardedCleared: 0,
			optionsAdded: 0,
			optionsMoved: 0,
			optionsRenamed: 0,
			optionsDemoted: 0
		});
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
			// Made before the backup's accounts, so never the same account as the backup's user 1 by sharing its second of
			// creation: an unsealed backup's same account would keep this server's password and be counted (card 2997, R2).
			sqlite.prepare("UPDATE users SET created_at = '2020-01-01 00:00:00' WHERE id = ?").run(admin.id);
			// With their password confirmed first (card 2701), before `arrange`
			// reads what there is: the session it is confirmed on is theirs.
			const confirmed = importConfirmation(admin);
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
				headers: { 'content-type': 'application/octet-stream', ...confirmed },
				body: bytes
			});

			// The logger writes to the database being restored. A line written
			// inside the restore's transaction would be lost with a rollback.
			expect(insideATransaction).toEqual([]);
			// Written where the test pointed it, and nowhere in the repository.
			expect(existsSync(join(workingDirectory, '.pre-restore-safety.json'))).toBe(true);
			expect(existsSync(join(workingDirectory, '.restore-temp.db'))).toBe(false);
			return { response, logged, size: `${(bytes.length / 1024).toFixed(1)} KB`, admin };
		};

		/** The CRITICAL line a committed import begins with (card 2899): who imported which file. */
		const IMPORTED = /^\[CRITICAL\] \[IMPORT\] The database was replaced from an uploaded backup by /;

		it('answers a failed restore with what had gone wrong by then, and says nothing was changed', async () => {
			const { backup } = backupWithAStrangeTable();
			let before: ReturnType<typeof dataIn> | null = null;

			const { response, logged, admin } = await upload(backup, () => {
				// Read here, with the administrator who uploads it already made.
				before = dataIn(sqlite);
				failAtCommit(sqlite, 'disk I/O error', { restoreOnly: true });
			});

			expect(response.status).toBe(500);
			expect(response.body.message).toBe('The restore failed and nothing was changed: disk I/O error');
			expect(response.body.committed).toBe(false);
			// It answered `errors: []`: the list was lost with the call that threw.
			expect(response.body.errors).toEqual(['settings: no matching columns']);
			// Naming who tried, by name and id, which are still theirs: nothing changed (card 2899).
			// And no line says the database was replaced.
			expect(logged).toEqual([
				'[CRITICAL] [IMPORT] Database restore: The restore failed and nothing was changed: disk I/O error ' +
					`(import by ${admin.username}, user ${admin.id}) | {"errors":["settings: no matching columns"]}`
			]);
			expect(
				sqlite.prepare("SELECT user_id AS userId FROM system_logs WHERE context = 'IMPORT' AND level = 'CRITICAL'").all()
			).toEqual([{ userId: admin.id }]);

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
			// At ERROR, with the problems themselves in the line, after the CRITICAL line of who imported (card 2899).
			expect(logged).toHaveLength(2);
			expect(logged[0]).toMatch(IMPORTED);
			expect(logged[1]).toBe(`[ERROR] [IMPORT] Restore committed, with 1 problem(s): ${problem}`);
			// And it is what it says: the backup is in, without that one row.
			expect(sqlite.prepare('SELECT id FROM boards ORDER BY id').all()).toEqual([{ id: 1 }, { id: 2 }, { id: 3 }]);
			// And the form signing key, made again once the restore committed (card 2750),
			// and no API key deadline, as this server has none (card 3064, R18),
			// and the flag the check of the stored images writes once the import has committed, the backup
			// holding no image (card 2761, the code review's CS3).
			// And the key check, recorded with the form key, sealed (card 2898).
			// And mail set up in the backup, recorded (card 2922's code review, C4).
			expect(sqlite.prepare('SELECT key FROM settings ORDER BY key').all()).toEqual([
				{ key: 'mail_ever_configured_at' },
				{ key: 'mfa_key_check' },
				{ key: 'request_form_secret' },
				{ key: 'secrets_scrub_pending' },
				{ key: 'smtp_host' },
				{ key: 'stored_images_rechecked' },
				{ key: 'theme' },
				// Two-step sign-in's switch, on here (`resetDb`, card 3064, R23) and so kept on by the restore (R1).
				{ key: 'two_step_required_at' },
				// The once-only seed's flag, which the restore writes for a backup holding none (card 2947, R7).
				{ key: 'webhook_reveals_seeded' },
				// The moment the restore's own run of the readable pass covered (card 2935, P12).
				{ key: 'webhooks_readable_by_disabled_held' }
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
			// Two lines after the CRITICAL one of who imported (card 2899). What was
			// filled in used to be logged only for a restore with nothing to
			// report, and this one filled in as much as any.
			expect(logged).toHaveLength(3);
			expect(logged.shift()).toMatch(IMPORTED);
			expect(logged[0]).toMatch(
				new RegExp(
					`^\\[INFO\\] \\[IMPORT\\] Database restored from an uploaded backup \\(${size.replace('.', '\\.')}\\)\\. ` +
						'Rows: .*\\bcards: 6\\b.*\\. Filled in: first_completed_at on 2 card\\(s\\), ' +
						// Card 6 is on no column, so it is not committed (milestone 22).
						'committed_at and committed_by on 5 card\\(s\\) not upstream, ' +
						// Each of the backup's boards, made before card 2527.
						'an Options column at the far left of 3 delivery board\\(s\\), ' +
						'the default \\(0\\) in place of NULL in columns\\.wip_limit on 2 row\\(s\\)\\. ' +
						'2 request link\\(s\\) replaced: a link mailed before this restore no longer works, and its requester can have ' +
						'a new one sent from the page it opens\\. ' +
						// Card 3009: one account's password not taken, its superadmin given the importer's, and (R4) its mail
						// settings, from a file with no seal, at a place this server did not hold, held.
						`${literally(`${ONE_PASSWORD_NOT_TAKEN} ${GIVEN_YOURS_NO_FACTOR} ${HELD_MAIL_UNSEALED} ${NOTIFICATIONS_OFF(2)}`)}$`
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
			// a backup too old to have it. The NULL WIP limits are among those, and
			// so is the commitment of every card, the backup being older than 0060.
			// After the CRITICAL line of who imported (card 2899).
			expect(logged).toHaveLength(2);
			expect(logged.shift()).toMatch(IMPORTED);
			expect(logged[0]).toMatch(
				new RegExp(
					`^\\[INFO\\] \\[IMPORT\\] Database restored from an uploaded backup \\(${size.replace('.', '\\.')}\\)\\. ` +
						'Rows: .*\\bcards: 5\\b.*\\. Filled in: first_completed_at on 2 card\\(s\\), ' +
						'committed_at and committed_by on 5 card\\(s\\) not upstream, ' +
						// Each of the backup's boards, made before card 2527.
						'an Options column at the far left of 3 delivery board\\(s\\), ' +
						'the default \\(0\\) in place of NULL in columns\\.wip_limit on 2 row\\(s\\)\\. ' +
						'2 request link\\(s\\) replaced: a link mailed before this restore no longer works, and its requester can have ' +
						'a new one sent from the page it opens\\. ' +
						// Card 3009: one account's password not taken, its superadmin given the importer's, and (R4) its mail
						// settings, from a file with no seal, at a place this server did not hold, held.
						`${literally(`${ONE_PASSWORD_NOT_TAKEN} ${GIVEN_YOURS_NO_FACTOR} ${HELD_MAIL_UNSEALED} ${NOTIFICATIONS_OFF(2)}`)}$`
				)
			);
			expect(sqlite.prepare('SELECT id, wip_limit FROM columns ORDER BY id').all()).toEqual([
				{ id: 1, wip_limit: 0 },
				{ id: 2, wip_limit: 3 },
				{ id: 4, wip_limit: 0 },
				// The three boards' Options columns, which the backfill gave them.
				{ id: 5, wip_limit: 0 },
				{ id: 6, wip_limit: 0 },
				{ id: 7, wip_limit: 0 }
			]);
		});

		it('names in its Filled in the cards it took out of a milestone of another board (review of card 2179)', async () => {
			const { backup } = liveAndBackup();
			// Card 1 is on board A (1), card 3 on board B (2): both in a milestone of board A.
			backup.exec(`
				INSERT INTO milestones (id, name, board_id) VALUES (1, 'Goal of A', 1);
				UPDATE cards SET milestone_id = 1 WHERE id IN (1, 3);
			`);
			process.env.LOG_LEVEL = 'INFO';

			const { response, logged } = await upload(backup);

			expect(response.status).toBe(200);
			// After the CRITICAL line of who imported (card 2899).
			expect(logged).toHaveLength(2);
			expect(logged.shift()).toMatch(IMPORTED);
			expect(logged[0]).toContain(
				'Filled in: first_completed_at on 2 card(s), ' +
					'1 card(s) taken out of a milestone of another board (card 3 left milestone 1), ' +
					'committed_at and committed_by on 5 card(s) not upstream, ' +
					'an Options column at the far left of 3 delivery board(s), the default (0)'
			);
		});

		it('names in its Filled in the boards it took out of a grouping that is not there (card 2293)', async () => {
			const { backup } = liveAndBackup();
			// Board B (2) is filed under grouping 9, which the backup does not hold.
			backup.exec('UPDATE boards SET category_id = 9 WHERE id = 2');
			process.env.LOG_LEVEL = 'INFO';

			const { response, logged } = await upload(backup);

			expect(response.status).toBe(200);
			expect(logged.join('\n')).toContain(
				'Filled in: first_completed_at on 2 card(s), ' +
					'1 board(s) taken out of a grouping that no longer exists (board 2 (grouping 9)), ' +
					'committed_at and committed_by on 5 card(s) not upstream, ' +
					'an Options column at the far left of 3 delivery board(s), the default (0)'
			);
			expect(sqlite.prepare('SELECT category_id FROM boards WHERE id = 2').get()).toEqual({ category_id: null });
		});

		it('names each repair of the commitment point, the fill in its Filled in and the two clears as clears (milestone 22)', async () => {
			// A backup in the current shape: a card in To Do with no commitment, an
			// option holding one, and a live card marked discarded.
			const backup = memoryDb();
			runMigrations({ database: backup, migrationsDir: REAL_MIGRATIONS });
			backup.exec(`
				INSERT INTO users (id, username, email, password_hash) VALUES (1, 'ann', 'ann@example.test', 'x');
				INSERT INTO boards (id, name) VALUES (1, 'A');
				INSERT INTO columns (id, board_id, title, position, role) VALUES (1, 1, 'Options', 0, 'options'), (2, 1, 'To Do', 1, NULL);
				INSERT INTO cards (id, column_id, title, committed_at, committed_by, discarded_at, discarded_by) VALUES
					(1, 2, 'Never committed', NULL, NULL, NULL, NULL),
					(2, 1, 'An option, committed', '2026-10-01 09:00:00', 1, NULL, NULL),
					(3, 2, 'Live, discarded', '2026-10-01 09:00:00', 1, '2026-10-01 09:00:00', 1);
			`);
			process.env.LOG_LEVEL = 'INFO';

			const { response, logged } = await upload(backup);

			expect(response.status).toBe(200);
			// After the CRITICAL line of who imported (card 2899).
			expect(logged).toHaveLength(2);
			expect(logged.shift()).toMatch(IMPORTED);
			expect(logged[0]).toMatch(
				// Card 3009: then the backup's superadmin given the importer's password.
				new RegExp(
					'Filled in: first_completed_at on 0 card\\(s\\), committed_at and committed_by on 1 card\\(s\\) not upstream\\. Cleared: the commitment of 1 upstream ' +
						`card\\(s\\), the discard mark of 1 card\\(s\\) that are not archived\\. ${literally(`${GIVEN_YOURS_NO_FACTOR} ${NOTIFICATIONS_OFF(1)}`)}$`
				)
			);
			// A restore that clears nothing says nothing of clearing: the pre-0060 ones above end at their Filled in.
			expect(logged[0].match(/Cleared:/g)).toHaveLength(1);
			expect(sqlite.prepare('SELECT id, committed_by, discarded_by FROM cards ORDER BY id').all()).toEqual([
				{ id: 1, committed_by: null, discarded_by: null },
				{ id: 2, committed_by: null, discarded_by: null },
				{ id: 3, committed_by: 1, discarded_by: null }
			]);
		});

		it('names the repairs of the Options column: the column added and the title given as filled in, a second one made ordinary as cleared (card 2527)', async () => {
			// A backup in the current shape: board A's Options column called Ideas,
			// board B with two, and board C with none.
			const backup = memoryDb();
			runMigrations({ database: backup, migrationsDir: REAL_MIGRATIONS });
			backup.exec(`
				INSERT INTO users (id, username, email, password_hash) VALUES (1, 'ann', 'ann@example.test', 'x');
				INSERT INTO boards (id, name) VALUES (1, 'A'), (2, 'B'), (3, 'C');
				INSERT INTO columns (id, board_id, title, position, role) VALUES
					(1, 1, 'Ideas', -1, 'options'), (2, 1, 'To Do', 0, NULL), (3, 2, 'Options', -1, 'options'), (4, 2, 'Later', 0, 'options'), (5, 3, 'To Do', 0, NULL);
			`);
			process.env.LOG_LEVEL = 'INFO';

			const { response, logged } = await upload(backup);

			expect(response.status).toBe(200);
			// After the CRITICAL line of who imported (card 2899).
			expect(logged).toHaveLength(2);
			expect(logged.shift()).toMatch(IMPORTED);
			expect(logged[0]).toMatch(
				// Card 3009: then the backup's superadmin given the importer's password.
				new RegExp(
					'Filled in: first_completed_at on 0 card\\(s\\), an Options column at the far left of 1 delivery board\\(s\\), the title Options on 1 Options ' +
						`column\\(s\\)\\. Cleared: the Options role of 1 second Options column\\(s\\), each board keeping its leftmost\\. ${literally(`${GIVEN_YOURS_NO_FACTOR} ${NOTIFICATIONS_OFF(1)}`)}$`
				)
			);
			expect(sqlite.prepare("SELECT board_id AS boardId, title FROM columns WHERE role IS 'options' ORDER BY board_id").all()).toEqual([
				{ boardId: 1, title: 'Options' },
				{ boardId: 2, title: 'Options' },
				{ boardId: 3, title: 'Options' }
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
			// One line in the backup's log, which is not brought in, and is said to have been kept out (card 2899's code review, F6).
			backup.exec("INSERT INTO system_logs (timestamp, level, context, message) VALUES ('2026-10-01 09:00:00', 'INFO', 'T', 'From the backup')");
			let real: Database.Database['pragma'] | null = null;

			const { response, logged, admin } = await upload(backup, () => {
				real = ignoringPragma(sqlite, 'ON');
			});
			const kept = "The system log was kept as it was: the backup's 1 log line(s) were not brought in, and remain in the backup file.";

			const toEnter =
				'To enter again, because a backup does not hold them: the mail password (Admin, 📧 Email / SMTP). None was ' +
				// No seal at all, so this reason and not the other (the second review's N7).
				'kept from this server, because this backup carries no seal this server can check.';
			const message =
				'The backup was restored and committed, but foreign keys could not be switched back on. Restart the ' +
				'server now: until it restarts, deleting a board, a card or a user leaves behind what belonged to it. ' +
				// It replaced every request's link, and listed the secrets, as a restore that succeeded does, and says so (O8).
				'2 request link(s) replaced: a link mailed before this restore no longer works, and its requester can have ' +
				// Card 3009 (R4): its mail settings, from a backup with no seal, held for review.
				`a new one sent from the page it opens. ${ONE_PASSWORD_NOT_TAKEN} ${GIVEN_YOURS_NO_FACTOR} ${toEnter} ${HELD_MAIL_UNSEALED} ${NOTIFICATIONS_OFF(2)} ${kept}`;
			expect(response.status).toBe(500);
			// The page reloads its data on this, and not on any other failure.
			expect(response.body.committed).toBe(true);
			expect(response.body.message).toBe(message);
			expect(response.body.systemLog).toBe(kept);
			expect(response.body.requestLinksReplaced).toBe(2);
			expect(response.body.secretsToEnter).toBe(toEnter);
			expect(response.body).not.toHaveProperty('secretsKept');
			// The database was replaced, so it says who imported which file as a
			// restore that succeeded does, before its own line (card 2899): by
			// name and id as they were before it, the line's user field empty.
			// This server has made no backup, so it has no key to check a seal
			// with, and says so (the code review's F8).
			expect(logged).toHaveLength(2);
			expect(logged[0]).toMatch(
				new RegExp(
					`^\\[CRITICAL\\] \\[IMPORT\\] The database was replaced from an uploaded backup by ${admin.username} ` +
						`\\(user ${admin.id} before the import\\): [0-9.]+ KB, SHA-256 [0-9a-f]{64}, ` +
						'a backup this server could not check, as it has no key to check a seal with, ' +
						// Card 3009 (R4): its mail settings held for review, counted.
						"restored as it is, keeping 1 of the backup's password\\(s\\) out of use, giving the backup's superadmin the importing account's password but no authenticator, " +
							"holding 1 setting\\(s\\) of a backup whose seal did not verify for the superadmin's review, " +
							// Card 3012: and what it would send outside, kept from it, counted.
							"keeping what a backup whose seal did not verify would send outside: 2 account\\(s\\)' notification mail switched off\\. The system log was kept as it was; "
				)
			);
			expect(logged[0]).toContain('"seal":"not checked"');
			expect(logged[1]).toBe(`[CRITICAL] [IMPORT] Database restore: ${message}`);
			expect(
				sqlite
					.prepare("SELECT user_id AS userId FROM system_logs WHERE context = 'IMPORT' AND message LIKE 'The database was replaced%'")
					.all()
			).toEqual([{ userId: null }]);
			expect(`${response.body.message} ${logged[0]} ${logged[1]}`).not.toMatch(/failed|nothing was changed/i);
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
		// indexes of 0053 (card 2106), the column of 0056 (card 2168), the
		// column of 0058 (card 2159), the table of 0059 (card 2397), the columns,
		// keys and indexes of 0060 (milestone 22), the tables, column, key and
		// index of 0061 (card 2673), the column of 0062 (card 2701), the table of
		// 0064 (card 2681), the four tables and eleven users columns of 0065
		// (card 2768), the sessions and users columns of 0066 (card 2769), the
		// api_keys and users columns of 0069 (card 2772), the table of 0070 (card 2870), the webhooks columns, key and index of 0071 (card 2752), the users columns, key and index of 0072 (card 2671), and no other. 0063's index (card 2685) is
		// on a table of 0061, absent here whole, so it is in that table's line
		// and has none of its own; so are 0065's indexes, each on a table of
		// 0065, and 0066's two columns of sign_in_challenges.
		expect(withoutTheIndexesOf0053(differencesFromModel(structureOf(database), structureOf(modelDatabase())))).toEqual([
			// The table of 0079 (card 3002), of 0077 (card 2996), and of 0076 (card 2995).
			TABLE_OF_0079,
			TABLE_OF_0077,
			TABLE_OF_0076,
			COLUMN_OF_0069,
			'boards.kind: the column is in the model but not in the database',
			'boards.product_owner_user_id: the column is in the model but not in the database',
			'boards: foreign key in the model but not in the database: (product_owner_user_id) references users(id), on update NO ACTION, on delete SET NULL',
			'boards: index in the model but not in the database: index idx_boards_product_owner_user_id on (product_owner_user_id)',
			'cards.committed_at: the column is in the model but not in the database',
			'cards.committed_by: the column is in the model but not in the database',
			'cards.discarded_at: the column is in the model but not in the database',
			'cards.discarded_by: the column is in the model but not in the database',
			'cards.first_completed_at: the column is in the model but not in the database',
			'cards: foreign key in the model but not in the database: (committed_by) references users(id), on update NO ACTION, on delete SET NULL',
			'cards: foreign key in the model but not in the database: (discarded_by) references users(id), on update NO ACTION, on delete SET NULL',
			'cards: index in the model but not in the database: index idx_cards_committed_by on (committed_by)',
			'cards: index in the model but not in the database: index idx_cards_discarded_by on (discarded_by)',
			'categories.board_id: is NOT NULL; the model has it nullable',
			'categories: foreign key not in the model: (board_id) references boards(id), on update NO ACTION, on delete CASCADE',
			'categories: foreign key in the model but not in the database: (board_id) references boards(id), on update NO ACTION, on delete SET NULL',
			'columns.role: the column is in the model but not in the database',
			'columns.wip_limit: is nullable; the model has it NOT NULL',
			...TABLES_OF_0061_0065_0082_AND_0083.filter((table) => table < 'invite_tokens').map(notInTheDatabase),
			'invite_tokens.token: is nullable; the model has it NOT NULL',
			...TABLES_OF_0061_0065_0082_AND_0083.filter((table) => table > 'invite_tokens' && table < 'outbound_changes').map(notInTheDatabase),
			// The table of 0081 (card 3004).
			TABLE_OF_0081,
			...TABLES_OF_0061_0065_0082_AND_0083.filter((table) => table > 'outbound_changes' && table < 'people_changes').map(notInTheDatabase),
			TABLE_OF_0064,
			...TABLES_OF_0061_0065_0082_AND_0083.filter((table) => table > 'people_changes' && table < 'report_schedules').map(notInTheDatabase),
			'report_schedules.time_zone: the column is in the model but not in the database',
			// The table of 0070 (card 2870).
			notInTheDatabase('request_links'),
			// The column of 0084 (card 3064).
			COLUMN_OF_0084,
			SESSIONS_COLUMN_OF_0066,
			COLUMN_OF_0062,
			// The table of 0074 (card 2922).
			TABLE_OF_0074,
			'setting_setters: the table is in the model but not in the database',
			'settings.key: is nullable; the model has it NOT NULL',
			notInTheDatabase('sign_in_challenges'),
			'task_requests.access_token: the column is in the model but not in the database',
			// The four columns, key and index of 0078 (card 3020), in the order the check gives them.
			...MODEL_LINES_OF_0078,
			'task_requests: index in the model but not in the database: unique index task_requests_access_token_idx on (access_token)',
			'time_entries: the table is not in the model',
			'user_xp.name: is nullable; the model has it NOT NULL',
			// With 0072's two columns, its key and its index (card 2671), in the order the check gives them.
			...[...USERS_COLUMNS_OF_0065_AND_0066, USERS_COLUMN_OF_0069, ...MODEL_LINES_OF_0072.slice(0, 2)].sort(),
			...MODEL_LINES_OF_0072.slice(2),
			// The table of 0075 (card 2947).
			TABLE_OF_0075,
			'webhooks.held_at: the column is in the model but not in the database',
			'webhooks.held_because: the column is in the model but not in the database',
			MODEL_LINE_OF_0073,
			'webhooks.set_by: the column is in the model but not in the database',
			'webhooks.set_by_key: the column is in the model but not in the database',
			'webhooks.set_with_key: the column is in the model but not in the database',
			'webhooks: foreign key in the model but not in the database: (set_by) references users(id), on update NO ACTION, on delete SET NULL',
			'webhooks: foreign key in the model but not in the database: (set_by_key) references api_keys(id), on update NO ACTION, on delete SET NULL',
			'webhooks: index in the model but not in the database: index idx_webhooks_set_by on (set_by)',
			'webhooks: index in the model but not in the database: index idx_webhooks_set_by_key on (set_by_key)'
		]);

		const report = runMigrations({ database, migrationsDir: REAL_MIGRATIONS });

		expect(report.applied).toEqual([
			'0050_add_first_completed_at.sql',
			'0051_add_request_access_token.sql',
			'0052_drop_time_entries.sql',
			'0053_index_foreign_keys_end_sessions.sql',
			FILE_0054,
			FILE_0055,
			FILE_0056,
			FILE_0057,
			FILE_0058,
			FILE_0059,
			FILE_0060,
			FILE_0061,
			FILE_0062,
			FILE_0063,
			FILE_0064,
			FILE_0065,
			FILE_0066,
			FILE_0067,
			FILE_0068,
			FILE_0069,
			FILE_0070,
			FILE_0071,
			FILE_0072,
			FILE_0073,
			FILE_0074,
			FILE_0075,
			FILE_0076,
			FILE_0077,
			FILE_0078,
			FILE_0079,
			FILE_0080,
			FILE_0081,
			FILE_0082,
			FILE_0083,
			FILE_0084
		]);
		expect(report.tolerated).toEqual([]);
		expect(report.rebuilt.map((r) => r.table)).toEqual(['columns', 'categories', 'settings', 'user_xp', 'invite_tokens']);
		expect(report.missingFromDisk).toEqual([]);
		expect(report.schemaDifferences).toEqual([]);
		expect(recordedIn(database)).toHaveLength(90);
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
		// none of the 39 indexes of 0053 (card 2106), no column of 0056
		// (card 2168) or 0058 (card 2159), no table of 0059 (card 2397),
		// nothing of 0060 (milestone 22), nothing of 0061 (card 2673), no
		// column of 0062 (card 2701), no index of 0063 (card 2685), which is on
		// a table of 0061 and so in that table's line, no table of 0064
		// (card 2681), none of the tables or users columns of 0065
		// (card 2768), neither the sessions nor the users column of 0066
		// (card 2769), neither column of 0069 (card 2772), no table of 0070
		// (card 2870), and none of the webhooks columns of 0071 (card 2752).
		expect(withoutTheIndexesOf0053(differencesFromModel(structureOf(database), structureOf(modelDatabase())))).toEqual([
			// The table of 0079 (card 3002), of 0077 (card 2996), and of 0076 (card 2995).
			TABLE_OF_0079,
			TABLE_OF_0077,
			TABLE_OF_0076,
			COLUMN_OF_0069,
			'boards.kind: the column is in the model but not in the database',
			'boards.product_owner_user_id: the column is in the model but not in the database',
			'boards: foreign key not in the model: (created_by) references users(id), on update NO ACTION, on delete NO ACTION',
			'boards: foreign key in the model but not in the database: (created_by) references users(id), on update NO ACTION, on delete SET NULL',
			'boards: foreign key in the model but not in the database: (parent_card_id) references cards(id), on update NO ACTION, on delete CASCADE',
			'boards: foreign key in the model but not in the database: (product_owner_user_id) references users(id), on update NO ACTION, on delete SET NULL',
			'boards: index in the model but not in the database: index idx_boards_product_owner_user_id on (product_owner_user_id)',
			'cards.committed_at: the column is in the model but not in the database',
			'cards.committed_by: the column is in the model but not in the database',
			'cards.discarded_at: the column is in the model but not in the database',
			'cards.discarded_by: the column is in the model but not in the database',
			'cards: foreign key in the model but not in the database: (committed_by) references users(id), on update NO ACTION, on delete SET NULL',
			'cards: foreign key in the model but not in the database: (discarded_by) references users(id), on update NO ACTION, on delete SET NULL',
			'cards: index in the model but not in the database: index idx_cards_committed_by on (committed_by)',
			'cards: index in the model but not in the database: index idx_cards_discarded_by on (discarded_by)',
			'categories.board_id: is NOT NULL; the model has it nullable',
			'categories: foreign key not in the model: (board_id) references boards(id), on update NO ACTION, on delete CASCADE',
			'categories: foreign key in the model but not in the database: (board_id) references boards(id), on update NO ACTION, on delete SET NULL',
			'columns.role: the column is in the model but not in the database',
			...TABLES_OF_0061_0065_0082_AND_0083.filter((table) => table < 'outbound_changes').map(notInTheDatabase),
			// The table of 0081 (card 3004).
			TABLE_OF_0081,
			...TABLES_OF_0061_0065_0082_AND_0083.filter((table) => table > 'outbound_changes' && table < 'people_changes').map(notInTheDatabase),
			TABLE_OF_0064,
			...TABLES_OF_0061_0065_0082_AND_0083.filter((table) => table > 'people_changes' && table < 'report_schedules').map(notInTheDatabase),
			'report_schedules.time_zone: the column is in the model but not in the database',
			// The table of 0070 (card 2870).
			notInTheDatabase('request_links'),
			// The column of 0084 (card 3064).
			COLUMN_OF_0084,
			SESSIONS_COLUMN_OF_0066,
			COLUMN_OF_0062,
			// The table of 0074 (card 2922).
			TABLE_OF_0074,
			'setting_setters: the table is in the model but not in the database',
			notInTheDatabase('sign_in_challenges'),
			// The four columns, key and index of 0078 (card 3020).
			...MODEL_LINES_OF_0078,
			'time_entries: the table is not in the model',
			// With 0072's two columns, its key and its index (card 2671), in the order the check gives them.
			...[...USERS_COLUMNS_OF_0065_AND_0066, USERS_COLUMN_OF_0069, ...MODEL_LINES_OF_0072.slice(0, 2)].sort(),
			...MODEL_LINES_OF_0072.slice(2),
			// The table of 0075 (card 2947).
			TABLE_OF_0075,
			'webhooks.held_at: the column is in the model but not in the database',
			'webhooks.held_because: the column is in the model but not in the database',
			MODEL_LINE_OF_0073,
			'webhooks.set_by: the column is in the model but not in the database',
			'webhooks.set_by_key: the column is in the model but not in the database',
			'webhooks.set_with_key: the column is in the model but not in the database',
			'webhooks: foreign key in the model but not in the database: (set_by) references users(id), on update NO ACTION, on delete SET NULL',
			'webhooks: foreign key in the model but not in the database: (set_by_key) references api_keys(id), on update NO ACTION, on delete SET NULL',
			'webhooks: index in the model but not in the database: index idx_webhooks_set_by on (set_by)',
			'webhooks: index in the model but not in the database: index idx_webhooks_set_by_key on (set_by_key)'
		]);
		const rowsOf = (table: string) => contentsOf(database)[table];
		const before = Object.fromEntries(['boards', 'columns', 'categories', 'cards', 'labels'].map((t) => [t, rowsOf(t)]));
		// Less the indexes of 0053, which the run creates before it rebuilds,
		// boards.kind, which 0060 adds before it rebuilds (milestone 22), and the
		// column, key and index 0061 adds to boards before it rebuilds (card 2673).
		const notOf0053 = (difference: string) => !INDEXES_FROM_0053.some(({ name }) => difference.includes(` index ${name} on `));
		const notOf0060 = (difference: string) =>
			!difference.startsWith('boards.kind: ') && !difference.includes('product_owner_user_id');
		const differed = {
			boards: differencesOf(database, 'boards').filter(notOf0053).filter(notOf0060),
			categories: differencesOf(database, 'categories').filter(notOf0053)
		};
		expect(differed.boards).toHaveLength(3);
		expect(differed.categories).toHaveLength(3);

		const report = runMigrations({ database, migrationsDir: REAL_MIGRATIONS });

		expect(report.applied).toEqual(['0052_drop_time_entries.sql', '0053_index_foreign_keys_end_sessions.sql', FILE_0054, FILE_0055, FILE_0056, FILE_0057, FILE_0058, FILE_0059, FILE_0060, FILE_0061, FILE_0062, FILE_0063, FILE_0064, FILE_0065, FILE_0066, FILE_0067, FILE_0068, FILE_0069, FILE_0070, FILE_0071, FILE_0072, FILE_0073, FILE_0074, FILE_0075, FILE_0076, FILE_0077, FILE_0078, FILE_0079, FILE_0080, FILE_0081, FILE_0082, FILE_0083, FILE_0084]);
		expect(report.rebuilt).toEqual([
			{ table: 'boards', rows: 3, defaulted: [], differences: differed.boards },
			{ table: 'categories', rows: 3, defaulted: [], differences: differed.categories }
		]);
		expect(report.schemaDifferences).toEqual([]);
		expect(differencesIn(database)).toEqual(NONE);
		// Every row kept, and as it was, but for what 0060 adds: `boards`, rebuilt
		// in the same start, keeps the `kind` it gave (milestone 22).
		for (const table of Object.keys(before)) expect(lessOptionsGiven(table, rowsOf(table))).toEqual(after0060(table, before[table]));
		// And each board its Options column (card 2527): left of its columns, or at 0 on the sub-board, which has none.
		expect(optionsGiven(rowsOf('columns'))).toEqual([
			[1, 'Options', -1, '#8b5cf6'],
			[2, 'Options', -1, '#8b5cf6'],
			[3, 'Options', 0, '#8b5cf6']
		]);
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
			-- In plain, on purpose: a database from before card 2775, which these migrations meet.
			INSERT INTO sessions (id, user_id, expires_at) VALUES
				('session-of-ann', 1, '2099-01-01 00:00:00'),
				('session-of-bob', 2, '2099-01-01 00:00:00');
			INSERT INTO api_keys (key_hash, key_prefix, name, user_id) VALUES ('hash-of-ann', 'df_ann', 'Ann''s key', 1);
			-- In plain, on purpose: a database from before 0068 (card 2849) holds its invites as mailed.
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

		expect(report.applied).toEqual([FILE_0053, FILE_0054, FILE_0055, FILE_0056, FILE_0057, FILE_0058, FILE_0059, FILE_0060, FILE_0061, FILE_0062, FILE_0063, FILE_0064, FILE_0065, FILE_0066, FILE_0067, FILE_0068, FILE_0069, FILE_0070, FILE_0071, FILE_0072, FILE_0073, FILE_0074, FILE_0075, FILE_0076, FILE_0077, FILE_0078, FILE_0079, FILE_0080, FILE_0081, FILE_0082, FILE_0083, FILE_0084]);
		expect(report.schemaDifferences).toEqual([]);
		const after = contentsOf(database);
		expect(after.sessions).toEqual([]);
		for (const table of Object.keys(before)) {
			// The migration record, and its id counter, gain the files; 0054 ends
			// the unused invite, which its own tests cover.
			if (['sessions', 'invite_tokens', '__drizzle_migrations', 'sqlite_sequence'].includes(table)) continue;
			expect(after[table], table).toEqual(afterRelease(table, before[table]));
		}
		expect(after.users).toHaveLength(2);
		expect(after.api_keys).toHaveLength(1);
		// The used one, with 0068's token in place of the one it was mailed with (card 2849).
		expect(after.invite_tokens).toEqual(afterRelease('invite_tokens', before.invite_tokens));
		expect(after.invite_tokens).toHaveLength(1);
	});

	it('deletes nothing at the next start, and a session made after it survives that start', () => {
		const database = signedIn();
		runMigrations({ database, migrationsDir: REAL_MIGRATIONS });
		// In plain, on purpose: a database from before card 2775, which these migrations meet.
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
			// 0053 is the one file declared for sessions (0067's delete was taken out by card 3064).
			`sessions had 2 row(s) and has 0: every row deleted by ${FILE_0053}, a one-off declared in tests/rehearsal/one-offs.ts`,
			// 0066 records the release in settings (card 2769), and 0069 the API key deadline (card 2772), both taken back by
			// 0084 (card 3064); there was no remembered-browser secret for 0067 to delete.
			SETTINGS_NOTE_OF_0066(0),
			USERS_NOTE_OF_0066(2),
			// 0068 replaces the used invite's token (card 2849).
			`invite_tokens: every used invite's token replaced in its 1 row(s) by ${FILE_0068}, a one-off declared in tests/rehearsal/one-offs.ts`,
			// 0069 gives the key, which has no expiry, the deadline (card 2772).
			`api_keys: deadline_at set for every key with no expiry or one later than the deadline in its 1 row(s) by ${FILE_0069}, ` +
				'a one-off declared in tests/rehearsal/one-offs.ts',
			...NOTES_OF_0084({ invite_tokens: 1, api_keys: 1, users: 2 })
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
			expect(sqlite.prepare('SELECT COUNT(*) AS n FROM sessions WHERE id = ?').get(sessionHashOf(token))).toEqual({ n: 1 });

			const bytes = generateBackupData();

			expect(bytes.includes(Buffer.from(token)), 'the id of a live session').toBe(false);
			// Nor its row, which holds the code's hash (card 2775).
			expect(bytes.includes(sessionHashOf(token)), 'the row of a live session').toBe(false);
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
				// A table of the `temp` schema is the connection's, never the database file's: 0076's guard (card 2995's code
				// review, FP5) drops its own, which holds no row of the data.
				if (statement.keyword === 'DROP') return /^\s*DROP\s+TABLE\b/i.test(code) && !/^\s*DROP\s+TABLE\s+(?:IF\s+EXISTS\s+)?temp\s*\./i.test(code);
				if (statement.keyword === 'INSERT' || statement.keyword === 'UPDATE') return /\bOR\s+REPLACE\b/i.test(code);
				if (statement.keyword === 'CREATE' && /^\s*CREATE\s+(TEMP\s+|TEMPORARY\s+)?TRIGGER\b/i.test(code)) {
					// After its BEGIN: the event it waits for may be a DELETE, which takes nothing.
					return /\b(DELETE|REPLACE)\b/i.test(code.slice(code.search(/\bBEGIN\b/i)));
				}
				return false;
			})
			.map((statement) => statement.text);

	/**
	 * Whether a statement names `table`, bare, quoted or in backticks, outside its comments and strings (card 3064): so
	 * that a file's keepsRows table is checked against its own statements only.
	 */
	const namesTable = (statement: string, table: string) =>
		new RegExp(`(^|[^\\w])${table}([^\\w]|$)`).test(statement.replace(/--[^\n]*|\/\*[\s\S]*?\*\/|'(?:[^']|'')*'/g, ' '));

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
				// none of the table it names, and updates it. The file may lose
				// rows of another table, declared as that (0084's settings, card
				// 3064).
				expect(losingRows(sql).filter((statement) => namesTable(statement, oneOff.table)), oneOff.file).toEqual([]);
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

	it('passes a DROP of a table of the temp schema, which holds no row of the database, and fails a DROP of a main table named like one (card 2995, FP5)', () => {
		expect(losingRows(statements('CREATE TEMP TABLE guard (n INTEGER);', 'DROP TABLE temp.guard;', 'DROP TABLE IF EXISTS temp.`guard`;'))).toEqual([]);
		expect(losingRows(statements('DROP TABLE main.temp_things;', 'DROP TABLE temporary_things;'))).toEqual(['DROP TABLE main.temp_things;', 'DROP TABLE temporary_things;']);
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
				// 0067 (card 2769) was declared for sessions too, until card 3064 took its delete out.
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
		expect(realFiles.filter((f) => f > FILE_0053)).toEqual([FILE_0054, FILE_0055, FILE_0056, FILE_0057, FILE_0058, FILE_0059, FILE_0060, FILE_0061, FILE_0062, FILE_0063, FILE_0064, FILE_0065, FILE_0066, FILE_0067, FILE_0068, FILE_0069, FILE_0070, FILE_0071, FILE_0072, FILE_0073, FILE_0074, FILE_0075, FILE_0076, FILE_0077, FILE_0078, FILE_0079, FILE_0080, FILE_0081, FILE_0082, FILE_0083, FILE_0084]);
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
			-- In plain, on purpose: a database from before 0068 (card 2849) holds its invites as mailed.
			INSERT INTO invite_tokens (token, user_id, expires_at, used) VALUES
				('waiting-from-an-old-backup', 2, '2099-01-01 00:00:00', 0),
				('expired-unused', 2, '2020-01-01 00:00:00', 0),
				('used-long-ago', 1, '2020-01-01 00:00:00', 1);
		`);
		const before = contentsOf(database);
		const state = stateOf(database);

		const report = runMigrations({ database, migrationsDir: REAL_MIGRATIONS });

		expect(report.applied).toEqual([FILE_0054, FILE_0055, FILE_0056, FILE_0057, FILE_0058, FILE_0059, FILE_0060, FILE_0061, FILE_0062, FILE_0063, FILE_0064, FILE_0065, FILE_0066, FILE_0067, FILE_0068, FILE_0069, FILE_0070, FILE_0071, FILE_0072, FILE_0073, FILE_0074, FILE_0075, FILE_0076, FILE_0077, FILE_0078, FILE_0079, FILE_0080, FILE_0081, FILE_0082, FILE_0083, FILE_0084]);
		expect(report.schemaDifferences).toEqual([]);
		// The used one, with 0068's token in place of the one it was mailed with (card 2849).
		expect(database.prepare('SELECT typeof(token) AS type, length(token) AS bytes FROM invite_tokens').all()).toEqual([{ type: 'blob', bytes: 32 }]);
		expect(contentsOf(database).invite_tokens).toEqual(afterRelease('invite_tokens', before.invite_tokens));
		const after = contentsOf(database);
		for (const table of Object.keys(before)) {
			// The migration record, and its id counter, gain the file.
			if (table === 'invite_tokens' || table === '__drizzle_migrations' || table === 'sqlite_sequence') continue;
			expect(after[table], table).toEqual(afterRelease(table, before[table]));
		}
		expect(indexesOf(database)).toContain('idx_activity_log_user_id_created_at');
		expect(indexesOf(database)).not.toContain('idx_activity_log_user_id');

		// The rehearsal notes the loss as the one-off declared for it.
		const found: Findings = { problems: [], notes: [] };
		compare(state, stateOf(database), report.applied, found);
		expect(found).toEqual({
			problems: [],
			notes: [
				`invite_tokens had 3 row(s) and has 1: every unused invite deleted by ${FILE_0054}, a one-off declared in tests/rehearsal/one-offs.ts`,
				// And 0066's, applied in the same run (card 2769).
				SETTINGS_NOTE_OF_0066(0),
				USERS_NOTE_OF_0066(2),
				// And 0068's and 0084's (cards 2849 and 3064).
				`invite_tokens: every used invite's token replaced in its 1 row(s) by ${FILE_0068}, a one-off declared in tests/rehearsal/one-offs.ts`,
				...NOTES_OF_0084({ invite_tokens: 1, users: 2 })
			]
		});

		// An invite issued after it survives the next start. In plain, on
		// purpose: the runner looks at no token, and the start-up sweep of
		// invites held in plain (card 2849) is not the runner's.
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

		// To 0069, so that 0055's links are seen before 0070 ends them (card 2870, E5).
		const report = runMigrations({ database, migrationsDir: filesTo(FILE_0069) });

		expect(report.applied).toEqual([FILE_0055, FILE_0056, FILE_0057, FILE_0058, FILE_0059, FILE_0060, FILE_0061, FILE_0062, FILE_0063, FILE_0064, FILE_0065, FILE_0066, FILE_0067, FILE_0068, FILE_0069]);
		// The model is 0074's: 0070's table, 0072's and 0073's columns, 0071's webhooks columns and 0074's table (card
		// 2922) are the differences a database at 0069 has.
		expect(report.schemaDifferences).toEqual([TABLE_OF_0079, TABLE_OF_0077, TABLE_OF_0076, TABLE_OF_0083, COLUMN_OF_0082, TABLE_OF_0082, TABLE_OF_0081, notInTheDatabase('request_links'), COLUMN_OF_0084, TABLE_OF_0074, ...MODEL_LINES_OF_0078, ...MODEL_LINES_OF_0072, TABLE_OF_0075, ...MODEL_LINES_OF_0071_AND_0073]);
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
			// The migration record, and its id counter, gain the file. Run to 0069, so with no setting of 0071 (card 2752),
			// no columns of 0072 on users (card 2671), and nothing of 0084 (card 3064): 0066's release moment and 0069's
			// deadline in settings, which held none, and 0066's mark on every account.
			if (['task_requests', '__drizzle_migrations', 'sqlite_sequence'].includes(table)) continue;
			const expected = afterRelease(table, before[table]);
			const noneOf0072 = (rows: unknown[]) =>
				(rows as string[]).map((json) => json.replace('"disabled_at":null,"disabled_by":null,', '').replace('"mfa_password_enrol":0', '"mfa_password_enrol":1'));
			expect(after[table], table).toEqual(table === 'settings' ? [DEADLINE_ROW, RELEASED_AT_ROW] : table === 'users' ? noneOf0072(expected) : expected);
		}

		// The rehearsal: every row kept, and the change noted as the one-off declared for it.
		const found: Findings = { problems: [], notes: [] };
		compare(state, stateOf(database), report.applied, found);
		expect(found).toEqual({
			problems: [],
			notes: [
				// 0066's, applied in the same run (card 2769), with it: run to 0069, so with no setting of 0071 (card 2752).
				'settings had 0 row(s) and has 2: a migration put the others there',
				`task_requests: every access_token replaced in its 3 row(s) by ${FILE_0055}, a one-off declared in tests/rehearsal/one-offs.ts`,
				USERS_NOTE_OF_0066(1)
			]
		});
	});

	it('is harmless on an empty table, as a new installation has', () => {
		const database = beforeIt(true);

		const report = runMigrations({ database, migrationsDir: filesTo(FILE_0069) });

		expect(report.applied).toEqual([FILE_0055, FILE_0056, FILE_0057, FILE_0058, FILE_0059, FILE_0060, FILE_0061, FILE_0062, FILE_0063, FILE_0064, FILE_0065, FILE_0066, FILE_0067, FILE_0068, FILE_0069]);
		expect(linksIn(database)).toEqual([]);
	});

	it('is recorded once, and the next start applies nothing and replaces no link given since', () => {
		const database = beforeIt();
		// To 0069 both times, so that 0055's links are not ended by 0070 (card 2870, E5).
		const dir = filesTo(FILE_0069);
		runMigrations({ database, migrationsDir: dir });
		const given = linksIn(database);
		expect(recordedIn(database).filter((name) => name === FILE_0055)).toHaveLength(1);

		const again = runMigrations({ database, migrationsDir: dir });

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

		expect(report.applied).toEqual([FILE_0056, FILE_0057, FILE_0058, FILE_0059, FILE_0060, FILE_0061, FILE_0062, FILE_0063, FILE_0064, FILE_0065, FILE_0066, FILE_0067, FILE_0068, FILE_0069, FILE_0070, FILE_0071, FILE_0072, FILE_0073, FILE_0074, FILE_0075, FILE_0076, FILE_0077, FILE_0078, FILE_0079, FILE_0080, FILE_0081, FILE_0082, FILE_0083, FILE_0084]);
		expect(report.schemaDifferences).toEqual([]);
		expect(database.prepare('SELECT id, url, secret, active, set_by FROM webhooks').all()).toEqual([
			{ id: 1, url: 'https://hooks.example.test/x', secret: 's3cret', active: 1, set_by: null }
		]);
		const after = contentsOf(database);
		for (const table of Object.keys(before)) {
			// The migration record, and its id counter, gain the file; each webhook gains the empty column.
			// The rest are as they were, but for what 0060, applied in the same run, adds.
			if (['webhooks', '__drizzle_migrations', 'sqlite_sequence'].includes(table)) continue;
			expect(lessOptionsGiven(table, after[table]), table).toEqual(after0060(table, before[table]));
		}
		// And the board its Options column, which the start gives it (card 2527).
		expect(optionsGiven(after.columns)).toEqual([[1, 'Options', 0, '#8b5cf6']]);
		expect(indexesOf(database)).toContain('idx_webhooks_set_by');
		expect(database.prepare('PRAGMA foreign_key_list(webhooks)').all()).toContainEqual(
			expect.objectContaining({ table: 'users', from: 'set_by', to: 'id', on_delete: 'SET NULL' })
		);
		// The rehearsal: every row kept, and the board noted as given its Options column (card 2527).
		const found: Findings = { problems: [], notes: [] };
		compare(state, stateOf(database), report.applied, found);
		expect(found).toEqual({
			problems: [],
			notes: [
				`columns had 0 row(s) and has 1: each delivery board that had none was given its Options column at the start (card 2527)`,
				// And 0066's and 0084's, applied in the same run (cards 2769 and 3064).
				SETTINGS_NOTE_OF_0066(0),
				USERS_NOTE_OF_0066(1),
				...NOTES_OF_0084({ users: 1, webhooks: 1 })
			]
		});

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

// ─── 0057: no card in a milestone of another board ───────────────────────────

describe('0057, which takes every card out of a milestone of another board once (card 2155)', () => {
	/** The file's one statement, as it is written there. */
	const STATEMENT = [
		'UPDATE `cards` SET `milestone_id` = NULL',
		'WHERE `milestone_id` IN (SELECT `id` FROM `milestones` WHERE `board_id` IS NOT NULL)',
		'  AND (SELECT `board_id` FROM `milestones` WHERE `id` = `cards`.`milestone_id`)',
		'      <> (SELECT `board_id` FROM `columns` WHERE `id` = `cards`.`column_id`);'
	].join('\n');

	/**
	 * Query 3 of the plan (section 3.1, as its review's R2 replaced it), which
	 * the owner runs on a copy of production before the deploy and
	 * docs/deployment.md prints: exactly the cards 0057 takes out, by its own
	 * WHERE, with left joins for the names.
	 */
	const QUERY_3 = `SELECT c.id AS card_id, c.title, c.archived_at, m.id AS milestone_id, m.name AS milestone,
  m.status AS milestone_status, m.board_id AS milestone_board_id, mb.name AS milestone_board,
  col.board_id AS card_board_id, cb.name AS card_board
FROM cards c
JOIN milestones m ON m.id = c.milestone_id
LEFT JOIN columns col ON col.id = c.column_id
LEFT JOIN boards mb ON mb.id = m.board_id
LEFT JOIN boards cb ON cb.id = col.board_id
WHERE c.milestone_id IN (SELECT id FROM milestones WHERE board_id IS NOT NULL)
  AND (SELECT board_id FROM milestones WHERE id = c.milestone_id)
      <> (SELECT board_id FROM columns WHERE id = c.column_id)
ORDER BY m.id, c.id;`;

	const STAMP = '2026-10-01 09:00:00';

	/**
	 * A database with every migration before 0057 applied and, unless `empty`,
	 * boards A (1) and B (2) and a board 3 deleted with foreign keys off, as a
	 * restore runs, so that its milestone is left. Milestones: 1 of A, 2 across
	 * boards, 3 of the deleted board. Cards:
	 *
	 *   1  on B, in A's milestone        taken out
	 *   2  on A, in A's milestone        kept
	 *   3  on B, archived, in A's        taken out
	 *   4  on B, in the goal across      kept
	 *   5  on A, in the deleted board's  taken out
	 *   6  on A, in a milestone gone     kept: there is no goal to read
	 *   7  on A, in none                 kept
	 */
	function beforeIt(empty = false): Database.Database {
		const database = memoryDb();
		const before = Object.fromEntries(
			realFiles.filter((f) => f < FILE_0057).map((f) => [f, readFileSync(join(REAL_MIGRATIONS, f), 'utf-8')])
		);
		applyFilesOnly(database, migrationsDir(before));
		if (empty) return database;
		database.exec(`
			INSERT INTO users (id, username, email, password_hash) VALUES (1, 'ann', 'ann@example.test', 'x');
			INSERT INTO boards (id, name, created_by) VALUES (1, 'A', 1), (2, 'B', 1), (3, 'Gone', 1);
			INSERT INTO columns (id, board_id, title) VALUES (1, 1, 'To Do'), (2, 2, 'To Do');
			INSERT INTO milestones (id, name, board_id, status) VALUES (1, 'Goal of A', 1, 'open'), (2, 'Across', NULL, 'open'), (3, 'Goal of Gone', 3, 'closed');
			INSERT INTO cards (id, column_id, title, milestone_id, archived_at, created_at, updated_at) VALUES
				(1, 2, 'Moved to B', 1, NULL, '${STAMP}', '${STAMP}'),
				(2, 1, 'Stayed on A', 1, NULL, '${STAMP}', '${STAMP}'),
				(3, 2, 'Archived on B', 1, '${STAMP}', '${STAMP}', '${STAMP}'),
				(4, 2, 'Across on B', 2, NULL, '${STAMP}', '${STAMP}'),
				(5, 1, 'Goal board gone', 3, NULL, '${STAMP}', '${STAMP}'),
				(6, 1, 'Goal gone', 99, NULL, '${STAMP}', '${STAMP}'),
				(7, 1, 'In none', NULL, NULL, '${STAMP}', '${STAMP}');
			PRAGMA foreign_keys = OFF;
			DELETE FROM boards WHERE id = 3;
			PRAGMA foreign_keys = ON;
		`);
		return database;
	}

	const cardsIn = (database: Database.Database) =>
		database.prepare('SELECT * FROM cards ORDER BY id').all() as Record<string, unknown>[];

	it('is one UPDATE of cards, after a header comment', () => {
		const sql = readFileSync(join(REAL_MIGRATIONS, FILE_0057), 'utf-8').replace(/\r\n/g, '\n');
		expect(sqlStatements(sql).map((s) => s.text)).toEqual([STATEMENT]);
		// What it changes, why, that it runs once and what people see (card 2106, decision 3).
		for (const said of ['A one-off change to data', 'What people see:', 'Harmless where it finds nothing', 'Runs once.']) {
			expect(sql, said).toContain(said);
		}
	});

	it('takes out the cards on a board other than their milestone’s, and changes no other cell', () => {
		const database = beforeIt();
		const before = contentsOf(database);
		const cardsBefore = cardsIn(database);
		const state = stateOf(database);
		// Query 3, run before it, lists exactly the cards it changes.
		const listed = (database.prepare(QUERY_3).all() as { card_id: number; milestone_board: string | null }[]);
		expect(listed.map((row) => row.card_id)).toEqual([1, 3, 5]);
		expect(listed.find((row) => row.card_id === 5)!.milestone_board).toBeNull();
		// The backfill's copy of the statement changes the same cards on a copy as it was.
		const copy = beforeIt();
		expect(copy.prepare(CARDS_LEAVE_OTHER_BOARDS_MILESTONES).run().changes).toBe(listed.length);
		expect(copy.prepare('SELECT id FROM cards WHERE milestone_id IS NULL AND id IN (1, 3, 5) ORDER BY id').all()).toEqual(
			listed.map((row) => ({ id: row.card_id }))
		);

		const report = runMigrations({ database, migrationsDir: REAL_MIGRATIONS });

		expect(report.applied).toEqual([FILE_0057, FILE_0058, FILE_0059, FILE_0060, FILE_0061, FILE_0062, FILE_0063, FILE_0064, FILE_0065, FILE_0066, FILE_0067, FILE_0068, FILE_0069, FILE_0070, FILE_0071, FILE_0072, FILE_0073, FILE_0074, FILE_0075, FILE_0076, FILE_0077, FILE_0078, FILE_0079, FILE_0080, FILE_0081, FILE_0082, FILE_0083, FILE_0084]);
		expect(report.schemaDifferences).toEqual([]);
		const cardsAfter = cardsIn(database);
		// 0060, applied in the same run, commits all seven, each on a column of a
		// board that is there, when it was created (milestone 22). Less its four
		// columns, each card is as 0057 leaves it.
		expect(cardsAfter.map((row) => [row.id, row.committed_at, row.committed_by, row.discarded_at, row.discarded_by])).toEqual(
			cardsBefore.map((row) => [row.id, STAMP, null, null, null])
		);
		const OF_0060 = ['committed_at', 'committed_by', 'discarded_at', 'discarded_by'];
		const without0060 = (row: Record<string, unknown>) => Object.fromEntries(Object.entries(row).filter(([key]) => !OF_0060.includes(key)));
		const changed = cardsAfter
			.filter((row, i) => JSON.stringify(without0060(row)) !== JSON.stringify(cardsBefore[i]))
			.map((row) => row.id);
		expect(changed).toEqual(listed.map((row) => row.card_id));
		// Each of them differs in its milestone alone: updated_at is as it was.
		for (const [i, row] of cardsAfter.entries()) {
			expect(without0060(row), `card ${row.id}`).toEqual(
				changed.includes(row.id as number) ? { ...cardsBefore[i], milestone_id: null } : cardsBefore[i]
			);
		}
		expect(cardsAfter.map((row) => row.updated_at)).toEqual(Array(7).fill(STAMP));
		const after = contentsOf(database);
		for (const table of Object.keys(before)) {
			// The migration record, and its id counter, gain the file; boards and
			// columns gain 0060's columns.
			if (['cards', '__drizzle_migrations', 'sqlite_sequence'].includes(table)) continue;
			expect(lessOptionsGiven(table, after[table]), table).toEqual(after0060(table, before[table]));
		}
		// And each board its Options column, which the start gives it (card 2527).
		expect(optionsGiven(after.columns)).toEqual([
			[1, 'Options', -1, '#8b5cf6'],
			[2, 'Options', -1, '#8b5cf6']
		]);

		// The same statement again, as the backfill repeats it at every start
		// (card 2179), changes nothing, and neither does the next start.
		expect(database.prepare(CARDS_LEAVE_OTHER_BOARDS_MILESTONES).run().changes).toBe(0);
		expect(runMigrations({ database, migrationsDir: REAL_MIGRATIONS }).applied).toEqual([]);
		expect(cardsIn(database)).toEqual(cardsAfter);

		// The rehearsal: every row kept, and the change noted as the one-off declared for it.
		const found: Findings = { problems: [], notes: [] };
		compare(state, stateOf(database), report.applied, found);
		expect(found).toEqual({
			problems: [],
			notes: [
				// Each board given its Options column at the start (card 2527).
				`columns had 2 row(s) and has 4: each delivery board that had none was given its Options column at the start (card 2527)`,
				// And 0066's, applied in the same run (card 2769).
				SETTINGS_NOTE_OF_0066(0),
				`cards: milestone_id cleared where it named a milestone of another board in its 7 row(s) by ${FILE_0057}, a one-off declared in tests/rehearsal/one-offs.ts`,
				// And 0060's, applied in the same run.
				`cards: committed_at and committed_by filled from created_at and created_by for every card not upstream in its 7 row(s) by ${FILE_0060}, a one-off declared in tests/rehearsal/one-offs.ts`,
				USERS_NOTE_OF_0066(1),
				// And 0084's (card 3064).
				...NOTES_OF_0084({ users: 1 })
			]
		});
	});

	it('is harmless on an empty table, as a new installation has', () => {
		const database = beforeIt(true);

		const report = runMigrations({ database, migrationsDir: REAL_MIGRATIONS });

		expect(report.applied).toEqual([FILE_0057, FILE_0058, FILE_0059, FILE_0060, FILE_0061, FILE_0062, FILE_0063, FILE_0064, FILE_0065, FILE_0066, FILE_0067, FILE_0068, FILE_0069, FILE_0070, FILE_0071, FILE_0072, FILE_0073, FILE_0074, FILE_0075, FILE_0076, FILE_0077, FILE_0078, FILE_0079, FILE_0080, FILE_0081, FILE_0082, FILE_0083, FILE_0084]);
		expect(cardsIn(database)).toEqual([]);
	});

	it('is declared to the rehearsal as a one-off that keeps every row of cards', () => {
		expect(ONE_OFFS).toContainEqual({
			file: FILE_0057,
			table: 'cards',
			change: 'milestone_id cleared where it named a milestone of another board',
			keepsRows: true
		});
	});
});

// ─── 0058: the time zone a report schedule's time is read in ─────────────────

describe("0058, which adds the time zone a report schedule's time is read in (card 2159)", () => {
	/** A database with every migration before 0058 applied, and a schedule made before it. */
	function beforeIt(): Database.Database {
		const database = memoryDb();
		const before = Object.fromEntries(
			realFiles.filter((f) => f < FILE_0058).map((f) => [f, readFileSync(join(REAL_MIGRATIONS, f), 'utf-8')])
		);
		applyFilesOnly(database, migrationsDir(before));
		database.exec(`
			INSERT INTO users (id, username, email, password_hash) VALUES (1, 'ann', 'ann@example.test', 'x');
			INSERT INTO boards (id, name, created_by) VALUES (1, 'A', 1);
			INSERT INTO report_schedules (id, user_id, name, scope, scope_id, frequency, day_of_week, time_of_day, recipients,
				last_run_at, next_run_at, created_at, updated_at)
			VALUES (1, 1, 'Weekly', 'board', 1, 'weekly', 1, '09:00', 'a@example.test',
				'2026-10-12 09:00:00', '2026-10-19 09:00:00', '2026-01-01 00:00:00', '2026-10-12 09:00:00');
		`);
		return database;
	}

	it('is the column, with its default, after a header comment', () => {
		const sql = readFileSync(join(REAL_MIGRATIONS, FILE_0058), 'utf-8');
		expect(sqlStatements(sql).map((s) => s.text)).toEqual([
			"ALTER TABLE `report_schedules` ADD COLUMN `time_zone` text DEFAULT 'UTC' NOT NULL;"
		]);
		for (const said of ['Keeps every row', 'Runs once.']) expect(sql, said).toContain(said);
	});

	it('gives every schedule UTC, changes nothing else, and does nothing at the next start', () => {
		const database = beforeIt();
		const before = contentsOf(database);
		const scheduleBefore = database.prepare('SELECT * FROM report_schedules').get() as Record<string, unknown>;
		const state = stateOf(database);

		const report = runMigrations({ database, migrationsDir: REAL_MIGRATIONS });

		expect(report.applied).toEqual([FILE_0058, FILE_0059, FILE_0060, FILE_0061, FILE_0062, FILE_0063, FILE_0064, FILE_0065, FILE_0066, FILE_0067, FILE_0068, FILE_0069, FILE_0070, FILE_0071, FILE_0072, FILE_0073, FILE_0074, FILE_0075, FILE_0076, FILE_0077, FILE_0078, FILE_0079, FILE_0080, FILE_0081, FILE_0082, FILE_0083, FILE_0084]);
		expect(report.schemaDifferences).toEqual([]);
		expect(database.prepare('SELECT * FROM report_schedules').get()).toEqual({ ...scheduleBefore, time_zone: 'UTC' });
		const after = contentsOf(database);
		for (const table of Object.keys(before)) {
			// The migration record, and its id counter, gain the file; each schedule gains the column.
			// The rest are as they were, but for what 0060, applied in the same run, adds.
			if (['report_schedules', '__drizzle_migrations', 'sqlite_sequence'].includes(table)) continue;
			expect(lessOptionsGiven(table, after[table]), table).toEqual(after0060(table, before[table]));
		}
		// And the board its Options column, which the start gives it (card 2527).
		expect(optionsGiven(after.columns)).toEqual([[1, 'Options', 0, '#8b5cf6']]);
		// The rehearsal: every row kept, and the board noted as given its Options column (card 2527).
		const found: Findings = { problems: [], notes: [] };
		compare(state, stateOf(database), report.applied, found);
		expect(found).toEqual({
			problems: [],
			notes: [
				`columns had 0 row(s) and has 1: each delivery board that had none was given its Options column at the start (card 2527)`,
				// And 0066's and 0084's, applied in the same run (cards 2769 and 3064).
				SETTINGS_NOTE_OF_0066(0),
				USERS_NOTE_OF_0066(1),
				...NOTES_OF_0084({ users: 1 })
			]
		});

		const again = runMigrations({ database, migrationsDir: REAL_MIGRATIONS });
		expect(again.applied).toEqual([]);
		expect(contentsOf(database)).toEqual(after);
	});

	it('declares nothing to the rehearsal: it keeps every row and changes no value a row held', () => {
		expect(ONE_OFFS.filter((oneOff) => oneOff.file === FILE_0058)).toEqual([]);
	});
});

// ─── 0059: who last changed the mail settings, the App URL and each destination ──

describe('0059, which adds who last changed the mail settings, the App URL and each backup destination (card 2397)', () => {
	/** The settings a server had before 0059: the mail set up, an App URL, and one destination. */
	const SETTINGS_BEFORE = `
		INSERT INTO settings (key, value) VALUES
			('smtp_host', 'smtp.example.test'),
			('smtp_from_address', 'board@example.test'),
			('app_url', 'https://board.example.test'),
			('backup_config', '{"schedule":"daily","scheduleTime":"02:00","scheduleDay":0,"retention":7,"destinations":[{"type":"s3","name":"Bucket","region":"eu-west-2","bucket":"b","accessKeyId":"AKIA","secretAccessKey":"s","prefix":"dumpfire/"}],"notifyOnFailure":false,"notifyEmail":""}');
	`;

	/** A database with every migration before 0059 applied, a superadmin and an administrator, and the settings above. */
	function beforeIt(): Database.Database {
		const database = memoryDb();
		const before = Object.fromEntries(
			realFiles.filter((f) => f < FILE_0059).map((f) => [f, readFileSync(join(REAL_MIGRATIONS, f), 'utf-8')])
		);
		applyFilesOnly(database, migrationsDir(before));
		database.exec(`
			INSERT INTO users (id, username, email, password_hash, role) VALUES
				(1, 'chief', 'chief@example.test', 'x', 'superadmin'),
				(2, 'ann', 'ann@example.test', 'x', 'admin');
			${SETTINGS_BEFORE}
		`);
		return database;
	}

	it('is the table with its foreign key, then its index, after a header comment', () => {
		const sql = readFileSync(join(REAL_MIGRATIONS, FILE_0059), 'utf-8');
		expect(sqlStatements(sql).map((s) => s.text.replace(/\r\n/g, '\n'))).toEqual([
			'CREATE TABLE `setting_setters` (\n' +
				'\t`setting` text NOT NULL,\n' +
				'\t`place` text NOT NULL,\n' +
				'\t`user_id` integer,\n' +
				'\tPRIMARY KEY(`setting`, `place`),\n' +
				'\tFOREIGN KEY (`user_id`) REFERENCES `users`(`id`) ON UPDATE no action ON DELETE cascade\n' +
				');',
			'CREATE INDEX IF NOT EXISTS `idx_setting_setters_user_id` ON `setting_setters` (`user_id`);'
		]);
		for (const said of ['Changes no row', 'Runs once.']) expect(sql, said).toContain(said);
	});

	it('leaves every setting unattributed and changes no row; a setter row goes when its account is deleted; nothing at the next start', () => {
		const database = beforeIt();
		const before = contentsOf(database);
		const state = stateOf(database);

		const report = runMigrations({ database, migrationsDir: REAL_MIGRATIONS });

		expect(report.applied).toEqual([FILE_0059, FILE_0060, FILE_0061, FILE_0062, FILE_0063, FILE_0064, FILE_0065, FILE_0066, FILE_0067, FILE_0068, FILE_0069, FILE_0070, FILE_0071, FILE_0072, FILE_0073, FILE_0074, FILE_0075, FILE_0076, FILE_0077, FILE_0078, FILE_0079, FILE_0080, FILE_0081, FILE_0082, FILE_0083, FILE_0084]);
		expect(report.schemaDifferences).toEqual([]);
		expect(database.prepare('SELECT * FROM setting_setters').all()).toEqual([]);
		const after = contentsOf(database);
		for (const table of Object.keys(before)) {
			// The migration record, and its id counter, gain the file.
			if (['__drizzle_migrations', 'sqlite_sequence'].includes(table)) continue;
			expect(after[table], table).toEqual(afterRelease(table, before[table]));
		}
		expect(indexesOf(database)).toContain('idx_setting_setters_user_id');
		expect(database.prepare('PRAGMA foreign_key_list(setting_setters)').all()).toContainEqual(
			expect.objectContaining({ table: 'users', from: 'user_id', to: 'id', on_delete: 'CASCADE' })
		);
		// The rehearsal: every row kept, nothing to note but 0066's, applied in the same run (card 2769).
		const found: Findings = { problems: [], notes: [] };
		compare(state, stateOf(database), report.applied, found);
		expect(found).toEqual({ problems: [], notes: [SETTINGS_NOTE_OF_0066(4), USERS_NOTE_OF_0066(2), ...NOTES_OF_0084({ users: 2 })] });

		expect(foreignKeysOn(database)).toBe(true);
		// Two accounts recorded for two places of one setting: the key is the setting and the place.
		// And a place recorded as nobody's (the third review): `user_id` NULL, which no delete takes.
		database.exec(
			"INSERT INTO setting_setters (setting, place, user_id) VALUES ('mail', 'p0', NULL), ('mail', 'p1', 2), ('mail', 'p2', 1), ('backup_destination:Bucket', 'p1', 1)"
		);
		expect(() => database.exec("INSERT INTO setting_setters (setting, place, user_id) VALUES ('mail', 'p1', 1)")).toThrow(/UNIQUE constraint failed/);
		database.prepare('DELETE FROM users WHERE id = 2').run();
		expect(database.prepare('SELECT setting, place, user_id FROM setting_setters ORDER BY setting, place').all()).toEqual([
			{ setting: 'backup_destination:Bucket', place: 'p1', user_id: 1 },
			{ setting: 'mail', place: 'p0', user_id: null },
			{ setting: 'mail', place: 'p2', user_id: 1 }
		]);

		const again = runMigrations({ database, migrationsDir: REAL_MIGRATIONS });
		expect(again.applied).toEqual([]);
	});

	it('declares nothing to the rehearsal: it changes no row', () => {
		expect(ONE_OFFS.filter((oneOff) => oneOff.file === FILE_0059)).toEqual([]);
	});

	it('restores a backup made before 0059: every setting it holds comes back but the From, unattributed, and this server’s setter rows are cleared', () => {
		const live = memoryDb();
		runMigrations({ database: live, migrationsDir: REAL_MIGRATIONS });
		live.exec(`
			INSERT INTO users (id, username, email, password_hash, role) VALUES (1, 'chief', 'chief@example.test', 'x', 'superadmin'), (9, 'gone', 'gone@example.test', 'x', 'admin');
			INSERT INTO settings (key, value) VALUES ('smtp_host', 'smtp.live.example.test');
			INSERT INTO setting_setters (setting, place, user_id) VALUES ('mail', 'p', 9), ('app_url', 'p', 9);
		`);
		const backup = beforeIt();
		expect(backup.prepare("SELECT name FROM sqlite_master WHERE name = 'setting_setters'").get()).toBeUndefined();

		const result = restoreFromBackup(live, backup);

		expect(result.errors).toEqual([]);
		// Card 3029: a backup made before 0059 has no seal, so its From Address is only the file's word, and this server,
		// which had none, is left with none.
		expect(live.prepare("SELECT key, value FROM settings WHERE key IN ('smtp_host', 'smtp_from_address', 'app_url') ORDER BY key").all()).toEqual([
			{ key: 'app_url', value: 'https://board.example.test' },
			{ key: 'smtp_host', value: 'smtp.example.test' }
		]);
		expect(JSON.parse((live.prepare("SELECT value FROM settings WHERE key = 'backup_config'").get() as { value: string }).value).destinations.map((d: { name: string }) => d.name)).toEqual(['Bucket']);
		expect(live.prepare('SELECT * FROM setting_setters').all()).toEqual([]);
		expect(live.pragma('foreign_key_check')).toEqual([]);
	});

	it('restores a backup made after 0059 with its setter rows, beside the accounts they name', () => {
		const live = memoryDb();
		runMigrations({ database: live, migrationsDir: REAL_MIGRATIONS });
		live.exec("INSERT INTO users (id, username, email, password_hash, role) VALUES (1, 'chief', 'chief@example.test', 'x', 'superadmin')");
		const backup = beforeIt();
		runMigrations({ database: backup, migrationsDir: REAL_MIGRATIONS });
		backup.exec("INSERT INTO setting_setters (setting, place, user_id) VALUES ('mail', 'p', 2), ('backup_destination:Bucket', 'p', 2)");

		const result = restoreFromBackup(live, backup);

		expect(result.errors).toEqual([]);
		expect(live.prepare('SELECT setting, place, user_id FROM setting_setters ORDER BY setting').all()).toEqual([
			{ setting: 'backup_destination:Bucket', place: 'p', user_id: 2 },
			{ setting: 'mail', place: 'p', user_id: 2 }
		]);
		expect(live.prepare('SELECT username FROM users WHERE id = 2').get()).toEqual({ username: 'ann' });
	});
});

// ─── 0060: upstream, the commitment point and discards ───────────────────────

describe('0060, which adds the Options role, the ideas kind, and each card’s commitment and discard (milestone 22)', () => {
	const STAMP = '2026-10-01 09:00:00';

	/**
	 * A database with every migration before 0060 applied and, unless `empty`:
	 * Ann (1) and Bob (2); boards A (1) and B (2), and a board 3 deleted with
	 * foreign keys off, as a restore runs, so that its column is left. Cards:
	 *
	 *   1  on A's To Do, raised by Ann          committed by Ann
	 *   2  on A's Complete, archived, by nobody committed, by nobody recorded
	 *   3  on B's Doing, raised by Bob          committed by Bob
	 *   4  on a column that is not there        left alone
	 *   5  on the deleted board's column        left alone
	 */
	function beforeIt(empty = false): Database.Database {
		const database = memoryDb();
		const before = Object.fromEntries(
			realFiles.filter((f) => f < FILE_0060).map((f) => [f, readFileSync(join(REAL_MIGRATIONS, f), 'utf-8')])
		);
		applyFilesOnly(database, migrationsDir(before));
		if (empty) return database;
		database.exec(`
			INSERT INTO users (id, username, email, password_hash) VALUES (1, 'ann', 'ann@example.test', 'x'), (2, 'bob', 'bob@example.test', 'x');
			INSERT INTO boards (id, name, created_by, created_at, updated_at) VALUES
				(1, 'A', 1, '${STAMP}', '${STAMP}'), (2, 'B', 2, '${STAMP}', '${STAMP}'), (3, 'Gone', 1, '${STAMP}', '${STAMP}');
			INSERT INTO columns (id, board_id, title) VALUES (1, 1, 'To Do'), (2, 1, 'Complete'), (3, 2, 'Doing'), (5, 3, 'To Do');
			PRAGMA foreign_keys = OFF;
			INSERT INTO cards (id, column_id, title, created_by, archived_at, completed_at, first_completed_at, created_at, updated_at) VALUES
				(1, 1, 'Raised by Ann', 1, NULL, NULL, NULL, '2026-09-01 08:00:00', '${STAMP}'),
				(2, 2, 'Done and archived', NULL, '${STAMP}', '${STAMP}', '${STAMP}', '2026-09-02 08:00:00', '${STAMP}'),
				(3, 3, 'Raised by Bob', 2, NULL, NULL, NULL, '2026-09-03 08:00:00', '${STAMP}'),
				(4, 99, 'On no column', 1, NULL, NULL, NULL, '2026-09-04 08:00:00', '${STAMP}'),
				(5, 5, 'On a board gone', 1, NULL, NULL, NULL, '2026-09-05 08:00:00', '${STAMP}');
			DELETE FROM boards WHERE id = 3;
			PRAGMA foreign_keys = ON;
		`);
		return database;
	}

	const commitmentsIn = (database: Database.Database) =>
		database
			.prepare('SELECT id, committed_at, committed_by, discarded_at, discarded_by, updated_at FROM cards ORDER BY id')
			.all();

	it('adds the five columns and two indexes, then commits the cards in one UPDATE, the backfill’s own text', () => {
		const sql = readFileSync(join(REAL_MIGRATIONS, FILE_0060), 'utf-8');
		const statements = sqlStatements(sql).map((s) => s.text.replace(/\r\n/g, '\n'));
		expect(statements.slice(0, -1)).toEqual([
			'ALTER TABLE `columns` ADD COLUMN `role` text;',
			"ALTER TABLE `boards` ADD COLUMN `kind` text DEFAULT 'delivery' NOT NULL;",
			'ALTER TABLE `cards` ADD COLUMN `committed_at` text;',
			'ALTER TABLE `cards` ADD COLUMN `committed_by` integer REFERENCES `users`(`id`) ON UPDATE no action ON DELETE set null;',
			'ALTER TABLE `cards` ADD COLUMN `discarded_at` text;',
			'ALTER TABLE `cards` ADD COLUMN `discarded_by` integer REFERENCES `users`(`id`) ON UPDATE no action ON DELETE set null;',
			'CREATE INDEX IF NOT EXISTS `idx_cards_committed_by` ON `cards` (`committed_by`);',
			'CREATE INDEX IF NOT EXISTS `idx_cards_discarded_by` ON `cards` (`discarded_by`);'
		]);
		// The UPDATE alone is the backfill's: the runner repeats it at every start
		// and after every restore, so the two are held to the same text.
		const words = (text: string) => text.replace(/\s+/g, ' ').trim();
		const updates = statements.filter((text) => text.startsWith('UPDATE'));
		expect(updates.map(words)).toEqual([words(COMMITTED_BEFORE_UPSTREAM)]);
		// What it changes, why, what people see, that it runs once (card 2106, decision 3), and a restore.
		for (const said of ['What people see:', 'Runs once.', 'duplicate column', 'A backup made before this file']) {
			expect(sql, said).toContain(said);
		}
	});

	it('commits every card on a column of a board that is there, archived ones included, from when and by whom it was created, and nothing else', () => {
		const database = beforeIt();
		const before = contentsOf(database);
		const state = stateOf(database);

		const report = runMigrations({ database, migrationsDir: REAL_MIGRATIONS });

		expect(report.applied).toEqual([FILE_0060, FILE_0061, FILE_0062, FILE_0063, FILE_0064, FILE_0065, FILE_0066, FILE_0067, FILE_0068, FILE_0069, FILE_0070, FILE_0071, FILE_0072, FILE_0073, FILE_0074, FILE_0075, FILE_0076, FILE_0077, FILE_0078, FILE_0079, FILE_0080, FILE_0081, FILE_0082, FILE_0083, FILE_0084]);
		expect(report.schemaDifferences).toEqual([]);
		// The file committed them, so the backfill after it found none.
		expect(report.backfilled.committedFilled).toBe(0);
		expect(commitmentsIn(database)).toEqual([
			{ id: 1, committed_at: '2026-09-01 08:00:00', committed_by: 1, discarded_at: null, discarded_by: null, updated_at: STAMP },
			{ id: 2, committed_at: '2026-09-02 08:00:00', committed_by: null, discarded_at: null, discarded_by: null, updated_at: STAMP },
			{ id: 3, committed_at: '2026-09-03 08:00:00', committed_by: 2, discarded_at: null, discarded_by: null, updated_at: STAMP },
			{ id: 4, committed_at: null, committed_by: null, discarded_at: null, discarded_by: null, updated_at: STAMP },
			{ id: 5, committed_at: null, committed_by: null, discarded_at: null, discarded_by: null, updated_at: STAMP }
		]);
		expect(database.prepare('SELECT id, kind FROM boards ORDER BY id').all()).toEqual([
			{ id: 1, kind: 'delivery' },
			{ id: 2, kind: 'delivery' }
		]);
		// The file gives no column a role: the backfill after it gives boards A
		// and B their Options columns (card 2527), and the deleted board's column
		// stays as it is.
		expect(database.prepare('SELECT board_id AS boardId FROM columns WHERE role IS NOT NULL ORDER BY board_id').all()).toEqual([
			{ boardId: 1 },
			{ boardId: 2 }
		]);
		// Every other table, and every other cell of these three, as it was.
		const after = contentsOf(database);
		for (const table of Object.keys(before)) {
			if (['__drizzle_migrations', 'sqlite_sequence'].includes(table)) continue;
			expect(lessOptionsGiven(table, after[table]), table).toEqual(after0060(table, before[table], [4, 5]));
		}
		expect(optionsGiven(after.columns)).toEqual([
			[1, 'Options', -1, '#8b5cf6'],
			[2, 'Options', -1, '#8b5cf6']
		]);
		// The rehearsal: every row kept, and the change noted as the one-off declared for it.
		const found: Findings = { problems: [], notes: [] };
		compare(state, stateOf(database), report.applied, found);
		expect(found).toEqual({
			problems: [],
			notes: [
				// Boards A and B given their Options columns at the start (card 2527).
				`columns had 4 row(s) and has 6: each delivery board that had none was given its Options column at the start (card 2527)`,
				// And 0066's, applied in the same run (card 2769).
				SETTINGS_NOTE_OF_0066(0),
				`cards: committed_at and committed_by filled from created_at and created_by for every card not upstream in its 5 row(s) by ${FILE_0060}, a one-off declared in tests/rehearsal/one-offs.ts`,
				USERS_NOTE_OF_0066(2),
				// And 0084's (card 3064).
				...NOTES_OF_0084({ users: 2 })
			]
		});

		// Nothing at the next start.
		const again = runMigrations({ database, migrationsDir: REAL_MIGRATIONS });
		expect(again.applied).toEqual([]);
		expect(again.backfilled).toMatchObject({ committedFilled: 0, upstreamCleared: 0, discardedCleared: 0 });
		expect(contentsOf(database)).toEqual(after);
	});

	it('empties who committed or discarded a card when that account is deleted, and indexes both', () => {
		const database = beforeIt();
		runMigrations({ database, migrationsDir: REAL_MIGRATIONS });
		for (const from of ['committed_by', 'discarded_by']) {
			expect(database.prepare('PRAGMA foreign_key_list(cards)').all(), from).toContainEqual(
				expect.objectContaining({ table: 'users', from, to: 'id', on_delete: 'SET NULL' })
			);
		}
		expect(indexesOf(database)).toEqual(expect.arrayContaining(['idx_cards_committed_by', 'idx_cards_discarded_by']));
		expect(unindexedForeignKeys(database)).toEqual([]);

		database.prepare("UPDATE cards SET archived_at = ?, discarded_at = ?, discarded_by = 2 WHERE id = 1").run(STAMP, STAMP);
		database.prepare('DELETE FROM users WHERE id = 2').run();

		expect(database.prepare('SELECT id, committed_by, discarded_by FROM cards WHERE id IN (1, 3) ORDER BY id').all()).toEqual([
			{ id: 1, committed_by: 1, discarded_by: null },
			{ id: 3, committed_by: null, discarded_by: null }
		]);
		// The work is kept: the cards are there, and still committed.
		expect(database.prepare('SELECT committed_at FROM cards WHERE id = 3').get()).toEqual({ committed_at: '2026-09-03 08:00:00' });
	});

	it('does not survive a second run: "duplicate column" is not tolerated in it', () => {
		const database = beforeIt(true);
		runMigrations({ database, migrationsDir: REAL_MIGRATIONS });
		expect(TOLERANT_FILES).not.toContain(FILE_0060);
		const files = Object.fromEntries(realFiles.map((f) => [f, readFileSync(join(REAL_MIGRATIONS, f), 'utf-8')]));
		const again = '0061_0060_again.sql';

		const { error } = halted({ database, migrationsDir: migrationsDir({ ...files, [again]: files[FILE_0060] }) });

		expect(error.message).toContain(again);
		expect(error.message).toContain('duplicate column name: role');
		expect(recordedIn(database)).not.toContain(again);
	});

	it('is harmless on an empty database, as a new installation has', () => {
		const database = beforeIt(true);

		const report = runMigrations({ database, migrationsDir: REAL_MIGRATIONS });

		expect(report.applied).toEqual([FILE_0060, FILE_0061, FILE_0062, FILE_0063, FILE_0064, FILE_0065, FILE_0066, FILE_0067, FILE_0068, FILE_0069, FILE_0070, FILE_0071, FILE_0072, FILE_0073, FILE_0074, FILE_0075, FILE_0076, FILE_0077, FILE_0078, FILE_0079, FILE_0080, FILE_0081, FILE_0082, FILE_0083, FILE_0084]);
		expect(report.schemaDifferences).toEqual([]);
		expect(database.prepare('SELECT COUNT(*) AS n FROM cards').get()).toEqual({ n: 0 });
	});

	it('is declared to the rehearsal as a one-off that keeps every row of cards', () => {
		expect(ONE_OFFS).toContainEqual({
			file: FILE_0060,
			table: 'cards',
			change: 'committed_at and committed_by filled from created_at and created_by for every card not upstream',
			keepsRows: true
		});
	});
});

// ─── 0061: decision records, and a Product Owner on each board ───────────────

describe('0061, which adds the decision records model and a Product Owner on each board (card 2673)', () => {
	const STAMP = '2026-11-03 09:00:00';

	/**
	 * The 35 indexes 0061 creates, by name: the 34 the plan names (section 4),
	 * and idx_decision_participants_user_id, from its review (2026-11-03).
	 */
	const INDEXES_OF_0061 = [
		'people_groups_name_unique',
		'people_email_unique',
		'idx_people_user_id',
		'idx_people_created_by',
		'idx_people_group_members_person_id',
		'idx_boards_product_owner_user_id',
		'idx_decisions_board_id',
		'idx_decisions_author_user_id',
		'idx_decisions_decider_user_id',
		'idx_decisions_supersedes_id',
		'idx_decisions_results_released_by',
		'idx_decision_options_decision_id',
		'idx_decision_versions_decision_id_number',
		'idx_decision_versions_published_by',
		'idx_decision_participants_decision_id',
		'idx_decision_participants_person_id',
		'idx_decision_participants_included_by',
		'idx_decision_participants_removed_by',
		'idx_decision_participants_user_id',
		'idx_decision_participants_link_token_hash',
		'idx_decision_responses_decision_id',
		'idx_decision_responses_participant_id',
		'idx_decision_responses_option_id',
		'idx_decision_responses_replaces_id',
		'idx_decision_questions_decision_id',
		'idx_decision_questions_participant_id',
		'idx_decision_questions_answered_by',
		'idx_decision_questions_answer_reviewed_by',
		'idx_decision_rulings_option_id',
		'idx_decision_rulings_ruled_by',
		'idx_decision_events_decision_id_created_at',
		'idx_decision_events_participant_id',
		'idx_decision_events_actor_user_id',
		'idx_decision_card_links_card_id',
		'idx_decision_card_links_created_by'
	];

	/**
	 * A database at 0060, as a start of the build before this one leaves it:
	 * every migration before 0061 applied, Ann (1, the superadmin) and Bob (2),
	 * boards A (1) and B (2) each with a To Do column, a card on A, and the
	 * backfills run, so that a start has nothing of its own to do.
	 */
	function beforeIt(): Database.Database {
		const database = memoryDb();
		const before = Object.fromEntries(
			realFiles.filter((f) => f < FILE_0061).map((f) => [f, readFileSync(join(REAL_MIGRATIONS, f), 'utf-8')])
		);
		applyFilesOnly(database, migrationsDir(before));
		database.exec(`
			INSERT INTO users (id, username, email, password_hash, role, created_at) VALUES
				(1, 'ann', 'ann@example.test', 'x', 'superadmin', '${STAMP}'), (2, 'bob', 'bob@example.test', 'x', 'user', '${STAMP}');
			INSERT INTO boards (id, name, created_by, created_at, updated_at) VALUES (1, 'A', 1, '${STAMP}', '${STAMP}'), (2, 'B', 2, '${STAMP}', '${STAMP}');
			INSERT INTO columns (id, board_id, title, position) VALUES (1, 1, 'To Do', 0), (2, 2, 'To Do', 0);
			INSERT INTO cards (id, column_id, title, created_by, created_at, updated_at) VALUES (1, 1, 'A card', 1, '${STAMP}', '${STAMP}');
		`);
		runBackfills(database);
		return database;
	}

	/**
	 * A current database holding one whole decision record, as later cards will
	 * write it:
	 *
	 *   users          Ann (1), the author; Bob (2), the decider
	 *   board          A (1), Product Owner Bob; cards 1 and 2 on it
	 *   people         1 (Ann's account) and 2 (no account), both in group 1
	 *   decision       1, on board A, ruled for option 2
	 *   options        1 and 2
	 *   participants   1 (person 1); 2 (person 2), removed
	 *   responses      1 (participant 1, option 1); 2 (participant 1, option 2), replacing 1
	 *   question       1, from participant 1, answered by Ann
	 *   ruling         option 2, by Bob
	 *   events         1 (participant 1, by Ann); 2 (no participant, by Bob)
	 *   card links     cards 1 and 2
	 */
	function withRecord(): Database.Database {
		const database = memoryDb();
		runMigrations({ database, migrationsDir: REAL_MIGRATIONS });
		database.exec(`
			INSERT INTO users (id, username, email, password_hash, created_at) VALUES
				(1, 'ann', 'ann@example.test', 'x', '${STAMP}'), (2, 'bob', 'bob@example.test', 'x', '${STAMP}');
			INSERT INTO boards (id, name, created_by, product_owner_user_id, created_at, updated_at) VALUES (1, 'A', 1, 2, '${STAMP}', '${STAMP}');
			INSERT INTO columns (id, board_id, title, position) VALUES (1, 1, 'To Do', 0);
			INSERT INTO cards (id, column_id, title, created_at, updated_at) VALUES (1, 1, 'One', '${STAMP}', '${STAMP}'), (2, 1, 'Two', '${STAMP}', '${STAMP}');
			INSERT INTO people (id, full_name, email, user_id, created_by, created_at, updated_at) VALUES
				(1, 'Ann Author', 'ann@example.test', 1, 1, '${STAMP}', '${STAMP}'),
				(2, 'Pat Outside', 'pat@example.test', NULL, 1, '${STAMP}', '${STAMP}');
			INSERT INTO people_groups (id, name, created_at) VALUES (1, 'Finance', '${STAMP}');
			INSERT INTO people_group_members (group_id, person_id) VALUES (1, 1), (1, 2);
			INSERT INTO decisions (id, board_id, board_name, title, status, current_version, author_user_id, author_name,
					decider_user_id, decider_name, opened_at, ruled_at, results_released_at, results_released_by, created_at, updated_at) VALUES
				(1, 1, 'A', 'Which supplier', 'ruled', 1, 1, 'Ann', 2, 'Bob', '${STAMP}', '${STAMP}', '${STAMP}', 2, '${STAMP}', '${STAMP}');
			INSERT INTO decision_options (id, decision_id, label, position, added_in_version) VALUES (1, 1, 'A', 1, 1), (2, 1, 'B', 2, 1);
			INSERT INTO decision_versions (id, decision_id, number, content, asks_again, published_by, published_by_name, published_at) VALUES
				(1, 1, 1, '{}', 1, 1, 'Ann', '${STAMP}');
			INSERT INTO decision_participants (id, decision_id, person_id, role, name, email, job_title, groups, included_at,
					included_by, included_by_name, removed_at, removed_by, user_id) VALUES
				(1, 1, 1, 'consulted', 'Ann Author', 'ann@example.test', '', '["Finance"]', '${STAMP}', 1, 'Ann', NULL, NULL, 1),
				(2, 1, 2, 'informed', 'Pat Outside', 'pat@example.test', '', '["Finance"]', '${STAMP}', 1, 'Ann', '${STAMP}', 1, NULL);
			INSERT INTO decision_responses (id, decision_id, participant_id, version_number, round, kind, option_id, replaces_id, via, created_at) VALUES
				(1, 1, 1, 1, 1, 'vote', 1, NULL, 'session', '${STAMP}'),
				(2, 1, 1, 1, 1, 'vote', 2, 1, 'session', '${STAMP}');
			INSERT INTO decision_questions (id, decision_id, participant_id, asker_name, question, asked_in_version, via, asked_at,
					answer, answered_by, answered_by_name, answered_at) VALUES
				(1, 1, 1, 'Ann Author', 'How much?', 1, 'session', '${STAMP}', 'Less.', 1, 'Ann', '${STAMP}');
			INSERT INTO decision_rulings (decision_id, option_id, reason, against_responses, early, version_number, ruled_by, ruled_by_name, ruled_at) VALUES
				(1, 2, 'Cheaper.', 0, 0, 1, 2, 'Bob', '${STAMP}');
			INSERT INTO decision_events (id, decision_id, participant_id, kind, actor_user_id, actor_name, source, created_at) VALUES
				(1, 1, 1, 'responded', 1, 'Ann', 'ui', '${STAMP}'),
				(2, 1, NULL, 'ruled', 2, 'Bob', 'ui', '${STAMP}');
			INSERT INTO decision_card_links (decision_id, card_id, created_by, created_at) VALUES (1, 1, 1, '${STAMP}'), (1, 2, 1, '${STAMP}');
		`);
		return database;
	}

	/** The number of rows in each of the twelve tables. */
	const countsOf = (database: Database.Database) =>
		Object.fromEntries(
			TABLES_OF_0061.map((table) => [table, (database.prepare(`SELECT COUNT(*) AS n FROM "${table}"`).get() as { n: number }).n])
		);
	const none = Object.fromEntries(TABLES_OF_0061.map((table) => [table, 0]));

	it('is the twelve tables, the column and the 35 named indexes, each the model’s own statement, after a header that says it runs once', () => {
		const sql = readFileSync(join(REAL_MIGRATIONS, FILE_0061), 'utf-8');
		const statements = sqlStatements(sql).map((s) => s.text.replace(/\r\n/g, '\n'));
		const tables = statements.filter((text) => text.startsWith('CREATE TABLE'));
		const indexes = statements.filter((text) => /^CREATE (UNIQUE )?INDEX IF NOT EXISTS /.test(text));
		const nameIn = (text: string) => /`([a-z_]+)`/.exec(text)?.[1];

		expect(statements).toHaveLength(48);
		// Parent first: each table after every table it refers to.
		expect(tables.map(nameIn)).toEqual([
			'people_groups',
			'people',
			'people_group_members',
			'decisions',
			'decision_options',
			'decision_versions',
			'decision_participants',
			'decision_responses',
			'decision_questions',
			'decision_rulings',
			'decision_events',
			'decision_card_links'
		]);
		expect(statements.filter((text) => text.startsWith('ALTER'))).toEqual([
			'ALTER TABLE `boards` ADD COLUMN `product_owner_user_id` integer REFERENCES `users`(`id`) ON UPDATE no action ON DELETE set null;'
		]);
		expect(indexes.map(nameIn).sort()).toEqual([...INDEXES_OF_0061].sort());
		// Nothing else: no data change, no trigger, no CHECK.
		expect(tables.length + 1 + indexes.length).toBe(statements.length);
		expect(sql).not.toMatch(/\bCHECK\s*\(|CREATE TRIGGER|^\s*(INSERT|UPDATE|DELETE)\b/im);
		// Each is the statement the model's export prints, so the two cannot drift.
		// Card 2683: 0082 appends `answers` to decision_responses, so 0061's statement is the model's without that line.
		const asOf0061 = EXPECTED_SCHEMA.map((text) => text.replace('\n\t`answers` text,', ''));
		for (const text of [...tables, ...indexes]) expect(asOf0061, text).toContain(text.replace(' IF NOT EXISTS', ''));
		for (const said of ['What people see:', 'Runs once.', 'A backup made before this file', 'Going back to an older image']) {
			expect(sql, said).toContain(said);
		}
	});

	it('applies to a database at 0060 and changes no row, leaves the model check nothing, and runs once, declaring nothing to the rehearsal', () => {
		const database = beforeIt();
		const before = contentsOf(database);
		const state = stateOf(database);

		const report = runMigrations({ database, migrationsDir: REAL_MIGRATIONS });

		expect(report.applied).toEqual([FILE_0061, FILE_0062, FILE_0063, FILE_0064, FILE_0065, FILE_0066, FILE_0067, FILE_0068, FILE_0069, FILE_0070, FILE_0071, FILE_0072, FILE_0073, FILE_0074, FILE_0075, FILE_0076, FILE_0077, FILE_0078, FILE_0079, FILE_0080, FILE_0081, FILE_0082, FILE_0083, FILE_0084]);
		expect(report.tolerated).toEqual([]);
		// boards takes the column in place: it is in the model's shape, so nothing is rebuilt.
		expect(report.rebuilt).toEqual([]);
		expect(report.leftAlone).toEqual([]);
		expect(report.schemaDifferences).toEqual([]);
		expect(schemaDifferences(database)).toEqual([]);
		expect(unindexedForeignKeys(database)).toEqual([]);
		expect(indexesOf(database)).toEqual(expect.arrayContaining(INDEXES_OF_0061));
		expect(countsOf(database)).toEqual(none);
		// Every row as it was, but for the column each board gains, NULL.
		const withProductOwner = (json: string) =>
			JSON.stringify(
				Object.fromEntries(
					Object.entries({ ...JSON.parse(json), product_owner_user_id: null }).sort(([a], [b]) => a.localeCompare(b))
				)
			);
		const after = contentsOf(database);
		for (const table of Object.keys(before)) {
			// The migration record, and its id counter, gain the file.
			if (['__drizzle_migrations', 'sqlite_sequence'].includes(table)) continue;
			const expected = table === 'boards' ? before.boards.map(withProductOwner).sort() : afterRelease(table, before[table]);
			expect(after[table], table).toEqual(expected);
		}
		// The rehearsal: every row kept, nothing to note but 0066's, applied in the same run (card 2769).
		const found: Findings = { problems: [], notes: [] };
		compare(state, stateOf(database), report.applied, found);
		expect(found).toEqual({ problems: [], notes: [SETTINGS_NOTE_OF_0066(0), USERS_NOTE_OF_0066(2), ...NOTES_OF_0084({ users: 2 })] });

		// Runs once: the next start applies nothing, and a second run is not tolerated.
		const again = runMigrations({ database, migrationsDir: REAL_MIGRATIONS });
		expect(again.applied).toEqual([]);
		expect(again.rebuilt).toEqual([]);
		expect(contentsOf(database)).toEqual(after);
		expect(TOLERANT_FILES).not.toContain(FILE_0061);
		expect(ONE_OFFS.filter((oneOff) => oneOff.file === FILE_0061)).toEqual([]);
	});

	it('restores a backup made before 0061: the twelve tables empty, and every board’s Product Owner NULL', () => {
		const live = withRecord();
		expect(countsOf(live).decisions).toBe(1);
		const backup = beforeIt();
		expect(backup.prepare("SELECT name FROM sqlite_master WHERE name = 'decisions'").get()).toBeUndefined();
		// Sealed as this server's own (card 3013, R1): from a copy whose seal did not verify, Ann, the same account here and
		// no superadmin here, would keep this server's role, and the restore would leave no superadmin.
		sealCopy(backup, backupSealKey(live));

		const result = restoreFromBackup(live, backup);

		expect(result.errors).toEqual([]);
		expect(countsOf(live)).toEqual(none);
		expect(live.prepare('SELECT id, name, product_owner_user_id FROM boards ORDER BY id').all()).toEqual([
			{ id: 1, name: 'A', product_owner_user_id: null },
			{ id: 2, name: 'B', product_owner_user_id: null }
		]);
		expect(live.pragma('foreign_key_check')).toEqual([]);
	});

	it('deletes a whole decision through every table under it: the NO ACTION keys do not block the cascade', () => {
		const database = withRecord();
		expect(Object.values(countsOf(database)).every((n) => n > 0)).toBe(true);

		database.prepare('DELETE FROM decisions WHERE id = 1').run();

		expect(countsOf(database)).toEqual({ ...none, people: 2, people_groups: 1, people_group_members: 2 });
		// Only the links went: the cards, the board and its Product Owner are there.
		expect(database.prepare('SELECT COUNT(*) AS n FROM cards').get()).toEqual({ n: 2 });
		expect(database.prepare('SELECT product_owner_user_id FROM boards WHERE id = 1').get()).toEqual({ product_owner_user_id: 2 });
		expect(database.pragma('foreign_key_check')).toEqual([]);
	});

	it('refuses to delete a participant or an option that a response, question, event or ruling mentions (decision 2)', () => {
		// Each mention on its own: every other row that mentions the same
		// participant or option is taken away first, so each key is shown to
		// refuse by itself.
		const mentions: [parent: string, id: number, child: string, column: string][] = [
			['decision_participants', 1, 'decision_responses', 'participant_id'],
			['decision_participants', 1, 'decision_questions', 'participant_id'],
			['decision_participants', 1, 'decision_events', 'participant_id'],
			['decision_options', 2, 'decision_responses', 'option_id'],
			['decision_options', 2, 'decision_rulings', 'option_id']
		];
		for (const [parent, id, child, column] of mentions) {
			const database = withRecord();
			for (const [p, , other, by] of mentions) {
				if (p === parent && other !== child) database.prepare(`DELETE FROM ${other} WHERE ${by} = ?`).run(id);
			}
			const remove = () => database.prepare(`DELETE FROM ${parent} WHERE id = ?`).run(id);

			expect(remove, `${child}.${column}`).toThrow(/FOREIGN KEY constraint failed/);
			expect(database.prepare(`SELECT COUNT(*) AS n FROM ${parent} WHERE id = ?`).get(id), `${child}.${column}`).toEqual({ n: 1 });

			// With the mention gone, the delete goes through: it was that key.
			database.prepare(`DELETE FROM ${child} WHERE ${column} = ?`).run(id);
			expect(remove().changes, `${child}.${column}`).toBe(1);
		}
	});

	it('keeps the record when its card, its people, their accounts and its board go', () => {
		const database = withRecord();

		// A card: only its link goes.
		database.prepare('DELETE FROM cards WHERE id = 1').run();
		expect(database.prepare('SELECT decision_id, card_id FROM decision_card_links').all()).toEqual([{ decision_id: 1, card_id: 2 }]);
		expect(database.prepare('SELECT COUNT(*) AS n FROM decisions').get()).toEqual({ n: 1 });
		// The author's and the decider's accounts: every key to them empties, every name stays.
		database.prepare('DELETE FROM users WHERE id IN (1, 2)').run();
		expect(database.prepare('SELECT card_id, created_by FROM decision_card_links').all()).toEqual([{ card_id: 2, created_by: null }]);
		// Seen before the person and the board go, so that it is the account
		// keys that empty these, not a row going: the board's Product Owner,
		// the person's account, and participant 1's snapshot of it.
		expect(database.prepare('SELECT product_owner_user_id FROM boards WHERE id = 1').get()).toEqual({ product_owner_user_id: null });
		expect(database.prepare('SELECT user_id FROM people WHERE id = 1').get()).toEqual({ user_id: null });
		expect(database.prepare('SELECT user_id FROM decision_participants WHERE id = 1').get()).toEqual({ user_id: null });
		// A person: the participant keeps what it was included with.
		database.prepare('DELETE FROM people WHERE id = 1').run();
		// The board: the decision stays, with the board's name. The board's
		// cards go with it, and so their links.
		database.prepare('DELETE FROM boards WHERE id = 1').run();
		expect(database.prepare('SELECT COUNT(*) AS n FROM decision_card_links').get()).toEqual({ n: 0 });

		expect(database.prepare(`SELECT id, board_id, board_name, author_user_id, author_name, decider_user_id, decider_name,
			results_released_by FROM decisions`).all()).toEqual([
			{ id: 1, board_id: null, board_name: 'A', author_user_id: null, author_name: 'Ann', decider_user_id: null, decider_name: 'Bob', results_released_by: null }
		]);
		expect(database.prepare(`SELECT id, person_id, name, included_by, included_by_name, removed_by, user_id
			FROM decision_participants ORDER BY id`).all()).toEqual([
			// user_id is a snapshot, but keyed to users: Ann's account went, so it emptied.
			{ id: 1, person_id: null, name: 'Ann Author', included_by: null, included_by_name: 'Ann', removed_by: null, user_id: null },
			{ id: 2, person_id: 2, name: 'Pat Outside', included_by: null, included_by_name: 'Ann', removed_by: null, user_id: null }
		]);
		expect(database.prepare('SELECT published_by, published_by_name FROM decision_versions').all()).toEqual([
			{ published_by: null, published_by_name: 'Ann' }
		]);
		expect(database.prepare('SELECT answered_by, answered_by_name FROM decision_questions').all()).toEqual([
			{ answered_by: null, answered_by_name: 'Ann' }
		]);
		expect(database.prepare('SELECT option_id, ruled_by, ruled_by_name FROM decision_rulings').all()).toEqual([
			{ option_id: 2, ruled_by: null, ruled_by_name: 'Bob' }
		]);
		expect(database.prepare('SELECT id, actor_user_id, actor_name FROM decision_events ORDER BY id').all()).toEqual([
			{ id: 1, actor_user_id: null, actor_name: 'Ann' },
			{ id: 2, actor_user_id: null, actor_name: 'Bob' }
		]);
		expect(database.prepare('SELECT id, user_id, created_by FROM people').all()).toEqual([{ id: 2, user_id: null, created_by: null }]);
		expect(database.prepare('SELECT group_id, person_id FROM people_group_members').all()).toEqual([{ group_id: 1, person_id: 2 }]);
		expect(countsOf(database)).toMatchObject({ decision_options: 2, decision_responses: 2 });
		expect(database.pragma('foreign_key_check')).toEqual([]);
	});
});

// ─── 0062: each session's count of wrong current passwords ──────────────────

describe("0062, which adds each session's count of wrong current passwords (card 2701)", () => {
	const STAMP = '2026-11-04 09:00:00';

	it('adds wrong_password_count, NOT NULL DEFAULT 0, to a database with sessions: every session reads 0 and nothing else changes, and the database is then the model', () => {
		// A database at 0061, as a start of the build before this one leaves it,
		// with two accounts and three sessions.
		const database = memoryDb();
		const before0062 = Object.fromEntries(
			realFiles.filter((f) => f < FILE_0062).map((f) => [f, readFileSync(join(REAL_MIGRATIONS, f), 'utf-8')])
		);
		applyFilesOnly(database, migrationsDir(before0062));
		database.exec(`
			INSERT INTO users (id, username, email, password_hash, role, created_at) VALUES
				(1, 'ann', 'ann@example.test', 'x', 'superadmin', '${STAMP}'), (2, 'bob', 'bob@example.test', 'x', 'user', '${STAMP}');
			-- In plain, on purpose: a database from before card 2775, which these migrations meet.
			INSERT INTO sessions (id, user_id, expires_at, created_at) VALUES
				('ann-laptop', 1, '2026-12-04 09:00:00', '${STAMP}'),
				('ann-phone', 1, '2026-12-04 09:00:00', '${STAMP}'),
				('bob-laptop', 2, '2026-12-04 09:00:00', '${STAMP}');
		`);
		runBackfills(database);
		const before = contentsOf(database);

		// Every session reads 0, as 0062 leaves them: read from a copy taken to
		// 0062 and no further, since 0067 (card 2769) then ends every session.
		const at0062 = new Database(database.serialize());
		opened.push(at0062);
		applyFilesOnly(
			at0062,
			migrationsDir(Object.fromEntries(realFiles.filter((f) => f <= FILE_0062).map((f) => [f, readFileSync(join(REAL_MIGRATIONS, f), 'utf-8')])))
		);
		expect(at0062.prepare('SELECT id, user_id, wrong_password_count FROM sessions ORDER BY id').all()).toEqual([
			{ id: 'ann-laptop', user_id: 1, wrong_password_count: 0 },
			{ id: 'ann-phone', user_id: 1, wrong_password_count: 0 },
			{ id: 'bob-laptop', user_id: 2, wrong_password_count: 0 }
		]);
		// And the sessions but for the new column, as they were.
		const withoutCount = (json: string) => {
			const { wrong_password_count: _count, ...row } = JSON.parse(json) as Record<string, unknown>;
			return JSON.stringify(row);
		};
		expect(contentsOf(at0062).sessions.map(withoutCount)).toEqual(before.sessions);

		const report = runMigrations({ database, migrationsDir: REAL_MIGRATIONS });

		expect(report.applied).toEqual([FILE_0062, FILE_0063, FILE_0064, FILE_0065, FILE_0066, FILE_0067, FILE_0068, FILE_0069, FILE_0070, FILE_0071, FILE_0072, FILE_0073, FILE_0074, FILE_0075, FILE_0076, FILE_0077, FILE_0078, FILE_0079, FILE_0080, FILE_0081, FILE_0082, FILE_0083, FILE_0084]);
		expect(report.tolerated).toEqual([]);
		// sessions is not one the runner reconciles: the file alone changes it.
		expect(report.rebuilt).toEqual([]);
		expect(report.schemaDifferences).toEqual([]);
		expect(schemaDifferences(database)).toEqual([]);
		expect(
			database
				.prepare("SELECT name, type, \"notnull\" AS required, dflt_value AS dflt FROM pragma_table_info('sessions') WHERE name = 'wrong_password_count'")
				.all()
		).toEqual([{ name: 'wrong_password_count', type: 'INTEGER', required: 1, dflt: '0' }]);
		// Every other row as it was; the sessions ended by 0067 (`afterRelease`).
		const after = contentsOf(database);
		for (const table of Object.keys(before)) {
			// The migration record, and its id counter, gain the file.
			if (['__drizzle_migrations', 'sqlite_sequence'].includes(table)) continue;
			expect(after[table], table).toEqual(afterRelease(table, before[table]));
		}

		// Runs once: the next start applies nothing, a second run is not
		// tolerated, and nothing is declared to the rehearsal.
		expect(runMigrations({ database, migrationsDir: REAL_MIGRATIONS }).applied).toEqual([]);
		expect(TOLERANT_FILES).not.toContain(FILE_0062);
		expect(ONE_OFFS.filter((oneOff) => oneOff.file === FILE_0062)).toEqual([]);
	});
});

// ─── 0063: one closing-date reminder per participant per round ──────────────

describe('0063, which holds one closing-date reminder per participant per round (card 2685)', () => {
	const STAMP = '2026-11-04 09:00:00';
	// No IF NOT EXISTS (the code review's S5): a same-named index already there fails the file, so the index is always this one.
	const STATEMENT =
		"CREATE UNIQUE INDEX `idx_decision_events_participant_id_version_number_reminded` ON `decision_events` (`participant_id`,`version_number`) WHERE kind = 'reminded';";

	/** A database with every file before 0063 applied, as a start of the build before this one leaves it. */
	const at0062 = () => {
		const database = memoryDb();
		const before0063 = Object.fromEntries(
			realFiles.filter((f) => f < FILE_0063).map((f) => [f, readFileSync(join(REAL_MIGRATIONS, f), 'utf-8')])
		);
		applyFilesOnly(database, migrationsDir(before0063));
		return database;
	};

	it('is one statement, the model’s own partial unique index, after a header that says it runs once, and declares nothing', () => {
		const sql = readFileSync(join(REAL_MIGRATIONS, FILE_0063), 'utf-8');
		const statements = sqlStatements(sql).map((s) => s.text.replace(/\r\n/g, '\n'));

		expect(statements).toEqual([STATEMENT]);
		expect(sql).not.toContain('--> statement-breakpoint');
		expect(STATEMENT).not.toContain('IF NOT EXISTS');
		// The statement the model's export prints, so the two cannot drift.
		expect(EXPECTED_SCHEMA).toContain(STATEMENT);
		for (const said of ['What people see:', 'Runs once.', 'A backup made before this file', 'Going back to an older image']) {
			expect(sql, said).toContain(said);
		}
		expect(TOLERANT_FILES).not.toContain(FILE_0063);
		expect(ONE_OFFS.filter((oneOff) => oneOff.file === FILE_0063)).toEqual([]);
	});

	it('applies to a database at 0062 holding repeated events of other kinds, changes no row, and then refuses a second reminder for one participant and round alone', () => {
		// A database at 0062, as a start of the build before this one leaves it,
		// with a decision, two participants, and events that repeat a
		// participant and version in other kinds.
		const database = at0062();
		database.exec(`
			INSERT INTO users (id, username, email, password_hash, created_at) VALUES (1, 'ann', 'ann@example.test', 'x', '${STAMP}');
			INSERT INTO decisions (id, board_id, board_name, title, status, current_version, author_user_id, author_name,
					decider_user_id, decider_name, opened_at, created_at, updated_at) VALUES
				(1, NULL, 'A', 'Which supplier', 'open', 2, 1, 'Ann', 1, 'Ann', '${STAMP}', '${STAMP}', '${STAMP}');
			INSERT INTO decision_participants (id, decision_id, person_id, role, name, email, job_title, groups, included_at,
					included_by, included_by_name, removed_at, removed_by, user_id) VALUES
				(1, 1, NULL, 'consulted', 'Pat One', 'pat@example.test', '', '[]', '${STAMP}', 1, 'Ann', NULL, NULL, NULL),
				(2, 1, NULL, 'consulted', 'Lee Two', 'lee@example.test', '', '[]', '${STAMP}', 1, 'Ann', NULL, NULL, NULL);
			INSERT INTO decision_events (id, decision_id, participant_id, kind, version_number, actor_user_id, actor_name, source, created_at) VALUES
				(1, 1, 1, 'invited', NULL, 1, 'Ann', 'ui', '${STAMP}'),
				(2, 1, 1, 'invited', NULL, 1, 'Ann', 'ui', '${STAMP}'),
				(3, 1, 1, 'asked_again', 2, 1, 'Ann', 'ui', '${STAMP}'),
				(4, 1, 1, 'asked_again', 2, 1, 'Ann', 'ui', '${STAMP}'),
				(5, 1, NULL, 'published', 1, 1, 'Ann', 'ui', '${STAMP}'),
				(6, 1, NULL, 'published', 1, 1, 'Ann', 'ui', '${STAMP}');
		`);
		runBackfills(database);
		const before = contentsOf(database);

		const report = runMigrations({ database, migrationsDir: REAL_MIGRATIONS });

		expect(report.applied).toEqual([FILE_0063, FILE_0064, FILE_0065, FILE_0066, FILE_0067, FILE_0068, FILE_0069, FILE_0070, FILE_0071, FILE_0072, FILE_0073, FILE_0074, FILE_0075, FILE_0076, FILE_0077, FILE_0078, FILE_0079, FILE_0080, FILE_0081, FILE_0082, FILE_0083, FILE_0084]);
		expect(report.tolerated).toEqual([]);
		// decision_events is not one the runner reconciles: the file alone changes it.
		expect(report.rebuilt).toEqual([]);
		expect(report.schemaDifferences).toEqual([]);
		expect(schemaDifferences(database)).toEqual([]);
		const after = contentsOf(database);
		for (const table of Object.keys(before)) {
			// The migration record, and its id counter, gain the file.
			if (['__drizzle_migrations', 'sqlite_sequence'].includes(table)) continue;
			expect(after[table], table).toEqual(afterRelease(table, before[table]));
		}
		expect(
			database.prepare("SELECT name, \"unique\" AS isUnique, partial FROM pragma_index_list('decision_events') WHERE name = ?").all(INDEX_OF_0063)
		).toEqual([{ name: INDEX_OF_0063, isUnique: 1, partial: 1 }]);

		// The index refuses a second reminder for one participant and round, and nothing else.
		const remind = (participantId: number, version: number) =>
			database
				.prepare(
					"INSERT INTO decision_events (decision_id, participant_id, kind, version_number, actor_name, source, created_at) VALUES (1, ?, 'reminded', ?, 'DumpFire', 'system', ?)"
				)
				.run(participantId, version, STAMP);
		expect(remind(1, 1).changes).toBe(1);
		expect(() => remind(1, 1)).toThrow(expect.objectContaining({ code: 'SQLITE_CONSTRAINT_UNIQUE' }));
		expect(remind(1, 2).changes).toBe(1);
		expect(remind(2, 1).changes).toBe(1);
		expect(database.prepare("SELECT COUNT(*) AS n FROM decision_events WHERE kind = 'reminded'").get()).toEqual({ n: 3 });

		// Runs once: the next start applies nothing.
		expect(runMigrations({ database, migrationsDir: REAL_MIGRATIONS }).applied).toEqual([]);
	});

	it('fails loudly where an index of its name is already there, records nothing, and is not taken as run (code review S5)', () => {
		// A stale index of the same name, neither unique nor partial: one IF NOT EXISTS would have kept, recording the file over it.
		const database = at0062();
		database.exec(`CREATE INDEX \`${INDEX_OF_0063}\` ON \`decision_events\` (\`participant_id\`)`);

		const { error } = halted({ database, migrationsDir: REAL_MIGRATIONS });

		expect(error.file).toBe(FILE_0063);
		expect(error.message).toContain('already exists');
		expect((database.prepare('SELECT hash FROM __drizzle_migrations').all() as { hash: string }[]).map((row) => row.hash)).not.toContain(FILE_0063);
	});
});

// ─── 0064: the record of every change to the people directory ───────────────

describe('0064, which adds people_changes, the record of every change to the people directory (card 2681)', () => {
	const STAMP = '2026-11-04 09:00:00';

	/** A database with every file before 0064 applied, as a start of the build before this one leaves it. */
	const at0063 = () => {
		const database = memoryDb();
		const before0064 = Object.fromEntries(
			realFiles.filter((f) => f < FILE_0064).map((f) => [f, readFileSync(join(REAL_MIGRATIONS, f), 'utf-8')])
		);
		applyFilesOnly(database, migrationsDir(before0064));
		return database;
	};

	it('is the model’s table and its two indexes, each the statement the model’s export prints, after a header that says it runs once, and declares nothing', () => {
		const sql = readFileSync(join(REAL_MIGRATIONS, FILE_0064), 'utf-8');
		const statements = sqlStatements(sql).map((s) => s.text.replace(/\r\n/g, '\n'));

		expect(statements).toHaveLength(3);
		expect(statements[0]).toMatch(/^CREATE TABLE `people_changes` \(/);
		expect(statements.slice(1)).toEqual([
			'CREATE INDEX `idx_people_changes_actor_user_id` ON `people_changes` (`actor_user_id`);',
			'CREATE INDEX `idx_people_changes_subject_subject_id` ON `people_changes` (`subject`,`subject_id`);'
		]);
		// The statements the model's export prints, so the two cannot drift.
		for (const statement of statements) expect(EXPECTED_SCHEMA).toContain(statement);
		// No IF NOT EXISTS (as 0063, card 2685's code review S5): a table or an index of these names already there fails the file.
		for (const statement of statements) expect(statement).not.toContain('IF NOT EXISTS');
		for (const said of ['What people see:', 'Runs once.', 'A backup made before this file', 'Going back to an older image', 'never an account id']) {
			expect(sql, said).toContain(said);
		}
		expect(TOLERANT_FILES).not.toContain(FILE_0064);
		expect(ONE_OFFS.filter((oneOff) => oneOff.file === FILE_0064)).toEqual([]);
	});

	it('applies to a database at 0063 with people and groups, changes no row, makes the table empty with no key to its subject, and runs once', () => {
		const database = at0063();
		database.exec(`
			INSERT INTO users (id, username, email, password_hash, role, created_at) VALUES (1, 'ann', 'ann@example.test', 'x', 'admin', '${STAMP}');
			INSERT INTO people (id, full_name, email, created_at, updated_at) VALUES (1, 'Pat One', 'pat@example.test', '${STAMP}', '${STAMP}');
			INSERT INTO people_groups (id, name, created_at) VALUES (1, 'Finance', '${STAMP}');
			INSERT INTO people_group_members (group_id, person_id) VALUES (1, 1);
		`);
		runBackfills(database);
		const before = contentsOf(database);

		const report = runMigrations({ database, migrationsDir: REAL_MIGRATIONS });

		expect(report.applied).toEqual([FILE_0064, FILE_0065, FILE_0066, FILE_0067, FILE_0068, FILE_0069, FILE_0070, FILE_0071, FILE_0072, FILE_0073, FILE_0074, FILE_0075, FILE_0076, FILE_0077, FILE_0078, FILE_0079, FILE_0080, FILE_0081, FILE_0082, FILE_0083, FILE_0084]);
		expect(report.tolerated).toEqual([]);
		// people_changes is new, not one the runner reconciles: the file alone makes it.
		expect(report.rebuilt).toEqual([]);
		expect(report.schemaDifferences).toEqual([]);
		expect(schemaDifferences(database)).toEqual([]);
		const after = contentsOf(database);
		for (const table of Object.keys(before)) {
			// The migration record, and its id counter, gain the file.
			if (['__drizzle_migrations', 'sqlite_sequence'].includes(table)) continue;
			expect(after[table], table).toEqual(afterRelease(table, before[table]));
		}
		expect(database.prepare('SELECT COUNT(*) AS n FROM people_changes').get()).toEqual({ n: 0 });
		// One key, to users, emptied with the account; the subject is a plain integer, so a delete leaves its rows.
		expect(
			database.prepare("SELECT \"table\", \"from\", on_delete AS onDelete FROM pragma_foreign_key_list('people_changes')").all()
		).toEqual([{ table: 'users', from: 'actor_user_id', onDelete: 'SET NULL' }]);
		database.pragma('foreign_keys = ON');
		database
			.prepare("INSERT INTO people_changes (actor_user_id, actor_name, source, subject, subject_id, kind, before, after, created_at) VALUES (1, 'ann', 'api', 'person', 1, 'deleted', '{}', NULL, ?)")
			.run(STAMP);
		database.exec('DELETE FROM people WHERE id = 1; DELETE FROM users WHERE id = 1;');
		expect(database.prepare('SELECT actor_user_id AS actor, actor_name AS name, subject_id AS subject FROM people_changes').all()).toEqual([
			{ actor: null, name: 'ann', subject: 1 }
		]);

		// Runs once: the next start applies nothing.
		expect(runMigrations({ database, migrationsDir: REAL_MIGRATIONS }).applied).toEqual([]);
	});

	it('fails loudly where a table of its name is already there, records nothing, and is not taken as run', () => {
		const database = at0063();
		database.exec('CREATE TABLE `people_changes` (`id` integer PRIMARY KEY)');

		const { error } = halted({ database, migrationsDir: REAL_MIGRATIONS });

		expect(error.file).toBe(FILE_0064);
		expect(error.message).toContain('already exists');
		expect((database.prepare('SELECT hash FROM __drizzle_migrations').all() as { hash: string }[]).map((row) => row.hash)).not.toContain(FILE_0064);
	});
});

// ─── 0065: where two-step sign-in keeps its second factors ───────────────────

describe('0065, which adds the tables and users columns of two-step sign-in (card 2768)', () => {
	const STAMP = '2026-11-05 09:00:00';

	/** A database with every file before 0065 applied, as a start of the build before this one leaves it. */
	const at0064 = () => {
		const database = memoryDb();
		const before0065 = Object.fromEntries(
			realFiles.filter((f) => f < FILE_0065).map((f) => [f, readFileSync(join(REAL_MIGRATIONS, f), 'utf-8')])
		);
		applyFilesOnly(database, migrationsDir(before0065));
		return database;
	};

	it('is the model’s four tables and six indexes, each the statement the model’s export prints, and eleven users columns, after a header that says it runs once, and declares nothing', () => {
		const sql = readFileSync(join(REAL_MIGRATIONS, FILE_0065), 'utf-8');
		const statements = sqlStatements(sql).map((s) => s.text.replace(/\r\n/g, '\n'));
		const creates = statements.filter((statement) => statement.startsWith('CREATE '));
		const alters = statements.filter((statement) => statement.startsWith('ALTER '));

		// Nothing but the two kinds.
		expect(creates.length + alters.length).toBe(statements.length);
		expect(creates.map((statement) => /^CREATE TABLE `([a-z_]+)` \(/.exec(statement)?.[1]).filter(Boolean)).toEqual(TABLES_OF_0065);
		expect(creates).toHaveLength(10);
		// The statements the model's export prints, so the two cannot drift;
		// sign_in_challenges' less the two columns 0066 adds to it after (card 2769).
		const lessColumnsOf0066 = (statement: string) =>
			statement.replace('\n\t`enrol_grant` text,\n\t`enrolment_link_hash` text,', '');
		for (const statement of creates) expect(EXPECTED_SCHEMA.map(lessColumnsOf0066)).toContain(statement);
		// Every ALTER adds one users column, declared as the model declares it.
		const usersOfTheModel = EXPECTED_SCHEMA.find((statement) => statement.startsWith('CREATE TABLE `users` (')) ?? '';
		expect(alters.map((statement) => /^ALTER TABLE `users` ADD COLUMN `([a-z_]+)` [^;]+;$/.exec(statement)?.[1])).toEqual(
			Object.keys(COLUMNS_OF_0065)
		);
		for (const statement of alters) {
			expect(usersOfTheModel).toContain(`\t${statement.replace(/^ALTER TABLE `users` ADD COLUMN /, '').replace(/;$/, '')}`);
		}
		// No IF NOT EXISTS (as 0063, card 2685's code review S5): a table or an index of these names already there fails the file.
		for (const statement of statements) expect(statement).not.toContain('IF NOT EXISTS');
		for (const said of ['What people see:', 'Runs once.', 'A backup made before this file', 'Going back to an older image']) {
			expect(sql, said).toContain(said);
		}
		expect(TOLERANT_FILES).not.toContain(FILE_0065);
		expect(ONE_OFFS.filter((oneOff) => oneOff.file === FILE_0065)).toEqual([]);
	});

	it('applies to a database at 0064 with accounts, keeps every value, gives each account the new columns at 0 or NULL, makes the four tables empty with one cascading key to users each, and runs once', () => {
		const database = at0064();
		database.exec(`
			INSERT INTO users (id, username, email, password_hash, role, created_at) VALUES
				(1, 'ann', 'ann@example.test', 'x', 'superadmin', '${STAMP}'), (2, 'bob', 'bob@example.test', 'x', 'user', '${STAMP}');
			-- In plain, on purpose: a database from before card 2775, which these migrations meet.
			INSERT INTO sessions (id, user_id, expires_at, created_at) VALUES ('ann-laptop', 1, '2026-12-05 09:00:00', '${STAMP}');
		`);
		runBackfills(database);
		const before = contentsOf(database);

		const report = runMigrations({ database, migrationsDir: REAL_MIGRATIONS });

		expect(report.applied).toEqual([FILE_0065, FILE_0066, FILE_0067, FILE_0068, FILE_0069, FILE_0070, FILE_0071, FILE_0072, FILE_0073, FILE_0074, FILE_0075, FILE_0076, FILE_0077, FILE_0078, FILE_0079, FILE_0080, FILE_0081, FILE_0082, FILE_0083, FILE_0084]);
		expect(report.tolerated).toEqual([]);
		// users is not one the runner reconciles, and the four tables are new: the file alone makes them.
		expect(report.rebuilt).toEqual([]);
		expect(report.schemaDifferences).toEqual([]);
		expect(schemaDifferences(database)).toEqual([]);
		expect(unindexedForeignKeys(database)).toEqual([]);
		// Every account keeps every value, and gains the eleven columns at 0 or NULL.
		const columns = Object.keys(COLUMNS_OF_0065).join(', ');
		expect(database.prepare(`SELECT ${columns} FROM users ORDER BY id`).all()).toEqual([COLUMNS_OF_0065, COLUMNS_OF_0065]);
		const after = contentsOf(database);
		for (const table of Object.keys(before)) {
			// The migration record, and its id counter, gain the file.
			if (['__drizzle_migrations', 'sqlite_sequence'].includes(table)) continue;
			expect(after[table], table).toEqual(afterRelease(table, before[table]));
		}
		// The four tables empty, each with one key, to users, emptied with the account.
		for (const table of TABLES_OF_0065) {
			expect(database.prepare(`SELECT COUNT(*) AS n FROM \`${table}\``).get(), table).toEqual({ n: 0 });
			expect(
				database.prepare(`SELECT "table", "from", on_delete AS onDelete FROM pragma_foreign_key_list('${table}')`).all(),
				table
			).toEqual([{ table: 'users', from: 'user_id', onDelete: 'CASCADE' }]);
		}

		// Runs once: the next start applies nothing.
		expect(runMigrations({ database, migrationsDir: REAL_MIGRATIONS }).applied).toEqual([]);
	});
});

// ─── 0066 and 0067: the release of two-step sign-in ──────────────────────────

describe('0066 and 0067, which release two-step sign-in: the leave to set up on a password, and every session ended (card 2769)', () => {
	const STAMP = '2026-11-13 09:00:00';
	const LATER = '2099-01-01 00:00:00';
	const EARLIER = '2026-11-01 00:00:00';

	/**
	 * A database with every file before 0066 applied, as a start of the build
	 * before this one leaves it: ann holds a second factor, bob a live
	 * enrolment link, cat an expired one, and dan neither. ann and dan are
	 * signed in, dan has a pending sign-in, and the remembered-browser secret
	 * and one other setting are there.
	 */
	function at0065(): Database.Database {
		const database = memoryDb();
		applyFilesOnly(database, filesTo(FILE_0066, { before: true }));
		database.exec(`
			INSERT INTO users (id, username, email, password_hash, role, created_at) VALUES
				(1, 'ann', 'ann@example.test', 'x', 'superadmin', '${STAMP}'),
				(2, 'bob', 'bob@example.test', 'x', 'user', '${STAMP}'),
				(3, 'cat', 'cat@example.test', 'x', 'user', '${STAMP}'),
				(4, 'dan', 'dan@example.test', 'x', 'user', '${STAMP}');
			INSERT INTO mfa_factors (factor_uid, user_id, kind, label, key_id, secret_ciphertext, secret_nonce, created_at) VALUES
				('00112233445566778899aabbccddeeff', 1, 'totp', 'Phone', 'k1', 'c', 'n', '${STAMP}');
			INSERT INTO enrolment_links (token_hash, user_id, issued_by, created_at, expires_at) VALUES
				('hash-of-bob-link', 2, 'admin-reset', '${STAMP}', '${LATER}'),
				('hash-of-cat-link', 3, 'admin-reset', '${STAMP}', '${EARLIER}');
			-- In plain, on purpose: a database from before card 2775, which these migrations meet.
			INSERT INTO sessions (id, user_id, expires_at, created_at) VALUES
				('ann-laptop', 1, '${LATER}', '${STAMP}'),
				('dan-phone', 4, '${LATER}', '${STAMP}');
			INSERT INTO sign_in_challenges (token_hash, short_id, user_id, purpose, lane, password_hash, created_at, expires_at) VALUES
				('hash-of-dan-challenge', 'c0ffee00', 4, 'sign-in', 'other', 'x', '${STAMP}', '${LATER}');
			INSERT INTO settings (key, value) VALUES ('known_browser_secret', 'ab12'), ('theme', 'dark');
		`);
		runBackfills(database);
		return database;
	}

	/** The moment a stored-form value names, in milliseconds. */
	const momentOf = (value: string) => Date.parse(`${value.replace(' ', 'T')}Z`);

	it('T1: 0066 is six statements, one to a block, none IF NOT EXISTS, after a header that says what it does, declared to the rehearsal as keeping the rows of users, and not tolerated twice', () => {
		const sql = readFileSync(join(REAL_MIGRATIONS, FILE_0066), 'utf-8').replace(/\r\n/g, '\n');
		const blocks = sql.split('--> statement-breakpoint');
		const statements = sqlStatements(sql).map((s) => s.text);

		expect(blocks).toHaveLength(6);
		for (const block of blocks) expect(sqlStatements(block), block).toHaveLength(1);
		expect(statements).toEqual([
			'ALTER TABLE `users` ADD COLUMN `mfa_password_enrol` integer DEFAULT 0 NOT NULL;',
			'ALTER TABLE `sessions` ADD COLUMN `two_step` integer DEFAULT 0 NOT NULL;',
			'ALTER TABLE `sign_in_challenges` ADD COLUMN `enrol_grant` text;',
			'ALTER TABLE `sign_in_challenges` ADD COLUMN `enrolment_link_hash` text;',
			"INSERT INTO `settings` (`key`, `value`) VALUES ('two_step_released_at', datetime('now'))\n  ON CONFLICT (`key`) DO NOTHING;",
			'UPDATE `users` SET `mfa_password_enrol` = 1\n' +
				'WHERE NOT EXISTS (SELECT 1 FROM `mfa_factors` WHERE `mfa_factors`.`user_id` = `users`.`id`)\n' +
				'  AND NOT EXISTS (SELECT 1 FROM `enrolment_links` WHERE `enrolment_links`.`user_id` = `users`.`id`);'
		]);
		// Each column declared as the model declares it.
		for (const statement of statements.filter((s) => s.startsWith('ALTER '))) {
			const [, table, column] = /^ALTER TABLE `([a-z_]+)` ADD COLUMN (.+);$/.exec(statement)!;
			const ofTheModel = EXPECTED_SCHEMA.find((s) => s.startsWith(`CREATE TABLE \`${table}\` (`)) ?? '';
			expect(ofTheModel, statement).toContain(`\t${column}`);
		}
		for (const statement of statements) expect(statement).not.toContain('IF NOT EXISTS');
		for (const said of [
			'What people see:',
			'Runs once.',
			'A backup made before this file',
			'Going back to an older image',
			'an expired one',
			'An account made after this',
			'two_step_released_at',
			'keepsRows on users'
		]) {
			expect(sql, said).toContain(said);
		}
		expect(ONE_OFFS.filter((oneOff) => oneOff.file === FILE_0066)).toEqual([
			{
				file: FILE_0066,
				table: 'users',
				change: 'mfa_password_enrol set to 1 for every account with no second factor and no enrolment link',
				keepsRows: true
			}
		]);
		expect(TOLERANT_FILES).not.toContain(FILE_0066);
	});

	it('T2: 0066 on a database at 0065 gives the flag only to the account with no factor and no link, expired or live; sessions two_step 0, the challenge columns NULL, the release written, the model clean, and runs once', () => {
		const database = at0065();
		const before = contentsOf(database);
		const dir = filesTo(FILE_0066);

		const report = runMigrations({ database, migrationsDir: dir });

		expect(report.applied).toEqual([FILE_0066]);
		expect(report.tolerated).toEqual([]);
		// users and sessions are not ones the runner reconciles; settings needs no rebuild: the file alone changes them.
		expect(report.rebuilt).toEqual([]);
		// Nothing but the columns of 0069 (card 2772), the table of 0070 (card 2870), the columns of 0071 to 0073 (cards 2752,
		// 2671 and 2928) and the table of 0074 (card 2922), later files not applied here.
		expect(report.schemaDifferences).toEqual([TABLE_OF_0079, TABLE_OF_0077, TABLE_OF_0076, COLUMN_OF_0069, TABLE_OF_0083, COLUMN_OF_0082, TABLE_OF_0082, TABLE_OF_0081, notInTheDatabase('request_links'), COLUMN_OF_0084, TABLE_OF_0074, ...MODEL_LINES_OF_0078, USERS_COLUMN_OF_0069, ...MODEL_LINES_OF_0072, TABLE_OF_0075, ...MODEL_LINES_OF_0071_AND_0073]);
		expect(schemaDifferences(database)).toEqual([TABLE_OF_0079, TABLE_OF_0077, TABLE_OF_0076, COLUMN_OF_0069, TABLE_OF_0083, COLUMN_OF_0082, TABLE_OF_0082, TABLE_OF_0081, notInTheDatabase('request_links'), COLUMN_OF_0084, TABLE_OF_0074, ...MODEL_LINES_OF_0078, USERS_COLUMN_OF_0069, ...MODEL_LINES_OF_0072, TABLE_OF_0075, ...MODEL_LINES_OF_0071_AND_0073]);
		// The factor, the live link and the expired link each keep 0.
		expect(database.prepare('SELECT username, mfa_password_enrol AS flag FROM users ORDER BY id').all()).toEqual([
			{ username: 'ann', flag: 0 },
			{ username: 'bob', flag: 0 },
			{ username: 'cat', flag: 0 },
			{ username: 'dan', flag: 1 }
		]);
		// Every session there is one this image refuses (findSession).
		expect(database.prepare('SELECT id, two_step FROM sessions ORDER BY id').all()).toEqual([
			{ id: 'ann-laptop', two_step: 0 },
			{ id: 'dan-phone', two_step: 0 }
		]);
		expect(database.prepare('SELECT short_id, enrol_grant, enrolment_link_hash FROM sign_in_challenges').all()).toEqual([
			{ short_id: 'c0ffee00', enrol_grant: null, enrolment_link_hash: null }
		]);
		// The release, now, in the stored form of a moment; the secret is 0067's to delete.
		const released = database.prepare("SELECT value FROM settings WHERE key = 'two_step_released_at'").pluck().get() as string;
		expect(released).toMatch(/^\d{4}-\d{2}-\d{2} \d{2}:\d{2}:\d{2}$/);
		expect(Math.abs(momentOf(released) - Date.now())).toBeLessThan(60_000);
		expect(database.prepare("SELECT value FROM settings WHERE key = 'known_browser_secret'").pluck().get()).toBe('ab12');
		// Every row of every other table as it was.
		const after = contentsOf(database);
		for (const table of Object.keys(before)) {
			if (['users', 'sessions', 'sign_in_challenges', 'settings', '__drizzle_migrations', 'sqlite_sequence'].includes(table)) continue;
			expect(after[table], table).toEqual(before[table]);
		}
		// And the accounts but for the flag.
		const withoutFlag = (json: string) => {
			const { mfa_password_enrol: _flag, ...row } = JSON.parse(json) as Record<string, unknown>;
			return JSON.stringify(row);
		};
		expect(after.users.map(withoutFlag)).toEqual(before.users);

		// Runs once: the next start applies nothing and changes nothing.
		expect(runMigrations({ database, migrationsDir: dir }).applied).toEqual([]);
		expect(contentsOf(database)).toEqual(after);
	});

	it('T3, card 3064 T10: 0067, edited, keeps every session and ends the remembered-browser secret, keeping every other setting; the rehearsal notes the one-offs declared for users, sessions and settings; a session made after it survives the next start', () => {
		const sql = readFileSync(join(REAL_MIGRATIONS, FILE_0067), 'utf-8').replace(/\r\n/g, '\n');
		expect(sqlStatements(sql).map((s) => s.text)).toEqual(["DELETE FROM `settings` WHERE `key` = 'known_browser_secret';"]);
		for (const said of ['What people see:', 'Runs once.', 'card 3064']) expect(sql, said).toContain(said);
		expect(ONE_OFFS.filter((oneOff) => oneOff.file === FILE_0067).map((oneOff) => oneOff.table)).toEqual(['settings']);
		expect(TOLERANT_FILES).not.toContain(FILE_0067);

		// To 0067 and no further: both sessions there as they were, in plain, two_step 0 (0066), and the secret gone.
		const alone = at0065();
		const sessionsBefore = alone.prepare('SELECT id, user_id, expires_at, created_at FROM sessions ORDER BY id').all();
		expect(runMigrations({ database: alone, migrationsDir: filesTo(FILE_0067) }).applied).toEqual([FILE_0066, FILE_0067]);
		expect(alone.prepare('SELECT id, user_id, expires_at, created_at FROM sessions ORDER BY id').all()).toEqual(sessionsBefore);
		expect(alone.prepare("SELECT value FROM settings WHERE key = 'known_browser_secret'").pluck().get()).toBeUndefined();
		expect(alone.prepare("SELECT value FROM settings WHERE key = 'theme'").pluck().get()).toBe('dark');

		// From 0065, as the release's start does: every file in one run, 0084 last (card 3064).
		const database = at0065();
		const state = stateOf(database);

		const report = runMigrations({ database, migrationsDir: REAL_MIGRATIONS });

		expect(report.applied).toEqual([FILE_0066, FILE_0067, FILE_0068, FILE_0069, FILE_0070, FILE_0071, FILE_0072, FILE_0073, FILE_0074, FILE_0075, FILE_0076, FILE_0077, FILE_0078, FILE_0079, FILE_0080, FILE_0081, FILE_0082, FILE_0083, FILE_0084]);
		expect(report.schemaDifferences).toEqual([]);
		// Both sessions kept, hashed and marked by 0084.
		expect(database.prepare('SELECT COUNT(*) AS n FROM sessions WHERE kept_at_release = 1').get()).toEqual({ n: 2 });
		// 0071's moment keys began to be recorded (card 2752), and 0084's release moment, six flags, one-shot leave to keep a
		// plain seal key and scrub marker (its code review, CS-M2 and CS-L4); 0066's release moment and 0069's API key deadline
		// taken back by 0084.
		expect(database.prepare('SELECT key FROM settings ORDER BY key').pluck().all()).toEqual([
			'backup_seal_key_keep_once',
			'compatibility_release_at',
			'report_schedules_announced',
			'secrets_scrub_pending',
			'stored_images_rechecked',
			'theme',
			'webhook_keys_recorded_at',
			'webhook_reveals_seeded',
			'webhooks_already_off_held',
			'webhooks_before_keys_announced',
			'webhooks_readable_by_disabled_held'
		]);
		// API keys, invites, enrolment links and pending sign-ins are untouched.
		expect(database.prepare('SELECT COUNT(*) AS n FROM enrolment_links').get()).toEqual({ n: 2 });
		expect(database.prepare('SELECT COUNT(*) AS n FROM sign_in_challenges').get()).toEqual({ n: 1 });
		// settings lost the secret and gained 0071's one and 0084's nine, so has nine rows more.
		const found: Findings = { problems: [], notes: [] };
		compare(state, stateOf(database), report.applied, found);
		expect(found).toEqual({
			problems: [],
			notes: [
				'settings had 2 row(s) and has 11: a migration put the others there',
				USERS_NOTE_OF_0066(4),
				`sessions: every session held in plain hashed in place and marked kept in its 2 row(s) by ${FILE_0084}, a one-off declared in tests/rehearsal/one-offs.ts`,
				`users: every mfa_password_enrol set to 0 in its 4 row(s) by ${FILE_0084}, a one-off declared in tests/rehearsal/one-offs.ts`
			]
		});

		// A start that stopped after 0066 (0067 failed, say) and is started again: the secret's loss is the one declared.
		const halfway = at0065();
		runMigrations({ database: halfway, migrationsDir: filesTo(FILE_0066) });
		const atHalfway = stateOf(halfway);
		// To 0068: 0069's setting (card 2772) would make up the row the secret's loss takes.
		const resumed = runMigrations({ database: halfway, migrationsDir: filesTo(FILE_0068) });
		expect(resumed.applied).toEqual([FILE_0067, FILE_0068]);
		const foundAfter: Findings = { problems: [], notes: [] };
		compare(atHalfway, stateOf(halfway), resumed.applied, foundAfter);
		expect(foundAfter).toEqual({
			problems: [],
			notes: [`settings had 3 row(s) and has 2: the remembered-browser secret deleted by ${FILE_0067}, a one-off declared in tests/rehearsal/one-offs.ts`]
		});

		// Signed in again after it, with a second factor: the next start deletes nothing.
		database.prepare('INSERT INTO sessions (id, user_id, expires_at, created_at, two_step) VALUES (?, 1, ?, ?, 1)').run(Buffer.alloc(32, 7), LATER, STAMP);
		const after = contentsOf(database);
		expect(runMigrations({ database, migrationsDir: REAL_MIGRATIONS }).applied).toEqual([]);
		expect(contentsOf(database)).toEqual(after);
		expect(database.prepare('SELECT COUNT(*) FROM sessions').pluck().get()).toBe(3);
	});

	it('T4, card 3064 T11: 0068, edited, keeps every unused invite as it was and gives every used one 32 random bytes as a BLOB, keeping the rest of its row; the rehearsal notes the one-off declared for invite_tokens as keeping its rows; and it runs once', () => {
		const sql = readFileSync(join(REAL_MIGRATIONS, FILE_0068), 'utf-8').replace(/\r\n/g, '\n');
		expect(sqlStatements(sql).map((s) => s.text)).toEqual(['UPDATE `invite_tokens` SET `token` = randomblob(32) WHERE `used` <> 0;']);
		for (const said of ['What people see:', 'Runs once.', 'A backup made before this file', 'Going back to an older image', 'card 3064']) {
			expect(sql, said).toContain(said);
		}
		expect(ONE_OFFS.filter((oneOff) => oneOff.file === FILE_0068)).toEqual([
			{ file: FILE_0068, table: 'invite_tokens', change: "every used invite's token replaced", keepsRows: true }
		]);
		expect(TOLERANT_FILES).not.toContain(FILE_0068);

		// At 0067, as the build before this one leaves a database: one invite
		// waiting and two used, each held as it was mailed.
		const database = at0065();
		runMigrations({ database, migrationsDir: filesTo(FILE_0067) });
		const [waiting, usedByCat, usedByDan] = [crypto.randomUUID(), crypto.randomUUID(), crypto.randomUUID()];
		const write = database.prepare('INSERT INTO invite_tokens (token, user_id, expires_at, used, created_at) VALUES (?, ?, ?, ?, ?)');
		write.run(waiting, 2, LATER, 0, STAMP);
		write.run(usedByCat, 3, LATER, 1, STAMP);
		write.run(usedByDan, 4, EARLIER, 1, STAMP);
		const restOfUsed = 'SELECT user_id, expires_at, used, created_at FROM invite_tokens WHERE used <> 0 ORDER BY user_id';
		const kept = database.prepare(restOfUsed).all();
		const state = stateOf(database);
		// To 0068 and no further: 0069 (card 2772) is a file of its own, tested below.
		const dir = filesTo(FILE_0068);

		const report = runMigrations({ database, migrationsDir: dir });

		expect(report.applied).toEqual([FILE_0068]);
		expect(report.schemaDifferences).toEqual([TABLE_OF_0079, TABLE_OF_0077, TABLE_OF_0076, COLUMN_OF_0069, TABLE_OF_0083, COLUMN_OF_0082, TABLE_OF_0082, TABLE_OF_0081, notInTheDatabase('request_links'), COLUMN_OF_0084, TABLE_OF_0074, ...MODEL_LINES_OF_0078, USERS_COLUMN_OF_0069, ...MODEL_LINES_OF_0072, TABLE_OF_0075, ...MODEL_LINES_OF_0071_AND_0073]);
		// The invite waiting is kept as it was mailed, for 0084 to hash in place (card 3064).
		expect(database.prepare('SELECT token, user_id, expires_at, created_at FROM invite_tokens WHERE used = 0').all()).toEqual([
			{ token: waiting, user_id: 2, expires_at: LATER, created_at: STAMP }
		]);
		expect(database.prepare(restOfUsed).all()).toEqual(kept);
		const tokens = database.prepare('SELECT token FROM invite_tokens WHERE used <> 0 ORDER BY user_id').pluck().all() as Buffer[];
		expect(database.prepare('SELECT typeof(token) AS type, length(token) AS bytes FROM invite_tokens WHERE used <> 0').all()).toEqual([
			{ type: 'blob', bytes: 32 },
			{ type: 'blob', bytes: 32 }
		]);
		expect(tokens[0].equals(tokens[1])).toBe(false);
		const everything = JSON.stringify(database.prepare('SELECT * FROM invite_tokens WHERE used <> 0').all());
		for (const old of [usedByCat, usedByDan]) expect(everything).not.toContain(old);
		const found: Findings = { problems: [], notes: [] };
		compare(state, stateOf(database), report.applied, found);
		expect(found).toEqual({
			problems: [],
			notes: [`invite_tokens: every used invite's token replaced in its 3 row(s) by ${FILE_0068}, a one-off declared in tests/rehearsal/one-offs.ts`]
		});

		// Runs once: the next start applies nothing and changes nothing.
		const after = contentsOf(database);
		expect(runMigrations({ database, migrationsDir: dir }).applied).toEqual([]);
		expect(contentsOf(database)).toEqual(after);
	});

	// Card 2772, T11: the deadline of every API key made before that release.
	it('T11: 0069 gives a key with no expiry and one expiring after the deadline the deadline, 60 days from the run, and leaves one expiring before it; the setting is written once; the rehearsal notes the one-off declared for api_keys; and it runs once', () => {
		const sql = readFileSync(join(REAL_MIGRATIONS, FILE_0069), 'utf-8').replace(/\r\n/g, '\n');
		expect(sqlStatements(sql).map((s) => s.text)).toEqual([
			'ALTER TABLE `api_keys` ADD COLUMN `deadline_at` text;',
			"INSERT INTO `settings` (`key`, `value`) VALUES ('api_key_deadline', datetime('now', '+60 days'))\n  ON CONFLICT (`key`) DO NOTHING;",
			"UPDATE `api_keys` SET `deadline_at` = (SELECT `value` FROM `settings` WHERE `key` = 'api_key_deadline')\n" +
				'WHERE `expires_at` IS NULL\n' +
				"   OR `expires_at` > (SELECT `value` FROM `settings` WHERE `key` = 'api_key_deadline');",
			// The latest security signal's moment (card 2772's code review, CS1).
			'ALTER TABLE `users` ADD COLUMN `security_signal_last_at` text;'
		]);
		for (const said of ['What people see:', 'Runs once.', 'A backup made before this file', 'Going back to an older image', 'users.security_signal_last_at']) {
			expect(sql, said).toContain(said);
		}
		expect(ONE_OFFS.filter((oneOff) => oneOff.file === FILE_0069)).toEqual([
			{
				file: FILE_0069,
				table: 'api_keys',
				change: 'deadline_at set for every key with no expiry or one later than the deadline',
				keepsRows: true
			}
		]);
		expect(TOLERANT_FILES).not.toContain(FILE_0069);

		// At 0068, as the build before this one leaves a database: three keys,
		// with no expiry, expiring in two years, and expiring in 30 days.
		const database = at0065();
		runMigrations({ database, migrationsDir: filesTo(FILE_0068) });
		const day = 86_400_000;
		const write = database.prepare('INSERT INTO api_keys (key_hash, key_prefix, name, user_id, expires_at, created_at) VALUES (?, ?, ?, ?, ?, ?)');
		write.run('hash-none', 'df_none', 'No expiry', 1, null, STAMP);
		write.run('hash-late', 'df_late', 'Two years', 1, stamp(new Date(Date.now() + 730 * day)), STAMP);
		write.run('hash-soon', 'df_soon', 'Thirty days', 1, stamp(new Date(Date.now() + 30 * day)), STAMP);
		const restOf = 'SELECT id, key_hash, key_prefix, name, user_id, last_used_at, expires_at, created_at FROM api_keys ORDER BY id';
		const kept = database.prepare(restOf).all();
		const state = stateOf(database);
		// To 0083 and no further: 0084 takes the deadline back (card 3064, its own cases).
		const dir = filesTo(FILE_0083);

		const report = runMigrations({ database, migrationsDir: dir });

		expect(report.applied).toEqual([FILE_0069, FILE_0070, FILE_0071, FILE_0072, FILE_0073, FILE_0074, FILE_0075, FILE_0076, FILE_0077, FILE_0078, FILE_0079, FILE_0080, FILE_0081, FILE_0082, FILE_0083]);
		expect(report.schemaDifferences).toEqual([COLUMN_OF_0084]);
		// The setting, 60 days from the run, in the stored form of a moment, written once.
		const settings = database.prepare("SELECT value FROM settings WHERE key = 'api_key_deadline'").pluck().all() as string[];
		expect(settings).toHaveLength(1);
		const [deadline] = settings;
		expect(deadline).toMatch(/^\d{4}-\d{2}-\d{2} \d{2}:\d{2}:\d{2}$/);
		expect(Math.abs(momentOf(deadline) - (Date.now() + 60 * day))).toBeLessThan(60_000);
		// The deadline on the two that end after it, to the second; the one that ends before it has none.
		expect(database.prepare('SELECT name, deadline_at FROM api_keys ORDER BY id').all()).toEqual([
			{ name: 'No expiry', deadline_at: deadline },
			{ name: 'Two years', deadline_at: deadline },
			{ name: 'Thirty days', deadline_at: null }
		]);
		// Every other cell of every key as it was.
		expect(database.prepare(restOf).all()).toEqual(kept);
		// Every account gains the latest signal's moment, NULL (CS1): its banner, if any, is read by security_banner_at.
		const accounts = database.prepare('SELECT security_signal_last_at FROM users').pluck().all();
		expect(accounts.length).toBeGreaterThan(0);
		expect(accounts.every((at) => at === null)).toBe(true);
		const found: Findings = { problems: [], notes: [] };
		compare(state, stateOf(database), report.applied, found);
		expect(found).toEqual({
			problems: [],
			notes: [
				// The deadline, and 0071's moment keys began to be recorded (card 2752).
				'settings had 2 row(s) and has 4: a migration put the others there',
				`api_keys: deadline_at set for every key with no expiry or one later than the deadline in its 3 row(s) by ${FILE_0069}, ` +
					'a one-off declared in tests/rehearsal/one-offs.ts'
			]
		});

		// Runs once: the next start applies nothing and changes nothing.
		const after = contentsOf(database);
		expect(runMigrations({ database, migrationsDir: dir }).applied).toEqual([]);
		expect(contentsOf(database)).toEqual(after);
	});
});

// ─── 0070: requester links kept as hashes ────────────────────────────────────

describe('0070, which keeps requester links as hashes (card 2870), its end of every link held in plain taken out (card 3064)', () => {
	// Card 2870, T9; card 3064, T12.
	it('T9, card 3064 T12: 0070, edited, makes request_links, with its cascade and indexes, keeps every access_token and changes nothing else; it declares nothing to the rehearsal; it runs once, and no backfill fills the column again', () => {
		// (1) The table and its two indexes as the model prints them, and nothing else.
		const sql = readFileSync(join(REAL_MIGRATIONS, FILE_0070), 'utf-8').replace(/\r\n/g, '\n');
		const ofTheModel = EXPECTED_SCHEMA.filter((s) => s.startsWith('CREATE TABLE `request_links` (') || s.includes(' ON `request_links` ('));
		expect(ofTheModel).toHaveLength(3);
		expect(sqlStatements(sql).map((s) => s.text)).toEqual(ofTheModel);
		// (2) The header (card 2106, decision 3).
		for (const said of ['What people see:', 'Runs once.', 'A backup made before this file', 'Going back to an older image', 'card 3064']) {
			expect(sql, said).toContain(said);
		}
		// (3) Declares nothing to the rehearsal, and not tolerated.
		expect(ONE_OFFS.filter((oneOff) => oneOff.file === FILE_0070)).toEqual([]);
		expect(TOLERANT_FILES).not.toContain(FILE_0070);

		// (4) At 0069, as the build before this one leaves a database: three
		// requests, open, settled and unconfirmed, each holding its token as mailed.
		const database = memoryDb();
		runMigrations({ database, migrationsDir: filesTo(FILE_0069) });
		database.exec("INSERT INTO users (id, username, email, password_hash) VALUES (1, 'ann', 'ann@example.test', 'x')");
		const insert = database.prepare(
			"INSERT INTO task_requests (target_type, target_id, title, requester_name, requester_email, status, access_token) VALUES ('user', 1, ?, 'Rita', 'rita@example.test', ?, ?)"
		);
		insert.run('Open', 'pending', '1'.repeat(64));
		insert.run('Settled', 'accepted', '2'.repeat(64));
		insert.run('Unconfirmed', 'unverified', '3'.repeat(64));
		const before = contentsOf(database);
		const state = stateOf(database);
		// To 0070 and no further: 0084 moves the tokens (card 3064, its own cases).
		const dir = filesTo(FILE_0070);

		const report = runMigrations({ database, migrationsDir: dir });

		expect(report.applied).toEqual([FILE_0070]);
		expect(report.schemaDifferences).toEqual([TABLE_OF_0079, TABLE_OF_0077, TABLE_OF_0076, TABLE_OF_0083, COLUMN_OF_0082, TABLE_OF_0082, TABLE_OF_0081, COLUMN_OF_0084, TABLE_OF_0074, ...MODEL_LINES_OF_0078, ...MODEL_LINES_OF_0072, TABLE_OF_0075, ...MODEL_LINES_OF_0071_AND_0073]);
		// Every request keeps its token as it was mailed, and every table but the migration record is as it was.
		expect(database.prepare('SELECT access_token FROM task_requests ORDER BY id').pluck().all()).toEqual(['1'.repeat(64), '2'.repeat(64), '3'.repeat(64)]);
		const after = contentsOf(database);
		for (const table of Object.keys(before)) {
			if (['__drizzle_migrations', 'sqlite_sequence'].includes(table)) continue;
			expect(after[table], table).toEqual(before[table]);
		}
		expect(after.request_links).toEqual([]);
		// The key to task_requests, ON DELETE CASCADE, and both indexes.
		expect(
			(database.prepare('PRAGMA foreign_key_list(request_links)').all() as { table: string; from: string; to: string; on_delete: string }[]).map(
				({ table, from, to, on_delete }) => ({ table, from, to, on_delete })
			)
		).toEqual([{ table: 'task_requests', from: 'request_id', to: 'id', on_delete: 'CASCADE' }]);
		expect(
			(database.prepare('PRAGMA index_list(request_links)').all() as { name: string; unique: number }[])
				.map(({ name, unique }) => ({ name, unique }))
				.sort((a, b) => a.name.localeCompare(b.name))
		).toEqual([
			{ name: 'idx_request_links_request_id', unique: 0 },
			{ name: 'request_links_token_hash_unique', unique: 1 }
		]);
		// The rehearsal: every row kept, and nothing to note.
		const found: Findings = { problems: [], notes: [] };
		compare(state, stateOf(database), report.applied, found);
		expect(found).toEqual({ problems: [], notes: [] });
		// A request deleted takes its links with it.
		const link = database.prepare("INSERT INTO request_links (token_hash, request_id, source) VALUES (?, ?, 'mail')");
		link.run('a'.repeat(64), 1);
		link.run('b'.repeat(64), 1);
		link.run('c'.repeat(64), 2);
		database.prepare('DELETE FROM task_requests WHERE id = 1').run();
		expect(database.prepare('SELECT request_id FROM request_links').pluck().all()).toEqual([2]);

		// (5) Runs once: the next start applies nothing. Then 0084 empties the column (card 3064), and no backfill fills
		// it again.
		expect(runMigrations({ database, migrationsDir: dir }).applied).toEqual([]);
		expect(runMigrations({ database, migrationsDir: REAL_MIGRATIONS }).applied).toContain(FILE_0084);
		const again = runMigrations({ database, migrationsDir: REAL_MIGRATIONS });
		expect(again.applied).toEqual([]);
		expect(database.prepare('SELECT access_token FROM task_requests').pluck().all()).toEqual([null, null]);
	});
});

// ─── 0071: why and when a webhook was switched off, and the key that set it ──

describe('0071, which adds why and when a webhook was switched off for good, and the key that set it (cards 2752 and 2893)', () => {
	it('is the four columns, the index and the setting, after a header comment, and declares nothing to the rehearsal', () => {
		const sql = readFileSync(join(REAL_MIGRATIONS, FILE_0071), 'utf-8').replace(/\r\n/g, '\n');
		expect(sqlStatements(sql).map((s) => s.text)).toEqual([
			'ALTER TABLE `webhooks` ADD COLUMN `held_because` text;',
			'ALTER TABLE `webhooks` ADD COLUMN `held_at` text;',
			'ALTER TABLE `webhooks` ADD COLUMN `set_by_key` integer REFERENCES `api_keys`(`id`) ON DELETE SET NULL;',
			'ALTER TABLE `webhooks` ADD COLUMN `set_with_key` integer;',
			'CREATE INDEX `idx_webhooks_set_by_key` ON `webhooks` (`set_by_key`);',
			"INSERT INTO `settings` (`key`, `value`) VALUES ('webhook_keys_recorded_at', datetime('now'));"
		]);
		for (const said of ['A one-off change to data', 'Changes no webhook', 'Runs once.', 'A backup made before this file', 'Going back to an older image']) {
			expect(sql, said).toContain(said);
		}
		// It takes and rewrites no row: the new setting is a row the rehearsal notes, as 0069's was.
		expect(ONE_OFFS.filter((oneOff) => oneOff.file === FILE_0071)).toEqual([]);
		expect(TOLERANT_FILES).not.toContain(FILE_0071);
	});

	it('applies to a database at 0070 holding webhooks: each gains the four columns NULL, the setting is written once, a key deleted empties set_by_key, and it runs once', () => {
		const database = memoryDb();
		runMigrations({ database, migrationsDir: filesTo(FILE_0070) });
		database.exec(`
			INSERT INTO users (id, username, email, password_hash) VALUES (1, 'ann', 'ann@example.test', 'x');
			INSERT INTO boards (id, name, created_by) VALUES (1, 'A', 1);
			INSERT INTO api_keys (id, key_hash, key_prefix, name, user_id) VALUES (7, 'hash-of-ann', 'df_ann', 'Ann''s key', 1);
			INSERT INTO webhooks (id, board_id, url, secret, active, set_by) VALUES (1, 1, 'https://hooks.example.test/on', 's3cret', 1, 1);
			INSERT INTO webhooks (id, board_id, url, secret, active, set_by) VALUES (2, 1, 'https://hooks.example.test/off', '', 0, NULL);
		`);
		const before = contentsOf(database);
		const state = stateOf(database);
		// To 0083 and no further: 0084 marks these webhooks set with no key (card 3064, its own cases).
		const dir = filesTo(FILE_0083);

		const report = runMigrations({ database, migrationsDir: dir });

		expect(report.applied).toEqual([FILE_0071, FILE_0072, FILE_0073, FILE_0074, FILE_0075, FILE_0076, FILE_0077, FILE_0078, FILE_0079, FILE_0080, FILE_0081, FILE_0082, FILE_0083]);
		expect(report.schemaDifferences).toEqual([COLUMN_OF_0084]);
		expect(database.prepare('SELECT id, active, held_because, held_at, set_by_key, set_with_key FROM webhooks ORDER BY id').all()).toEqual([
			{ id: 1, active: 1, held_because: null, held_at: null, set_by_key: null, set_with_key: null },
			{ id: 2, active: 0, held_because: null, held_at: null, set_by_key: null, set_with_key: null }
		]);
		// Every other cell of every webhook, and every other table, as it was; settings gains the moment it ran.
		const after = contentsOf(database);
		for (const table of Object.keys(before)) {
			// The board's Options column is the start's (card 2527), not this file's. Every account gains 0072's two columns NULL (card 2671).
			if (['columns', '__drizzle_migrations', 'sqlite_sequence'].includes(table)) continue;
			expect(after[table], table).toEqual(
				table === 'users'
					? withColumns(before[table], USERS_COLUMNS_OF_0072)
					: table === 'webhooks'
						? withColumns(before[table], { ...WEBHOOK_COLUMNS_OF_0071, ...WEBHOOK_COLUMNS_OF_0073 })
						: table === 'settings'
							? [...before[table], expect.stringMatching(/^\{"key":"webhook_keys_recorded_at","value":"\d{4}-\d{2}-\d{2} \d{2}:\d{2}:\d{2}"\}$/)]
							: before[table]
			);
		}
		expect(database.prepare("SELECT value FROM settings WHERE key = 'webhook_keys_recorded_at'").pluck().all()).toEqual([
			expect.stringMatching(/^\d{4}-\d{2}-\d{2} \d{2}:\d{2}:\d{2}$/)
		]);
		expect(indexesOf(database)).toContain('idx_webhooks_set_by_key');
		expect(database.prepare('PRAGMA foreign_key_list(webhooks)').all()).toContainEqual(
			expect.objectContaining({ table: 'api_keys', from: 'set_by_key', to: 'id', on_delete: 'SET NULL' })
		);
		// The rehearsal: every row kept, and the setting noted as a row the migration put there.
		const found: Findings = { problems: [], notes: [] };
		compare(state, stateOf(database), report.applied, found);
		expect(found).toEqual({
			problems: [],
			notes: [
				'columns had 0 row(s) and has 1: each delivery board that had none was given its Options column at the start (card 2527)',
				'settings had 2 row(s) and has 3: a migration put the others there'
			]
		});

		// A key's delete empties set_by_key.
		expect(foreignKeysOn(database)).toBe(true);
		database.prepare('UPDATE webhooks SET set_by_key = 7, set_with_key = 1 WHERE id = 1').run();
		database.prepare('DELETE FROM api_keys WHERE id = 7').run();
		expect(database.prepare('SELECT set_by_key, set_with_key FROM webhooks WHERE id = 1').get()).toEqual({ set_by_key: null, set_with_key: 1 });

		// Runs once: the next start applies nothing, and the setting is still the one row.
		const again = runMigrations({ database, migrationsDir: dir });
		expect(again.applied).toEqual([]);
		expect(database.prepare("SELECT COUNT(*) FROM settings WHERE key = 'webhook_keys_recorded_at'").pluck().get()).toBe(1);
	});
});

// ─── 0072: when an account was disabled, and by whom ─────────────────────────

describe('0072, which adds when an account was disabled and by whom (card 2671)', () => {
	it('is the two columns and the index, after a header comment, and declares nothing to the rehearsal', () => {
		const sql = readFileSync(join(REAL_MIGRATIONS, FILE_0072), 'utf-8').replace(/\r\n/g, '\n');
		expect(sqlStatements(sql).map((s) => s.text)).toEqual([
			'ALTER TABLE `users` ADD COLUMN `disabled_at` text;',
			'ALTER TABLE `users` ADD COLUMN `disabled_by` integer REFERENCES `users`(`id`) ON DELETE SET NULL;',
			'CREATE INDEX `idx_users_disabled_by` ON `users` (`disabled_by`);'
		]);
		for (const said of ['disableAccount', 'carryDisabled', "card 2106's rule", 'No IF NOT EXISTS, as 0063', 'Runs once.', 'A backup made before this file', 'Going back to an older image']) {
			expect(sql, said).toContain(said);
		}
		// It takes and rewrites no row.
		expect(ONE_OFFS.filter((oneOff) => oneOff.file === FILE_0072)).toEqual([]);
		expect(TOLERANT_FILES).not.toContain(FILE_0072);
	});

	it('applies to a database at 0071 holding accounts: each gains both columns NULL, the key and the index, a disabler deleted empties disabled_by, and it runs once (case 44)', () => {
		const database = memoryDb();
		runMigrations({ database, migrationsDir: filesTo(FILE_0071) });
		// Before 0072 the model check reports its columns, key and index, 0073's column (card 2928) and 0074's table
		// (card 2922), nothing else.
		expect(schemaDifferences(database)).toEqual([TABLE_OF_0079, TABLE_OF_0077, TABLE_OF_0076, TABLE_OF_0083, COLUMN_OF_0082, TABLE_OF_0082, TABLE_OF_0081, COLUMN_OF_0084, TABLE_OF_0074, ...MODEL_LINES_OF_0078, ...MODEL_LINES_OF_0072, TABLE_OF_0075, MODEL_LINE_OF_0073]);
		database.exec(`
			INSERT INTO users (id, username, email, password_hash, role) VALUES (1, 'chief', 'chief@example.test', 'x', 'superadmin');
			INSERT INTO users (id, username, email, password_hash) VALUES (2, 'bob', 'bob@example.test', 'x');
		`);
		const before = contentsOf(database);
		const state = stateOf(database);

		const report = runMigrations({ database, migrationsDir: REAL_MIGRATIONS });

		expect(report.applied).toEqual([FILE_0072, FILE_0073, FILE_0074, FILE_0075, FILE_0076, FILE_0077, FILE_0078, FILE_0079, FILE_0080, FILE_0081, FILE_0082, FILE_0083, FILE_0084]);
		expect(report.schemaDifferences).toEqual([]);
		expect(database.prepare('SELECT id, disabled_at, disabled_by FROM users ORDER BY id').all()).toEqual([
			{ id: 1, disabled_at: null, disabled_by: null },
			{ id: 2, disabled_at: null, disabled_by: null }
		]);
		// Every other cell of every account, and every other table, as it was.
		const after = contentsOf(database);
		for (const table of Object.keys(before)) {
			if (['__drizzle_migrations', 'sqlite_sequence'].includes(table)) continue;
			// And for what 0084 changes, applied in the same run (card 3064).
			expect(after[table], table).toEqual(as0084Leaves(table, table === 'users' ? withColumns(before[table], USERS_COLUMNS_OF_0072) : before[table]));
		}
		expect(indexesOf(database)).toContain('idx_users_disabled_by');
		expect(database.prepare('PRAGMA foreign_key_list(users)').all()).toContainEqual(
			expect.objectContaining({ table: 'users', from: 'disabled_by', to: 'id', on_delete: 'SET NULL' })
		);
		// The rehearsal: every row kept, nothing to note but 0084's, applied in the same run (card 3064): its nine settings
		// in place of the two it takes back, and its one-off declared for users.
		const found: Findings = { problems: [], notes: [] };
		compare(state, stateOf(database), report.applied, found);
		expect(found).toEqual({ problems: [], notes: ['settings had 3 row(s) and has 10: a migration put the others there', ...NOTES_OF_0084({ users: 2 })] });

		// The disabler deleted empties disabled_by, and the account stays disabled.
		expect(foreignKeysOn(database)).toBe(true);
		database.prepare("UPDATE users SET disabled_at = '2099-01-01 09:00:00', disabled_by = 1 WHERE id = 2").run();
		database.prepare('DELETE FROM users WHERE id = 1').run();
		expect(database.prepare('SELECT disabled_at, disabled_by FROM users WHERE id = 2').get()).toEqual({ disabled_at: '2099-01-01 09:00:00', disabled_by: null });

		// Runs once: the next start applies nothing.
		expect(runMigrations({ database, migrationsDir: REAL_MIGRATIONS }).applied).toEqual([]);
	});
});

// ─── 0073: the receiver beside a webhook's sealed address ────────────────────

describe('0073, which adds the receiver a webhook sends to beside its sealed address (card 2928)', () => {
	it('is the one column, after a header comment, and declares nothing to the rehearsal', () => {
		const sql = readFileSync(join(REAL_MIGRATIONS, FILE_0073), 'utf-8').replace(/\r\n/g, '\n');
		expect(sqlStatements(sql).map((s) => s.text)).toEqual(["ALTER TABLE `webhooks` ADD COLUMN `receiver` text DEFAULT '' NOT NULL;"]);
		for (const said of ['receiverOf', 'sealPlainSecrets', 'sealedForRestore', 'No IF NOT EXISTS, as 0063', 'Runs once', 'A backup made before this file', 'Going back to an older image']) {
			expect(sql, said).toContain(said);
		}
		expect(ONE_OFFS.filter((oneOff) => oneOff.file === FILE_0073)).toEqual([]);
		expect(TOLERANT_FILES).not.toContain(FILE_0073);
	});

	it("14: applies to a database at 0072 holding webhooks: each gains receiver '', no other cell changes, and it runs once", () => {
		const database = memoryDb();
		runMigrations({ database, migrationsDir: filesTo(FILE_0072) });
		// Before 0073 the model check reports its column and 0074's table (card 2922), and nothing else.
		expect(schemaDifferences(database)).toEqual([TABLE_OF_0079, TABLE_OF_0077, TABLE_OF_0076, TABLE_OF_0083, COLUMN_OF_0082, TABLE_OF_0082, TABLE_OF_0081, COLUMN_OF_0084, TABLE_OF_0074, ...MODEL_LINES_OF_0078, TABLE_OF_0075, MODEL_LINE_OF_0073]);
		database.exec(`
			INSERT INTO users (id, username, email, password_hash, role) VALUES (1, 'chief', 'chief@example.test', 'x', 'superadmin');
			INSERT INTO boards (id, name, created_by) VALUES (1, 'A', 1);
			INSERT INTO webhooks (id, board_id, url, secret, active, set_by) VALUES (1, 1, 'https://hooks.example.test/T/B/x', 's3cret', 1, 1);
			INSERT INTO webhooks (id, board_id, url, secret, active, set_by) VALUES (2, 1, 'https://hooks.example.test/off', '', 0, NULL);
		`);
		const before = contentsOf(database);
		const state = stateOf(database);

		const report = runMigrations({ database, migrationsDir: REAL_MIGRATIONS });

		expect(report.applied).toEqual([FILE_0073, FILE_0074, FILE_0075, FILE_0076, FILE_0077, FILE_0078, FILE_0079, FILE_0080, FILE_0081, FILE_0082, FILE_0083, FILE_0084]);
		expect(report.schemaDifferences).toEqual([]);
		// The start fills it as it seals each address, not the file: SQL cannot read a URL as Node does.
		expect(database.prepare('SELECT id, receiver FROM webhooks ORDER BY id').all()).toEqual([
			{ id: 1, receiver: '' },
			{ id: 2, receiver: '' }
		]);
		const after = contentsOf(database);
		for (const table of Object.keys(before)) {
			// The board's Options column is the start's (card 2527), not this file's.
			if (['columns', '__drizzle_migrations', 'sqlite_sequence'].includes(table)) continue;
			// And for what 0084 changes, applied in the same run (card 3064).
			expect(after[table], table).toEqual(as0084Leaves(table, table === 'webhooks' ? withColumns(before[table], WEBHOOK_COLUMNS_OF_0073) : before[table]));
		}
		const found: Findings = { problems: [], notes: [] };
		compare(state, stateOf(database), report.applied, found);
		expect(found.problems).toEqual([]);

		expect(runMigrations({ database, migrationsDir: REAL_MIGRATIONS }).applied).toEqual([]);
	});
});

// ─── 0074: the settings held for review ─────────────────────────────────────

describe('0074, which adds the settings held for the superadmin’s review (card 2922)', () => {
	it('is the one table, after a header comment, and declares nothing to the rehearsal', () => {
		const sql = readFileSync(join(REAL_MIGRATIONS, FILE_0074), 'utf-8').replace(/\r\n/g, '\n');
		expect(sqlStatements(sql).map((s) => s.text.replace(/\s+/g, ' '))).toEqual([
			'CREATE TABLE `setting_holds` ( `setting` text NOT NULL, `place` text NOT NULL, `held_because` text NOT NULL, `held_at` text NOT NULL, ' +
				'`set_by` integer, `set_by_name` text, PRIMARY KEY(`setting`, `place`) );'
		]);
		for (const said of ['Only the superadmin', 'No foreign key', 'carrySettingHolds', 'Going back to an older image']) {
			expect(sql, said).toContain(said);
		}
		expect(ONE_OFFS.filter((oneOff) => oneOff.file === FILE_0074)).toEqual([]);
		expect(TOLERANT_FILES).not.toContain(FILE_0074);
	});

	it('case 29: applies to a database at 0073 with rows: makes the empty table, changes no other cell, leaves the model clean, and runs once', () => {
		const database = memoryDb();
		runMigrations({ database, migrationsDir: filesTo(FILE_0073) });
		// Before 0074 the model check reports its table, 0075's (card 2947) and 0076's (card 2995), and nothing else.
		expect(schemaDifferences(database)).toEqual([TABLE_OF_0079, TABLE_OF_0077, TABLE_OF_0076, TABLE_OF_0083, COLUMN_OF_0082, TABLE_OF_0082, TABLE_OF_0081, COLUMN_OF_0084, TABLE_OF_0074, ...MODEL_LINES_OF_0078, TABLE_OF_0075]);
		database.exec(`
			INSERT INTO users (id, username, email, password_hash, role) VALUES (1, 'chief', 'chief@example.test', 'x', 'superadmin');
			INSERT INTO setting_setters (setting, place, user_id) VALUES ('mail', 'a-place', 1);
			INSERT INTO settings (key, value) VALUES ('smtp_host', 'smtp.example.test');
		`);
		const before = contentsOf(database);
		const state = stateOf(database);

		const report = runMigrations({ database, migrationsDir: REAL_MIGRATIONS });

		expect(report.applied).toEqual([FILE_0074, FILE_0075, FILE_0076, FILE_0077, FILE_0078, FILE_0079, FILE_0080, FILE_0081, FILE_0082, FILE_0083, FILE_0084]);
		expect(report.schemaDifferences).toEqual([]);
		expect(database.prepare('SELECT COUNT(*) AS n FROM setting_holds').get()).toEqual({ n: 0 });
		const after = contentsOf(database);
		for (const table of Object.keys(before)) {
			if (['columns', '__drizzle_migrations', 'sqlite_sequence'].includes(table)) continue;
			// But for what 0084 changes, applied in the same run (card 3064).
			expect(after[table], table).toEqual(as0084Leaves(table, before[table]));
		}
		const found: Findings = { problems: [], notes: [] };
		compare(state, stateOf(database), report.applied, found);
		expect(found.problems).toEqual([]);

		expect(runMigrations({ database, migrationsDir: REAL_MIGRATIONS }).applied).toEqual([]);
	});
});

// ─── 0075: which API key was given which webhook's secret ───────────────────

describe('0075, which records which API key was given which webhook’s secret (card 2947)', () => {
	it('is the one table and its index, after a header comment, and declares nothing to the rehearsal', () => {
		const sql = readFileSync(join(REAL_MIGRATIONS, FILE_0075), 'utf-8').replace(/\r\n/g, '\n');
		expect(sqlStatements(sql).map((s) => s.text.replace(/\s+/g, ' '))).toEqual([
			'CREATE TABLE `webhook_reveals` ( `webhook_id` integer NOT NULL, `key_id` integer NOT NULL, `revealed_at` text, ' +
				'PRIMARY KEY(`webhook_id`, `key_id`), ' +
				'FOREIGN KEY (`webhook_id`) REFERENCES `webhooks`(`id`) ON UPDATE no action ON DELETE cascade, ' +
				'FOREIGN KEY (`key_id`) REFERENCES `api_keys`(`id`) ON UPDATE no action ON DELETE cascade );',
			'CREATE INDEX `idx_webhook_reveals_key_id` ON `webhook_reveals` (`key_id`);'
		]);
		for (const said of ['answerWebhook', 'Both foreign keys cascade', 'the seed runs', 'Going back to an older image']) {
			expect(sql, said).toContain(said);
		}
		expect(ONE_OFFS.filter((oneOff) => oneOff.file === FILE_0075)).toEqual([]);
		expect(TOLERANT_FILES).not.toContain(FILE_0075);
	});

	it('applies to a database at 0074 with rows: makes the empty table and its index, changes no other cell, both keys cascade, and runs once', () => {
		const database = memoryDb();
		runMigrations({ database, migrationsDir: filesTo(FILE_0074) });
		// Before 0075 the model check reports its table and 0076's (card 2995), and nothing else.
		expect(schemaDifferences(database)).toEqual([TABLE_OF_0079, TABLE_OF_0077, TABLE_OF_0076, TABLE_OF_0083, COLUMN_OF_0082, TABLE_OF_0082, TABLE_OF_0081, COLUMN_OF_0084, ...MODEL_LINES_OF_0078, TABLE_OF_0075]);
		database.exec(`
			INSERT INTO users (id, username, email, password_hash, role) VALUES (1, 'chief', 'chief@example.test', 'x', 'superadmin');
			INSERT INTO boards (id, name, created_by) VALUES (1, 'A', 1);
			INSERT INTO webhooks (id, board_id, url, secret, active, set_by) VALUES (1, 1, 'https://hooks.example.test/x', 's3cret', 1, 1);
			INSERT INTO api_keys (id, key_hash, key_prefix, name, user_id) VALUES (1, 'h1', 'df_1', 'k', 1), (2, 'h2', 'df_2', 'l', 1);
		`);
		const before = contentsOf(database);
		const state = stateOf(database);

		const report = runMigrations({ database, migrationsDir: REAL_MIGRATIONS });

		expect(report.applied).toEqual([FILE_0075, FILE_0076, FILE_0077, FILE_0078, FILE_0079, FILE_0080, FILE_0081, FILE_0082, FILE_0083, FILE_0084]);
		expect(report.schemaDifferences).toEqual([]);
		expect(database.prepare('SELECT COUNT(*) AS n FROM webhook_reveals').get()).toEqual({ n: 0 });
		expect(indexesOf(database)).toContain('idx_webhook_reveals_key_id');
		const after = contentsOf(database);
		for (const table of Object.keys(before)) {
			if (['columns', '__drizzle_migrations', 'sqlite_sequence'].includes(table)) continue;
			// But for what 0084 changes, applied in the same run (card 3064).
			expect(after[table], table).toEqual(as0084Leaves(table, before[table]));
		}
		const found: Findings = { problems: [], notes: [] };
		compare(state, stateOf(database), report.applied, found);
		expect(found.problems).toEqual([]);

		// A row goes with its key and with its webhook.
		expect(foreignKeysOn(database)).toBe(true);
		database.exec("INSERT INTO webhook_reveals (webhook_id, key_id, revealed_at) VALUES (1, 1, '2026-11-19 09:00:00'), (1, 2, NULL)");
		database.prepare('DELETE FROM api_keys WHERE id = 1').run();
		expect(database.prepare('SELECT webhook_id, key_id FROM webhook_reveals').all()).toEqual([{ webhook_id: 1, key_id: 2 }]);
		database.prepare('DELETE FROM webhooks WHERE id = 1').run();
		expect(database.prepare('SELECT COUNT(*) AS n FROM webhook_reveals').get()).toEqual({ n: 0 });

		expect(runMigrations({ database, migrationsDir: REAL_MIGRATIONS }).applied).toEqual([]);
	});
});

// ─── 0076: every API key ended on this server ───────────────────────────────

describe('0076, which records every API key ended on this server, its watermark and its once-only seed (card 2995)', () => {
	/** The record as the migration leaves it, without its moments. */
	const recordOf = (database: Database.Database) =>
		database.prepare('SELECT key_id AS id, key_hash AS hash, revoked_because AS because FROM api_key_revocations ORDER BY key_hash, key_id').all();
	/** Every moment it wrote is one in the stored form. */
	const momentsOf = (database: Database.Database) => database.prepare('SELECT DISTINCT revoked_at FROM api_key_revocations').pluck().all() as string[];

	it('is the table with its one key, then the watermark, then the seed, after a header comment, and declares nothing to the rehearsal', () => {
		const sql = readFileSync(join(REAL_MIGRATIONS, FILE_0076), 'utf-8').replace(/\r\n/g, '\n');
		const all = sqlStatements(sql).map((s) => s.text.replace(/\s+/g, ' '));
		// The guard first (card 2995's code review, FP5): a temporary table with a named CHECK, filled once, dropped.
		expect(all).toHaveLength(6);
		expect(all[0]).toMatch(/^CREATE TEMP TABLE `migration_0076_guard` \( `seed_rows` integer NOT NULL CONSTRAINT `migration 0076 would record more than 1,000,000 API key ids/);
		expect(all[0]).toContain('CHECK (`seed_rows` <= 1000000)');
		expect(all[1]).toMatch(/^INSERT INTO temp\.`migration_0076_guard`/);
		expect(all[2]).toBe('DROP TABLE temp.`migration_0076_guard`;');
		const statements = all.slice(3);
		expect(statements[0]).toBe(
			'CREATE TABLE `api_key_revocations` ( `key_id` integer NOT NULL, `key_hash` text NOT NULL, `revoked_at` text NOT NULL, ' +
				'`revoked_because` text NOT NULL, PRIMARY KEY(`key_hash`, `key_id`) );'
		);
		// No index but the key (R9): the hash is looked up by the key's first column.
		expect(statements.some((s) => /CREATE INDEX/i.test(s))).toBe(false);
		expect(statements[1]).toContain("'watermark', datetime('now'), 'before record'");
		expect(statements[2]).toContain("SELECT id, '', datetime('now'), 'before record' FROM ids WHERE id NOT IN (SELECT id FROM api_keys);");
		for (const said of ['never the key', 'endApiKeys', 'No foreign key', 'c6ed310', 'Going back to an older image']) {
			expect(sql, said).toContain(said);
		}
		expect(ONE_OFFS.filter((oneOff) => oneOff.file === FILE_0076)).toEqual([]);
		expect(TOLERANT_FILES).not.toContain(FILE_0076);
	});

	it('test 1: applies to a database at 0075 holding keys 1 to 5 with 2 and 5 deleted: seeds (2, \'\') and (5, \'\') before record, the watermark 5, and changes no other cell', () => {
		const database = memoryDb();
		runMigrations({ database, migrationsDir: filesTo(FILE_0075) });
		// Before 0076 the model check reports its table, and nothing else.
		expect(schemaDifferences(database)).toEqual([TABLE_OF_0079, TABLE_OF_0077, TABLE_OF_0076, TABLE_OF_0083, COLUMN_OF_0082, TABLE_OF_0082, TABLE_OF_0081, COLUMN_OF_0084, ...MODEL_LINES_OF_0078]);
		database.exec(`
			INSERT INTO users (id, username, email, password_hash, role) VALUES (1, 'chief', 'chief@example.test', 'x', 'superadmin');
			INSERT INTO api_keys (id, key_hash, key_prefix, name, user_id) VALUES (1, 'h1', 'df_1', 'a', 1), (2, 'h2', 'df_2', 'b', 1), (3, 'h3', 'df_3', 'c', 1), (4, 'h4', 'df_4', 'd', 1), (5, 'h5', 'df_5', 'e', 1);
			DELETE FROM api_keys WHERE id IN (2, 5);
		`);
		expect(sequenceIn(database, 'api_keys')).toBe(5);
		const before = contentsOf(database);
		const state = stateOf(database);

		const report = runMigrations({ database, migrationsDir: REAL_MIGRATIONS });

		expect(report.applied).toEqual([FILE_0076, FILE_0077, FILE_0078, FILE_0079, FILE_0080, FILE_0081, FILE_0082, FILE_0083, FILE_0084]);
		expect(report.schemaDifferences).toEqual([]);
		expect(recordOf(database)).toEqual([
			{ id: 2, hash: '', because: 'before record' },
			{ id: 5, hash: '', because: 'before record' },
			{ id: 5, hash: 'watermark', because: 'before record' }
		]);
		for (const at of momentsOf(database)) expect(at).toMatch(/^\d{4}-\d{2}-\d{2} \d{2}:\d{2}:\d{2}$/);
		const after = contentsOf(database);
		for (const table of Object.keys(before)) {
			if (['columns', '__drizzle_migrations', 'sqlite_sequence'].includes(table)) continue;
			// But for what 0084 changes, applied in the same run (card 3064).
			expect(after[table], table).toEqual(as0084Leaves(table, before[table]));
		}
		// The counter is not raised: the seed writes no api_keys row.
		expect(sequenceIn(database, 'api_keys')).toBe(5);
		const found: Findings = { problems: [], notes: [] };
		compare(state, stateOf(database), report.applied, found);
		expect(found.problems).toEqual([]);

		expect(runMigrations({ database, migrationsDir: REAL_MIGRATIONS }).applied).toEqual([]);
		expect(recordOf(database)).toHaveLength(3);
	});

	it('test 2: applies where no key was ever made: no seed row, and the watermark 0 (R1)', () => {
		const database = memoryDb();
		runMigrations({ database, migrationsDir: filesTo(FILE_0075) });
		database.exec("INSERT INTO users (id, username, email, password_hash, role) VALUES (1, 'chief', 'chief@example.test', 'x', 'superadmin');");
		expect(sequenceIn(database, 'api_keys')).toBeNull();

		const report = runMigrations({ database, migrationsDir: REAL_MIGRATIONS });

		expect(report.applied).toEqual([FILE_0076, FILE_0077, FILE_0078, FILE_0079, FILE_0080, FILE_0081, FILE_0082, FILE_0083, FILE_0084]);
		expect(report.schemaDifferences).toEqual([]);
		expect(recordOf(database)).toEqual([{ id: 0, hash: 'watermark', because: 'before record' }]);
		expect(sequenceIn(database, 'api_keys')).toBeNull();
	});

	it('(a): applies to a database at 0075 whose api_keys counter row was deleted, as Admin › Vacuum did before c6ed310, keys 1, 3 and 4 live: (2, \'\') and the watermark 4, nothing else changed', () => {
		const database = memoryDb();
		runMigrations({ database, migrationsDir: filesTo(FILE_0075) });
		database.exec(`
			INSERT INTO users (id, username, email, password_hash, role) VALUES (1, 'chief', 'chief@example.test', 'x', 'superadmin');
			INSERT INTO api_keys (id, key_hash, key_prefix, name, user_id) VALUES (1, 'h1', 'df_1', 'a', 1), (2, 'h2', 'df_2', 'b', 1), (3, 'h3', 'df_3', 'c', 1), (4, 'h4', 'df_4', 'd', 1);
			DELETE FROM api_keys WHERE id = 2;
			DELETE FROM sqlite_sequence WHERE name = 'api_keys';
		`);
		expect(sequenceIn(database, 'api_keys')).toBeNull();
		const keysBefore = database.prepare('SELECT * FROM api_keys ORDER BY id').all();
		// The counters but the migration record's, which the runner raises by one as it records the file.
		// But request_links's, which 0084's move of requester links writes, at 0 where it moves none (card 3064).
		const counters = () => database.prepare("SELECT name, seq FROM sqlite_sequence WHERE name NOT IN ('__drizzle_migrations', 'request_links') ORDER BY name").all();
		const countersBefore = counters();

		const report = runMigrations({ database, migrationsDir: REAL_MIGRATIONS });

		expect(report.applied).toEqual([FILE_0076, FILE_0077, FILE_0078, FILE_0079, FILE_0080, FILE_0081, FILE_0082, FILE_0083, FILE_0084]);
		expect(recordOf(database)).toEqual([
			{ id: 2, hash: '', because: 'before record' },
			{ id: 4, hash: 'watermark', because: 'before record' }
		]);
		expect(database.prepare('SELECT * FROM api_keys ORDER BY id').all()).toEqual(keysBefore);
		expect(counters()).toEqual(countersBefore);
		expect(report.schemaDifferences).toEqual([]);
		expect(schemaDifferences(database)).toEqual([]);
	});

	it('FP5: halts, applying nothing of it, where W less the keys held is more than 1,000,000, saying why', () => {
		const database = memoryDb();
		runMigrations({ database, migrationsDir: filesTo(FILE_0075) });
		database.exec(`
			INSERT INTO users (id, username, email, password_hash, role) VALUES (1, 'chief', 'chief@example.test', 'x', 'superadmin');
			INSERT INTO api_keys (id, key_hash, key_prefix, name, user_id) VALUES (1, 'h1', 'df_1', 'a', 1);
			UPDATE sqlite_sequence SET seq = 1000002 WHERE name = 'api_keys';
		`);

		expect(() => runMigrations({ database, migrationsDir: REAL_MIGRATIONS })).toThrow(
			/migration 0076 would record more than 1,000,000 API key ids this server no longer holds/
		);
		expect(database.prepare("SELECT name FROM sqlite_master WHERE name IN ('api_key_revocations', 'migration_0076_guard')").all()).toEqual([]);
		expect(database.prepare("SELECT name FROM sqlite_temp_master WHERE name = 'migration_0076_guard'").all()).toEqual([]);
		expect(recordedIn(database)).toHaveLength(81);

		// A million exactly is seeded, one row per id.
		database.prepare("UPDATE sqlite_sequence SET seq = 1000001 WHERE name = 'api_keys'").run();
		expect(runMigrations({ database, migrationsDir: REAL_MIGRATIONS }).applied).toEqual([FILE_0076, FILE_0077, FILE_0078, FILE_0079, FILE_0080, FILE_0081, FILE_0082, FILE_0083, FILE_0084]);
		expect(database.prepare("SELECT count(*) AS n FROM api_key_revocations WHERE key_hash = ''").get()).toEqual({ n: 1000000 });
	});
});

// ─── 0077: every ending of an account on this server ────────────────────────

describe('0077, which records every ending of an account on this server, its watermark and its once-only seed (card 2996)', () => {
	/** The record as the migration leaves it, without its moments. */
	const recordOf = (database: Database.Database) =>
		database
			.prepare('SELECT user_id AS id, account_created AS created, ending, role, credential, origin FROM account_endings ORDER BY seq')
			.all();
	/** Every `ended_at` it wrote is a moment in the stored form. */
	const momentsOf = (database: Database.Database) => database.prepare('SELECT DISTINCT ended_at FROM account_endings').pluck().all() as string[];

	it('is the guard, the table and its three indexes, then the watermark and the seed, after a header comment, and declares nothing to the rehearsal', () => {
		const sql = readFileSync(join(REAL_MIGRATIONS, FILE_0077), 'utf-8').replace(/\r\n/g, '\n');
		const all = sqlStatements(sql).map((s) => s.text.replace(/\s+/g, ' '));
		expect(all).toHaveLength(11);
		expect(all[0]).toMatch(/^CREATE TEMP TABLE `migration_0077_guard` \( `seed_rows` integer NOT NULL CONSTRAINT `migration 0077 would record more than 1,000,000 account ids/);
		expect(all[0]).toContain('CHECK (`seed_rows` <= 1000000)');
		expect(all[1]).toMatch(/^INSERT INTO temp\.`migration_0077_guard`/);
		expect(all[2]).toBe('DROP TABLE temp.`migration_0077_guard`;');
		const statements = all.slice(3);
		expect(statements[0]).toBe(
			'CREATE TABLE `account_endings` ( `seq` integer PRIMARY KEY NOT NULL, `user_id` integer NOT NULL, `account_created` text NOT NULL, ' +
				"`ending` text NOT NULL, `role` text DEFAULT '' NOT NULL, `credential` text DEFAULT '' NOT NULL, `ended_at` text NOT NULL, " +
				"`stated_ended` text DEFAULT '' NOT NULL, `origin` text DEFAULT 'here' NOT NULL );"
		);
		// No unique index (R4): writes here are plain inserts, and the restore's union asks NOT EXISTS. Three indexes (R11),
		// the account's carrying the union's key too (the code review's FP3, FP5).
		expect(statements.some((s) => /CREATE UNIQUE INDEX/i.test(s))).toBe(false);
		expect(statements.slice(1, 4)).toEqual([
			'CREATE INDEX `account_endings_account` ON `account_endings` (`user_id`,`account_created`,`ending`,`stated_ended`);',
			"CREATE INDEX `account_endings_credential` ON `account_endings` (`credential`) WHERE credential <> '';",
			"CREATE INDEX `account_endings_watermark` ON `account_endings` (`user_id`) WHERE ending = 'watermark';"
		]);
		expect(statements[4]).toContain("'', 'watermark', datetime('now')");
		expect(statements[5]).toContain("SELECT id, '', 'deleted', datetime('now'), datetime('now') FROM ids WHERE id NOT IN (SELECT id FROM users);");
		// Never the superadmin (R1), and each creation time in the stored form (R4).
		expect(statements[6]).toContain("WHERE disabled_at IS NOT NULL AND role <> 'superadmin'");
		expect(statements[7]).toContain("WHERE role IN ('admin', 'user')");
		for (const statement of statements.slice(6)) expect(statement).toContain('coalesce(datetime(created_at), created_at)');
		// FP4: the seed's role rows dated at the account's creation, its disables at their own moment, the earliest stamp
		// where either names none or one after the migration.
		expect(statements[6]).toContain("THEN datetime(disabled_at) ELSE '0001-01-01 00:00:00' END");
		expect(statements[7]).toContain("THEN datetime(created_at) ELSE '0001-01-01 00:00:00' END");
		for (const said of ['never the hash', 'recordAccountEnding', 'No foreign key', 'c6ed310', 'never a superadmin', 'Going back to an older image']) {
			expect(sql, said).toContain(said);
		}
		expect(ONE_OFFS.filter((oneOff) => oneOff.file === FILE_0077)).toEqual([]);
		expect(TOLERANT_FILES).not.toContain(FILE_0077);
	});

	it('test 1: applies to a database at 0076 holding accounts 1 to 5 with 2 and 5 deleted: seeds 2 and 5 by id, the watermark 5, 4 disabled, the roles of 3 and 4, nothing of the superadmin, and changes no other cell', () => {
		const database = memoryDb();
		runMigrations({ database, migrationsDir: filesTo(FILE_0076) });
		// Before 0077 the model check reports its table, and nothing else.
		expect(schemaDifferences(database)).toEqual([TABLE_OF_0079, TABLE_OF_0077, TABLE_OF_0083, COLUMN_OF_0082, TABLE_OF_0082, TABLE_OF_0081, COLUMN_OF_0084, ...MODEL_LINES_OF_0078]);
		database.exec(`
			INSERT INTO users (id, username, email, password_hash, role, created_at) VALUES
				(1, 'chief', 'chief@example.test', 'x', 'superadmin', '2026-01-01 09:00:00'),
				(2, 'gone', 'gone@example.test', 'x', 'user', '2026-01-02 09:00:00'),
				(3, 'ann', 'ann@example.test', 'x', 'admin', '2026-01-03 09:00:00'),
				(4, 'bob', 'bob@example.test', 'x', 'user', '2026-01-04 09:00:00'),
				(5, 'left', 'left@example.test', 'x', 'user', '2026-01-05 09:00:00');
			UPDATE users SET disabled_at = '2026-11-01 08:00:00', disabled_by = 1 WHERE id = 4;
			-- A superadmin disabled by a host edit: still no row of it (R1).
			UPDATE users SET disabled_at = '2026-11-02 08:00:00' WHERE id = 1;
			DELETE FROM users WHERE id IN (2, 5);
		`);
		expect(sequenceIn(database, 'users')).toBe(5);
		const before = contentsOf(database);
		const state = stateOf(database);

		const report = runMigrations({ database, migrationsDir: REAL_MIGRATIONS });

		expect(report.applied).toEqual([FILE_0077, FILE_0078, FILE_0079, FILE_0080, FILE_0081, FILE_0082, FILE_0083, FILE_0084]);
		expect(report.schemaDifferences).toEqual([]);
		expect(recordOf(database)).toEqual([
			{ id: 5, created: '', ending: 'watermark', role: '', credential: '', origin: 'here' },
			{ id: 2, created: '', ending: 'deleted', role: '', credential: '', origin: 'here' },
			{ id: 5, created: '', ending: 'deleted', role: '', credential: '', origin: 'here' },
			{ id: 4, created: '2026-01-04 09:00:00', ending: 'disabled', role: '', credential: '', origin: 'here' },
			{ id: 3, created: '2026-01-03 09:00:00', ending: 'role', role: 'admin', credential: '', origin: 'here' },
			{ id: 4, created: '2026-01-04 09:00:00', ending: 'role', role: 'user', credential: '', origin: 'here' }
		]);
		expect(database.prepare("SELECT ended_at FROM account_endings WHERE ending = 'disabled'").pluck().get()).toBe('2026-11-01 08:00:00');
		// FP4: each role row dated at its account's creation, and every row's stated moment its own (FP5).
		expect(database.prepare("SELECT user_id AS id, ended_at AS at FROM account_endings WHERE ending = 'role' ORDER BY user_id").all()).toEqual([
			{ id: 3, at: '2026-01-03 09:00:00' },
			{ id: 4, at: '2026-01-04 09:00:00' }
		]);
		expect(database.prepare('SELECT COUNT(*) FROM account_endings WHERE stated_ended IS NOT ended_at').pluck().get()).toBe(0);
		for (const at of momentsOf(database)) expect(at).toMatch(/^\d{4}-\d{2}-\d{2} \d{2}:\d{2}:\d{2}$/);
		const after = contentsOf(database);
		for (const table of Object.keys(before)) {
			if (['columns', '__drizzle_migrations', 'sqlite_sequence'].includes(table)) continue;
			// But for what 0084 changes, applied in the same run (card 3064).
			expect(after[table], table).toEqual(as0084Leaves(table, before[table]));
		}
		// The counter is not raised: the seed writes no users row.
		expect(sequenceIn(database, 'users')).toBe(5);
		const found: Findings = { problems: [], notes: [] };
		compare(state, stateOf(database), report.applied, found);
		expect(found.problems).toEqual([]);

		expect(runMigrations({ database, migrationsDir: REAL_MIGRATIONS }).applied).toEqual([]);
		expect(recordOf(database)).toHaveLength(6);
	});

	it('test 2: applies where no account was ever made: the watermark 0, and no other row', () => {
		const database = memoryDb();
		runMigrations({ database, migrationsDir: filesTo(FILE_0076) });
		expect(sequenceIn(database, 'users')).toBeNull();

		const report = runMigrations({ database, migrationsDir: REAL_MIGRATIONS });

		expect(report.applied).toEqual([FILE_0077, FILE_0078, FILE_0079, FILE_0080, FILE_0081, FILE_0082, FILE_0083, FILE_0084]);
		expect(report.schemaDifferences).toEqual([]);
		expect(recordOf(database)).toEqual([{ id: 0, created: '', ending: 'watermark', role: '', credential: '', origin: 'here' }]);
		expect(sequenceIn(database, 'users')).toBeNull();
	});

	it("test 3: applies to a database at 0076 whose users counter row was deleted, as Admin › Vacuum did before c6ed310, accounts 1, 3 and 4 held: seed row 2, the watermark 4, the counters unchanged", () => {
		const database = memoryDb();
		runMigrations({ database, migrationsDir: filesTo(FILE_0076) });
		database.exec(`
			INSERT INTO users (id, username, email, password_hash, role) VALUES
				(1, 'chief', 'chief@example.test', 'x', 'superadmin'), (2, 'gone', 'gone@example.test', 'x', 'user'),
				(3, 'ann', 'ann@example.test', 'x', 'user'), (4, 'bob', 'bob@example.test', 'x', 'user');
			DELETE FROM users WHERE id = 2;
			DELETE FROM sqlite_sequence WHERE name = 'users';
		`);
		expect(sequenceIn(database, 'users')).toBeNull();
		const usersBefore = database.prepare('SELECT * FROM users ORDER BY id').all();
		// The counters but the migration record's, which the runner raises by one as it records the file.
		// But request_links's, which 0084's move of requester links writes, at 0 where it moves none (card 3064).
		const counters = () => database.prepare("SELECT name, seq FROM sqlite_sequence WHERE name NOT IN ('__drizzle_migrations', 'request_links') ORDER BY name").all();
		const countersBefore = counters();

		const report = runMigrations({ database, migrationsDir: REAL_MIGRATIONS });

		expect(report.applied).toEqual([FILE_0077, FILE_0078, FILE_0079, FILE_0080, FILE_0081, FILE_0082, FILE_0083, FILE_0084]);
		expect((recordOf(database) as { id: number; ending: string }[]).filter((row) => row.ending !== 'role')).toEqual([
			{ id: 4, created: '', ending: 'watermark', role: '', credential: '', origin: 'here' },
			{ id: 2, created: '', ending: 'deleted', role: '', credential: '', origin: 'here' }
		]);
		expect(database.prepare('SELECT * FROM users ORDER BY id').all()).toEqual(usersBefore);
		expect(counters()).toEqual(countersBefore);
		expect(report.schemaDifferences).toEqual([]);
		expect(schemaDifferences(database)).toEqual([]);
	});

	it('FP4: a cold copy returned and migrated again, the dump of the record put back after it, keeps a demotion made before the rollback', () => {
		// The copy, taken while Ada was an administrator, from before 0077.
		const copy = memoryDb();
		runMigrations({ database: copy, migrationsDir: filesTo(FILE_0076) });
		copy.exec(`
			INSERT INTO users (id, username, email, password_hash, role, created_at) VALUES
				(1, 'chief', 'chief@example.test', 'x', 'superadmin', '2026-01-01 09:00:00'),
				(2, 'ada', 'ada@example.test', 'x', 'admin', '2026-01-02 09:00:00');
		`);
		// The dump of the live record: Ada made a user before the rollback, at a moment earlier than this migration's.
		const dump = [{ user_id: 2, account_created: '2026-01-02 09:00:00', ending: 'role', role: 'user', credential: '', ended_at: '2026-11-19 09:00:00', stated_ended: '2026-11-19 09:00:00', origin: 'here' }];

		// Step 1: this release's first start on the returned copy; step 2: the dump put back (docs/deployment.md).
		runMigrations({ database: copy, migrationsDir: REAL_MIGRATIONS });
		const put = copy.prepare(
			'INSERT INTO account_endings (user_id, account_created, ending, role, credential, ended_at, stated_ended, origin) VALUES (@user_id, @account_created, @ending, @role, @credential, @ended_at, @stated_ended, @origin)'
		);
		for (const row of dump) put.run(row);

		expect(accountRulings(copy, [{ id: 2, createdAt: '2026-01-02 09:00:00', role: 'admin', passwordHash: '' }])).toEqual([
			expect.objectContaining({ id: 2, lowerTo: 'user' })
		]);
	});

	it('test 4: halts, applying nothing of it, where W less the accounts held is more than 1,000,000, saying why; a million exactly is seeded', () => {
		const database = memoryDb();
		runMigrations({ database, migrationsDir: filesTo(FILE_0076) });
		database.exec(`
			INSERT INTO users (id, username, email, password_hash, role) VALUES (1, 'chief', 'chief@example.test', 'x', 'superadmin');
			UPDATE sqlite_sequence SET seq = 1000002 WHERE name = 'users';
		`);

		expect(() => runMigrations({ database, migrationsDir: REAL_MIGRATIONS })).toThrow(
			/migration 0077 would record more than 1,000,000 account ids this server no longer holds/
		);
		expect(database.prepare("SELECT name FROM sqlite_master WHERE name IN ('account_endings', 'migration_0077_guard')").all()).toEqual([]);
		expect(database.prepare("SELECT name FROM sqlite_temp_master WHERE name = 'migration_0077_guard'").all()).toEqual([]);
		expect(recordedIn(database)).toHaveLength(82);

		database.prepare("UPDATE sqlite_sequence SET seq = 1000001 WHERE name = 'users'").run();
		expect(runMigrations({ database, migrationsDir: REAL_MIGRATIONS }).applied).toEqual([FILE_0077, FILE_0078, FILE_0079, FILE_0080, FILE_0081, FILE_0082, FILE_0083, FILE_0084]);
		expect(database.prepare("SELECT count(*) AS n FROM account_endings WHERE ending = 'deleted' AND account_created = ''").get()).toEqual({ n: 1000000 });
	});
});

// ─── 0078: a request's requester mail held, and its last release ────────────

describe("0078, which adds a request's requester mail held and its last release (card 3020)", () => {
	it('(n) card 3020: is the four columns and the index, after a header comment, and declares nothing to the rehearsal', () => {
		const sql = readFileSync(join(REAL_MIGRATIONS, FILE_0078), 'utf-8').replace(/\r\n/g, '\n');
		expect(sqlStatements(sql).map((s) => s.text)).toEqual([
			'ALTER TABLE `task_requests` ADD COLUMN `mail_held_because` text;',
			'ALTER TABLE `task_requests` ADD COLUMN `mail_released_at` text;',
			'ALTER TABLE `task_requests` ADD COLUMN `mail_released_by` integer REFERENCES `users`(`id`) ON DELETE SET NULL;',
			'ALTER TABLE `task_requests` ADD COLUMN `mail_released_by_name` text;',
			'CREATE INDEX `idx_task_requests_mail_released_by` ON `task_requests` (`mail_released_by`);'
		]);
		// R15: the comment says that a sealed restore and Reset clear the column too.
		for (const said of [
			'holdUnsealedRequestMail',
			'requesterMailAddress',
			'POST /api/requests/held',
			'a restore of a backup whose seal verified',
			'Reset Everything deletes every request',
			"card 2106's rule",
			'No IF NOT EXISTS, as 0072',
			'Runs once.',
			'Going back to an older image'
		]) {
			expect(sql, said).toContain(said);
		}
		// It takes and rewrites no row.
		expect(ONE_OFFS.filter((oneOff) => oneOff.file === FILE_0078)).toEqual([]);
		expect(TOLERANT_FILES).not.toContain(FILE_0078);
	});

	it('(n) card 3020: applies to a database at 0077 holding requests: each gains the four columns NULL, the key and the index, the model check is clean, a releaser deleted empties mail_released_by, and it runs once', () => {
		const database = memoryDb();
		runMigrations({ database, migrationsDir: filesTo(FILE_0077) });
		// Before 0078 the model check reports its four columns, key and index, and 0079's table (card 3002), and nothing else.
		expect(schemaDifferences(database)).toEqual([TABLE_OF_0079, TABLE_OF_0083, COLUMN_OF_0082, TABLE_OF_0082, TABLE_OF_0081, COLUMN_OF_0084, ...MODEL_LINES_OF_0078]);
		database.exec(`
			INSERT INTO users (id, username, email, password_hash, role) VALUES (1, 'chief', 'chief@example.test', 'x', 'superadmin');
			INSERT INTO task_requests (id, target_type, target_id, title, requester_name, requester_email, status) VALUES
				(1, 'user', 1, 'Open', 'Rita', 'rita@example.test', 'pending'),
				(2, 'user', 1, 'Settled', 'Rita', 'rita@example.test', 'accepted');
		`);
		const before = contentsOf(database);
		const state = stateOf(database);

		const report = runMigrations({ database, migrationsDir: REAL_MIGRATIONS });

		expect(report.applied).toEqual([FILE_0078, FILE_0079, FILE_0080, FILE_0081, FILE_0082, FILE_0083, FILE_0084]);
		expect(report.schemaDifferences).toEqual([]);
		expect(schemaDifferences(database)).toEqual([]);
		expect(database.prepare('SELECT id, mail_held_because, mail_released_at, mail_released_by, mail_released_by_name FROM task_requests ORDER BY id').all()).toEqual([
			{ id: 1, ...TASK_REQUEST_COLUMNS_OF_0078 },
			{ id: 2, ...TASK_REQUEST_COLUMNS_OF_0078 }
		]);
		// Every other cell of every request, and every other table, as it was.
		const after = contentsOf(database);
		for (const table of Object.keys(before)) {
			if (['__drizzle_migrations', 'sqlite_sequence'].includes(table)) continue;
			// And for what 0084 changes, applied in the same run (card 3064).
			expect(after[table], table).toEqual(as0084Leaves(table, table === 'task_requests' ? withColumns(before[table], TASK_REQUEST_COLUMNS_OF_0078) : before[table]));
		}
		expect(indexesOf(database)).toContain('idx_task_requests_mail_released_by');
		expect(database.prepare('PRAGMA foreign_key_list(task_requests)').all()).toContainEqual(
			expect.objectContaining({ table: 'users', from: 'mail_released_by', to: 'id', on_delete: 'SET NULL' })
		);
		// The rehearsal: every row kept, nothing to note but 0084's, applied in the same run (card 3064): its nine settings
		// in place of the two it takes back, and its one-offs declared for task_requests and users.
		const found: Findings = { problems: [], notes: [] };
		compare(state, stateOf(database), report.applied, found);
		expect(found).toEqual({
			problems: [],
			notes: ['settings had 3 row(s) and has 10: a migration put the others there', ...NOTES_OF_0084({ task_requests: 2, users: 1 })]
		});

		// The releaser deleted empties mail_released_by, and the name and moment are kept.
		expect(foreignKeysOn(database)).toBe(true);
		database.exec("INSERT INTO users (id, username, email, password_hash, role) VALUES (2, 'ann', 'ann@example.test', 'x', 'admin')");
		database.prepare("UPDATE task_requests SET mail_released_at = '2026-11-20 09:00:00', mail_released_by = 2, mail_released_by_name = 'ann' WHERE id = 2").run();
		database.prepare('DELETE FROM users WHERE id = 2').run();
		expect(database.prepare('SELECT mail_released_at, mail_released_by, mail_released_by_name FROM task_requests WHERE id = 2').get()).toEqual({
			mail_released_at: '2026-11-20 09:00:00',
			mail_released_by: null,
			mail_released_by_name: 'ann'
		});

		// Runs once: the next start applies nothing.
		expect(runMigrations({ database, migrationsDir: REAL_MIGRATIONS }).applied).toEqual([]);
	});
});

// ─── 0079: the record of every change of access here ────────────────────────

describe('0079, which adds the record of every change of access to a board, a team or a person here (card 3002)', () => {
	/** The record, in the order it was written. */
	const accessRecordOf = (database: Database.Database) =>
		database
			.prepare(
				'SELECT seq, kind, subject_id AS subject, subject_created AS subjectCreated, holder_id AS holder, holder_created AS holderCreated, access, changed_at AS changedAt, stated_changed AS statedChanged, origin FROM access_changes ORDER BY seq'
			)
			.all();
	const EARLIEST = '0001-01-01 00:00:00';
	/** A seed row: dated at the earliest stamp, written here. */
	const row = (seq: number, kind: string, subject: number, subjectCreated: string, holder: number, holderCreated: string, access: string) => ({
		seq,
		kind,
		subject,
		subjectCreated,
		holder,
		holderCreated,
		access,
		changedAt: EARLIEST,
		statedChanged: EARLIEST,
		origin: 'here'
	});

	it('(a) card 3002: applies to a database at 0078 holding boards, members, shares, a team and people: exactly the seed rows, a role not known read low, an orphan and an account whose creation time is no moment skipped, and the board it made and the person linked to it left untracked so that no start or restore clears either (R21), a board, team or account whose own is in a form the runner puts in the stored form tracked in that form, a board whose own is no moment untracked, and no existing row changed', () => {
		const database = memoryDb();
		runMigrations({ database, migrationsDir: filesTo(FILE_0078) });
		// Before 0079 the model check reports its table, and nothing else.
		expect(schemaDifferences(database)).toEqual([TABLE_OF_0079, TABLE_OF_0083, COLUMN_OF_0082, TABLE_OF_0082, TABLE_OF_0081, COLUMN_OF_0084]);
		database.exec(`
			INSERT INTO users (id, username, email, password_hash, role, created_at) VALUES
				(1, 'chief', 'chief@example.test', 'x', 'superadmin', '2026-01-01 09:00:00'),
				(2, 'ann', 'ann@example.test', 'x', 'user', '2026-01-02 09:00:00'),
				(3, 'bob', 'bob@example.test', 'x', 'user', '2026-01-03 09:00:00'),
				(4, 'cat', 'cat@example.test', 'x', 'user', '2026-01-04T09:00:00Z'),
				(5, 'odd', 'odd@example.test', 'x', 'user', '2026-02-30 08:00:00');
			INSERT INTO boards (id, name, is_public, created_by, product_owner_user_id, created_at) VALUES
				(1, 'Public', 1, 2, 3, '2026-02-01 09:00:00'),
				(2, 'Private', 0, 5, 5, '2026-02-02 09:00:00'),
				(3, 'Not stored', 0, 2, 2, '2026-02-03T09:00:00'),
				(4, 'No moment', 0, 2, 2, '2026-02-31T09:00:00');
			INSERT INTO board_members (board_id, user_id, role) VALUES
				(1, 2, 'owner'), (1, 5, 'viewer'), (2, 3, 'editor'), (2, 4, 'admin'), (3, 2, 'owner'), (4, 3, 'editor');
			INSERT INTO teams (id, name, created_at) VALUES (1, 'Team', '2026-03-01T10:00:00.250+01:00');
			INSERT INTO team_members (team_id, user_id, role) VALUES (1, 3, 'owner'), (1, 4, 'lead');
			INSERT INTO board_teams (board_id, team_id, role) VALUES (1, 1, 'editor'), (2, 1, 'reader');
			INSERT INTO people (id, full_name, email, user_id, created_at) VALUES
				(1, 'Cat', 'cat@example.test', 4, '2026-04-01 09:00:00'),
				(2, 'Dee', 'dee@example.test', NULL, '2026-04-02 09:00:00'),
				(3, 'Odd', 'odd@example.test', 5, '2026-04-03 09:00:00');
			PRAGMA foreign_keys = OFF;
			-- An orphan member row: it names no account, and opens nothing.
			INSERT INTO board_members (board_id, user_id, role) VALUES (2, 99, 'editor');
			PRAGMA foreign_keys = ON;
		`);
		const before = contentsOf(database);
		const state = stateOf(database);

		const report = runMigrations({ database, migrationsDir: REAL_MIGRATIONS });

		expect(report.applied).toEqual([FILE_0079, FILE_0080, FILE_0081, FILE_0082, FILE_0083, FILE_0084]);
		expect(report.schemaDifferences).toEqual([]);
		const b1 = '2026-02-01 09:00:00';
		const b2 = '2026-02-02 09:00:00';
		// Board 3's, the team's and cat's creation times are in forms the runner's timestamp pass puts in the stored form
		// after the migrations (card 3002 R19): each is tracked, and written, in the form the runner gives it.
		const b3 = '2026-02-03 09:00:00';
		const t1 = '2026-03-01 09:00:00';
		const cat = '2026-01-04 09:00:00';
		expect(accessRecordOf(database)).toEqual([
			// Each board's creator. R21: odd's creation time is no moment the calendar has, so board 2's creator is not
			// written, and board 2 is not tracked: held as none, the first start would clear its creator.
			row(1, 'board', 1, b1, 2, '2026-01-02 09:00:00', 'tracked'),
			row(2, 'board', 3, b3, 2, '2026-01-02 09:00:00', 'tracked'),
			row(3, 'board_public', 1, b1, 0, '', 'public'),
			row(4, 'board_public', 2, b2, 0, '', 'private'),
			row(5, 'board_public', 3, b3, 0, '', 'private'),
			// Board 2's Product Owner is odd: not written.
			row(6, 'product_owner', 1, b1, 3, '2026-01-03 09:00:00', 'yes'),
			row(7, 'product_owner', 3, b3, 2, '2026-01-02 09:00:00', 'yes'),
			// odd's member row and the orphan skipped; `admin` read as viewer.
			row(8, 'board_member', 1, b1, 2, '2026-01-02 09:00:00', 'owner'),
			row(9, 'board_member', 2, b2, 3, '2026-01-03 09:00:00', 'editor'),
			row(10, 'board_member', 2, b2, 4, cat, 'viewer'),
			row(11, 'board_member', 3, b3, 2, '2026-01-02 09:00:00', 'owner'),
			// A share's role that is not editor read as viewer.
			row(12, 'board_team', 1, b1, 1, t1, 'editor'),
			row(13, 'board_team', 2, b2, 1, t1, 'viewer'),
			row(14, 'team', 1, t1, 0, '', 'tracked'),
			// A team role that is not owner read as member.
			row(15, 'team_member', 1, t1, 3, '2026-01-03 09:00:00', 'owner'),
			row(16, 'team_member', 1, t1, 4, cat, 'member'),
			row(17, 'person_link', 1, '2026-04-01 09:00:00', 4, cat, 'linked'),
			// Linked to no account: none.
			row(18, 'person_link', 2, '2026-04-02 09:00:00', 0, '', 'none')
			// R21: person 3 is linked to odd, whose creation time is no moment: not written, so not tracked.
		]);
		// R21: neither the start pass nor a restore acts on board 2's creator or person 3's link, as no row names either:
		// before R21 each was held as none, and the first start cleared board 2's creator and unlinked person 3.
		const odd = { id: 5, created: toStamp('2026-02-30 08:00:00') };
		for (const item of [
			{ kind: ACCESS_KIND.board, subject: { id: 2, created: b2 }, holder: odd },
			{ kind: ACCESS_KIND.personLink, subject: { id: 3, created: '2026-04-03 09:00:00' }, holder: odd }
		]) {
			expect(accessCeiling(database, item, { deletions: false, asOf: stamp() }), `${item.kind} at start`).toBeNull();
			expect(accessCeiling(database, item, { guess: true, heldBefore: false }), `${item.kind} at a restore`).toBeNull();
		}
		// Board 4's creation time names no moment the calendar has, in any form: not tracked, its member not written.
		expect(database.prepare('SELECT count(*) FROM access_changes WHERE subject_id = 4').pluck().get()).toBe(0);
		// The seed's TEMP table is gone.
		expect(database.prepare("SELECT count(*) FROM sqlite_temp_master WHERE name = 'migration_0079_stamps'").pluck().get()).toBe(0);
		// No row has a real holder with no creation time.
		expect(database.prepare("SELECT count(*) FROM access_changes WHERE holder_id <> 0 AND holder_created = ''").pluck().get()).toBe(0);
		// Every existing row as 0079 left it: as it was. Board 3's, the team's and cat's creation times are put in the stored
		// form by the runner's own timestamp pass, which runs after every migration file; board 4's is left as it is; and
		// each board is given its Options column by the runner's backfill, as in 0077's test 1.
		const after = contentsOf(database);
		const normalised: Record<string, [string, string]> = {
			boards: ['2026-02-03T09:00:00', b3],
			teams: ['2026-03-01T10:00:00.250+01:00', t1],
			users: ['2026-01-04T09:00:00Z', cat]
		};
		for (const table of Object.keys(before)) {
			if (['columns', '__drizzle_migrations', 'sqlite_sequence'].includes(table)) continue;
			const was = normalised[table] ? before[table].map((value) => value.replace(...normalised[table])) : before[table];
			// And for what 0084 changes, applied in the same run (card 3064).
			expect(after[table], table).toEqual(as0084Leaves(table, was));
		}
		const found: Findings = { problems: [], notes: [] };
		compare(state, stateOf(database), report.applied, found);
		expect(found.problems).toEqual([]);

		// Runs once: the next start applies nothing, and the seed is not written again.
		expect(runMigrations({ database, migrationsDir: REAL_MIGRATIONS }).applied).toEqual([]);
		expect(accessRecordOf(database)).toHaveLength(18);
	});

	it('(b) card 3002: applies where there is no board, team or person: the table and its three indexes, no row, no foreign key, and declares nothing to the rehearsal', () => {
		const sql = readFileSync(join(REAL_MIGRATIONS, FILE_0079), 'utf-8').replace(/\r\n/g, '\n');
		for (const said of ['recordAccessChange', 'No foreign key', 'One reading of a creation time', 'Reset Everything keeps it', 'Going back to an', 'No guard']) {
			expect(sql, said).toContain(said);
		}
		expect(ONE_OFFS.filter((oneOff) => oneOff.file === FILE_0079)).toEqual([]);
		expect(TOLERANT_FILES).not.toContain(FILE_0079);
		const database = memoryDb();
		runMigrations({ database, migrationsDir: filesTo(FILE_0078) });

		const report = runMigrations({ database, migrationsDir: REAL_MIGRATIONS });

		expect(report.applied).toEqual([FILE_0079, FILE_0080, FILE_0081, FILE_0082, FILE_0083, FILE_0084]);
		expect(report.schemaDifferences).toEqual([]);
		expect(schemaDifferences(database)).toEqual([]);
		expect(accessRecordOf(database)).toEqual([]);
		// 0080, applied with it, adds the fourth, the start pass's on changed_at (card 3033).
		expect(database.prepare("SELECT name FROM sqlite_master WHERE type = 'index' AND tbl_name = 'access_changes' ORDER BY name").pluck().all()).toEqual([
			'access_changes_changed',
			'access_changes_pair',
			'access_changes_subject',
			'access_changes_union'
		]);
		expect(database.prepare('PRAGMA foreign_key_list(access_changes)').all()).toEqual([]);
		expect(
			(database.prepare('PRAGMA table_info(access_changes)').all() as { name: string; notnull: number; dflt_value: string | null; pk: number }[]).map(
				(column) => [column.name, column.notnull, column.dflt_value, column.pk]
			)
		).toEqual([
			['seq', 1, null, 1],
			['kind', 1, null, 0],
			['subject_id', 1, null, 0],
			['subject_created', 1, null, 0],
			['holder_id', 1, '0', 0],
			['holder_created', 1, "''", 0],
			['access', 1, null, 0],
			['changed_at', 1, null, 0],
			['stated_changed', 1, "''", 0],
			['origin', 1, "'here'", 0]
		]);
	});
});

// ─── 0080: every decision role in the record of changes of access ───────────

describe('0080, which seeds every decision role into the record of changes of access, once (card 3033)', () => {
	/** The record, in the order it was written. */
	const accessRecordOf = (database: Database.Database) =>
		database
			.prepare(
				'SELECT seq, kind, subject_id AS subject, subject_created AS subjectCreated, holder_id AS holder, holder_created AS holderCreated, access, changed_at AS changedAt, stated_changed AS statedChanged, origin FROM access_changes ORDER BY seq'
			)
			.all();
	const EARLIEST = '0001-01-01 00:00:00';
	/** A seed row: dated at the earliest stamp, written here. */
	const row = (seq: number, kind: string, subject: number, subjectCreated: string, holder: number, holderCreated: string, access: string) => ({
		seq,
		kind,
		subject,
		subjectCreated,
		holder,
		holderCreated,
		access,
		changedAt: EARLIEST,
		statedChanged: EARLIEST,
		origin: 'here'
	});
	const ann = '2026-01-02 09:00:00';
	const bob = '2026-01-03 09:00:00';
	const cat = '2026-01-04 09:00:00';
	const d1 = '2026-03-01 09:00:00';
	const d2 = '2026-03-02 09:00:00';

	/**
	 * A database at 0079 whose record holds 0079's four seed rows for board 1 (its creator ann, private, its Product Owner
	 * bob, bob an editor), and accounts ann (2), bob (3), cat (4) and odd (5), whose creation time is no moment the
	 * calendar has. Each case adds its decisions after 0079's start has run, so that 0080 reads their times as written.
	 */
	function at0079(): Database.Database {
		const database = memoryDb();
		runMigrations({ database, migrationsDir: filesTo(FILE_0078) });
		database.exec(`
			INSERT INTO users (id, username, email, password_hash, role, created_at) VALUES
				(1, 'chief', 'chief@example.test', 'x', 'superadmin', '2026-01-01 09:00:00'),
				(2, 'ann', 'ann@example.test', 'x', 'user', '${ann}'),
				(3, 'bob', 'bob@example.test', 'x', 'user', '${bob}'),
				(4, 'cat', 'cat@example.test', 'x', 'user', '${cat}'),
				(5, 'odd', 'odd@example.test', 'x', 'user', '2026-02-30 08:00:00');
			INSERT INTO boards (id, name, is_public, created_by, product_owner_user_id, created_at) VALUES (1, 'Board', 0, 2, 3, '2026-02-01 09:00:00');
			INSERT INTO board_members (board_id, user_id, role) VALUES (1, 3, 'editor');
		`);
		expect(runMigrations({ database, migrationsDir: filesTo(FILE_0079) }).applied).toEqual([FILE_0079]);
		expect(accessRecordOf(database)).toHaveLength(4);
		return database;
	}

	it("(a1) card 3033: applies to a database at 0079 holding an open decision, a draft and a decision whose creation time is in a form the runner puts in the stored form: exactly the seed rows, each place named by its row id and its decision's creation time, that decision tracked in the stored form, 0079's rows and every other row unchanged, and its TEMP table gone (R13 L5)", () => {
		const database = at0079();
		database.exec(`
			INSERT INTO decisions (id, board_id, board_name, title, status, author_user_id, author_name, decider_user_id, decider_name, opened_at, created_at) VALUES
				(1, 1, 'Board', 'Open', 'open', 2, 'ann', 2, 'ann', '2026-03-02 10:00:00', '${d1}'),
				(2, 1, 'Board', 'Draft', 'draft', 2, 'ann', 3, 'bob', NULL, '${d2}'),
				(4, 1, 'Board', 'Not stored', 'open', 2, 'ann', 4, 'cat', '2026-03-05 09:00:00', '2026-03-04T09:00:00Z');
			INSERT INTO decision_participants (id, decision_id, role, name, email, job_title, groups, included_at, user_id, removed_at, link_token_hash, link_issued_at) VALUES
				(1, 1, 'consulted', 'bob', 'bob@example.test', '', '[]', '2026-03-02 10:00:00', 3, NULL, NULL, NULL),
				(2, 1, 'informed', 'Lin', 'lin@example.test', '', '[]', '2026-03-02 10:00:00', NULL, NULL, 'h2', '2026-03-02 10:00:00'),
				(3, 1, 'consulted', 'cat', 'cat@example.test', '', '[]', '2026-03-02 10:00:00', 4, '2026-03-03 09:00:00', NULL, NULL),
				(4, 2, 'consulted', 'ann', 'ann@example.test', '', '[]', '2026-03-02 09:30:00', 2, NULL, NULL, NULL),
				(5, 4, 'consulted', 'cat', 'cat@example.test', '', '[]', '2026-03-05 09:00:00', 4, NULL, NULL, NULL);
		`);
		const record0079 = accessRecordOf(database);
		const before = contentsOf(database);
		const state = stateOf(database);

		const report = runMigrations({ database, migrationsDir: REAL_MIGRATIONS });

		expect(report.applied).toEqual([FILE_0080, FILE_0081, FILE_0082, FILE_0083, FILE_0084]);
		expect(report.schemaDifferences).toEqual([]);
		expect(schemaDifferences(database)).toEqual([]);
		// Decision 4's creation time is in a form the runner's timestamp pass puts in the stored form after the migrations
		// (card 3002 R19): it is tracked, and written, in the form the runner gives it.
		const d4 = '2026-03-04 09:00:00';
		expect(accessRecordOf(database)).toEqual([
			...record0079,
			row(5, 'decision', 1, d1, 0, '', 'tracked'),
			row(6, 'decision', 2, d2, 0, '', 'tracked'),
			row(7, 'decision', 4, d4, 0, '', 'tracked'),
			row(8, 'decision_decider', 1, d1, 2, ann, 'yes'),
			row(9, 'decision_decider', 2, d2, 3, bob, 'yes'),
			row(10, 'decision_decider', 4, d4, 4, cat, 'yes'),
			// A place is its row id with its decision's creation time, never its own `included_at`; a removed place is
			// removed whatever its role, and the link holder, with no account, is informed.
			row(11, 'decision_participant', 1, d1, 1, d1, 'consulted'),
			row(12, 'decision_participant', 1, d1, 2, d1, 'informed'),
			row(13, 'decision_participant', 1, d1, 3, d1, 'removed'),
			row(14, 'decision_participant', 2, d2, 4, d2, 'consulted'),
			row(15, 'decision_participant', 4, d4, 5, d4, 'consulted'),
			// Each place's account, the place its subject: the removed place's included; the link holder has none.
			row(16, 'decision_account', 1, d1, 3, bob, 'held'),
			row(17, 'decision_account', 3, d1, 4, cat, 'held'),
			row(18, 'decision_account', 4, d2, 2, ann, 'held'),
			row(19, 'decision_account', 5, d4, 4, cat, 'held')
		]);
		// The seed's TEMP table is gone.
		expect(database.prepare("SELECT count(*) FROM sqlite_temp_master WHERE name = 'migration_0080_stamps'").pluck().get()).toBe(0);
		// No row has a real holder with no creation time.
		expect(database.prepare("SELECT count(*) FROM access_changes WHERE holder_id <> 0 AND holder_created = ''").pluck().get()).toBe(0);
		// Every other row as it was, but decision 4's creation time, put in the stored form by the runner's own pass.
		const after = contentsOf(database);
		for (const table of Object.keys(before)) {
			if (['access_changes', '__drizzle_migrations', 'sqlite_sequence'].includes(table)) continue;
			const was = table === 'decisions' ? before[table].map((value) => value.replace('2026-03-04T09:00:00Z', d4)) : before[table];
			// And for what 0084 changes, applied in the same run (card 3064).
			expect(after[table], table).toEqual(as0084Leaves(table, was));
		}
		const found: Findings = { problems: [], notes: [] };
		compare(state, stateOf(database), report.applied, found);
		expect(found.problems).toEqual([]);

		// Runs once: the next start applies nothing, and the seed is not written again.
		expect(runMigrations({ database, migrationsDir: REAL_MIGRATIONS }).applied).toEqual([]);
		expect(accessRecordOf(database)).toHaveLength(19);
	});

	it("(a2) card 3033 R12: a decider whose account's creation time is no moment the calendar has is not written (card 3002 R21), and the decision is tracked", () => {
		const database = at0079();
		database.exec(`
			INSERT INTO decisions (id, board_id, board_name, title, status, author_user_id, author_name, decider_user_id, decider_name, created_at) VALUES
				(1, 1, 'Board', 'Odd decides', 'open', 2, 'ann', 5, 'odd', '${d1}');
		`);
		const record0079 = accessRecordOf(database);

		expect(runMigrations({ database, migrationsDir: REAL_MIGRATIONS }).applied).toEqual([FILE_0080, FILE_0081, FILE_0082, FILE_0083, FILE_0084]);

		// Held as none, the first start would clear the decider: no decider row.
		expect(accessRecordOf(database)).toEqual([...record0079, row(5, 'decision', 1, d1, 0, '', 'tracked')]);
	});

	it('(a3) card 3033 R12: a decider naming no account, or one that is not here, is written as none, holder 0', () => {
		const database = at0079();
		database.exec(`
			PRAGMA foreign_keys = OFF;
			INSERT INTO decisions (id, board_id, board_name, title, status, author_user_id, author_name, decider_user_id, decider_name, created_at) VALUES
				(1, 1, 'Board', 'No decider', 'open', 2, 'ann', NULL, NULL, '${d1}'),
				(2, 1, 'Board', 'Gone decider', 'open', 2, 'ann', 99, 'gone', '${d2}');
			PRAGMA foreign_keys = ON;
		`);
		const record0079 = accessRecordOf(database);

		expect(runMigrations({ database, migrationsDir: REAL_MIGRATIONS }).applied).toEqual([FILE_0080, FILE_0081, FILE_0082, FILE_0083, FILE_0084]);

		expect(accessRecordOf(database)).toEqual([
			...record0079,
			row(5, 'decision', 1, d1, 0, '', 'tracked'),
			row(6, 'decision', 2, d2, 0, '', 'tracked'),
			row(7, 'decision_decider', 1, d1, 0, '', 'none'),
			row(8, 'decision_decider', 2, d2, 0, '', 'none')
		]);
	});

	it('(a4) card 3033: a decision whose creation time is no moment the calendar has is not tracked: no row of any kind names it or its places', () => {
		const database = at0079();
		database.exec(`
			INSERT INTO decisions (id, board_id, board_name, title, status, author_user_id, author_name, decider_user_id, decider_name, created_at) VALUES
				(1, 1, 'Board', 'No moment', 'open', 2, 'ann', 2, 'ann', '2026-02-31 09:00:00'),
				(2, 1, 'Board', 'A moment', 'open', 2, 'ann', 3, 'bob', '${d2}');
			INSERT INTO decision_participants (id, decision_id, role, name, email, job_title, groups, included_at, user_id) VALUES
				(1, 1, 'consulted', 'bob', 'bob@example.test', '', '[]', '2026-03-02 10:00:00', 3);
		`);
		const record0079 = accessRecordOf(database);

		expect(runMigrations({ database, migrationsDir: REAL_MIGRATIONS }).applied).toEqual([FILE_0080, FILE_0081, FILE_0082, FILE_0083, FILE_0084]);

		// Decision 2 is seeded as any decision is: decision 1, its decider, its place and the place's account are not.
		expect(accessRecordOf(database)).toEqual([...record0079, row(5, 'decision', 2, d2, 0, '', 'tracked'), row(6, 'decision_decider', 2, d2, 3, bob, 'yes')]);
	});

	it("(b) card 3033: applies where there is no decision: no row added, no table or column changed, and one index added, the start pass's on changed_at; its statements a seed and that index, every comment in its header, and declares nothing to the rehearsal", () => {
		const sql = readFileSync(join(REAL_MIGRATIONS, FILE_0080), 'utf-8').replace(/\r\n/g, '\n');
		for (const said of ['decision_account', 'One reading of a creation time', 'R21', 'Changes no existing row', 'Going back to an older image', 'No guard', 'access_changes_changed']) {
			expect(sql, said).toContain(said);
		}
		// A TEMP table for the stamps, the seed's inserts, the TEMP table dropped, and, last, the one index (S4's fold-in).
		const statements = sql
			.slice(sql.indexOf('CREATE TEMP TABLE'))
			.split('--> statement-breakpoint')
			.map((statement) => statement.trim());
		expect(statements.map((statement) => statement.split(/\s+/).slice(0, 3).join(' '))).toEqual([
			'CREATE TEMP TABLE',
			'INSERT INTO temp.`migration_0080_stamps`',
			'INSERT INTO `access_changes`',
			'INSERT INTO `access_changes`',
			'INSERT INTO `access_changes`',
			'INSERT INTO `access_changes`',
			'DROP TABLE temp.`migration_0080_stamps`;',
			'CREATE INDEX `access_changes_changed`'
		]);
		expect(statements.at(-1)).toBe('CREATE INDEX `access_changes_changed` ON `access_changes` (`changed_at`);');
		// Every comment is in the header, none inside a statement (R13 L5).
		expect(statements.join('\n').split('\n').filter((line) => line.trim().startsWith('--'))).toEqual([]);
		expect(sql.slice(0, sql.indexOf('CREATE TEMP TABLE')).split('\n').filter((line) => line.trim() !== '' && !line.startsWith('--'))).toEqual([]);
		expect(ONE_OFFS.filter((oneOff) => oneOff.file === FILE_0080)).toEqual([]);
		expect(TOLERANT_FILES).not.toContain(FILE_0080);
		const database = at0079();
		const record0079 = accessRecordOf(database);
		const tables = tablesOf(database);
		const indexes = indexesOf(database);

		const report = runMigrations({ database, migrationsDir: REAL_MIGRATIONS });

		expect(report.applied).toEqual([FILE_0080, FILE_0081, FILE_0082, FILE_0083, FILE_0084]);
		expect(report.schemaDifferences).toEqual([]);
		expect(schemaDifferences(database)).toEqual([]);
		expect(accessRecordOf(database)).toEqual(record0079);
		// And 0081's table and its three indexes, applied with it (card 3004), 0082's table and its index (card 2683), and 0083's table and its three indexes (card 2684), and nothing else.
		expect(tablesOf(database)).toEqual([...tables, 'outbound_changes', 'decision_survey_questions', 'decision_flags'].sort());
		expect(indexes).not.toContain('access_changes_changed');
		expect(indexesOf(database)).toEqual([...indexes, 'access_changes_changed', ...INDEXES_OF_0081, INDEX_OF_0082, ...INDEXES_OF_0083].sort());
		expect(database.prepare("SELECT count(*) FROM sqlite_temp_master WHERE name = 'migration_0080_stamps'").pluck().get()).toBe(0);
	});
});

// ─── 0081: the record of changes of where this server sends ─────────────────

describe('0081, which adds the record of every change of where this server sends, with no seed (card 3004)', () => {
	it('(a) card 3004: applies to a database at 0080 holding a webhook, a report schedule and outbound settings: the table and its three indexes, no row, no foreign key, every other row, table and index as it was; its statements the table and those indexes, every comment in its header, and declares nothing to the rehearsal', () => {
		const sql = readFileSync(join(REAL_MIGRATIONS, FILE_0081), 'utf-8').replace(/\r\n/g, '\n');
		for (const said of ['keyed digest', 'No foreign key', 'No seed here', '`seeded` row', 'Reset Everything keeps it', 'Changes no existing row', 'Going back to an older image', 'No guard']) {
			expect(sql, said).toContain(said);
		}
		// The table and its three indexes, nothing else: no seed, no row of any table written.
		const statements = sql
			.slice(sql.indexOf('CREATE TABLE'))
			.split('--> statement-breakpoint')
			.map((statement) => statement.trim());
		expect(statements.map((statement) => statement.split(/\s+/).slice(0, 3).join(' '))).toEqual([
			'CREATE TABLE `outbound_changes`',
			'CREATE INDEX `outbound_changes_item`',
			'CREATE INDEX `outbound_changes_union`',
			'CREATE INDEX `outbound_changes_changed`'
		]);
		// Every comment is in the header, none inside a statement, as 0080's.
		expect(statements.join('\n').split('\n').filter((line) => line.trim().startsWith('--'))).toEqual([]);
		expect(sql.slice(0, sql.indexOf('CREATE TABLE')).split('\n').filter((line) => line.trim() !== '' && !line.startsWith('--'))).toEqual([]);
		expect(ONE_OFFS.filter((oneOff) => oneOff.file === FILE_0081)).toEqual([]);
		expect(TOLERANT_FILES).not.toContain(FILE_0081);
		const database = memoryDb();
		// The rows go in at 0079, and the start that applies 0080 runs its passes over them, so that what 0081's start finds
		// is a database at 0080 that has been started.
		expect(runMigrations({ database, migrationsDir: filesTo(FILE_0079) }).applied.at(-1)).toBe(FILE_0079);
		database.exec(`
			INSERT INTO users (id, username, email, password_hash, role, created_at) VALUES (1, 'chief', 'chief@example.test', 'x', 'superadmin', '2026-01-01 09:00:00');
			INSERT INTO boards (id, name, created_by, created_at) VALUES (1, 'Board', 1, '2026-02-01 09:00:00');
			INSERT INTO webhooks (id, board_id, url, active, created_at) VALUES (1, 1, 'https://hooks.example.test/a', 1, '2026-02-02 09:00:00'), (2, 1, 'https://hooks.example.test/b', 0, '2026-02-03 09:00:00');
			INSERT INTO report_schedules (id, user_id, name, recipients, enabled, created_at, updated_at) VALUES (1, 1, 'Weekly', 'ann@example.test', 1, '2026-02-04 09:00:00', '2026-02-04 09:00:00');
			INSERT INTO settings (key, value) VALUES ('backup_config', '{"destinations":[]}'), ('smtp_host', 'mail.example.test'), ('app_url', 'https://dumpfire.example.test');
			INSERT INTO setting_holds (setting, place, held_because, held_at) VALUES ('mail', '${'f'.repeat(64)}', 'setter access ended', '2026-11-19 09:00:00');
		`);
		expect(runMigrations({ database, migrationsDir: filesTo(FILE_0080) }).applied).toEqual([FILE_0080]);
		const before = contentsOf(database);
		const tables = tablesOf(database);
		const indexes = indexesOf(database);
		const state = stateOf(database);
		expect(tables).not.toContain('outbound_changes');

		const report = runMigrations({ database, migrationsDir: REAL_MIGRATIONS });

		expect(report.applied).toEqual([FILE_0081, FILE_0082, FILE_0083, FILE_0084]);
		expect(report.schemaDifferences).toEqual([]);
		expect(schemaDifferences(database)).toEqual([]);
		// The table and its three indexes, and no other table or index but 0082's and 0083's, applied with it (cards 2683 and 2684).
		expect(tablesOf(database)).toEqual([...tables, 'outbound_changes', 'decision_survey_questions', 'decision_flags'].sort());
		expect(indexesOf(database)).toEqual([...indexes, ...INDEXES_OF_0081, INDEX_OF_0082, ...INDEXES_OF_0083].sort());
		expect(database.prepare("SELECT name FROM sqlite_master WHERE type = 'index' AND tbl_name = 'outbound_changes' ORDER BY name").pluck().all()).toEqual(INDEXES_OF_0081);
		// No row: the server seeds it, once, from what is here (R7).
		expect(database.prepare('SELECT count(*) FROM outbound_changes').pluck().get()).toBe(0);
		expect(database.prepare('PRAGMA foreign_key_list(outbound_changes)').all()).toEqual([]);
		expect(
			(database.prepare('PRAGMA table_info(outbound_changes)').all() as { name: string; notnull: number; dflt_value: string | null; pk: number }[]).map(
				(column) => [column.name, column.notnull, column.dflt_value, column.pk]
			)
		).toEqual([
			['seq', 1, null, 1],
			['kind', 1, null, 0],
			['item_id', 1, '0', 0],
			['item_created', 1, "''", 0],
			['place', 1, "''", 0],
			['address', 1, "''", 0],
			['state', 1, null, 0],
			['changed_at', 1, null, 0],
			['stated_changed', 1, "''", 0],
			['origin', 1, "'here'", 0]
		]);
		// Every other row as it was.
		const after = contentsOf(database);
		expect(after['outbound_changes']).toEqual([]);
		for (const table of Object.keys(before)) {
			if (['__drizzle_migrations', 'sqlite_sequence'].includes(table)) continue;
			// But for what 0084 changes, applied in the same run (card 3064).
			expect(after[table], table).toEqual(as0084Leaves(table, before[table]));
		}
		const found: Findings = { problems: [], notes: [] };
		compare(state, stateOf(database), report.applied, found);
		expect(found.problems).toEqual([]);

		// Runs once: the next start applies nothing.
		expect(runMigrations({ database, migrationsDir: REAL_MIGRATIONS }).applied).toEqual([]);
		expect(database.prepare('SELECT count(*) FROM outbound_changes').pluck().get()).toBe(0);
	});
});

// ─── 0082: a decision's survey questions, and the answers given with a response ─

describe("0082, which adds a decision's survey questions and the answers given with a response (card 2683)", () => {
	/** A database at 0081 holding an open decision with two options, a participant and two responses, started at each step. */
	function at0081WithResponses(): Database.Database {
		const database = memoryDb();
		expect(runMigrations({ database, migrationsDir: filesTo(FILE_0079) }).applied.at(-1)).toBe(FILE_0079);
		database.exec(`
			INSERT INTO users (id, username, email, password_hash, role, created_at) VALUES (1, 'chief', 'chief@example.test', 'x', 'superadmin', '2026-01-01 09:00:00');
			INSERT INTO boards (id, name, created_by, created_at) VALUES (1, 'Board', 1, '2026-02-01 09:00:00');
			INSERT INTO decisions (id, board_id, board_name, title, status, current_version, author_user_id, author_name, decider_user_id, decider_name, closes_at, opened_at, created_at, updated_at)
				VALUES (1, 1, 'Board', 'Pick one', 'open', 1, 1, 'chief', 1, 'chief', '2026-12-01 09:00:00', '2026-11-01 09:00:00', '2026-11-01 08:00:00', '2026-11-01 09:00:00');
			INSERT INTO decision_options (id, decision_id, label, position, added_in_version) VALUES (1, 1, 'A', 0, 1), (2, 1, 'B', 1, 1);
			INSERT INTO decision_participants (id, decision_id, role, name, email, job_title, groups, included_at, user_id)
				VALUES (1, 1, 'consulted', 'chief', 'chief@example.test', '', '[]', '2026-11-01 09:00:00', 1);
			INSERT INTO decision_responses (id, decision_id, participant_id, version_number, round, kind, option_id, comment, via, created_at) VALUES
				(1, 1, 1, 1, 1, 'vote', 1, 'First', 'session', '2026-11-02 09:00:00'),
				(2, 1, 1, 1, 1, 'abstain', NULL, NULL, 'link', '2026-11-03 09:00:00');
			UPDATE decision_responses SET replaces_id = 1 WHERE id = 2;
		`);
		expect(runMigrations({ database, migrationsDir: filesTo(FILE_0081) }).applied).toEqual([FILE_0080, FILE_0081]);
		return database;
	}

	it('T1: is the table, its index and the column after a header comment, declares nothing to the rehearsal; a database before it reports both and nothing else of it, and after it the model check is clean', () => {
		const sql = readFileSync(join(REAL_MIGRATIONS, FILE_0082), 'utf-8').replace(/\r\n/g, '\n');
		expect(sqlStatements(sql).map((s) => s.text.split(/\s+/).slice(0, 3).join(' '))).toEqual([
			'CREATE TABLE `decision_survey_questions`',
			'CREATE INDEX `idx_decision_survey_questions_decision_id`',
			'ALTER TABLE `decision_responses`'
		]);
		// Each is the statement the model's export prints, so the two cannot drift; and no IF NOT EXISTS, as 0063.
		const [table, index, column] = sqlStatements(sql).map((s) => s.text);
		expect(EXPECTED_SCHEMA).toContain(table);
		expect(EXPECTED_SCHEMA).toContain(index);
		expect(column).toBe('ALTER TABLE `decision_responses` ADD `answers` text;');
		for (const statement of sqlStatements(sql)) expect(statement.text).not.toContain('IF NOT EXISTS');
		for (const said of ['card 2106', 'No IF NOT EXISTS, as 0063', 'Runs once.', 'A backup made before this file', 'Going back to an older image', '332634f', 'Never drop the table']) {
			expect(sql, said).toContain(said);
		}
		expect(ONE_OFFS.filter((oneOff) => oneOff.file === FILE_0082)).toEqual([]);
		expect(TOLERANT_FILES).not.toContain(FILE_0082);

		const database = memoryDb();
		runMigrations({ database, migrationsDir: filesTo(FILE_0081) });
		// Before 0082 the model check reports its column and its table, after 0083's table (card 2684) in name order, and nothing else.
		expect(schemaDifferences(database)).toEqual([TABLE_OF_0083, COLUMN_OF_0082, TABLE_OF_0082, COLUMN_OF_0084]);
		const tables = tablesOf(database);
		const indexes = indexesOf(database);

		const report = runMigrations({ database, migrationsDir: REAL_MIGRATIONS });

		expect(report.applied).toEqual([FILE_0082, FILE_0083, FILE_0084]);
		expect(report.schemaDifferences).toEqual([]);
		expect(schemaDifferences(database)).toEqual([]);
		expect(tablesOf(database)).toEqual([...tables, 'decision_survey_questions', 'decision_flags'].sort());
		expect(indexesOf(database)).toEqual([...indexes, INDEX_OF_0082, ...INDEXES_OF_0083].sort());
		expect(database.prepare('PRAGMA foreign_key_list(decision_survey_questions)').all()).toEqual([
			expect.objectContaining({ table: 'decisions', from: 'decision_id', to: 'id', on_delete: 'CASCADE' })
		]);
		expect(
			(database.prepare('PRAGMA table_info(decision_responses)').all() as { name: string; notnull: number; dflt_value: string | null }[])
				.at(-1)
		).toEqual(expect.objectContaining({ name: 'answers', type: 'TEXT', notnull: 0, dflt_value: null }));
	});

	it('T2: applies to a database at 0081 holding responses: every row kept, each response with answers NULL, the table empty, deleting the decision cascades a question, and it runs once', () => {
		const database = at0081WithResponses();
		const before = contentsOf(database);
		const state = stateOf(database);

		const report = runMigrations({ database, migrationsDir: REAL_MIGRATIONS });

		expect(report.applied).toEqual([FILE_0082, FILE_0083, FILE_0084]);
		expect(report.schemaDifferences).toEqual([]);
		expect(database.prepare('SELECT id, kind, replaces_id, answers FROM decision_responses ORDER BY id').all()).toEqual([
			{ id: 1, kind: 'vote', replaces_id: null, answers: null },
			{ id: 2, kind: 'abstain', replaces_id: 1, answers: null }
		]);
		// Every other cell of every response, and every other table, as it was.
		const after = contentsOf(database);
		expect(after['decision_survey_questions']).toEqual([]);
		for (const table of Object.keys(before)) {
			if (['__drizzle_migrations', 'sqlite_sequence'].includes(table)) continue;
			// And for what 0084 changes, applied in the same run (card 3064).
			expect(after[table], table).toEqual(as0084Leaves(table, table === 'decision_responses' ? withColumns(before[table], { answers: null }) : before[table]));
		}
		const found: Findings = { problems: [], notes: [] };
		compare(state, stateOf(database), report.applied, found);
		expect(found.problems).toEqual([]);

		// The cascade: a question goes with its decision (its responses and every other row of it too).
		expect(foreignKeysOn(database)).toBe(true);
		database.exec('INSERT INTO decision_survey_questions (decision_id, position, added_in_version) VALUES (1, 0, 1)');
		database.exec('DELETE FROM decisions WHERE id = 1');
		expect(database.prepare('SELECT count(*) FROM decision_survey_questions').pluck().get()).toBe(0);

		// Runs once: the next start applies nothing.
		expect(runMigrations({ database, migrationsDir: REAL_MIGRATIONS }).applied).toEqual([]);
	});
});

// ─── 0083: a participant's objections and requests to talk ──────────────────

describe("0083, which adds a participant's objections and requests to talk, and the decider's replies (card 2684)", () => {
	it('T1: is the table and its three indexes after a header comment, declares nothing to the rehearsal; a database at 0082 reports the table and nothing else, keeps every row, and after it the model check is clean, the keys hold and it runs once', () => {
		const sql = readFileSync(join(REAL_MIGRATIONS, FILE_0083), 'utf-8').replace(/\r\n/g, '\n');
		expect(sqlStatements(sql).map((s) => s.text.split(/\s+/).slice(0, 3).join(' '))).toEqual([
			'CREATE TABLE `decision_flags`',
			'CREATE INDEX `idx_decision_flags_decision_id`',
			'CREATE INDEX `idx_decision_flags_participant_id`',
			'CREATE INDEX `idx_decision_flags_replied_by`'
		]);
		// Each is the statement the model's export prints, so the two cannot drift; and no IF NOT EXISTS, as 0063 and 0082.
		for (const statement of sqlStatements(sql)) {
			expect(EXPECTED_SCHEMA).toContain(statement.text);
			expect(statement.text).not.toContain('IF NOT EXISTS');
		}
		for (const said of ['card 2106', 'No IF NOT EXISTS, as 0063 and 0082', 'Runs once.', 'A backup made before this file', 'Going back to an older image', '332634f', 'Never drop the table']) {
			expect(sql, said).toContain(said);
		}
		expect(ONE_OFFS.filter((oneOff) => oneOff.file === FILE_0083)).toEqual([]);
		expect(TOLERANT_FILES).not.toContain(FILE_0083);

		// A database at 0082 holding an open decision and a participant.
		const database = memoryDb();
		expect(runMigrations({ database, migrationsDir: filesTo(FILE_0082) }).applied.at(-1)).toBe(FILE_0082);
		database.exec(`
			INSERT INTO users (id, username, email, password_hash, role, created_at) VALUES (1, 'chief', 'chief@example.test', 'x', 'superadmin', '2026-01-01 09:00:00'),
				(2, 'dana', 'dana@example.test', 'x', 'user', '2026-01-01 09:00:00');
			INSERT INTO decisions (id, board_name, title, status, current_version, author_user_id, author_name, decider_user_id, decider_name, closes_at, opened_at, created_at, updated_at)
				VALUES (1, 'Board', 'Pick one', 'open', 1, 1, 'chief', 2, 'dana', '2026-12-01 09:00:00', '2026-11-01 09:00:00', '2026-11-01 08:00:00', '2026-11-01 09:00:00');
			INSERT INTO decision_participants (id, decision_id, role, name, email, job_title, groups, included_at, user_id)
				VALUES (1, 1, 'consulted', 'chief', 'chief@example.test', '', '[]', '2026-11-01 09:00:00', 1);
		`);
		// Before 0083 the model check reports its table, and nothing else.
		expect(schemaDifferences(database)).toEqual([TABLE_OF_0083, COLUMN_OF_0084]);
		const tables = tablesOf(database);
		const indexes = indexesOf(database);
		const before = contentsOf(database);

		const report = runMigrations({ database, migrationsDir: REAL_MIGRATIONS });

		// And 0084 (card 3064).
		expect(report.applied).toEqual([FILE_0083, FILE_0084]);
		expect(report.schemaDifferences).toEqual([]);
		expect(schemaDifferences(database)).toEqual([]);
		expect(tablesOf(database)).toEqual([...tables, 'decision_flags'].sort());
		expect(indexesOf(database)).toEqual([...indexes, ...INDEXES_OF_0083].sort());
		// Every row as it was, and the new table empty.
		const after = contentsOf(database);
		expect(after['decision_flags']).toEqual([]);
		for (const table of Object.keys(before)) {
			if (['__drizzle_migrations', 'sqlite_sequence'].includes(table)) continue;
			// But for what 0084 changes, applied in the same run (card 3064).
			expect(after[table], table).toEqual(as0084Leaves(table, before[table]));
		}
		expect(database.prepare('SELECT "table", "from", on_delete AS onDelete FROM pragma_foreign_key_list(?) ORDER BY "from"').all('decision_flags')).toEqual([
			{ table: 'decisions', from: 'decision_id', onDelete: 'CASCADE' },
			{ table: 'decision_participants', from: 'participant_id', onDelete: 'NO ACTION' },
			{ table: 'users', from: 'replied_by', onDelete: 'SET NULL' }
		]);

		// The keys: a place a flag names cannot be deleted; the replier's account deleted leaves the reply and the name; the
		// decision deleted takes its flags with it.
		expect(foreignKeysOn(database)).toBe(true);
		database.exec(
			"INSERT INTO decision_flags (decision_id, participant_id, kind, reason, version_number, via, raised_at, reply, replied_by, replied_by_name, replied_at) VALUES (1, 1, 'objection', 'No.', 1, 'session', '2026-11-02 09:00:00', 'Heard.', 2, 'dana', '2026-11-03 09:00:00')"
		);
		expect(() => database.exec('DELETE FROM decision_participants WHERE id = 1')).toThrow(/FOREIGN KEY/);
		database.exec('DELETE FROM users WHERE id = 2');
		expect(database.prepare('SELECT reply, replied_by AS repliedBy, replied_by_name AS repliedByName FROM decision_flags').get()).toEqual({ reply: 'Heard.', repliedBy: null, repliedByName: 'dana' });
		database.exec('DELETE FROM decisions WHERE id = 1');
		expect(database.prepare('SELECT count(*) FROM decision_flags').pluck().get()).toBe(0);

		// Runs once: the next start applies nothing.
		expect(runMigrations({ database, migrationsDir: REAL_MIGRATIONS }).applied).toEqual([]);
	});
});

// ─── 0084: the compatibility release ─────────────────────────────────────────

describe('0084, the compatibility release, which keeps what a server from before two-step sign-in holds (card 3064)', () => {
	const STAMP = '2026-10-01 09:00:00';
	const LATER = '2099-01-01 00:00:00';
	const DAY = 86_400_000;
	/** A request token as 106ea45 mailed one: 64 hex. */
	const REQUEST_TOKEN = 'a1'.repeat(32);
	/** The six first-run flags 0084 seeds, in name order. */
	const FLAGS = [
		'report_schedules_announced',
		'stored_images_rechecked',
		'webhook_reveals_seeded',
		'webhooks_already_off_held',
		'webhooks_before_keys_announced',
		'webhooks_readable_by_disabled_held'
	];
	const STORED_FORM = /^\d{4}-\d{2}-\d{2} \d{2}:\d{2}:\d{2}$/;

	/** The SHA-256 of `text`, its 32 bytes, as the application hashes a session's code or an invite's token. */
	const sha256 = (text: string) => createHash('sha256').update(text).digest();
	/** The moment a stored-form value names, in milliseconds. */
	const momentOf = (value: string) => Date.parse(`${value.replace(' ', 'T')}Z`);
	/** Every setting, by key. */
	const settingsOf = (database: Database.Database) =>
		Object.fromEntries((database.prepare('SELECT key, value FROM settings').all() as { key: string; value: string }[]).map((row) => [row.key, row.value]));

	/**
	 * A database at 0083, as the release's start finds it on live just before 0084: every file from 0061 on applied,
	 * 0067, 0068 and 0070 in their edited form, so that 0066's release moment, 0069's deadline setting and 0071's moment
	 * are written. Two accounts and a board; nothing else.
	 */
	function at0083(): Database.Database {
		const database = memoryDb();
		synthetic({ database, migrationsDir: filesTo(FILE_0083) });
		database.exec(`
			INSERT INTO users (id, username, email, password_hash, role, created_at) VALUES
				(1, 'ann', 'ann@example.test', 'x', 'superadmin', '${STAMP}'),
				(2, 'bob', 'bob@example.test', 'x', 'user', '${STAMP}');
			INSERT INTO boards (id, name, created_by, created_at, updated_at) VALUES (1, 'Board', 1, '${STAMP}', '${STAMP}');
		`);
		return database;
	}

	/**
	 * At 0083 with what 106ea45 wrote and 0061 to 0083 left in place (A3): two sessions in plain, ann's expiring in 60 days
	 * and bob's in 10; an unused invite in plain; a request with its token and one with none; two API keys, the first given
	 * 0069's deadline; both accounts with 0066's leave to set up on a password; and three webhooks, set before keys were
	 * recorded (set_with_key NULL), with a key (1) and with none (0).
	 */
	function liveAt0083(): Database.Database {
		const database = at0083();
		const far = stamp(new Date(Date.now() + 60 * DAY));
		const near = stamp(new Date(Date.now() + 10 * DAY));
		database.exec(`
			UPDATE users SET mfa_password_enrol = 1;
			INSERT INTO sessions (id, user_id, expires_at, created_at) VALUES
				('ann-laptop', 1, '${far}', '${STAMP}'),
				('bob-phone', 2, '${near}', '${STAMP}');
			INSERT INTO invite_tokens (token, user_id, expires_at, used, created_at) VALUES ('mailed-invite', 2, '${LATER}', 0, '${STAMP}');
			INSERT INTO task_requests (id, target_type, target_id, title, requester_name, requester_email, status, access_token, created_at) VALUES
				(1, 'user', 1, 'With a link', 'Rita', 'rita@example.test', 'pending', '${REQUEST_TOKEN}', '${STAMP}'),
				(2, 'user', 1, 'Without one', 'Rita', 'rita@example.test', 'pending', NULL, '${STAMP}');
			INSERT INTO api_keys (id, key_hash, key_prefix, name, user_id, expires_at, created_at) VALUES
				(1, 'hash-one', 'df_one', 'No expiry', 1, NULL, '${STAMP}'),
				(2, 'hash-two', 'df_two', 'Soon', 1, '${near}', '${STAMP}');
			UPDATE api_keys SET deadline_at = (SELECT value FROM settings WHERE key = 'api_key_deadline') WHERE id = 1;
			INSERT INTO webhooks (id, board_id, url, secret, set_by, set_by_key, set_with_key, created_at) VALUES
				(1, 1, 'https://hooks.example.test/1', 's1', 1, NULL, NULL, '${STAMP}'),
				(2, 1, 'https://hooks.example.test/2', 's2', 1, 1, 1, '${STAMP}'),
				(3, 1, 'https://hooks.example.test/3', 's3', 1, NULL, 0, '${STAMP}');
		`);
		return database;
	}

	it('card 3064 T13: sha256_blob and sha256_hex are on a database a test passes to the runner, give the digests Node gives, and NULL for NULL', () => {
		const database = memoryDb();
		runMigrations({ database, migrationsDir: REAL_MIGRATIONS });

		const read = database
			.prepare("SELECT sha256_blob('ann-laptop') AS blob, sha256_hex('ann-laptop') AS hex, sha256_blob(NULL) AS noBlob, sha256_hex(NULL) AS noHex, typeof(sha256_blob('x')) AS type")
			.get() as { blob: Buffer; hex: string; noBlob: null; noHex: null; type: string };
		expect(read.blob.equals(createHash('sha256').update('ann-laptop').digest())).toBe(true);
		expect(read.hex).toBe(createHash('sha256').update('ann-laptop').digest('hex'));
		expect(read.noBlob).toBeNull();
		expect(read.noHex).toBeNull();
		expect(read.type).toBe('blob');
		// Text as the application hashes a token: its UTF-8 bytes.
		expect(database.prepare("SELECT sha256_hex('café')").pluck().get()).toBe(createHash('sha256').update('café').digest('hex'));
		// The forms the application looks a session, an invite and a requester link up by.
		expect(database.prepare("SELECT sha256_hex('t')").pluck().get()).toBe(requestLinkHash('t'));
		expect((database.prepare("SELECT sha256_blob('t')").pluck().get() as Buffer).equals(inviteTokenHash('t'))).toBe(true);
	});

	it('card 3064 T1: on a database with nothing in plain (dev’s), changes no session, invite, link or key, gives every session kept_at_release 0, writes the release moment, the six flags, the one-shot leave to keep the seal key and the scrub marker, and runs once', () => {
		const sql = readFileSync(join(REAL_MIGRATIONS, FILE_0084), 'utf-8').replace(/\r\n/g, '\n');
		for (const said of ['What people see:', 'Runs once.', 'A backup before it', 'Going back to an older image', 'keepsRows on sessions']) {
			expect(sql, said).toContain(said);
		}
		expect(TOLERANT_FILES).not.toContain(FILE_0084);

		const database = at0083();
		database.prepare('INSERT INTO sessions (id, user_id, expires_at, created_at, two_step) VALUES (?, 1, ?, ?, 1)').run(sha256('made-since'), LATER, STAMP);
		database.prepare('INSERT INTO invite_tokens (token, user_id, expires_at, used, created_at) VALUES (?, 2, ?, 0, ?)').run(sha256('sent-since'), LATER, STAMP);
		database.exec(`
			INSERT INTO task_requests (id, target_type, target_id, title, requester_name, requester_email, status, created_at) VALUES
				(1, 'user', 1, 'Since', 'Rita', 'rita@example.test', 'pending', '${STAMP}');
			INSERT INTO request_links (token_hash, request_id, source, created_at) VALUES ('${'b2'.repeat(32)}', 1, 'mail', '${STAMP}');
			INSERT INTO api_keys (key_hash, key_prefix, name, user_id, created_at) VALUES ('hash-since', 'df_since', 'Since', 1, '${STAMP}');
		`);
		const before = contentsOf(database);

		const report = runMigrations({ database, migrationsDir: REAL_MIGRATIONS });

		expect(report.applied).toEqual([FILE_0084]);
		expect(report.schemaDifferences).toEqual([]);
		const after = contentsOf(database);
		expect(after.sessions).toEqual(withColumns(before.sessions, { kept_at_release: 0 }));
		for (const table of ['invite_tokens', 'task_requests', 'request_links', 'api_keys', 'users', 'webhooks']) expect(after[table], table).toEqual(before[table]);
		const settings = settingsOf(database);
		expect(Object.keys(settings).sort()).toEqual(['compatibility_release_at', ...FLAGS, 'backup_seal_key_keep_once', 'secrets_scrub_pending', 'webhook_keys_recorded_at'].sort());
		expect(settings.compatibility_release_at).toMatch(STORED_FORM);
		// Its code review: the one-shot leave to keep a plain seal key (CS-M2), and the scrub's marker as an ISO time of this run (CS-L4).
		expect(settings.backup_seal_key_keep_once).toMatch(STORED_FORM);
		expect(settings.secrets_scrub_pending).toMatch(/^\d{4}-\d{2}-\d{2}T\d{2}:\d{2}:\d{2}\.\d{3}Z$/);
		expect(Math.abs(Date.parse(settings.secrets_scrub_pending) - Date.now())).toBeLessThan(60_000);
		expect(Math.abs(momentOf(settings.compatibility_release_at) - Date.now())).toBeLessThan(60_000);
		for (const flag of FLAGS) expect(settings[flag], flag).toMatch(STORED_FORM);

		// Runs once: the next start applies nothing and changes nothing.
		const done = contentsOf(database);
		expect(runMigrations({ database, migrationsDir: REAL_MIGRATIONS }).applied).toEqual([]);
		expect(contentsOf(database)).toEqual(done);
	});

	it('card 3064 T2: a plain session becomes its SHA-256 BLOB, kept_at_release 1, dated at the release, its expiry capped at 30 days in the stored form; a hashed one is untouched with 0', () => {
		const database = liveAt0083();
		database.prepare('INSERT INTO sessions (id, user_id, expires_at, created_at, two_step) VALUES (?, 1, ?, ?, 1)').run(sha256('made-since'), LATER, STAMP);
		const bobExpiry = database.prepare("SELECT expires_at FROM sessions WHERE id = 'bob-phone'").pluck().get() as string;

		runMigrations({ database, migrationsDir: REAL_MIGRATIONS });

		const release = settingsOf(database).compatibility_release_at;
		const rows = database.prepare('SELECT id, user_id AS userId, created_at AS createdAt, expires_at AS expiresAt, two_step AS twoStep, kept_at_release AS kept FROM sessions ORDER BY user_id, kept').all() as {
			id: Buffer;
			userId: number;
			createdAt: string;
			expiresAt: string;
			twoStep: number;
			kept: number;
		}[];
		expect(rows.map((row) => ({ ...row, id: row.id.toString('hex') }))).toEqual([
			// Ann's, made since: as it was, marked 0.
			{ id: sha256('made-since').toString('hex'), userId: 1, createdAt: STAMP, expiresAt: LATER, twoStep: 1, kept: 0 },
			// Ann's laptop: 60 days out, capped at 30.
			{ id: sha256('ann-laptop').toString('hex'), userId: 1, createdAt: release, expiresAt: expect.stringMatching(STORED_FORM), twoStep: 0, kept: 1 },
			// Bob's phone: 10 days out, its own expiry.
			{ id: sha256('bob-phone').toString('hex'), userId: 2, createdAt: release, expiresAt: bobExpiry, twoStep: 0, kept: 1 }
		]);
		expect(Math.abs(momentOf(rows[1].expiresAt) - (Date.now() + 30 * DAY))).toBeLessThan(60_000);
		expect(database.prepare("SELECT COUNT(*) FROM sessions WHERE typeof(id) <> 'blob' OR length(id) <> 32").pluck().get()).toBe(0);
	});

	it('card 3064 T3: a plain unused invite becomes its hash, and usableInvite opens it by the mailed token', () => {
		const database = liveAt0083();

		runMigrations({ database, migrationsDir: REAL_MIGRATIONS });

		const invite = database.prepare('SELECT token, user_id AS userId, expires_at AS expiresAt, used, created_at AS createdAt FROM invite_tokens').all() as {
			token: Buffer;
			userId: number;
			expiresAt: string;
			used: number;
			createdAt: string;
		}[];
		expect(invite).toHaveLength(1);
		expect(Buffer.isBuffer(invite[0].token) && invite[0].token.equals(inviteTokenHash('mailed-invite'))).toBe(true);
		expect({ ...invite[0], token: null }).toEqual({ token: null, userId: 2, expiresAt: LATER, used: 0, createdAt: STAMP });

		// The row as this server holds it, here: the mailed link opens it.
		resetDb();
		const bob = makeUser();
		sqlite.prepare('INSERT INTO invite_tokens (token, user_id, expires_at, used, created_at) VALUES (?, ?, ?, ?, ?)').run(invite[0].token, bob.id, LATER, 0, STAMP);
		expect(usableInvite('mailed-invite')?.userId).toBe(bob.id);
		expect(usableInvite('another-token')).toBeUndefined();
		resetDb();
	});

	it('card 3064 T4: a request’s token moves into request_links as a mail link dated at the release, linkCheck opens the request with the old token, and the column is NULL', () => {
		const database = liveAt0083();

		runMigrations({ database, migrationsDir: REAL_MIGRATIONS });

		const release = settingsOf(database).compatibility_release_at;
		expect(database.prepare('SELECT access_token FROM task_requests ORDER BY id').pluck().all()).toEqual([null, null]);
		const links = database.prepare('SELECT token_hash AS tokenHash, request_id AS requestId, source, created_at AS createdAt FROM request_links').all();
		expect(links).toEqual([{ tokenHash: requestLinkHash(REQUEST_TOKEN), requestId: 1, source: 'mail', createdAt: release }]);

		// The link as this server holds it, here: the mailed token opens its request and no other.
		resetDb();
		const ann = makeUser();
		const insert = sqlite.prepare(
			"INSERT INTO task_requests (target_type, target_id, title, requester_name, requester_email, status) VALUES ('user', ?, ?, 'Rita', 'rita@example.test', 'pending') RETURNING id"
		);
		const linked = insert.pluck().get(ann.id, 'With a link') as number;
		const other = insert.pluck().get(ann.id, 'Without one') as number;
		sqlite.prepare("INSERT INTO request_links (token_hash, request_id, source, created_at) VALUES (?, ?, 'mail', ?)").run(requestLinkHash(REQUEST_TOKEN), linked, release);
		const requestOf = (id: number) => db.select().from(taskRequests).where(eq(taskRequests.id, id)).get()!;
		expect(linkCheck(REQUEST_TOKEN)(requestOf(linked))).toBe(true);
		expect(linkCheck(REQUEST_TOKEN)(requestOf(other))).toBe(false);
		resetDb();
	});

	it('card 3064 T5: every deadline 0069 wrote, and its setting, are gone', () => {
		const database = liveAt0083();
		expect(database.prepare('SELECT COUNT(*) FROM api_keys WHERE deadline_at IS NOT NULL').pluck().get()).toBe(1);
		const keysBefore = database.prepare('SELECT id, key_hash, expires_at, created_at FROM api_keys ORDER BY id').all();

		runMigrations({ database, migrationsDir: REAL_MIGRATIONS });

		expect(database.prepare('SELECT deadline_at FROM api_keys ORDER BY id').pluck().all()).toEqual([null, null]);
		expect(database.prepare('SELECT id, key_hash, expires_at, created_at FROM api_keys ORDER BY id').all()).toEqual(keysBefore);
		expect(settingsOf(database)).not.toHaveProperty('api_key_deadline');
	});

	it('card 3064 T6: two_step_released_at is deleted and every mark of leave to set up on a password zeroed', () => {
		const database = liveAt0083();
		expect(settingsOf(database)).toHaveProperty('two_step_released_at');

		runMigrations({ database, migrationsDir: REAL_MIGRATIONS });

		expect(settingsOf(database)).not.toHaveProperty('two_step_released_at');
		expect(database.prepare('SELECT username, mfa_password_enrol AS mark FROM users ORDER BY id').all()).toEqual([
			{ username: 'ann', mark: 0 },
			{ username: 'bob', mark: 0 }
		]);
		// Nor any switch: two-step sign-in is dormant.
		expect(settingsOf(database)).not.toHaveProperty('two_step_required_at');
	});

	it('card 3064 T7: a webhook with set_with_key NULL becomes 0, and holdOf gives null when its setter has no key from before; 1 and 0 stay', () => {
		const database = liveAt0083();

		runMigrations({ database, migrationsDir: REAL_MIGRATIONS });

		const rows = database.prepare('SELECT id, set_with_key AS setWithKey FROM webhooks ORDER BY id').all() as { id: number; setWithKey: number | null }[];
		expect(rows).toEqual([
			{ id: 1, setWithKey: 0 },
			{ id: 2, setWithKey: 1 },
			{ id: 3, setWithKey: 0 }
		]);

		// The first as this server holds it, here: its setter can open the board and has no key made before keys were
		// recorded. As the release found it (NULL), 2893's rule would hold it.
		resetDb();
		const setter = makeUser();
		const board = makeBoard({ owner: setter }).board;
		const migrated = makeWebhook(board, { setBy: setter, setWithKey: rows[0].setWithKey === null ? null : rows[0].setWithKey !== 0 });
		const asFound = makeWebhook(board, { setBy: setter, setWithKey: null });
		expect(holdOf(migrated)).toBeNull();
		expect(holdOf(asFound)).toBe('key ended');
		resetDb();
	});

	it('card 3064 T8: a flag already present keeps its value (ON CONFLICT DO NOTHING), and so does a release moment', () => {
		const database = liveAt0083();
		database.exec(`
			INSERT INTO settings (key, value) VALUES ('stored_images_rechecked', '2026-01-02 03:04:05'), ('compatibility_release_at', '2026-01-03 04:05:06');
		`);

		runMigrations({ database, migrationsDir: REAL_MIGRATIONS });

		const settings = settingsOf(database);
		expect(settings.stored_images_rechecked).toBe('2026-01-02 03:04:05');
		expect(settings.compatibility_release_at).toBe('2026-01-03 04:05:06');
		for (const flag of FLAGS.filter((f) => f !== 'stored_images_rechecked')) {
			expect(Math.abs(momentOf(settings[flag]) - Date.now()), flag).toBeLessThan(60_000);
		}
	});

	it('card 3064 T72: ISO-form expiries: one 40 days out is capped and written in the stored form, one 10 days out keeps its moment in the stored form, and one that names no moment is left as it is and the start’s clean-up deletes it', () => {
		const database = at0083();
		const iso = (ms: number) => new Date(ms).toISOString();
		const tenDays = Date.now() + 10 * DAY;
		database.exec(`
			INSERT INTO sessions (id, user_id, expires_at, created_at) VALUES
				('iso-far', 1, '${iso(Date.now() + 40 * DAY)}', '${STAMP}'),
				('iso-near', 1, '${iso(tenDays)}', '${STAMP}'),
				('no-moment', 2, 'zzz', '${STAMP}');
		`);

		const report = runMigrations({ database, migrationsDir: REAL_MIGRATIONS });

		const expiryOf = (code: string) => database.prepare('SELECT expires_at FROM sessions WHERE id = ?').pluck().get(sha256(code)) as string;
		expect(expiryOf('iso-far')).toMatch(STORED_FORM);
		expect(Math.abs(momentOf(expiryOf('iso-far')) - (Date.now() + 30 * DAY))).toBeLessThan(60_000);
		expect(expiryOf('iso-near')).toBe(stamp(new Date(tenDays)));
		expect(expiryOf('no-moment')).toBe('zzz');
		// 0084 wrote the stored form itself: the start's conversion had none of them to rewrite.
		expect(report.timestamps?.converted).not.toHaveProperty('sessions.expires_at');
		expect(database.prepare('SELECT COUNT(*) FROM sessions WHERE kept_at_release = 1').pluck().get()).toBe(3);

		// The row that names no moment, as this server holds it: the start's clean-up deletes it.
		resetDb();
		const bob = makeUser();
		sqlite.prepare('INSERT INTO sessions (id, user_id, expires_at, created_at, kept_at_release) VALUES (?, ?, ?, ?, 1)').run(sha256('no-moment'), bob.id, 'zzz', stamp());
		cleanExpiredSessions();
		expect(sqlite.prepare('SELECT COUNT(*) FROM sessions').pluck().get()).toBe(0);
		resetDb();
	});
});

// ─── The three backfills of the commitment point ─────────────────────────────

describe('the backfills of the commitment point, repeated at every start (milestone 22)', () => {
	const STAMP = '2026-10-01 09:00:00';

	/**
	 * A current database. Board A (1) is a delivery board with an Options
	 * column (1), To Do (2) and Complete (3); board B (2) is an ideas board
	 * (column 4). Cards:
	 *
	 *    1  To Do, no commitment, raised by Bob       committed, by Bob
	 *    2  Complete, archived, no commitment         committed, by nobody recorded
	 *    3  Options, no commitment                    left an option
	 *    4  the ideas board, no commitment            left an option
	 *    5  Options, holding a commitment             cleared
	 *    6  the ideas board, holding a commitment     cleared
	 *    7  To Do, committed earlier than created     left as it is
	 *    8  To Do, not archived, marked discarded     the mark cleared
	 *    9  Options, archived and discarded           left as it is
	 *   10  a column that is not there                left alone
	 */
	function current(): Database.Database {
		const database = memoryDb();
		runMigrations({ database, migrationsDir: REAL_MIGRATIONS });
		database.exec(`
			INSERT INTO users (id, username, email, password_hash) VALUES (1, 'ann', 'ann@example.test', 'x'), (2, 'bob', 'bob@example.test', 'x');
			INSERT INTO boards (id, name, kind) VALUES (1, 'Delivery', 'delivery'), (2, 'Ideas', 'ideas');
			INSERT INTO columns (id, board_id, title, position, role) VALUES
				(1, 1, 'Options', 0, 'options'), (2, 1, 'To Do', 1, NULL), (3, 1, 'Complete', 2, NULL), (4, 2, 'New Ideas', 0, NULL);
			PRAGMA foreign_keys = OFF;
			INSERT INTO cards (id, column_id, title, created_by, created_at, updated_at, archived_at, committed_at, committed_by, discarded_at, discarded_by) VALUES
				(1, 2, 'One', 2, '2026-09-01 08:00:00', '${STAMP}', NULL, NULL, NULL, NULL, NULL),
				(2, 3, 'Two', NULL, '2026-09-02 08:00:00', '${STAMP}', '${STAMP}', NULL, NULL, NULL, NULL),
				(3, 1, 'Three', 1, '2026-09-03 08:00:00', '${STAMP}', NULL, NULL, NULL, NULL, NULL),
				(4, 4, 'Four', 1, '2026-09-04 08:00:00', '${STAMP}', NULL, NULL, NULL, NULL, NULL),
				(5, 1, 'Five', 1, '2026-09-05 08:00:00', '${STAMP}', NULL, '2026-09-06 08:00:00', 1, NULL, NULL),
				(6, 4, 'Six', 1, '2026-09-06 08:00:00', '${STAMP}', NULL, '2026-09-07 08:00:00', 2, NULL, NULL),
				(7, 2, 'Seven', 1, '2026-09-07 08:00:00', '${STAMP}', NULL, '2026-09-08 08:00:00', 2, NULL, NULL),
				(8, 2, 'Eight', 1, '2026-09-08 08:00:00', '${STAMP}', NULL, '2026-09-08 08:00:00', 1, '${STAMP}', 1),
				(9, 1, 'Nine', 1, '2026-09-09 08:00:00', '${STAMP}', '${STAMP}', NULL, NULL, '${STAMP}', 1),
				(10, 99, 'Ten', 1, '2026-09-10 08:00:00', '${STAMP}', NULL, NULL, NULL, NULL, NULL);
			PRAGMA foreign_keys = ON;
		`);
		return database;
	}

	const commitmentsIn = (database: Database.Database) =>
		(
			database
				.prepare('SELECT id, committed_at, committed_by, discarded_at, discarded_by, updated_at FROM cards ORDER BY id')
				.all() as { id: number; committed_at: string | null; committed_by: number | null; discarded_at: string | null; discarded_by: number | null; updated_at: string }[]
		).map((c) => [c.id, c.committed_at, c.committed_by, c.discarded_at, c.discarded_by, c.updated_at]);

	it('commit each card not upstream that has no commitment, clear one on an upstream card and a discard mark on a live card, once', () => {
		const database = current();

		expect(runBackfills(database)).toEqual({
			firstCompletedAt: 0,
			releasedFromMilestones: 0,
			released: [],
			unfiledBoards: 0,
			unfiled: [],
			committedFilled: 2,
			upstreamCleared: 2,
			discardedCleared: 1,
			optionsAdded: 0,
			optionsMoved: 0,
			optionsRenamed: 0,
			optionsDemoted: 0
		});
		expect(commitmentsIn(database)).toEqual([
			[1, '2026-09-01 08:00:00', 2, null, null, STAMP],
			[2, '2026-09-02 08:00:00', null, null, null, STAMP],
			[3, null, null, null, null, STAMP],
			[4, null, null, null, null, STAMP],
			[5, null, null, null, null, STAMP],
			[6, null, null, null, null, STAMP],
			[7, '2026-09-08 08:00:00', 2, null, null, STAMP],
			[8, '2026-09-08 08:00:00', 1, null, null, STAMP],
			[9, null, null, STAMP, 1, STAMP],
			[10, null, null, null, null, STAMP]
		]);
		// Every card's updated_at is as it was: nobody edited them.
		expect(runBackfills(database)).toMatchObject({ committedFilled: 0, upstreamCleared: 0, discardedCleared: 0 });
	});

	it('say what they did at a start in WARN lines, none of them beginning "Took"', () => {
		const database = current();
		process.env.LOG_LEVEL = 'WARN';
		const lines: string[] = [];
		vi.spyOn(console, 'warn').mockImplementation((line) => {
			lines.push(String(line).replace(/^\[[^\]]+\] /, ''));
		});

		const report = runMigrations({ database, migrationsDir: REAL_MIGRATIONS });

		expect(report.backfilled).toMatchObject({ committedFilled: 2, upstreamCleared: 2, discardedCleared: 1 });
		expect(lines).toEqual([
			'[WARN] [DB] Committed 2 card(s) that are not upstream and had no commitment recorded, at the moment each was created and by whoever created it',
			'[WARN] [DB] Cleared the commitment on 2 card(s) in an Options column or on an ideas board: an option is not committed',
			'[WARN] [DB] Cleared the discard mark on 1 card(s) that are not archived'
		]);
		expect(lines.filter((line) => line.includes('Took '))).toEqual([]);
	});

	it('commit a card on a board of a kind it does not know, the exact complement of the clear (the S1a review, R3)', () => {
		const database = memoryDb();
		runMigrations({ database, migrationsDir: REAL_MIGRATIONS });
		database.exec(`
			INSERT INTO boards (id, name, kind) VALUES (1, 'Portfolio', 'portfolio');
			INSERT INTO columns (id, board_id, title, position, role) VALUES (1, 1, 'Ideas', 0, 'options'), (2, 1, 'Doing', 1, NULL);
			INSERT INTO cards (id, column_id, title, created_at) VALUES (1, 2, 'Committed', '${STAMP}'), (2, 1, 'An option', '${STAMP}');
		`);

		expect(runBackfills(database)).toMatchObject({ committedFilled: 1, upstreamCleared: 0 });
		expect(commitmentsIn(database).map((row) => row.slice(0, 2))).toEqual([
			[1, STAMP],
			[2, null]
		]);
		// Every card is on one side or the other: one more run moves nothing either way.
		expect(runBackfills(database)).toMatchObject({ committedFilled: 0, upstreamCleared: 0 });
	});

	it('skip what is not there, as on a database the runner was given other files for', () => {
		const database = memoryDb();
		database.exec('CREATE TABLE cards (id INTEGER PRIMARY KEY, created_at TEXT, created_by INTEGER, archived_at TEXT)');
		database.exec("INSERT INTO cards (id, created_at) VALUES (1, '2026-09-01 08:00:00')");

		expect(runBackfills(database)).toMatchObject({ committedFilled: 0, upstreamCleared: 0, discardedCleared: 0 });
	});

	it('repair a restored backup as they repair a start', () => {
		// A backup in the current shape, as one made after 0060 and restored into
		// an older build, then brought forward, can be: a card with no
		// commitment, commitments on options and a discard mark on a live card.
		// Card 10, on no column, is left out: the restore reports such a row, which is another test's.
		const backup = current();
		backup.exec("UPDATE users SET role = 'superadmin' WHERE id = 1; DELETE FROM cards WHERE id = 10");
		const live = memoryDb();
		runMigrations({ database: live, migrationsDir: REAL_MIGRATIONS });
		const repaired = current();
		repaired.exec('DELETE FROM cards WHERE id = 10');
		runBackfills(repaired);

		const result = restoreFromBackup(live, backup);

		expect(result.errors).toEqual([]);
		expect(result.backfilled).toMatchObject({ committedFilled: 2, upstreamCleared: 2, discardedCleared: 1 });
		expect(commitmentsIn(live)).toEqual(commitmentsIn(repaired));
	});
});
