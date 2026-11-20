/**
 * Import Backup as a working copy: a restore that switches off what reaches
 * outside the instance.
 *
 * A backup of production restored anywhere else arrives with production's
 * report schedules, webhooks, backup destinations and mail settings, all live.
 * Keeping the schedulers from starting does not disarm it: assigning a card
 * still mails real people and calls real webhook addresses, and a backup run by
 * hand still uploads to production's destination and prunes what is there. So
 * the import asks, and `outside: 'off'` switches the four off or removes them
 * inside the restore's own transaction.
 *
 * These tests ask three things of it. That `'off'` leaves nothing live, as the
 * code that would act on it reads it, and changes nothing else. That `'keep'`,
 * which is what putting an installation back needs, restores all four exactly.
 * And that the choice made when none is given is the same in the route and in
 * the dialog, and follows whether the instance runs its schedulers.
 *
 * Every database a test here builds is in memory. `dumpfire.db` holds real
 * data and nothing here goes near it. The tests that call the import route
 * point it at a temporary directory first, because it writes its upload and a
 * safety copy under the working directory, and they empty the application's
 * own in-memory database again afterwards.
 */
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import Database from 'better-sqlite3';
import { and, eq } from 'drizzle-orm';
import { existsSync, mkdtempSync, readFileSync, readdirSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { generateBackupData, getBackupConfig, withoutSecrets } from '$lib/server/backup';
import { db, sqlite } from '$lib/server/db';
import { runMigrations } from '$lib/server/db/migrate';
import {
	RestoreError,
	SIGNED_OUT,
	defaultOutside,
	restoreFromBackup,
	switchOffOutside,
	type OutsideSwitchedOff
} from '$lib/server/db/restore';
import { reportSchedules, webhooks } from '$lib/server/db/schema';
import { getSmtpConfig, isSmtpConfigured } from '$lib/server/email';
import { issueFormToken, resetFormSecretCache, verifyFormToken } from '$lib/server/request-tokens';
import { api, routeMethods } from './helpers/api';
import { importConfirmation, makeUser, resetDb, startedSinceAlreadyOffHeld } from './helpers/fixtures';
import { afterEachTimestampCheck } from './helpers/timestamps';
import { readOpened, readOpenedUrl } from './helpers/reads';

const REAL_MIGRATIONS = join(process.cwd(), 'drizzle');

// ─── Helpers ─────────────────────────────────────────────────────────────────

const opened: Database.Database[] = [];
const tempDirs: string[] = [];
const logLevel = process.env.LOG_LEVEL;
const schedulers = process.env.SCHEDULERS;

// Not set, whatever the shell that started the tests has: the default these
// tests expect is the dev server's, and vitest runs as one.
beforeEach(() => {
	delete process.env.SCHEDULERS;
});

afterEach(() => {
	for (const database of opened.splice(0)) database.close();
	for (const dir of tempDirs.splice(0)) rmSync(dir, { recursive: true, force: true });
	vi.restoreAllMocks();
	if (logLevel === undefined) delete process.env.LOG_LEVEL;
	else process.env.LOG_LEVEL = logLevel;
	if (schedulers === undefined) delete process.env.SCHEDULERS;
	else process.env.SCHEDULERS = schedulers;
});

/** A separate, empty in-memory database with foreign keys on, as the application's has. */
function memoryDb(): Database.Database {
	const database = new Database(':memory:');
	database.pragma('foreign_keys = ON');
	opened.push(database);
	return database;
}

/** A separate in-memory database with every migration applied, and no rows. */
function migratedDb(): Database.Database {
	const database = memoryDb();
	runMigrations({ database, migrationsDir: REAL_MIGRATIONS });
	return database;
}

/**
 * Every row of every table, as text, sorted. The stored secrets opened: a
 * restore seals each one a backup holds in plain as it reads it (card 2898),
 * and a value in plain is given as it is.
 */
function contentsOf(database: Database.Database): Record<string, string[]> {
	const names = (
		database.prepare("SELECT name FROM sqlite_master WHERE type = 'table' ORDER BY name").all() as { name: string }[]
	).map((t) => t.name);
	const opened = (name: string, row: Record<string, unknown>): Record<string, unknown> => {
		if (name === 'webhooks') {
			// The address opened too, and its receiver, which a restore works out again from it, left out (card 2928).
			const { receiver: _receiver, ...rest } = row;
			return { ...rest, url: readOpenedUrl(row.id as number, database), secret: readOpened('webhooks', row.id as number, database) };
		}
		if (name === 'settings' && (row.key === 'smtp_pass' || row.key === 'backup_config')) return { ...row, value: readOpened('settings', row.key, database) };
		return row;
	};
	const contents: Record<string, string[]> = {};
	for (const name of names) {
		contents[name] = (database.prepare(`SELECT * FROM "${name}"`).all() as Record<string, unknown>[])
			.map((row) => JSON.stringify(Object.fromEntries(Object.entries(opened(name, row)).sort(([a], [b]) => a.localeCompare(b)))))
			.sort();
	}
	return contents;
}

/**
 * A table's rows without the form signing key, which a restore makes in its transaction (card 2750) and no backup
 * brings, and without the key check its sealing records (card 2898), which no restore takes from a backup.
 * And without the record that mail was set up (card 2922's code review, C4), which a restore writes for a backup
 * with a mail host and a backup made before card 2922 does not hold: pinned by its own cases below.
 */
const withoutFormKey = (rows: string[]) =>
	rows.filter(
		(row) =>
			!row.includes('"key":"request_form_secret"') &&
			!row.includes('"key":"mfa_key_check"') &&
			!row.includes('"key":"secrets_scrub_pending"') &&
			!row.includes('"key":"mail_ever_configured_at"')
	);

/**
 * Settings rows without migration 0071's moment, which a restore keeps as this
 * server had it, over the backup's (card 2752): two databases migrated a
 * second apart hold two moments.
 */
const withoutKeysRecorded = (rows: string[]) =>
	rows.filter(
		(row) =>
			!row.includes('"key":"webhook_keys_recorded_at"') &&
			// And the once-only seed's flag, which the restore writes, as now, for a backup holding none (card 2995, R3).
			!row.includes('"key":"webhook_reveals_seeded"')
	);

/** The tables that hold something a working copy switches off. */
const OUTSIDE_TABLES = ['report_schedules', 'webhooks', 'settings'];

/**
 * The rows of every table a restore copies, apart from the three above. The
 * id counters and the migration record are not copied by a restore, nor is the
 * record of API keys ended here (card 2995), nor the record of accounts ended here (card 2996): it keeps both and adds
 * to them.
 */
function everythingElseIn(database: Database.Database): Record<string, string[]> {
	const contents = contentsOf(database);
	for (const table of [...OUTSIDE_TABLES, 'sqlite_sequence', '__drizzle_migrations', 'api_key_revocations', 'account_endings']) delete contents[table];
	return contents;
}

const rowsOf = (database: Database.Database, table: string, orderBy = 'id') =>
	database.prepare(`SELECT * FROM "${table}" ORDER BY ${orderBy}`).all() as Record<string, unknown>[];

const settingsIn = (database: Database.Database) =>
	Object.fromEntries(
		(database.prepare('SELECT key, value FROM settings').all() as { key: string; value: string }[]).map((row) => [
			row.key,
			row.value
		])
	);

/**
 * Make `database` do the work of a transaction and then fail, as it would if
 * the COMMIT could not be written: the work is rolled back and the caller gets
 * the error. `justBefore` runs with the work done and the failure still to
 * come, to see what the transaction had done. With `restoreOnly`, only a
 * transaction begun with foreign keys off fails, which is the restore's: the
 * import route asks who is calling in a transaction of its own first (card
 * 2253), and that one is let through.
 */
function failAtCommit(
	database: Database.Database,
	message: string,
	justBefore: () => void = () => {},
	{ restoreOnly = false }: { restoreOnly?: boolean } = {}
): void {
	const real = database.transaction.bind(database) as (fn: (...args: unknown[]) => unknown) => unknown;
	vi.spyOn(database, 'transaction').mockImplementation(((fn: (...args: unknown[]) => unknown) =>
		restoreOnly && database.pragma('foreign_keys', { simple: true }) !== 0
			? real(fn)
			: real((...args: unknown[]) => {
					fn(...args);
					justBefore();
					throw new Error(message);
				})) as unknown as typeof database.transaction);
}

// ─── The backup ──────────────────────────────────────────────────────────────

/** The backup's backup configuration: a schedule, two destinations, and everything else it holds. */
const BACKUP_CONFIG = {
	schedule: 'daily',
	scheduleTime: '03:30',
	scheduleDay: 2,
	retention: 14,
	destinations: [
		{
			type: 'sftp',
			name: 'Offsite',
			host: 'sftp.example.test',
			port: 22,
			username: 'backup',
			password: 'not-a-real-password',
			remotePath: '/backups'
		},
		{
			type: 's3',
			name: 'Bucket',
			region: 'eu-west-2',
			bucket: 'dumpfire-backups',
			accessKeyId: 'not-a-real-key',
			secretAccessKey: 'not-a-real-secret',
			prefix: 'dumpfire/'
		}
	],
	notifyOnFailure: true,
	notifyEmail: 'ops@example.test'
};

/** The same configuration as a working copy has it: its other fields kept. */
const BACKUP_CONFIG_OFF = { ...BACKUP_CONFIG, schedule: 'disabled', destinations: [] };

const MAIL_SETTINGS: Record<string, string> = {
	smtp_host: 'mail.example.test',
	smtp_port: '465',
	smtp_user: 'dumpfire',
	smtp_pass: 'not-a-real-password',
	smtp_secure: 'true',
	smtp_allow_insecure: 'true',
	smtp_from_address: 'dumpfire@example.test',
	smtp_from_name: 'DumpFire'
};

const APP_URL = 'https://dumpfire.example.test';

/**
 * Rows for a backup that is armed, in a database that has every migration:
 *
 *   report_schedules   1, 2 and 4 enabled; 3 disabled
 *   webhooks           1 and 3 active; 2 inactive
 *   settings           `backup_config` as above, the eight `smtp_*` keys,
 *                      `app_url` and `theme`
 *
 * and two users, two boards, two columns and two cards for those to belong to.
 * Each webhook's setter is its board's creator, who can open it, so that a
 * restore as it is keeps the ones that are on (card 2752: one whose setter
 * cannot open its board, or that has none, is switched off by the restore),
 * each recorded as made with no credential (`set_with_key` 0), as a test's
 * call records it, so that no key rule holds them (card 2893: one set up
 * before keys were recorded stops once its setter has no key from then).
 * One of the users is the superadmin: the import refuses a backup that has
 * users and none. The cards are committed, as a card created in To Do is
 * (milestone 22), and each board has its Options column, as every delivery
 * board has (card 2527), so that the restore's backfills find nothing to fill
 * in and every table comes back exactly as the backup has it.
 */
function seed(database: Database.Database): void {
	database.exec(`
		INSERT INTO users (id, username, email, password_hash, role) VALUES
			(1, 'ann', 'ann@example.test', 'x', 'superadmin'),
			(2, 'bob', 'bob@example.test', 'x', 'user');
		INSERT INTO boards (id, name, created_by) VALUES (1, 'A', 1), (2, 'B', 2);
		INSERT INTO columns (id, board_id, title) VALUES (1, 1, 'To Do'), (2, 2, 'To Do');
		INSERT INTO columns (id, board_id, title, position, color, role) VALUES
			(3, 1, 'Options', -1, '#8b5cf6', 'options'), (4, 2, 'Options', -1, '#8b5cf6', 'options');
		INSERT INTO cards (id, column_id, title) VALUES (1, 1, 'One'), (2, 2, 'Two');
		UPDATE cards SET committed_at = created_at;
		INSERT INTO report_schedules (id, user_id, name, enabled, recipients) VALUES
			(1, 1, 'Weekly to the board', 1, 'board@example.test'),
			(2, 1, 'Monthly to finance', 1, 'finance@example.test'),
			(3, 2, 'Paused', 0, 'nobody@example.test'),
			(4, 2, 'Weekly to the team', 1, 'team@example.test');
		INSERT INTO webhooks (id, board_id, url, secret, events, active, set_by, set_with_key) VALUES
			(1, 1, 'https://hooks.example.test/a', 'secret-a', '[]', 1, 1, 0),
			(2, 1, 'https://hooks.example.test/b', 'secret-b', '["card.moved"]', 0, 1, 0),
			(3, 2, 'https://hooks.example.test/c', 'secret-c', '[]', 1, 2, 0);
	`);
	const set = database.prepare('INSERT INTO settings (key, value) VALUES (?, ?)');
	set.run('app_url', APP_URL);
	set.run('theme', 'dark');
	set.run('backup_config', JSON.stringify(BACKUP_CONFIG));
	for (const [key, value] of Object.entries(MAIL_SETTINGS)) set.run(key, value);
	// A backup of a server started since card 2923's release: its restore holds only the already-off webhooks of a
	// disabled or missing setter, none here (its code review, S2).
	startedSinceAlreadyOffHeld(database);
}

/** What switching the backup above off comes to. Only what was on is counted. */
const SWITCHED_OFF: OutsideSwitchedOff = {
	reportSchedules: 3,
	webhooks: 2,
	backupScheduleWasOn: true,
	backupDestinations: 2,
	mailSettings: 8
};

/** How the route says it. */
const SENTENCE =
	'Restored as a working copy: 3 report schedule(s) and 2 webhook(s) switched off, the backup schedule switched off, ' +
	'2 backup destination(s) removed, 8 mail setting(s) removed.';

/** The armed backup. */
function armedBackup(): Database.Database {
	const backup = migratedDb();
	seed(backup);
	return backup;
}

/**
 * The armed backup as a backup made since card 2169 holds it: written out by
 * `withoutSecrets`, with no mail password, the destinations' secrets empty, and
 * its three webhooks, every one signed, switched off and listed in
 * `webhook_secrets_left_out` (1 and 3 as on, 2 as off).
 */
function armedBackupMadeNow(): Database.Database {
	const dir = mkdtempSync(join(tmpdir(), 'dumpfire-working-copy-'));
	tempDirs.push(dir);
	writeFileSync(join(dir, 'from.db'), armedBackup().serialize());
	withoutSecrets(join(dir, 'from.db'), join(dir, 'to.db'));
	const backup = new Database(readFileSync(join(dir, 'to.db')));
	opened.push(backup);
	return backup;
}

/** The webhooks of the armed backup, as a working copy of one made now lists them to enter. */
const ARMED_HOOKS_TO_ENTER = [
	{ id: 1, boardId: 1, board: 'A' },
	{ id: 2, boardId: 1, board: 'A' },
	{ id: 3, boardId: 2, board: 'B' }
];

/**
 * A running database with rows of its own that reach outside, none of them
 * the backup's: one enabled report schedule, one active webhook, one backup
 * destination on an hourly schedule and a mail host.
 */
function armedLive(): Database.Database {
	const live = migratedDb();
	arm(live);
	return live;
}

function arm(database: Database.Database): void {
	database.exec(`
		INSERT INTO users (id, username, email, password_hash) VALUES (9, 'here', 'here@example.test', 'x');
		INSERT INTO boards (id, name, created_by) VALUES (7, 'Here before the restore', 9);
		INSERT INTO report_schedules (id, user_id, name, enabled, recipients) VALUES
			(70, 9, 'Sent from here', 1, 'here@example.test');
		INSERT INTO webhooks (id, board_id, url, active) VALUES (70, 7, 'https://hooks.here.test/x', 1);
	`);
	const set = database.prepare('INSERT INTO settings (key, value) VALUES (?, ?)');
	set.run('smtp_host', 'mail.here.test');
	set.run(
		'backup_config',
		JSON.stringify({ ...BACKUP_CONFIG, schedule: 'hourly', destinations: [BACKUP_CONFIG.destinations[0]] })
	);
}

/** What in `database` still reaches outside: the four things a working copy switches off. */
function reachingOutside(database: Database.Database) {
	const count = (sql: string) => (database.prepare(sql).get() as { n: number }).n;
	const stored = settingsIn(database)['backup_config'];
	const config = stored === undefined ? null : (JSON.parse(stored) as { schedule: string; destinations: unknown[] });
	return {
		reportSchedulesEnabled: count('SELECT COUNT(*) AS n FROM report_schedules WHERE enabled != 0'),
		webhooksActive: count('SELECT COUNT(*) AS n FROM webhooks WHERE active != 0'),
		backupSchedule: config ? config.schedule : null,
		backupDestinations: config ? config.destinations.length : 0,
		mailSettings: count("SELECT COUNT(*) AS n FROM settings WHERE substr(key, 1, 5) = 'smtp_'")
	};
}

const AS_THE_BACKUP_HAS_IT = {
	reportSchedulesEnabled: 3,
	webhooksActive: 2,
	backupSchedule: 'daily',
	backupDestinations: 2,
	mailSettings: 8
};
const AS_IT_WAS_HERE = {
	reportSchedulesEnabled: 1,
	webhooksActive: 1,
	backupSchedule: 'hourly',
	backupDestinations: 1,
	mailSettings: 1
};
const NOTHING = {
	reportSchedulesEnabled: 0,
	webhooksActive: 0,
	backupSchedule: 'disabled',
	backupDestinations: 0,
	mailSettings: 0
};

// ─── The restore ─────────────────────────────────────────────────────────────

describe('restoring as a working copy', () => {
	it('switches off every report schedule and webhook, the backup schedule and its destinations, and the mail settings', () => {
		const live = armedLive();
		const backup = armedBackup();
		const backupBefore = contentsOf(backup);

		const result = restoreFromBackup(live, backup, { outside: 'off' });

		expect(result.errors).toEqual([]);
		// Counted: what was on. The schedule and the webhook that were off
		// already are not among them.
		expect(result.outside).toEqual(SWITCHED_OFF);
		expect(reachingOutside(live)).toEqual(NOTHING);

		// Every schedule and every webhook is there, as the backup has it but
		// for the flag, so that it can be switched back on in the admin panel.
		expect(rowsOf(live, 'report_schedules')).toEqual(
			rowsOf(backup, 'report_schedules').map((row) => ({ ...row, enabled: 0 }))
		);
		expect(rowsOf(live, 'report_schedules').map((row) => row.id)).toEqual([1, 2, 3, 4]);
		// Each secret the backup held in plain is sealed as it was read (card 2898), and opens to it.
		// And each address (card 2928), its receiver worked out again from it.
		const withSecretsOpened = (database: Database.Database) =>
			rowsOf(database, 'webhooks').map(({ receiver: _receiver, ...row }) => ({
				...row,
				url: readOpenedUrl(row.id as number, database),
				secret: readOpened('webhooks', row.id as number, database)
			}));
		expect(rowsOf(live, 'webhooks').every((row) => String(row.secret).startsWith('dfsealed:1:'))).toBe(true);
		expect(rowsOf(live, 'webhooks').every((row) => String(row.url).startsWith('dfsealed:1:'))).toBe(true);
		expect(rowsOf(live, 'webhooks').map((row) => row.receiver)).toEqual(['https://hooks.example.test', 'https://hooks.example.test', expect.any(String)]);
		expect(withSecretsOpened(live)).toEqual(withSecretsOpened(backup).map((row) => ({ ...row, active: 0 })));
		expect(rowsOf(live, 'webhooks').map((row) => row.id)).toEqual([1, 2, 3]);

		// The backup configuration keeps what does not reach outside. The mail
		// settings are gone, and no other setting is touched.
		const settings = settingsIn(live);
		// With the form signing key the restore makes (card 2750), and the
		// backup's two_step_released_at, written by migration 0066 (card 2769),
		// and its api_key_deadline, written by migration 0069 (card 2772), and this
		// server's webhook_keys_recorded_at, written by migration 0071 and kept (card 2752).
		// And the backup's webhooks_already_off_held: one made since card 2923's release (its code review, S2).
		// And the key check the sealed form key records, and the scrub every restore marks pending (card 2898).
		// And the moment the restore's own run of the start pass covered (card 2935, P12).
		// And the record that mail was set up, written before the working copy removed it (card 2922's code review, C4):
		// the copy's password-only set-up stays shut. And the once-only seed's flag, written for a backup holding none
		// before the keys are left out (card 2995, R3).
		expect(Object.keys(settings).sort()).toEqual([
			'api_key_deadline',
			'app_url',
			'backup_config',
			'mail_ever_configured_at',
			'mfa_key_check',
			'request_form_secret',
			'secrets_scrub_pending',
			'theme',
			'two_step_released_at',
			'webhook_keys_recorded_at',
			'webhook_reveals_seeded',
			'webhooks_already_off_held',
			'webhooks_readable_by_disabled_held'
		]);
		expect(JSON.parse(settings['backup_config'])).toEqual(BACKUP_CONFIG_OFF);
		expect(settings['app_url']).toBe(APP_URL);
		expect(settings['theme']).toBe('dark');

		// Everything else is the backup's, and the backup was only read.
		expect(everythingElseIn(live)).toEqual(everythingElseIn(backup));
		expect(rowsOf(live, 'users').map((row) => row.username)).toEqual(['ann', 'bob']);
		expect(contentsOf(backup)).toEqual(backupBefore);
		expect(live.pragma('foreign_keys', { simple: true })).toBe(1);
		expect(live.inTransaction).toBe(false);
	});

	it('counts what a backup made since card 2169 had on, and lists its webhooks to enter and neither mail nor a destination (R3)', () => {
		const live = armedLive();
		const backup = armedBackupMadeNow();
		expect(settingsIn(backup)['webhook_secrets_left_out']).toBe('[{"id":1,"active":true},{"id":2,"active":false},{"id":3,"active":true}]');

		const result = restoreFromBackup(live, backup, { outside: 'off' });

		expect(result.errors).toEqual([]);
		// Webhooks 1 and 3 were on, and are off in the backup for want of a
		// secret: still counted. One mail setting fewer: there is no password.
		expect(result.outside).toEqual({ ...SWITCHED_OFF, mailSettings: 7 });
		expect(reachingOutside(live)).toEqual(NOTHING);
		expect(rowsOf(live, 'webhooks').map((row) => [row.id, row.secret, row.active])).toEqual([
			[1, '', 0],
			[2, '', 0],
			[3, '', 0]
		]);
		expect(result.secrets).toEqual({
			kept: { mailPassword: false, destinations: [], webhooks: [] },
			// And their addresses, which a backup leaves out too (card 2928).
			toEnter: { mailPassword: false, destinations: [], webhooks: ARMED_HOOKS_TO_ENTER, webhookAddresses: ARMED_HOOKS_TO_ENTER }
		});
		// No list written: its webhooks are off on purpose.
		expect(settingsIn(live)['webhook_secrets_left_out']).toBeUndefined();
	});

	it.each<[string, (live: Database.Database, backup: Database.Database) => ReturnType<typeof restoreFromBackup>]>([
		['no options', (live, backup) => restoreFromBackup(live, backup)],
		['an empty options object', (live, backup) => restoreFromBackup(live, backup, {})],
		["outside: 'keep'", (live, backup) => restoreFromBackup(live, backup, { outside: 'keep' })]
	])('restores all four exactly as the backup has them with %s', (_name, restore) => {
		// What putting an installation back needs, and what every caller got
		// before the option existed.
		const live = armedLive();
		const backup = armedBackup();

		const result = restore(live, backup);

		expect(result.errors).toEqual([]);
		expect(result.outside).toBeNull();
		expect(reachingOutside(live)).toEqual(AS_THE_BACKUP_HAS_IT);
		for (const table of OUTSIDE_TABLES) {
			expect(withoutKeysRecorded(withoutFormKey(contentsOf(live)[table]))).toEqual(withoutKeysRecorded(withoutFormKey(contentsOf(backup)[table])));
		}
		expect(everythingElseIn(live)).toEqual(everythingElseIn(backup));
	});

	it.each(['not json {', '', '[1, 2]', 'null', '"daily"', '42'])(
		'removes a backup configuration that is not a JSON object, and restores the rest: %j',
		(value) => {
			// There is nothing in it to rewrite, and a missing configuration is
			// read as no schedule and no destinations, which is what is wanted.
			const live = armedLive();
			const backup = armedBackup();
			backup.prepare("UPDATE settings SET value = ? WHERE key = 'backup_config'").run(value);

			const result = restoreFromBackup(live, backup, { outside: 'off' });

			expect(result.errors).toEqual([]);
			expect(result.outside).toEqual({ ...SWITCHED_OFF, backupScheduleWasOn: false, backupDestinations: 0 });
			// It went on to the mail settings, and the restore is committed; mail set up recorded first (card 2922, C4).
			expect(Object.keys(settingsIn(live)).sort()).toEqual([
				'api_key_deadline',
				'app_url',
				'mail_ever_configured_at',
				'mfa_key_check',
				'request_form_secret',
				'secrets_scrub_pending',
				'theme',
				'two_step_released_at',
				'webhook_keys_recorded_at',
				// Card 2995 (R3): the once-only seed's flag, for a backup holding none.
				'webhook_reveals_seeded',
				'webhooks_already_off_held',
				// Card 2935 (P12): the restore's own run of the start pass.
				'webhooks_readable_by_disabled_held'
			]);
			expect(everythingElseIn(live)).toEqual(everythingElseIn(backup));
		}
	);

	it('counts nothing where nothing was on: no backup configuration, no mail settings, no schedule or webhook that was live', () => {
		const live = armedLive();
		const backup = armedBackup();
		backup.exec(`
			UPDATE report_schedules SET enabled = 0;
			UPDATE webhooks SET active = 0;
			DELETE FROM settings WHERE key NOT IN ('app_url', 'theme', 'webhooks_already_off_held', 'webhooks_readable_by_disabled_held');
		`);

		const result = restoreFromBackup(live, backup, { outside: 'off' });

		expect(result.errors).toEqual([]);
		expect(result.outside).toEqual({
			reportSchedules: 0,
			webhooks: 0,
			backupScheduleWasOn: false,
			backupDestinations: 0,
			mailSettings: 0
		});
		// No configuration is written where there was none.
		expect(settingsIn(live)).toEqual({
			app_url: APP_URL,
			// The key check its sealing records, and the form key sealed (card 2898).
			mfa_key_check: expect.stringMatching(/^[0-9a-f]{64}$/),
			request_form_secret: expect.stringMatching(/^dfsealed:1:/),
			// The scrub every restore marks pending (card 2898's code review, S1).
			secrets_scrub_pending: expect.stringMatching(/^\d{4}-\d\d-\d\dT/),
			theme: 'dark',
			// This server's, written by migration 0071 and kept by a restore (card 2752).
			webhook_keys_recorded_at: expect.stringMatching(/^\d{4}-\d{2}-\d{2} \d{2}:\d{2}:\d{2}$/),
			// The once-only seed's flag, written for a backup holding none (card 2995, R3).
			webhook_reveals_seeded: expect.stringMatching(/^\d{4}-\d{2}-\d{2} \d{2}:\d{2}:\d{2}$/),
			// The backup's: one made since card 2923's release (its code review, S2).
			webhooks_already_off_held: '2026-11-19T00:00:00.000Z',
			// The backup's too: card 2935's pass ran there (P4), so the restore does not run it (P12).
			webhooks_readable_by_disabled_held: '2026-11-19 00:00:00'
		});
		expect(readOpened('settings', 'request_form_secret', live)).toMatch(/^v2:[0-9a-f]{64}$/);
		// The settings as the backup has them, but for this server's 0071 moment, kept (card 2752).
		for (const table of OUTSIDE_TABLES) {
			expect(withoutKeysRecorded(withoutFormKey(contentsOf(live)[table]))).toEqual(withoutFormKey(contentsOf(backup)[table]));
		}
	});

	it('says the backup schedule was already off when it was, and still removes its destinations', () => {
		const live = armedLive();
		const backup = armedBackup();
		backup
			.prepare("UPDATE settings SET value = ? WHERE key = 'backup_config'")
			.run(JSON.stringify({ ...BACKUP_CONFIG, schedule: 'disabled' }));

		const result = restoreFromBackup(live, backup, { outside: 'off' });

		// "Run Backup Now" needs a destination and no schedule.
		expect(result.outside).toEqual({ ...SWITCHED_OFF, backupScheduleWasOn: false });
		expect(JSON.parse(settingsIn(live)['backup_config'])).toEqual(BACKUP_CONFIG_OFF);
	});

	it('rolls back with the restore: all four are as they were, though they had been switched off inside it', () => {
		const live = armedLive();
		const backup = armedBackup();
		const before = contentsOf(live);
		let insideTheTransaction: ReturnType<typeof reachingOutside> | null = null;
		failAtCommit(live, 'disk I/O error', () => {
			insideTheTransaction = reachingOutside(live);
		});

		let thrown: unknown;
		try {
			restoreFromBackup(live, backup, { outside: 'off' });
		} catch (error) {
			thrown = error;
		}

		expect(thrown).toBeInstanceOf(RestoreError);
		expect((thrown as RestoreError).committed).toBe(false);
		expect((thrown as RestoreError).message).toBe('The restore failed and nothing was changed: disk I/O error');
		// It was done in the restore's transaction, and not after it: the
		// backup's rows were in, switched off, when the commit failed.
		expect(insideTheTransaction).toEqual(NOTHING);
		// And it went with the rest. Not the backup's rows, and not switched off.
		expect(contentsOf(live)).toEqual(before);
		expect(reachingOutside(live)).toEqual(AS_IT_WAS_HERE);
		expect(live.pragma('foreign_keys', { simple: true })).toBe(1);
		expect(live.inTransaction).toBe(false);
	});

	it('does not commit a working copy that it could not switch off', () => {
		// Something that stops the switching off and not the copy: the copy
		// inserts webhooks, and this objects only to an update. A restore that
		// committed here would be a copy asked to be safe, and live.
		const backup = armedBackup();
		const frozen = () => {
			const live = armedLive();
			live.exec(`
				CREATE TRIGGER webhooks_frozen BEFORE UPDATE OF active ON webhooks
				BEGIN SELECT RAISE(ABORT, 'webhooks are frozen'); END
			`);
			return live;
		};
		const live = frozen();
		const before = contentsOf(live);

		let thrown: unknown;
		try {
			restoreFromBackup(live, backup, { outside: 'off' });
		} catch (error) {
			thrown = error;
		}

		expect(thrown).toBeInstanceOf(RestoreError);
		expect((thrown as RestoreError).committed).toBe(false);
		expect((thrown as RestoreError).message).toBe('The restore failed and nothing was changed: webhooks are frozen');
		expect(contentsOf(live)).toEqual(before);
		expect(reachingOutside(live)).toEqual(AS_IT_WAS_HERE);

		// The same database takes the same backup as it is.
		const kept = frozen();
		expect(restoreFromBackup(kept, backup, { outside: 'keep' }).errors).toEqual([]);
		expect(reachingOutside(kept)).toEqual(AS_THE_BACKUP_HAS_IT);
	});
});

describe('switchOffOutside', () => {
	it('skips a table that is not there', () => {
		// No table at all, and then `settings` alone.
		const bare = memoryDb();
		expect(switchOffOutside(bare)).toEqual({
			reportSchedules: 0,
			webhooks: 0,
			backupScheduleWasOn: false,
			backupDestinations: 0,
			mailSettings: 0
		});

		const settingsOnly = memoryDb();
		settingsOnly.exec(`
			CREATE TABLE settings (key TEXT PRIMARY KEY NOT NULL, value TEXT NOT NULL);
			INSERT INTO settings (key, value) VALUES ('smtp_host', 'mail.example.test'), ('smtp_pass', 'x'), ('theme', 'dark');
		`);
		expect(switchOffOutside(settingsOnly)).toEqual({
			reportSchedules: 0,
			webhooks: 0,
			backupScheduleWasOn: false,
			backupDestinations: 0,
			mailSettings: 2
		});
		expect(settingsIn(settingsOnly)).toEqual({ theme: 'dark' });
	});

	it('opens no transaction of its own, so that the caller can undo it', () => {
		const database = armedBackup();
		const before = contentsOf(database);

		database.exec('BEGIN');
		expect(switchOffOutside(database)).toEqual(SWITCHED_OFF);
		// Still the caller's transaction: nothing here committed or ended it.
		expect(database.inTransaction).toBe(true);
		expect(reachingOutside(database)).toEqual(NOTHING);
		database.exec('ROLLBACK');

		expect(contentsOf(database)).toEqual(before);
	});

	// Card 2406: the rows would make the mail, or a destination set up again at the same place, their account's again.
	it('removes the setter rows of the mail settings and the destinations it removes, and keeps the App URL’s', () => {
		const database = armedBackup();
		const setter = database.prepare('INSERT INTO setting_setters (setting, place, user_id) VALUES (?, ?, ?)');
		setter.run('mail', 'place-of-the-mail', 1);
		setter.run('mail', 'place-left', null);
		setter.run('backup_destination:Bucket', 'place-of-the-bucket', 1);
		setter.run('backup_destination:Offsite', 'place-of-offsite', 2);
		setter.run('app_url', 'place-of-the-app-url', 1);
		// And their holds for review (card 2922, R17), carried just before by a restore: the App URL's stays, as it does.
		const held = database.prepare("INSERT INTO setting_holds (setting, place, held_because, held_at) VALUES (?, ?, 'setter access ended', '2026-11-19 09:00:00')");
		held.run('mail', 'place-of-the-mail');
		held.run('backup_destination:Bucket', 'place-of-the-bucket');
		held.run('app_url', 'place-of-the-app-url');
		const before = everythingElseIn(database);

		expect(switchOffOutside(database)).toEqual(SWITCHED_OFF);

		expect(rowsOf(database, 'setting_setters', 'setting')).toEqual([{ setting: 'app_url', place: 'place-of-the-app-url', user_id: 1 }]);
		// Nothing else but the setter rows and the holds changed outside the three tables.
		expect(everythingElseIn(database)).toEqual({
			...before,
			setting_setters: [JSON.stringify({ place: 'place-of-the-app-url', setting: 'app_url', user_id: 1 })],
			setting_holds: [
				JSON.stringify({ held_at: '2026-11-19 09:00:00', held_because: 'setter access ended', place: 'place-of-the-app-url', set_by: null, set_by_name: null, setting: 'app_url' })
			]
		});
	});

	it('finds nothing to do the second time', () => {
		const database = armedBackup();
		switchOffOutside(database);
		const after = contentsOf(database);

		expect(switchOffOutside(database)).toEqual({
			reportSchedules: 0,
			webhooks: 0,
			backupScheduleWasOn: false,
			backupDestinations: 0,
			mailSettings: 0
		});
		expect(contentsOf(database)).toEqual(after);
	});
});

// ─── What acts on it ─────────────────────────────────────────────────────────

describe('what the application reads after a restore', () => {
	/*
	 * The application's own readers, on the application's own database: the
	 * backup configuration the scheduler and "Run Backup Now" use, the check
	 * that mail is configured, and the two queries that pick the report
	 * schedules to send and the webhooks to call. A working copy is one that
	 * all four find nothing in.
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

	/** As `runDueReportSchedules` selects them. */
	const schedulesToRun = () => db.select().from(reportSchedules).where(eq(reportSchedules.enabled, true)).all();

	/** As `dispatchWebhook` selects them, for one board. */
	const webhooksToCall = (boardId: number) =>
		db
			.select()
			.from(webhooks)
			.where(and(eq(webhooks.boardId, boardId), eq(webhooks.active, true)))
			.all();

	it('has no backup destination, no backup schedule, no mail, no report to send and no webhook to call in a working copy', () => {
		const result = restoreFromBackup(sqlite, armedBackup(), { outside: 'off' });

		expect(result.errors).toEqual([]);
		expect(getBackupConfig()).toEqual(BACKUP_CONFIG_OFF);
		expect(getBackupConfig().destinations).toEqual([]);
		expect(getBackupConfig().schedule).toBe('disabled');
		expect(isSmtpConfigured()).toBe(false);
		expect(getSmtpConfig()).toBeNull();
		expect(schedulesToRun()).toEqual([]);
		expect(webhooksToCall(1)).toEqual([]);
		expect(webhooksToCall(2)).toEqual([]);
	});

	it('has all of them when the same backup is restored as it is', () => {
		// The same readers find everything, so that finding nothing above is
		// the working copy and not the readers.
		const result = restoreFromBackup(sqlite, armedBackup(), { outside: 'keep' });

		expect(result.errors).toEqual([]);
		expect(getBackupConfig()).toEqual(BACKUP_CONFIG);
		expect(isSmtpConfigured()).toBe(true);
		expect(getSmtpConfig()?.host).toBe('mail.example.test');
		expect(schedulesToRun().map((schedule) => schedule.id)).toEqual([1, 2, 4]);
		expect(webhooksToCall(1).map((hook) => hook.id)).toEqual([1]);
		expect(webhooksToCall(2).map((hook) => hook.id)).toEqual([3]);
	});

	it('reads a backup configuration that was removed for not being JSON as one with no schedule and no destination', () => {
		const backup = armedBackup();
		backup.prepare("UPDATE settings SET value = 'not json {' WHERE key = 'backup_config'").run();

		restoreFromBackup(sqlite, backup, { outside: 'off' });

		// Removed, and what reads a missing one says what a rewritten one would.
		expect(settingsIn(sqlite)['backup_config']).toBeUndefined();
		expect(getBackupConfig().destinations).toEqual([]);
		expect(getBackupConfig().schedule).toBe('disabled');
	});
});

// ─── The default ─────────────────────────────────────────────────────────────

describe('the choice made when none is given', () => {
	it('is a working copy where the schedulers are off, and everything as it is where they run', () => {
		// The dev server and a rehearsal hold a copy. A built server that runs
		// its schedulers is the installation, being put back.
		expect(defaultOutside(undefined, true)).toBe('off');
		expect(defaultOutside(undefined, false)).toBe('keep');
		expect(defaultOutside('on', true)).toBe('keep');
		expect(defaultOutside('off', false)).toBe('off');
		expect(defaultOutside(' OFF ', false)).toBe('off');
	});

	it('follows the default for the mode when SCHEDULERS is neither on nor off', () => {
		expect(defaultOutside('yes', true)).toBe('off');
		expect(defaultOutside('yes', false)).toBe('keep');
		expect(defaultOutside('', true)).toBe('off');
	});

	it('reads SCHEDULERS and the mode of this instance when it is given neither', () => {
		// Vitest runs as the dev server does, and SCHEDULERS is not set here.
		expect(defaultOutside()).toBe('off');
		process.env.SCHEDULERS = 'on';
		expect(defaultOutside()).toBe('keep');
		process.env.SCHEDULERS = 'off';
		expect(defaultOutside()).toBe('off');
	});

	describe('in the admin page', () => {
		afterEach(() => {
			// The check after every test (tests/setup.ts) runs after this hook, on an
			// emptied database, so it is made here first (card 2095).
			try {
				afterEachTimestampCheck(sqlite);
			} finally {
				resetDb();
			}
		});

		/** What the page's load hands the import dialog as the choice to open with. */
		const loaded = async () => {
			const { load } = await import('../src/routes/admin/+page.server');
			const admin = makeUser({ role: 'admin' });
			return (await load({ locals: { user: admin } } as unknown as Parameters<typeof load>[0])) as {
				importOutsideDefault: string;
			};
		};

		it('opens the dialog on the working copy where the schedulers are off', async () => {
			const data = await loaded();

			expect(data.importOutsideDefault).toBe('off');
			expect(data.importOutsideDefault).toBe(defaultOutside());
		});

		it('opens the dialog on everything as it is where the schedulers run', async () => {
			process.env.SCHEDULERS = 'on';

			const data = await loaded();

			expect(data.importOutsideDefault).toBe('keep');
			expect(data.importOutsideDefault).toBe(defaultOutside());
		});
	});
});

// ─── Through the route ───────────────────────────────────────────────────────

describe('through the route', () => {
	/*
	 * The route restores into the application's own database, which every test
	 * here shares. So each ends by emptying it again, with foreign keys on,
	 * whatever the test did to it.
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
	 * Send `body` to the import route as the superadmin would, with `query`
	 * after the path, and return the route's answer with every line it logged,
	 * without the timestamp, and the directory it had to write in. `arrange`
	 * runs once the console is being listened to and before the call.
	 */
	const send = async (
		query: string,
		contentType: string,
		body: Uint8Array | Record<string, unknown>,
		arrange: () => void = () => {}
	) => {
		await routeMethods('/api/admin/import');
		// The superadmin: an import is refused to an administrator.
		const admin = makeUser({ role: 'superadmin' });
		// With their password confirmed first (card 2701), before `arrange`
		// reads what there is: the session it is confirmed on is theirs.
		const confirmed = importConfirmation(admin);
		const workingDirectory = mkdtempSync(join(tmpdir(), 'dumpfire-import-'));
		tempDirs.push(workingDirectory);
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

		const response = await api('POST', `/api/admin/import${query}`, {
			user: admin,
			headers: { 'content-type': contentType, ...confirmed },
			body
		});

		// The logger writes to the database being restored. A line written
		// inside the restore's transaction would be lost with a rollback.
		expect(insideATransaction).toEqual([]);
		return { response, logged, workingDirectory };
	};

	/** Upload `backup` as a .db file. */
	const upload = async (query: string, backup: Database.Database, arrange: () => void = () => {}) => {
		const bytes = backup.serialize();
		const sent = await send(query, 'application/octet-stream', bytes, arrange);
		// Written where the test pointed it, and nowhere in the repository.
		expect(existsSync(join(sent.workingDirectory, '.pre-restore-safety.json'))).toBe(true);
		expect(existsSync(join(sent.workingDirectory, '.restore-temp.db'))).toBe(false);
		return { ...sent, size: `${(bytes.length / 1024).toFixed(1)} KB`.replace('.', '\\.') };
	};

	it('restores a working copy for ?outside=off, and says what it switched off in its answer and in the log', async () => {
		process.env.LOG_LEVEL = 'INFO';

		const { response, logged, size } = await upload('?outside=off', armedBackup());

		expect(response.status).toBe(200);
		expect(response.body.success).toBe(true);
		expect(response.body.errors).toBeUndefined();
		expect(response.body.outside).toEqual(SWITCHED_OFF);
		// The message it had, closed with a full stop, then that everybody is
		// signed out, which the answer says and the log line does not, and then
		// the sentence.
		expect(response.body.message).toMatch(new RegExp(`^Database restored \\(${size}\\)\\. .*\\bwebhooks: 3\\. Everybody`));
		expect(response.body.message.endsWith(`webhooks: 3. ${SIGNED_OUT} The superadmin is now ann. ${SENTENCE}`)).toBe(true);
		expect(response.body.superadmins).toEqual(['ann']);
		// Who imported which file first, at CRITICAL (card 2899), then the account of it.
		expect(logged).toHaveLength(2);
		expect(logged[0]).toMatch(/^\[CRITICAL\] \[IMPORT\] The database was replaced from an uploaded backup by /);
		expect(logged[1]).toMatch(
			new RegExp(
				`^\\[INFO\\] \\[IMPORT\\] Database restored from an uploaded backup \\(${size}\\)\\. Rows: .*\\. ` +
					'Filled in: first_completed_at on 0 card\\(s\\)\\. Restored as'
			)
		);
		expect(logged[1].endsWith(`. ${SENTENCE}`)).toBe(true);
		// The same account in parts, which is what the admin page lays out: the
		// size, the rows of each table, and the sentence on its own.
		expect(response.body.sizeBytes).toBeGreaterThan(0);
		expect(response.body.restored.boards).toBe(2);
		expect(response.body.restored.webhooks).toBe(3);
		expect(response.body.workingCopy).toBe(SENTENCE);
		// And it is what it says.
		expect(reachingOutside(sqlite)).toEqual(NOTHING);
		expect(settingsIn(sqlite)['app_url']).toBe(APP_URL);
		expect(sqlite.prepare('SELECT id FROM boards ORDER BY id').all()).toEqual([{ id: 1 }, { id: 2 }]);
	});

	it('restores everything as it is for ?outside=keep, and says nothing of a working copy', async () => {
		// Asked for, so it decides: here the choice made when none is given
		// would have been the working copy.
		expect(defaultOutside()).toBe('off');
		process.env.LOG_LEVEL = 'INFO';
		const backup = armedBackup();

		const { response, logged, size } = await upload('?outside=keep', backup);

		expect(response.status).toBe(200);
		expect(response.body.success).toBe(true);
		expect(response.body.outside).toBeUndefined();
		expect(response.body.workingCopy).toBeUndefined();
		expect(response.body.restored.boards).toBe(2);
		expect(response.body.message).toMatch(new RegExp(`^Database restored \\(${size}\\)\\. .*\\bwebhooks: 3\\. Everybody`));
		expect(response.body.message.endsWith(`webhooks: 3. ${SIGNED_OUT} The superadmin is now ann.`)).toBe(true);
		// The CRITICAL line of who imported (card 2899), then the account of it.
		expect(logged).toHaveLength(2);
		expect(logged[0]).toMatch(/^\[CRITICAL\] \[IMPORT\] The database was replaced from an uploaded backup by .*, restored as it is\. /);
		expect(logged[1]).toMatch(/Filled in: first_completed_at on 0 card\(s\)\.$/);
		expect(`${response.body.message} ${logged[1]}`).not.toMatch(/working copy|switched off|removed/i);
		expect(reachingOutside(sqlite)).toEqual(AS_THE_BACKUP_HAS_IT);
		// The settings as the backup has them, beside the form signing key the restore makes (card 2750), and the flag
		// the check of the stored images writes once the import has committed, the backup holding no image and no flag
		// (card 2761, the code review's CS3).
		// And the flag of the once-only seed of reads made before they were recorded, which the restore runs for a backup
		// holding none (card 2947, R7).
		const made = (rows: string[]) =>
			withoutFormKey(rows).filter((row) => !row.includes('"key":"stored_images_rechecked"') && !row.includes('"key":"webhook_reveals_seeded"'));
		for (const table of OUTSIDE_TABLES) expect(made(contentsOf(sqlite)[table])).toEqual(made(contentsOf(backup)[table]));
		expect(contentsOf(backup).settings.filter((row) => row.includes('"key":"stored_images_rechecked"'))).toEqual([]);
		expect(contentsOf(sqlite).settings.filter((row) => row.includes('"key":"stored_images_rechecked"'))).toHaveLength(1);
		expect(contentsOf(backup).settings.filter((row) => row.includes('"key":"webhook_reveals_seeded"'))).toEqual([]);
		expect(contentsOf(sqlite).settings.filter((row) => row.includes('"key":"webhook_reveals_seeded"'))).toHaveLength(1);
	});

	// Card 2899 (case 6): the seal's other answer, and the working copy's words.
	it('says of this server’s own backup restored as a working copy that it is its own and unchanged, and keeps every earlier line', async () => {
		const line = sqlite.prepare("INSERT INTO system_logs (timestamp, level, context, message) VALUES (?, 'WARN', 'AUTH', ?)");
		line.run('2026-11-17 09:00:00', 'A line before the export');
		// This server's own backup, sealed and unchanged: it has no users, so it is taken (set-up follows).
		const bytes = generateBackupData();
		line.run('2026-11-17 09:30:00', 'A line after the export');
		const everyLine = () => sqlite.prepare('SELECT * FROM system_logs ORDER BY id').all();
		const before = everyLine();

		const { response, logged } = await send('?outside=off', 'application/octet-stream', bytes);

		expect(response.status).toBe(200);
		// The line written after the export is still there, as is the one before it.
		expect(everyLine().slice(0, before.length)).toEqual(before);
		const critical = logged.filter((said) => said.startsWith('[CRITICAL]'));
		expect(critical).toHaveLength(1);
		expect(critical[0]).toContain(
			', a backup this server made that nobody has changed, restored as a working copy. The system log was kept as it was; ' +
				"the backup's 1 log line(s), 2026-11-17 09:00:00 to 2026-11-17 09:00:00, were not brought in and remain in the file."
		);
	});

	it('says what a working copy of a backup made since card 2169 had on, and the webhooks to enter', async () => {
		const { response } = await upload('?outside=off', armedBackupMadeNow());

		const sentence = SENTENCE.replace('8 mail setting(s) removed', '7 mail setting(s) removed');
		expect(response.status).toBe(200);
		expect(response.body.outside).toEqual({ ...SWITCHED_OFF, mailSettings: 7 });
		expect(response.body.workingCopy).toBe(sentence);
		expect(response.body.secretsToEnter).toBe(
			'To enter again, because a backup does not hold them: the signing secret(s) of webhook(s) 1 (board "A"), 2 ' +
				`(board "A"), 3 (board "B"), which stay switched off until the board's owner or an administrator sets each ` +
				'one and switches it on with PUT /api/v1/webhooks/{id}; the address(es) of webhook(s) 1 (board "A"), 2 (board "A"), 3 (board "B"), ' +
				"which stay switched off until the board's owner or an administrator sends each one its url (and its secret) with active true " +
				'in PUT /api/v1/webhooks/{id}.'
		);
		expect(response.body).not.toHaveProperty('secretsKept');
		// The working copy's sentence is still the last thing it says.
		expect(response.body.message.endsWith(`${response.body.secretsToEnter} ${sentence}`)).toBe(true);
	});

	it('restores a working copy for ?outside=off on an instance that would have kept everything', async () => {
		process.env.SCHEDULERS = 'on';
		expect(defaultOutside()).toBe('keep');

		const { response } = await upload('?outside=off', armedBackup());

		expect(response.status).toBe(200);
		expect(response.body.outside).toEqual(SWITCHED_OFF);
		expect(reachingOutside(sqlite)).toEqual(NOTHING);
	});

	it('restores a working copy when it is not told and the schedulers are off', async () => {
		// Vitest runs as the dev server does, and SCHEDULERS is not set: this
		// is the dev server holding a copy of production.
		const { response } = await upload('', armedBackup());

		expect(response.status).toBe(200);
		expect(response.body.outside).toEqual(SWITCHED_OFF);
		expect(response.body.message.endsWith(`. ${SENTENCE}`)).toBe(true);
		expect(reachingOutside(sqlite)).toEqual(NOTHING);
	});

	it('restores a working copy when it is not told and SCHEDULERS is off', async () => {
		process.env.SCHEDULERS = 'off';

		const { response } = await upload('', armedBackup());

		expect(response.status).toBe(200);
		expect(response.body.outside).toEqual(SWITCHED_OFF);
		expect(reachingOutside(sqlite)).toEqual(NOTHING);
	});

	it('restores everything as it is when it is not told and the schedulers run', async () => {
		process.env.SCHEDULERS = 'on';

		const { response } = await upload('', armedBackup());

		expect(response.status).toBe(200);
		expect(response.body.outside).toBeUndefined();
		expect(response.body.message).not.toMatch(/working copy/i);
		expect(reachingOutside(sqlite)).toEqual(AS_THE_BACKUP_HAS_IT);
	});

	it.each(['sideways', '', 'OFF', 'true'])(
		'refuses ?outside=%s before it reads or changes anything',
		async (value) => {
			// A misspelt `off` given the default would, on an instance that runs
			// its schedulers, restore a copy with everything in it still live.
			process.env.SCHEDULERS = 'on';
			arm(sqlite);
			let before: ReturnType<typeof dataIn> | null = null;

			const { response, logged, workingDirectory } = await send(
				`?outside=${value}`,
				'application/octet-stream',
				armedBackup().serialize(),
				() => {
					// Read here, with the administrator who uploads it already made.
					before = dataIn(sqlite);
				}
			);

			expect(response.status).toBe(400);
			expect(response.body.message).toBe(
				'outside must be "keep" (restore everything as it is) or "off" (restore as a working copy), ' +
					`not "${value}". Nothing was changed.`
			);
			expect(logged).toEqual([]);
			expect(before).not.toBeNull();
			expect(dataIn(sqlite)).toEqual(before);
			expect(reachingOutside(sqlite)).toEqual(AS_IT_WAS_HERE);
			// Not so much as the safety copy: nothing was read to make one from.
			expect(readdirSync(workingDirectory)).toEqual([]);
		}
	);

	it('says what it switched off when the restore also has a problem to report', async () => {
		// A card on a column that does not exist is in the backup that way. It
		// is copied and reported, and the answer leads with the problem. What
		// the working copy switched off is still the last thing it says.
		const backup = armedBackup();
		backup.pragma('foreign_keys = OFF');
		backup.exec("INSERT INTO cards (id, column_id, title) VALUES (6, 99, 'On no column')");
		backup.pragma('foreign_keys = ON');
		const problem =
			'cards: 1 row(s) refer to a row of columns that is not there (rowid 6). No row of columns was left out ' +
			'by this restore, so the backup holds them that way';

		const { response, logged, size } = await upload('?outside=off', backup);

		expect(response.status).toBe(200);
		expect(response.body.success).toBe(true);
		expect(response.body.errors).toEqual([problem]);
		expect(response.body.outside).toEqual(SWITCHED_OFF);
		expect(response.body.message).toMatch(
			new RegExp(`^Database restored \\(${size}\\), with 1 problem\\(s\\); each is given in the list\\. .*\\bcards: 3\\b`)
		);
		expect(response.body.message.endsWith(`. ${SENTENCE}`)).toBe(true);
		// After the CRITICAL line of who imported (card 2899).
		expect(logged).toHaveLength(2);
		expect(logged[0]).toMatch(/^\[CRITICAL\] \[IMPORT\] The database was replaced from an uploaded backup by /);
		expect(logged[1]).toBe(`[ERROR] [IMPORT] Restore committed, with 1 problem(s): ${problem}`);
		expect(reachingOutside(sqlite)).toEqual(NOTHING);
	});

	it('says that it found nothing to switch off, count by count, when the backup had nothing live', async () => {
		// Every count is given, a zero included, so that the answer shows each
		// of the four was looked at. A schedule that was off is said to have been.
		const backup = armedBackup();
		backup.exec(`
			UPDATE report_schedules SET enabled = 0;
			UPDATE webhooks SET active = 0;
			DELETE FROM settings WHERE key NOT IN ('app_url', 'theme');
		`);

		const { response } = await upload('?outside=off', backup);

		expect(response.status).toBe(200);
		expect(response.body.outside).toEqual({
			reportSchedules: 0,
			webhooks: 0,
			backupScheduleWasOn: false,
			backupDestinations: 0,
			mailSettings: 0
		});
		expect(
			response.body.message.endsWith(
				'. Restored as a working copy: 0 report schedule(s) and 0 webhook(s) switched off, the backup schedule ' +
					'was already off, 0 backup destination(s) removed, 0 mail setting(s) removed.'
			)
		).toBe(true);
	});

	it('leaves all four as they were when a working-copy restore fails', async () => {
		arm(sqlite);
		let before: ReturnType<typeof dataIn> | null = null;

		const { response } = await upload('?outside=off', armedBackup(), () => {
			before = dataIn(sqlite);
			failAtCommit(sqlite, 'disk I/O error', undefined, { restoreOnly: true });
		});

		expect(response.status).toBe(500);
		expect(response.body.message).toBe('The restore failed and nothing was changed: disk I/O error');
		expect(response.body.committed).toBe(false);
		expect(response.body.outside).toBeUndefined();

		vi.restoreAllMocks();
		expect(before).not.toBeNull();
		expect(dataIn(sqlite)).toEqual(before);
		expect(reachingOutside(sqlite)).toEqual(AS_IT_WAS_HERE);
		expect(sqlite.pragma('foreign_keys', { simple: true })).toBe(1);
		expect(sqlite.inTransaction).toBe(false);
	});

	it('forgets the key the public request form signs with and brings in none, so a form token made before the import is refused after it', async () => {
		// As a process that has just started: nothing cached by an earlier test.
		resetFormSecretCache();
		const before = issueFormToken();
		expect(verifyFormToken(before)).toBe(true);
		const backup = armedBackup();
		backup.prepare("INSERT INTO settings (key, value) VALUES ('request_form_secret', 'the-key-in-the-backup')").run();

		const { response } = await upload('?outside=keep', backup);

		expect(response.status).toBe(200);
		// The key is a setting, and no restore brings one in (card 2158): the
		// backup's is left out, and the one that was here went with the rest.
		// The copy in memory of the one it replaced used to stay, and went on
		// accepting this token.
		// A new one is made as the restore commits (card 2750), not at first
		// use, so no check that only reads is the first to need it.
		const made = settingsIn(sqlite)['request_form_secret'];
		// Sealed (card 2898), `v2:` and 32 random bytes as hex once opened (card 2943).
		expect(made).toMatch(/^dfsealed:1:/);
		expect(readOpened('settings', 'request_form_secret')).toMatch(/^v2:[0-9a-f]{64}$/);
		expect(verifyFormToken(before)).toBe(false);

		// A token made now is signed with it: a process starting now agrees
		// with this one.
		const after = issueFormToken();
		expect(verifyFormToken(after)).toBe(true);
		resetFormSecretCache();
		expect(verifyFormToken(after)).toBe(true);
		expect(verifyFormToken(before)).toBe(false);
		expect(settingsIn(sqlite)['request_form_secret']).toBe(made);
	});

	// The import of the old JSON export was removed (card 2157), and with it
	// the working copy it made of one. An export in that format is refused
	// before it is read, whatever is asked of the outside connections.
	it.each(['?outside=off', '?outside=keep', ''].map((query) => ({ query, asked: query || 'no outside' })))(
		'refuses an export in the old JSON format ($asked) before it reads or changes anything',
		async ({ query }) => {
			arm(sqlite);
			const read = vi.spyOn(Request.prototype, 'json');
			let before: ReturnType<typeof dataIn> | null = null;

			const { response, logged, workingDirectory } = await send(
				query,
				'application/json',
				{
					version: 1,
					users: [{ id: 1, username: 'ann', email: 'ann@example.test', password_hash: 'x', role: 'superadmin' }],
					boards: [{ id: 7, name: 'A' }],
					columns: [{ id: 1, board_id: 7, title: 'To Do', position: 0 }],
					categories: [],
					cards: [],
					settings: [{ key: 'backup_config', value: JSON.stringify(BACKUP_CONFIG) }]
				},
				() => {
					before = dataIn(sqlite);
				}
			);

			expect(response.status).toBe(400);
			expect(response.body.message).toBe(
				'Import takes a .db backup, sent as application/octet-stream. Exports in the old JSON format, which ' +
					'DumpFire wrote only from 1 to 7 April 2026, are no longer imported. Nothing was changed.'
			);
			expect(response.body.outside).toBeUndefined();
			expect(read).not.toHaveBeenCalled();
			expect(logged).toEqual([]);
			expect(before).not.toBeNull();
			expect(dataIn(sqlite)).toEqual(before);
			expect(reachingOutside(sqlite)).toEqual(AS_IT_WAS_HERE);
			expect(readdirSync(workingDirectory)).toEqual([]);
		}
	);
});
