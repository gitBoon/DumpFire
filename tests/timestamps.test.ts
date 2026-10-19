/**
 * One timestamp form (card 2095): the helper, the conversion at every start
 * and after every restore, the check the suite runs, and the server modules
 * that compared one form with the other.
 *
 * The stored form is `YYYY-MM-DD HH:MM:SS`, UTC, whole seconds. Text orders
 * moments only when both sides are in one form: `'2026-10-14 08:00:00' <
 * '2026-10-14T00:00:00.000Z'` is true, because a space sorts before `T`. So
 * each test of a comparison puts a row on the boundary day, where the old code
 * gave the wrong answer.
 */
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import Database from 'better-sqlite3';
import { mkdtempSync, readdirSync, readFileSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { eq } from 'drizzle-orm';
import { db, sqlite } from '$lib/server/db';
import { runMigrations } from '$lib/server/db/migrate';
import { restoreFromBackup } from '$lib/server/db/restore';
import { normaliseTimestamps, timestampColumns } from '$lib/server/db/timestamps';
import { apiKeys, cards, inviteTokens, milestones, reportSchedules, sessions, tokenUsage, users } from '$lib/server/db/schema';
import { inTransaction } from '$lib/server/db/transaction';
import { SESSION_COOKIE_NAME, cleanExpiredSessions, createSession, findApiKey, markApiKeyUsed, validateSession } from '$lib/server/auth';
import { issueInvite } from '$lib/server/invites';
import { createLogger, getRecentLogs } from '$lib/server/logger';
import { buildActivityReport, getCardBoardHistory } from '$lib/server/activity-report';
import { formatDate, generateBoardReport, readReportWindow, runDueReportSchedules } from '$lib/server/reports';
import { makePasswordHash } from '$lib/server/passwords';
import { onTheWire } from '$lib/server/v1-json';
import { dispatchWebhook } from '$lib/server/webhooks';
import { parseStamp, stamp, toIso, toStamp } from '$lib/timestamps';
import { daysUntilDue, dueDay, formatDueDate, getDueRelative, getDueStatus, parseUTC } from '$lib/utils/date-utils';
import { sortCards } from '$lib/utils/card-utils';
import type { CardType } from '$lib/types';
import { api, routeMethods } from './helpers/api';
import { pageLoad } from './helpers/actions';
import { effects } from './helpers/effects';
import {
	assignCard,
	makeApiKey,
	makeBoard,
	makeCard,
	makeComment,
	makeDependency,
	makeMilestone,
	makeUser,
	makeWebhook,
	resetDb
} from './helpers/fixtures';
import { afterEachTimestampCheck, allowOtherTimestampForms, otherTimestampForms } from './helpers/timestamps';

const REAL_MIGRATIONS = join(process.cwd(), 'drizzle');
const STORED = /^\d{4}-\d{2}-\d{2} \d{2}:\d{2}:\d{2}$/;

const opened: Database.Database[] = [];
const tempDirs: string[] = [];

/** A separate in-memory database taken through the real migrations, as a new installation is. */
function migratedDb(): Database.Database {
	const database = new Database(':memory:');
	database.pragma('foreign_keys = ON');
	opened.push(database);
	runMigrations({ database, migrationsDir: REAL_MIGRATIONS });
	return database;
}

let logLevel: string | undefined;
beforeEach(() => {
	resetDb();
	// The lines this file reads are WARN and INFO, which the suite's level drops.
	logLevel = process.env.LOG_LEVEL;
	process.env.LOG_LEVEL = 'DEBUG';
});
afterEach(() => {
	if (logLevel === undefined) delete process.env.LOG_LEVEL;
	else process.env.LOG_LEVEL = logLevel;
	for (const database of opened.splice(0)) database.close();
	for (const dir of tempDirs.splice(0)) rmSync(dir, { recursive: true, force: true });
	vi.restoreAllMocks();
	vi.useRealTimers();
});

// ─── The helper ──────────────────────────────────────────────────────────────

describe('stamp, toStamp and parseStamp', () => {
	it('stamp gives the stored form of a moment, in UTC, the fraction dropped', () => {
		expect(stamp(new Date('2026-10-14T08:09:10.999Z'))).toBe('2026-10-14 08:09:10');
		expect(stamp(new Date('0099-01-02T03:04:05Z'))).toBe('0099-01-02 03:04:05');
		expect(stamp()).toMatch(STORED);
	});

	it.each([
		['the stored form', '2026-10-14 08:00:00', '2026-10-14 08:00:00'],
		['the stored form with a fraction', '2026-10-14 08:00:00.5', '2026-10-14 08:00:00'],
		['ISO with Z', '2026-10-14T08:00:00Z', '2026-10-14 08:00:00'],
		['ISO with milliseconds', '2026-10-14T08:00:00.999Z', '2026-10-14 08:00:00'],
		['ISO with seven fraction digits, as PowerShell writes', '2026-10-14T08:00:00.1234567+01:00', '2026-10-14 07:00:00'],
		['ISO with an offset', '2026-10-14T08:00:00+01:00', '2026-10-14 07:00:00'],
		['ISO with a negative offset over midnight', '2026-10-14T22:30:00-05:00', '2026-10-15 03:30:00'],
		['ISO with no zone, which is UTC', '2026-10-14T08:00:00', '2026-10-14 08:00:00'],
		['ISO to the minute', '2026-10-14T08:00', '2026-10-14 08:00:00'],
		['a bare date', '2026-10-14', '2026-10-14 00:00:00']
	])('toStamp reads %s', (_, input, expected) => {
		expect(toStamp(input)).toBe(expected);
	});

	it('toStamp reads a bare date as the start of the day below and its last second above', () => {
		expect(toStamp('2026-10-14', 'lower')).toBe('2026-10-14 00:00:00');
		expect(toStamp('2026-10-14', 'upper')).toBe('2026-10-14 23:59:59');
		// Only a bare date: a time given is the time meant, at either end.
		expect(toStamp('2026-10-14T00:00:00Z', 'upper')).toBe('2026-10-14 00:00:00');
	});

	it.each([
		['a word', 'yesterday'],
		['a date in another order', '14/10/2026'],
		['a number as text', '1760000000'],
		['a day that is not in the calendar', '2026-02-30'],
		['a month that is not', '2026-13-01'],
		['an hour that is not', '2026-10-14T24:00:00Z'],
		['an offset that is not', '2026-10-14T08:00:00+25:00'],
		['an empty string', ''],
		['a date with words after it', '2026-10-14Tnonsense']
	])('toStamp gives null for %s', (_, input) => {
		expect(toStamp(input)).toBeNull();
	});

	it('toStamp gives null for what is not text', () => {
		for (const input of [null, undefined, 1760000000, true, {}, new Date()]) expect(toStamp(input)).toBeNull();
	});

	it('parseStamp reads both forms as the same moment, in UTC', () => {
		const instant = Date.UTC(2026, 6, 14, 8, 0, 0);
		expect(parseStamp('2026-07-14 08:00:00')?.getTime()).toBe(instant);
		expect(parseStamp('2026-07-14T08:00:00.000Z')?.getTime()).toBe(instant);
		expect(parseStamp('2026-07-14T09:00:00+01:00')?.getTime()).toBe(instant);
		expect(parseStamp('2026-07-14')?.getTime()).toBe(Date.UTC(2026, 6, 14));
	});

	it('parseStamp gives null for what is not a timestamp', () => {
		for (const input of ['zzz', '', null, undefined, 42, '2026-02-30']) expect(parseStamp(input)).toBeNull();
	});
});

// ─── Which columns ───────────────────────────────────────────────────────────

describe('timestampColumns', () => {
	it('names every TEXT *_at column and system_logs.timestamp, and nothing that holds a day', () => {
		const found = timestampColumns(sqlite).map((c) => `${c.table}.${c.column}`);
		expect(found).toHaveLength(37);
		for (const column of [
			'activity_log.created_at',
			'api_keys.expires_at',
			'cards.completed_at',
			'cards.first_completed_at',
			'cards.archived_at',
			'report_schedules.next_run_at',
			'sessions.expires_at',
			'system_logs.timestamp'
		]) {
			expect(found).toContain(column);
		}
		for (const column of ['cards.due_date', 'cards.next_recurrence', 'daily_snapshots.date', 'milestones.target_date']) {
			expect(found).not.toContain(column);
		}
		// The runner's own record is not ours.
		expect(found).not.toContain('__drizzle_migrations.created_at');
	});

	it('finds a column added later by its name alone, and passes over leftovers and other types', () => {
		const database = migratedDb();
		database.exec(`
			CREATE TABLE later (id INTEGER PRIMARY KEY, seen_at TEXT, count_at INTEGER, timestamp TEXT);
			CREATE TABLE "__new_cards" (id INTEGER PRIMARY KEY, created_at TEXT);
		`);
		const found = timestampColumns(database).map((c) => `${c.table}.${c.column}`);
		expect(found).toContain('later.seen_at');
		// An INTEGER is not a moment in the stored form, and `timestamp` counts only in system_logs.
		expect(found).not.toContain('later.count_at');
		expect(found).not.toContain('later.timestamp');
		expect(found.filter((c) => c.startsWith('__new_'))).toEqual([]);
	});
});

// ─── The conversion ──────────────────────────────────────────────────────────

/** A database with a card, a session, an API key and a log row, whose timestamps are set by the test. */
function withRows(database: Database.Database): void {
	database.exec(`
		INSERT INTO users (id, username, email, password_hash, role) VALUES (1, 'ann', 'ann@example.test', 'x', 'superadmin');
		INSERT INTO boards (id, name, created_by) VALUES (1, 'B', 1);
		INSERT INTO columns (id, board_id, title, position) VALUES (1, 1, 'To Do', 0);
	`);
}

describe('normaliseTimestamps', () => {
	it('converts each shape it recognises, in a column of each kind, to the same moment', () => {
		const database = migratedDb();
		withRows(database);
		const shapes = [
			'2026-10-14T08:00:00.000Z',
			'2026-10-14T08:00:00Z',
			'2026-10-14T09:00:00+01:00',
			'2026-10-14T08:00',
			'2026-10-14 08:00:00.123',
			'2026-10-14'
		];
		const card = database.prepare('INSERT INTO cards (column_id, title, completed_at, created_at) VALUES (1, ?, ?, ?)');
		shapes.forEach((shape, i) => card.run(`card ${i}`, shape, shape));
		database.prepare("INSERT INTO sessions (id, user_id, expires_at) VALUES ('s', 1, '2026-10-21T08:00:00.000Z')").run();
		database.prepare("INSERT INTO system_logs (timestamp, level, context, message) VALUES ('2026-10-14T08:00:00.000Z', 'INFO', 'T', 'm')").run();

		const done = normaliseTimestamps(database);

		expect(done).toEqual({
			converted: {
				'cards.completed_at': 6,
				'cards.created_at': 6,
				'sessions.expires_at': 1,
				'system_logs.timestamp': 1
			},
			unreadable: {},
			failed: null
		});
		const values = database.prepare('SELECT completed_at AS c, created_at AS d FROM cards ORDER BY id').all() as { c: string; d: string }[];
		expect(values.map((v) => v.c)).toEqual([
			'2026-10-14 08:00:00',
			'2026-10-14 08:00:00',
			'2026-10-14 08:00:00',
			'2026-10-14 08:00:00',
			'2026-10-14 08:00:00',
			'2026-10-14 00:00:00'
		]);
		expect(values.map((v) => v.d)).toEqual(values.map((v) => v.c));
		expect(database.prepare('SELECT expires_at FROM sessions').pluck().get()).toBe('2026-10-21 08:00:00');
	});

	it('converts the stored form to the minute, with no seconds, which toStamp reads (the second P6 review)', () => {
		// No pattern matched a space and no seconds, so such a value was
		// reported as unreadable at every start though toStamp reads it.
		const database = migratedDb();
		withRows(database);
		const card = database.prepare('INSERT INTO cards (column_id, title, completed_at) VALUES (1, ?, ?)');
		for (const value of ['2026-10-14 08:00', '2026-10-14 08:00Z', '2026-10-14 09:00+01:00', '2026-10-14 24:00', '2026-02-30 08:00']) {
			card.run(value, value);
		}

		const done = normaliseTimestamps(database);

		expect(done.converted).toEqual({ 'cards.completed_at': 3 });
		expect(done.unreadable).toEqual({ 'cards.completed_at': { count: 2, example: '2026-02-30 08:00' } });
		expect(database.prepare('SELECT completed_at FROM cards ORDER BY id').pluck().all()).toEqual([
			'2026-10-14 08:00:00',
			'2026-10-14 08:00:00',
			'2026-10-14 08:00:00',
			'2026-10-14 24:00',
			'2026-02-30 08:00'
		]);
	});

	it('leaves a value it cannot read as it is, and reports it with an example', () => {
		const database = migratedDb();
		withRows(database);
		database
			.prepare('INSERT INTO api_keys (user_id, name, key_hash, key_prefix, expires_at) VALUES (1, ?, ?, ?, ?)')
			.run('k', 'hash-1', 'df_1', 'zzz');
		database
			.prepare('INSERT INTO api_keys (user_id, name, key_hash, key_prefix, expires_at) VALUES (1, ?, ?, ?, ?)')
			.run('k2', 'hash-2', 'df_2', '2026-10-14Tnonsense');
		database
			.prepare('INSERT INTO api_keys (user_id, name, key_hash, key_prefix, expires_at) VALUES (1, ?, ?, ?, ?)')
			.run('k3', 'hash-3', 'df_3', '2026-10-14T08:00:00Z');

		const done = normaliseTimestamps(database);

		expect(done.converted).toEqual({ 'api_keys.expires_at': 1 });
		expect(done.unreadable).toEqual({ 'api_keys.expires_at': { count: 2, example: '2026-10-14Tnonsense' } });
		expect(done.failed).toBeNull();
		expect(database.prepare('SELECT expires_at FROM api_keys ORDER BY id').pluck().all()).toEqual([
			'zzz',
			'2026-10-14Tnonsense',
			'2026-10-14 08:00:00'
		]);
	});

	it('converts no value that names no real moment, and reports each, the ones in the stored form’s shape among them (S1)', () => {
		// SQLite's strftime rolls 30 February over to 2 March and keeps an hour
		// of 24, and a GLOB sees only the shape: each of these was converted to
		// another moment, or passed as stored, and none was reported.
		const database = migratedDb();
		withRows(database);
		const unreal = [
			'2026-02-30T08:00:00Z',
			'2026-02-30',
			'2026-10-14T24:00:00',
			'2026-10-14 24:00:00.5',
			'9999-99-99 99:99:99',
			'2026-02-29 08:00:00'
		];
		const card = database.prepare('INSERT INTO cards (column_id, title, completed_at) VALUES (1, ?, ?)');
		for (const value of [...unreal, '2026-10-14T08:00:00Z']) card.run(value, value);

		const done = normaliseTimestamps(database);

		expect(done.converted).toEqual({ 'cards.completed_at': 1 });
		expect(done.unreadable).toEqual({ 'cards.completed_at': { count: 6, example: '2026-02-29 08:00:00' } });
		expect(database.prepare('SELECT completed_at FROM cards ORDER BY id').pluck().all()).toEqual([
			...unreal,
			'2026-10-14 08:00:00'
		]);
		// And the same again at the next run, until somebody deals with them.
		expect(normaliseTimestamps(database).unreadable).toEqual(done.unreadable);
	});

	it('converts nothing on a second run', () => {
		const database = migratedDb();
		withRows(database);
		database.prepare("INSERT INTO cards (column_id, title, completed_at) VALUES (1, 'c', '2026-10-14T08:00:00.000Z')").run();
		database.prepare("INSERT INTO cards (column_id, title, completed_at) VALUES (1, 'd', 'zzz')").run();

		expect(normaliseTimestamps(database).converted).toEqual({ 'cards.completed_at': 1 });
		const again = normaliseTimestamps(database);
		expect(again.converted).toEqual({});
		// What it could not read is reported again, at every run, until dealt with.
		expect(again.unreadable).toEqual({ 'cards.completed_at': { count: 1, example: 'zzz' } });
	});

	it('rolls back, reports and does not throw when an update fails', () => {
		const database = migratedDb();
		withRows(database);
		database.prepare("INSERT INTO cards (column_id, title, completed_at) VALUES (1, 'c', '2026-10-14T08:00:00.000Z')").run();
		database.prepare("INSERT INTO sessions (id, user_id, expires_at) VALUES ('s', 1, '2026-10-21T08:00:00.000Z')").run();
		database.exec(`CREATE TRIGGER refuse BEFORE UPDATE ON sessions BEGIN SELECT RAISE(ABORT, 'refused by a trigger'); END`);

		const done = normaliseTimestamps(database);

		expect(done).toEqual({ converted: {}, unreadable: {}, failed: 'refused by a trigger' });
		// Nothing was changed, the card converted before the failure included.
		expect(database.prepare('SELECT completed_at FROM cards').pluck().get()).toBe('2026-10-14T08:00:00.000Z');
		expect(database.inTransaction).toBe(false);
	});
});

describe('a restore of a backup holding the other form', () => {
	it('leaves every timestamp column in the stored form, and counts what it converted', () => {
		const backup = migratedDb();
		withRows(backup);
		backup.exec(`
			INSERT INTO cards (column_id, title, completed_at, first_completed_at, updated_at, archived_at)
				VALUES (1, 'done', '2026-10-14T08:00:00.000Z', '2026-10-13T08:00:00.000Z', '2026-10-14T08:00:00.000Z', '2026-10-14T09:00:00.000Z');
			INSERT INTO system_logs (timestamp, level, context, message) VALUES ('2026-10-14T08:00:00.000Z', 'INFO', 'T', 'm');
		`);
		const live = migratedDb();

		const result = restoreFromBackup(live, backup);

		expect(result.errors).toEqual([]);
		expect(result.timestamps.converted).toEqual({
			'cards.archived_at': 1,
			'cards.completed_at': 1,
			'cards.first_completed_at': 1,
			'cards.updated_at': 1,
			'system_logs.timestamp': 1
		});
		expect(otherTimestampForms(live)).toEqual([]);
		expect(live.prepare('SELECT completed_at FROM cards').pluck().get()).toBe('2026-10-14 08:00:00');
	});

	it('reports a value it cannot read among the restore’s problems', () => {
		const backup = migratedDb();
		withRows(backup);
		backup.prepare("INSERT INTO cards (column_id, title, archived_at) VALUES (1, 'odd', 'last Tuesday')").run();
		const live = migratedDb();

		const result = restoreFromBackup(live, backup);

		expect(result.timestamps.unreadable).toEqual({ 'cards.archived_at': { count: 1, example: 'last Tuesday' } });
		expect(result.errors).toEqual([
			'Timestamps in no form this build can read were left as they are: cards.archived_at 1 (such as "last Tuesday"). ' +
				'Each start reports them until they are corrected.'
		]);
	});

	it('through Import Backup, converts them and says so in one WARN line', async () => {
		const chief = makeUser({ role: 'superadmin', username: 'chief' });
		const backup = migratedDb();
		backup.exec(`
			INSERT INTO users (id, username, email, password_hash, role) VALUES (1, 'chief', 'chief@example.test', 'x', 'superadmin');
			INSERT INTO boards (id, name, created_by) VALUES (1, 'B', 1);
			INSERT INTO columns (id, board_id, title, position) VALUES (1, 1, 'Complete', 0);
			INSERT INTO cards (column_id, title, completed_at) VALUES (1, 'done', '2026-10-14T08:00:00.000Z');
		`);
		await routeMethods('/api/admin/import');
		const dir = mkdtempSync(join(tmpdir(), 'dumpfire-import-'));
		tempDirs.push(dir);
		vi.spyOn(process, 'cwd').mockReturnValue(dir);
		vi.spyOn(console, 'warn').mockImplementation(() => {});
		vi.spyOn(console, 'log').mockImplementation(() => {});

		const res = await api('POST', '/api/admin/import?outside=keep', {
			user: chief,
			headers: { 'content-type': 'application/octet-stream' },
			body: backup.serialize()
		});

		expect(res.status).toBe(200);
		expect(otherTimestampForms(sqlite)).toEqual([]);
		expect(db.select().from(cards).get()?.completedAt).toBe('2026-10-14 08:00:00');
		const lines = sqlite
			.prepare("SELECT message FROM system_logs WHERE level = 'WARN' AND context = 'IMPORT'")
			.pluck()
			.all() as string[];
		expect(lines).toEqual([
			// The backfill copied completed_at to first_completed_at first, as the backup had it.
			'2 timestamp(s) the backup held in another form were converted to the stored form (YYYY-MM-DD HH:MM:SS, UTC), ' +
				'each still naming the same moment to the second: cards.completed_at 1, cards.first_completed_at 1.'
		]);
	});
});

// ─── The check after every test ──────────────────────────────────────────────

describe('otherTimestampForms, the check after every test', () => {
	it('names the table, the column and the value of anything not in the stored form', () => {
		const database = migratedDb();
		withRows(database);
		database.prepare("INSERT INTO cards (column_id, title, completed_at) VALUES (1, 'c', '2026-10-14T08:00:00.000Z')").run();
		database.prepare("INSERT INTO cards (column_id, title, archived_at) VALUES (1, 'd', 42)").run();

		expect(otherTimestampForms(database)).toEqual([
			'cards.completed_at = "2026-10-14T08:00:00.000Z"',
			'cards.archived_at = "42"'
		]);
		expect(() => afterEachTimestampCheck(database)).toThrow(
			/This test left timestamps that are not in the stored form .*cards\.completed_at = "2026-10-14T08:00:00\.000Z"/
		);
	});

	it('names a value in the stored form’s shape that names no real moment, as the conversion reports it (S1)', () => {
		const database = migratedDb();
		withRows(database);
		database.prepare("INSERT INTO cards (column_id, title, completed_at) VALUES (1, 'c', '2026-02-30 08:00:00')").run();
		database.prepare("INSERT INTO cards (column_id, title, archived_at) VALUES (1, 'd', '2026-10-14 24:00:00')").run();
		database.prepare("INSERT INTO cards (column_id, title, archived_at) VALUES (1, 'e', '2026-10-14 23:59:59')").run();

		expect(otherTimestampForms(database)).toEqual([
			'cards.completed_at = "2026-02-30 08:00:00"',
			'cards.archived_at = "2026-10-14 24:00:00"'
		]);
	});

	it('passes a test that allowed other forms, and forgets the allowance after it', () => {
		const database = migratedDb();
		withRows(database);
		database.prepare("INSERT INTO cards (column_id, title, completed_at) VALUES (1, 'c', '2026-10-14T08:00:00.000Z')").run();

		allowOtherTimestampForms();
		expect(otherTimestampForms(database)).toEqual([]);
		// What the check after the test does; it forgets the allowance.
		expect(() => afterEachTimestampCheck(database)).not.toThrow();
		// The next test is checked again.
		expect(otherTimestampForms(database)).toHaveLength(1);
	});

	it('finds nothing on a converged database', () => {
		const database = migratedDb();
		withRows(database);
		database.prepare("INSERT INTO cards (column_id, title, completed_at) VALUES (1, 'c', '2026-10-14T08:00:00.000Z')").run();
		normaliseTimestamps(database);
		expect(otherTimestampForms(database)).toEqual([]);
	});
});

// ─── The server modules (slice 2) ────────────────────────────────────────────

describe('what the server modules write', () => {
	it('is the stored form, through every write path they own', async () => {
		const owner = makeUser({ username: 'owner' });
		const invitee = makeUser({ username: 'invitee' });
		const { board, cols } = makeBoard({ owner });
		const card = makeCard(cols['To Do'], { title: 'moved' });
		const milestone = makeMilestone({ board, cards: [card], createdBy: owner });

		// A session made and slid, an API key used, an invite issued.
		const token = createSession(owner.id);
		expect(validateSession(token)).not.toBeNull();
		makeApiKey(owner);
		markApiKeyUsed(db.select().from(apiKeys).get()!.id);
		inTransaction(() => issueInvite(invitee.id));
		// A completion by a move and by a creation in a Complete column, an
		// archive and a restore, a milestone edited.
		expect((await api('PUT', `/api/v1/cards/${card.id}/move`, { user: owner, body: { columnId: cols['Complete'].id } })).status).toBe(200);
		expect(
			(await api('POST', `/api/v1/boards/${board.id}/cards`, { user: owner, body: { columnId: cols['Complete'].id, title: 'made done' } }))
				.status
		).toBe(201);
		expect((await api('DELETE', `/api/cards/${card.id}`, { user: owner })).status).toBe(200);
		expect((await api('POST', `/api/cards/${card.id}/restore`, { user: owner })).status).toBe(200);
		expect((await api('DELETE', `/api/cards/${card.id}`, { user: owner })).status).toBe(200);
		expect((await api('PATCH', `/api/v1/milestones/${milestone.id}`, { user: owner, body: { name: 'renamed' } })).status).toBe(200);

		expect(otherTimestampForms(sqlite)).toEqual([]);
		const written = db.select().from(cards).where(eq(cards.id, card.id)).get()!;
		for (const value of [written.completedAt, written.firstCompletedAt, written.archivedAt, written.updatedAt]) {
			expect(value).toMatch(STORED);
		}
		expect(db.select().from(milestones).get()!.updatedAt).toMatch(STORED);
		expect(db.select().from(apiKeys).get()!.lastUsedAt).toMatch(STORED);
	});

	it('the log: the row and the live feed in the stored form, the console line in ISO', () => {
		const printed = vi.spyOn(console, 'warn').mockImplementation(() => {});
		createLogger('TEST').warn('a line');

		const [line] = printed.mock.calls.map((call) => String(call[0]));
		expect(line).toMatch(/^\[\d{4}-\d{2}-\d{2}T\d{2}:\d{2}:\d{2}\.\d{3}Z\] \[WARN\] \[TEST\] a line$/);
		expect(getRecentLogs(1)[0].timestamp).toMatch(STORED);
		expect(sqlite.prepare("SELECT timestamp FROM system_logs WHERE context = 'TEST'").pluck().get()).toMatch(STORED);
	});
});

describe('the comparisons of table B keep their answer on the boundary day', () => {
	it('a session that expires later today is open, and is not cleared as expired', () => {
		const owner = makeUser();
		const token = createSession(owner.id);
		const later = stamp(new Date(Date.now() + 60 * 60 * 1000));
		db.update(sessions).set({ expiresAt: later }).where(eq(sessions.id, token)).run();

		cleanExpiredSessions();
		expect(db.select().from(sessions).all()).toHaveLength(1);
		expect(validateSession(token)?.id).toBe(owner.id);
	});

	it('a session that expired a second ago is closed', () => {
		const owner = makeUser();
		const token = createSession(owner.id);
		db.update(sessions).set({ expiresAt: stamp(new Date(Date.now() - 1000)) }).where(eq(sessions.id, token)).run();
		vi.spyOn(console, 'log').mockImplementation(() => {});

		expect(validateSession(token)).toBeNull();
	});

	it('a schedule due at 09:00 does not run at 00:30 that day, and runs at 09:00', async () => {
		const owner = makeUser();
		const { board } = makeBoard({ owner });
		const id = db
			.insert(reportSchedules)
			.values({ userId: owner.id, name: 'Daily', scope: 'board', scopeId: board.id, recipients: '', nextRunAt: '2026-10-15 09:00:00' })
			.returning()
			.get().id;
		vi.spyOn(console, 'warn').mockImplementation(() => {});

		await runDueReportSchedules(new Date('2026-10-15T00:30:00Z'));
		expect(db.select().from(reportSchedules).where(eq(reportSchedules.id, id)).get()!.lastRunAt).toBeNull();

		await runDueReportSchedules(new Date('2026-10-15T09:00:00Z'));
		const row = db.select().from(reportSchedules).where(eq(reportSchedules.id, id)).get()!;
		expect(row.lastRunAt).toBe('2026-10-15 09:00:00');
		expect(row.nextRunAt).toMatch(STORED);
	});

	it('an expiry that names no moment ends the session, the key and the invite, where text comparison let it through (S2)', async () => {
		// `zzz` sorts after every stamp, and so does 30 February 2099 or ISO
		// with its `T` on the day itself: compared as text, each was "not yet",
		// and each sign-in stayed open for good, or for the rest of the day.
		const owner = makeUser();
		const key = makeApiKey(owner);
		vi.spyOn(console, 'log').mockImplementation(() => {});
		vi.useFakeTimers({ toFake: ['Date'] });
		vi.setSystemTime(new Date('2026-10-14T10:00:00Z'));
		allowOtherTimestampForms();
		for (const expiresAt of ['zzz', '2099-02-30 08:00:00', '2099-10-14 24:00:00', '2026-10-14T09:00:00.000Z']) {
			const token = createSession(owner.id);
			db.update(sessions).set({ expiresAt }).where(eq(sessions.id, token)).run();
			expect(validateSession(token), `session ${expiresAt}`).toBeNull();

			db.update(apiKeys).set({ expiresAt }).run();
			expect(findApiKey(key), `key ${expiresAt}`).toBeNull();

			const invite = inTransaction(() => issueInvite(owner.id));
			db.update(inviteTokens).set({ expiresAt }).where(eq(inviteTokens.token, invite)).run();
			const page = await pageLoad(`/invite/${invite}`);
			expect(page.type === 'data' && page.data.valid, `invite ${expiresAt}`).toBe(false);
		}

		// One that names a moment still to come is still open, in either form.
		for (const expiresAt of ['2026-10-14 11:00:00', '2026-10-14T11:00:00.000Z']) {
			const token = createSession(owner.id);
			db.update(sessions).set({ expiresAt }).where(eq(sessions.id, token)).run();
			db.update(apiKeys).set({ expiresAt }).run();
			const invite = inTransaction(() => issueInvite(owner.id));
			db.update(inviteTokens).set({ expiresAt }).where(eq(inviteTokens.token, invite)).run();

			expect(findApiKey(key)?.user.id, `key ${expiresAt}`).toBe(owner.id);
			const page = await pageLoad(`/invite/${invite}`);
			expect(page.type === 'data' && page.data.valid, `invite ${expiresAt}`).toBe(true);
			expect(validateSession(token)?.id, `session ${expiresAt}`).toBe(owner.id);
		}
	});

	it('the sweep of expired sessions clears the ones findSession closes, and keeps the ones it leaves open', () => {
		// It deleted by text, `expires_at < now`, so a session whose expiry
		// names no moment was closed at its next use (S2) but never cleared
		// (the second P6 review).
		const owner = makeUser();
		vi.spyOn(console, 'log').mockImplementation(() => {});
		vi.useFakeTimers({ toFake: ['Date'] });
		vi.setSystemTime(new Date('2026-10-14T10:00:00Z'));
		allowOtherTimestampForms();
		const closed = ['zzz', '2099-02-30 08:00:00', '2099-10-14 24:00:00', '2026-10-14T09:00:00.000Z', '2026-10-14 09:59:59'];
		const open = ['2026-10-14 11:00:00', '2026-10-14T11:00:00.000Z', '2099-01-01'];
		const tokens = new Map<string, string>();
		for (const expiresAt of [...closed, ...open]) {
			const token = createSession(owner.id);
			db.update(sessions).set({ expiresAt }).where(eq(sessions.id, token)).run();
			tokens.set(token, expiresAt);
		}

		cleanExpiredSessions();
		const left = db.select({ expiresAt: sessions.expiresAt }).from(sessions).all().map((s) => s.expiresAt).sort();
		expect(left).toEqual([...open].sort());
		for (const [token, expiresAt] of tokens) {
			expect(validateSession(token) !== null, expiresAt).toBe(open.includes(expiresAt));
		}
	});

	it('pins: a key whose expiry is a date stops at 00:00 UTC that day, as it did before (A9)', () => {
		const owner = makeUser();
		const key = makeApiKey(owner);
		vi.useFakeTimers({ toFake: ['Date'] });
		// Stored as the conversion stores a bare date, and as a caller's bare date was stored.
		for (const expiresAt of ['2026-10-15 00:00:00', '2026-10-15']) {
			db.update(apiKeys).set({ expiresAt }).run();
			vi.setSystemTime(new Date('2026-10-14T23:59:59Z'));
			expect(findApiKey(key)?.user.id, expiresAt).toBe(owner.id);
			vi.setSystemTime(new Date('2026-10-15T00:00:01Z'));
			expect(findApiKey(key), expiresAt).toBeNull();
		}
		// The bare date was written to show it is read the same; it is not left behind.
		db.update(apiKeys).set({ expiresAt: null }).run();
	});
});

describe('the reports (A2 to A5)', () => {
	function reported(created: string, completed: string | null, period: [string, string]) {
		const owner = makeUser();
		const { board, cols } = makeBoard({ owner });
		const card = makeCard(completed ? cols['Complete'] : cols['To Do'], {
			title: 'on the edge',
			createdAt: created,
			updatedAt: created,
			completedAt: completed
		});
		const report = generateBoardReport(board.id, period[0], period[1], owner)!;
		return { report, card };
	}

	it('counts a card created in the afternoon of the first day (A2)', () => {
		const { report } = reported('2026-10-01 15:00:00', null, ['2026-10-01T00:00:00.000Z', '2026-10-14T23:59:59.999Z']);
		expect(report.summary.createdInPeriod).toBe(1);
	});

	it('does not count a card created on the last day after the period ends (A2)', () => {
		const { report } = reported('2026-10-14 15:00:00', null, ['2026-10-01T00:00:00.000Z', '2026-10-14T12:00:00.000Z']);
		expect(report.summary.createdInPeriod).toBe(0);
	});

	it('takes a bare date as the end to mean the whole of that day', () => {
		const { report } = reported('2026-10-14 23:30:00', null, ['2026-10-01', '2026-10-14']);
		expect(report.summary.createdInPeriod).toBe(1);
	});

	it('counts a completion on the first day whose only date is updated_at (A3)', () => {
		const owner = makeUser();
		const { board, cols } = makeBoard({ owner });
		makeCard(cols['Complete'], { createdAt: '2026-09-01 10:00:00', updatedAt: '2026-10-01 15:00:00', completedAt: null });
		const report = generateBoardReport(board.id, '2026-10-01T00:00:00.000Z', '2026-10-14T23:59:59.999Z', owner)!;
		expect(report.summary.completedInPeriod).toBe(1);
	});

	it('lists completions newest first, and the newer card first within one second (A4)', () => {
		const owner = makeUser();
		const { board, cols } = makeBoard({ owner });
		const older = makeCard(cols['Complete'], { title: 'older', completedAt: '2026-10-05 08:00:00' });
		const first = makeCard(cols['Complete'], { title: 'first', completedAt: '2026-10-05 09:00:00' });
		const second = makeCard(cols['Complete'], { title: 'second', completedAt: '2026-10-05 09:00:00' });
		const report = generateBoardReport(board.id, '2026-10-01', '2026-10-14', owner)!;
		expect(report.completedTasks.map((t) => t.id)).toEqual([second.id, first.id, older.id]);
	});

	it('shows the day a stored value names in UTC, on a host that is not on UTC (A5)', () => {
		const zone = process.env.TZ;
		process.env.TZ = 'America/New_York';
		try {
			// 02:00 UTC on the 15th is 22:00 on the 14th in New York.
			expect(formatDate('2026-10-15 02:00:00')).toBe('14 Oct 2026');
			expect(formatDate('2026-10-15T02:00:00.000Z')).toBe('14 Oct 2026');
			expect(formatDate('not a date')).toBe('—');
		} finally {
			if (zone === undefined) delete process.env.TZ;
			else process.env.TZ = zone;
		}
	});
});

describe('the activity report (A12, and its plain comparisons)', () => {
	it('closes a span with the stored form, where the log and the card disagree', () => {
		const owner = makeUser();
		const A = makeBoard({ owner, name: 'A' });
		const B = makeBoard({ owner, name: 'B' });
		const card = makeCard(B.cols['To Do'], { title: 'moved without a record' });
		// The log says it was made on A, and has no record of the move to B.
		sqlite
			.prepare("INSERT INTO activity_log (board_id, card_id, user_id, action, created_at) VALUES (?, ?, ?, 'card_created', '2026-10-01 08:00:00')")
			.run(A.board.id, card.id, owner.id);

		const spans = getCardBoardHistory(card.id);

		expect(spans.map((s) => s.boardId)).toEqual([A.board.id, B.board.id]);
		expect(spans[0].to).toMatch(STORED);
		expect(spans[1].from).toBe(spans[0].to);
	});

	it('takes a completion at 23:00 on the last day, with a bare date as the end, and none after', () => {
		const owner = makeUser();
		const { cols } = makeBoard({ owner });
		const inside = makeCard(cols['Complete'], { title: 'inside', createdAt: '2026-09-01 08:00:00', updatedAt: '2026-10-14 23:00:00', completedAt: '2026-10-14 23:00:00' });
		makeCard(cols['Complete'], { title: 'after', createdAt: '2026-09-01 08:00:00', updatedAt: '2026-10-15 00:00:00', completedAt: '2026-10-15 00:00:00' });

		const report = buildActivityReport({ actor: owner, from: '2026-10-01', to: '2026-10-14' });

		expect(report.period).toMatchObject({ from: '2026-10-01 00:00:00', to: '2026-10-14 23:59:59' });
		expect(report.boards.flatMap((b) => b.cards.map((c) => c.id))).toEqual([inside.id]);
	});
});

// ─── Slice 3: the routes ─────────────────────────────────────────────────────

/** Puts the clock at `iso` for `Date` alone, so that timers and the event loop run as they do. */
function clockAt(iso: string): void {
	vi.useFakeTimers({ toFake: ['Date'] });
	vi.setSystemTime(new Date(iso));
}

/** Runs `body` with the process in time zone `zone`, and puts the zone back. */
async function inZone<T>(zone: string, body: () => Promise<T>): Promise<T> {
	const was = process.env.TZ;
	process.env.TZ = zone;
	try {
		return await body();
	} finally {
		if (was === undefined) delete process.env.TZ;
		else process.env.TZ = was;
	}
}

/** The data of a page load that answered with data. */
function dataOf(page: Awaited<ReturnType<typeof pageLoad>>): any {
	expect(page.type).toBe('data');
	return (page as { data: unknown }).data;
}

describe('the routes compare in the stored form (A1, A6, A7, A11, A18, A19)', () => {
	it('counts a completion a quarter of an hour after the cutoff of the last 7 and 30 days (A1)', async () => {
		clockAt('2026-10-15T23:30:00Z');
		const owner = makeUser();
		const { board } = makeBoard({ owner });
		const logged = sqlite.prepare("INSERT INTO activity_log (board_id, user_id, action, created_at) VALUES (?, ?, 'card_completed', ?)");
		logged.run(board.id, owner.id, '2026-10-08 23:45:00');
		logged.run(board.id, owner.id, '2026-09-15 23:45:00');
		// And one a quarter of an hour before the 30-day cutoff.
		logged.run(board.id, owner.id, '2026-09-15 23:15:00');

		const stats = await api('GET', '/api/v1/me/stats', { user: owner });

		expect(stats.status).toBe(200);
		expect(stats.body.cardsCompleted).toEqual({ total: 3, last7Days: 1, last30Days: 2 });
	});

	it('shows the later of the board’s and its cards’ edits as the board’s last activity (A6)', async () => {
		const owner = makeUser();
		const { board, cols } = makeBoard({ owner });
		clockAt('2026-10-14T08:00:00Z');
		expect((await api('PUT', `/api/boards/${board.id}`, { user: owner, body: { name: 'Renamed' } })).status).toBe(200);
		makeCard(cols['To Do'], { title: 'edited later that day', updatedAt: '2026-10-14 09:00:00' });

		const shown = dataOf(await pageLoad('/', { user: owner })).boards.find((b: { id: number }) => b.id === board.id);

		expect(shown.updatedAt).toBe('2026-10-14 08:00:00');
		expect(shown.lastActivity).toBe('2026-10-14 09:00:00');
	});

	it('lists the newer of two cards completed in one second first, so that the cap keeps it (A7)', async () => {
		const owner = makeUser();
		const { cols } = makeBoard({ owner });
		makeCard(cols['Complete'], { title: 'older', completedAt: '2026-10-14 09:00:00' });
		const newer = makeCard(cols['Complete'], { title: 'newer', completedAt: '2026-10-14 09:00:00' });

		const buckets = dataOf(await pageLoad('/all?completedLimit=1', { user: owner })).buckets;

		const complete = buckets.find((b: { title: string }) => b.title === 'Complete');
		expect(complete.cards.map((c: { id: number }) => c.id)).toEqual([newer.id]);
	});

	it('reads lead and cycle time in UTC, on a host that is not on UTC (A11)', async () => {
		clockAt('2026-11-10T12:00:00Z');
		const owner = makeUser();
		const { board, cols } = makeBoard({ owner });
		// Across the end of summer time in New York, which a time read there moves by an hour.
		const card = makeCard(cols['Complete'], { title: 'done', createdAt: '2026-11-01 00:00:00', completedAt: '2026-11-02 12:00:00' });
		sqlite
			.prepare("INSERT INTO activity_log (board_id, card_id, user_id, action, created_at) VALUES (?, ?, ?, 'card_moved', '2026-11-01 12:00:00')")
			.run(board.id, card.id, owner.id);

		const res = await inZone('America/New_York', () => api('GET', `/api/boards/${board.id}/metrics`, { user: owner }));

		expect(res.status).toBe(200);
		expect(res.body.cards).toEqual([expect.objectContaining({ id: card.id, leadTimeHours: 36, cycleTimeHours: 24 })]);
	});

	it('counts a completion at 00:30 today in today, and one at 23:30 yesterday in yesterday (velocity, table B)', async () => {
		clockAt('2026-10-15T12:00:00Z');
		const owner = makeUser();
		const { cols } = makeBoard({ owner });
		for (const completedAt of ['2026-10-15 00:30:00', '2026-10-14 23:30:00']) {
			assignCard(makeCard(cols['Complete'], { title: completedAt, completedAt }), owner);
		}

		const res = await api('GET', '/api/velocity?days=14', { user: owner });

		expect(res.status).toBe(200);
		expect(res.body.buckets.slice(-2).map((b: { start: string; count: number }) => [b.start, b.count])).toEqual([
			['2026-10-14', 1],
			['2026-10-15', 1]
		]);
		expect(res.body.summary.total).toBe(2);
	});

	it('reads the activity report’s window in either form, refuses one that ends before it begins, and takes a bare `to` as its whole day (A18)', async () => {
		const owner = makeUser();
		const report = (from: string, to: string) =>
			api('GET', `/api/v1/reports/activity?from=${encodeURIComponent(from)}&to=${encodeURIComponent(to)}`, { user: owner });

		const backwards = await report('2026-10-14 09:00:00', '2026-10-14 08:00:00');
		expect(backwards.status).toBe(400);
		expect(backwards.body).toEqual({ message: '`from` is after `to`' });

		const day = await report('2026-10-14 09:00:00', '2026-10-14');
		expect(day.status, JSON.stringify(day.body)).toBe(200);
		expect(day.body.period).toMatchObject({ from: '2026-10-14T09:00:00.000Z', to: '2026-10-14T23:59:59.000Z' });
	});

	it('reads a report’s period as whole days in the stored form, so that a period to 14 October counts 23:30 that day (A19)', () => {
		const window = readReportWindow({ periodStart: '2026-10-01', periodEnd: '2026-10-14' }, 'missing');
		expect(window).toEqual({ periodStart: '2026-10-01 00:00:00', periodEnd: '2026-10-14 23:59:59' });
		// One day's report, from a date to the same date, is that day.
		expect(readReportWindow({ periodStart: '2026-10-14', periodEnd: '2026-10-14' }, 'missing')).toEqual({
			periodStart: '2026-10-14 00:00:00',
			periodEnd: '2026-10-14 23:59:59'
		});
		expect(readReportWindow({ periodStart: '2026-10-14T09:00:00+02:00', periodEnd: '2026-10-14 08:00:00' }, 'missing')).toEqual({
			periodStart: '2026-10-14 07:00:00',
			periodEnd: '2026-10-14 08:00:00'
		});

		const owner = makeUser();
		const { board, cols } = makeBoard({ owner });
		makeCard(cols['To Do'], { title: 'late on the last day', createdAt: '2026-10-14 23:30:00', updatedAt: '2026-10-14 23:30:00' });
		expect(generateBoardReport(board.id, window.periodStart, window.periodEnd, owner)!.summary.createdInPeriod).toBe(1);
	});
});

describe.each([
	{ route: '/api/audit', of: (row: any) => row.createdAt },
	{ route: '/api/v1/audit-log', of: (row: any) => row.createdAt },
	{ route: '/api/logs', of: (row: any) => row.timestamp }
])('$route: from and to (A8)', ({ route, of }) => {
	let admin: ReturnType<typeof makeUser>;
	let narrow = '';

	beforeEach(() => {
		admin = makeUser({ role: 'admin' });
		const { board } = makeBoard({ owner: admin });
		const moments = ['2026-10-14 21:30:00', '2026-10-14 23:00:00', '2026-10-15 00:00:00'];
		if (route === '/api/logs') {
			narrow = 'context=EDGE';
			for (const at of moments) {
				sqlite.prepare("INSERT INTO system_logs (timestamp, level, context, message) VALUES (?, 'INFO', 'EDGE', 'a line')").run(at);
			}
		} else {
			narrow = `boardId=${board.id}`;
			for (const at of moments) {
				sqlite.prepare("INSERT INTO activity_log (board_id, user_id, action, created_at) VALUES (?, ?, 'card_moved', ?)").run(board.id, admin.id, at);
			}
		}
	});

	/** The moments found, in the stored form, oldest first. */
	const found = async (query: string) => {
		const res = await api('GET', `${route}?${narrow}&${query}`, { user: admin });
		expect(res.status, JSON.stringify(res.body)).toBe(200);
		return (res.body.data as unknown[]).map((row) => toStamp(of(row))).sort();
	};

	it('takes a bare `to` as the whole of its day, and nothing after it', async () => {
		expect(await found('to=2026-10-14')).toEqual(['2026-10-14 21:30:00', '2026-10-14 23:00:00']);
	});

	it('compares an ISO bound as the moment it names', async () => {
		expect(await found(`to=${encodeURIComponent('2026-10-14T22:00:00Z')}`)).toEqual(['2026-10-14 21:30:00']);
		expect(await found(`from=${encodeURIComponent('2026-10-14T23:00:00Z')}`)).toEqual(['2026-10-14 23:00:00', '2026-10-15 00:00:00']);
		expect(await found(`from=${encodeURIComponent('2026-10-15T01:00:00+01:00')}&to=${encodeURIComponent('2026-10-15 00:00:00')}`)).toEqual([
			'2026-10-15 00:00:00'
		]);
	});
});

describe('a timestamp a caller sends that cannot be read is a 400 that names it (decision 10)', () => {
	const SESSION = { cookie: `${SESSION_COOKIE_NAME}=a-session` };

	it.each([
		['GET', '/api/audit?from=yesterday', 'from is not a date'],
		['GET', '/api/audit?to=2026-02-30', 'to is not a date'],
		['GET', '/api/logs?from=yesterday', 'from is not a date'],
		['GET', '/api/logs?to=14/10/2026', 'to is not a date'],
		['GET', '/api/v1/audit-log?from=yesterday', 'from is not a date'],
		['GET', '/api/v1/audit-log?to=soon', 'to is not a date'],
		['GET', '/api/v1/reports/activity?from=yesterday', 'from is not a date'],
		['GET', '/api/v1/reports/activity?to=1', 'to is not a date']
	])('%s %s', async (method, path, message) => {
		const res = await api(method as 'GET', path, { user: makeUser({ role: 'admin' }) });
		expect(res.status).toBe(400);
		expect(res.body).toEqual({ message });
	});

	it('POST /api/reports and /api/reports/email: periodStart and periodEnd', async () => {
		const owner = makeUser();
		const { board } = makeBoard({ owner });
		const report = { scope: 'board', scopeId: board.id, recipients: ['a@example.test'] };
		for (const route of ['/api/reports', '/api/reports/email']) {
			const start = await api('POST', route, { user: owner, body: { ...report, periodStart: 'soon', periodEnd: '2026-10-14' } });
			expect([start.status, start.body]).toEqual([400, { message: 'periodStart is not a date' }]);
			const end = await api('POST', route, { user: owner, body: { ...report, periodStart: '2026-10-01', periodEnd: '2026-10-32' } });
			expect([end.status, end.body]).toEqual([400, { message: 'periodEnd is not a date' }]);
		}
	});

	it('POST /api/account/api-keys: expiresAt', async () => {
		const res = await api('POST', '/api/account/api-keys', {
			user: makeUser(),
			body: { name: 'my script', password: 'the password', expiresAt: 'yesterday' },
			headers: SESSION
		});
		expect([res.status, res.body]).toEqual([400, { message: 'expiresAt must be a timestamp, such as 2027-01-01T09:00:00Z' }]);
	});

	it('PUT /api/v1/cards/{id}: archivedAt', async () => {
		const owner = makeUser();
		const card = makeCard(makeBoard({ owner }).cols['To Do'], { title: 'held', archivedAt: '2026-10-01 09:00:00' });
		const res = await api('PUT', `/api/v1/cards/${card.id}`, { user: owner, body: { archivedAt: 'yesterday' } });
		expect([res.status, res.body]).toEqual([
			400,
			{ message: 'archivedAt may only be null, which restores the card. Archive a card with DELETE /cards/{cardId}' }
		]);
	});
});

describe('null, text and anything else, for archivedAt and expiresAt (R7)', () => {
	const SESSION = { cookie: `${SESSION_COOKIE_NAME}=a-session` };
	const REFUSED = 'archivedAt may only be null, which restores the card. Archive a card with DELETE /cards/{cardId}';

	it('archivedAt: the stamp held, sent back in either form, changes nothing; null restores; true and a number are refused, naming it', async () => {
		const owner = makeUser();
		const card = makeCard(makeBoard({ owner }).cols['To Do'], { title: 'held', archivedAt: '2026-10-01 09:00:00' });
		const put = (archivedAt: unknown) => api('PUT', `/api/v1/cards/${card.id}`, { user: owner, body: { archivedAt } });

		for (const same of ['2026-10-01 09:00:00', '2026-10-01T09:00:00.000Z', '2026-10-01T10:00:00.1234567+01:00']) {
			const kept = await put(same);
			expect(kept.status, same).toBe(200);
			expect(kept.body.archivedAt).toBe('2026-10-01T09:00:00.000Z');
		}
		for (const other of [true, 5, '2026-10-01T09:00:01Z']) {
			expect([(await put(other)).body], JSON.stringify(other)).toEqual([{ message: REFUSED }]);
		}
		const restored = await put(null);
		expect(restored.status).toBe(200);
		expect(restored.body.archivedAt).toBeNull();
	});

	it('expiresAt: null is no expiry, text is read into the stored form, true and a number are refused, naming it', async () => {
		const owner = makeUser();
		db.update(users).set({ passwordHash: await makePasswordHash('the password', 'known') }).where(eq(users.id, owner.id)).run();
		const make = (expiresAt: unknown) =>
			api('POST', '/api/account/api-keys', { user: owner, body: { name: 'my script', password: 'the password', expiresAt }, headers: SESSION });

		const never = await make(null);
		expect([never.status, never.body.expiresAt]).toEqual([201, null]);
		const read = await make('2099-01-01T10:30:00.1234567+01:00');
		expect([read.status, read.body.expiresAt]).toEqual([201, '2099-01-01 09:30:00']);
		for (const other of [true, 4102444800000]) {
			expect((await make(other)).body, JSON.stringify(other)).toEqual({ message: 'expiresAt must be a timestamp, such as 2027-01-01T09:00:00Z' });
		}
		expect(db.select({ expiresAt: apiKeys.expiresAt }).from(apiKeys).all()).toEqual([{ expiresAt: null }, { expiresAt: '2099-01-01 09:30:00' }]);
	});
});

// ─── Slice 3b: the public edge (R1) ──────────────────────────────────────────

/** A string in the stored form anywhere in `text`. */
const STORED_ANYWHERE = /\d{4}-\d{2}-\d{2} \d{2}:\d{2}:\d{2}/;
/** A string in the form the v1 API answers with. */
const ISO_ANYWHERE = /"\d{4}-\d{2}-\d{2}T\d{2}:\d{2}:\d{2}\.000Z"/;

describe('onTheWire', () => {
	it('turns a stored value into ISO 8601 at every key the rule names, through arrays and objects', () => {
		const sent = {
			createdAt: '2026-10-14 08:00:00',
			last_run_at: '2026-10-14 08:00:01',
			timestamp: '2026-10-14 08:00:02',
			period: { from: '2026-10-01 00:00:00', to: '2026-10-14 23:59:59' },
			cards: [{ id: 1, updatedAt: '2026-10-14 09:00:00', comments: [{ createdAt: '2026-10-14 10:00:00' }] }],
			completedAt: null
		};
		const copy = structuredClone(sent);

		expect(onTheWire(sent)).toEqual({
			createdAt: '2026-10-14T08:00:00.000Z',
			last_run_at: '2026-10-14T08:00:01.000Z',
			timestamp: '2026-10-14T08:00:02.000Z',
			period: { from: '2026-10-01T00:00:00.000Z', to: '2026-10-14T23:59:59.000Z' },
			cards: [{ id: 1, updatedAt: '2026-10-14T09:00:00.000Z', comments: [{ createdAt: '2026-10-14T10:00:00.000Z' }] }],
			completedAt: null
		});
		// What it was given is not changed.
		expect(sent).toEqual(copy);
	});

	it('leaves a date, a number, null, ISO, text that only looks like a moment, and what is not a plain object', () => {
		const moment = new Date('2026-10-14T08:00:00Z');
		const sent = {
			dueDate: '2026-10-14',
			targetDate: '2026-10-14',
			asOf: '2026-10-14',
			title: '2026-10-14 08:00:00',
			description: 'Due 2026-10-14 08:00:00',
			createdAt: '2026-10-14T08:00:00.000Z',
			updatedAt: '2026-10-14 08:00:00 and more',
			expiresAt: 5,
			archivedAt: null,
			generatedAt: moment
		};
		expect(onTheWire(sent)).toEqual(sent);
		expect(onTheWire(sent).generatedAt).toBe(moment);
		expect(onTheWire('2026-10-14 08:00:00')).toBe('2026-10-14 08:00:00');
		expect(onTheWire(['2026-10-14 08:00:00'])).toEqual(['2026-10-14 08:00:00']);
	});

	it('keeps a key named __proto__ as a key of the copy, as JSON.parse made it, and does not make it the copy’s prototype (N7)', () => {
		// Assigned with `copy[name] = ...`, the key set the copy's prototype:
		// the key was lost from the answer, and the copy inherited what it held.
		const sent = JSON.parse('{"__proto__": {"createdAt": "2026-10-14 08:00:00", "admin": true}, "id": 1}');
		const copy = onTheWire(sent) as Record<string, unknown>;

		expect(Object.getPrototypeOf(copy)).toBe(Object.prototype);
		expect(Object.keys(copy)).toEqual(['__proto__', 'id']);
		expect(copy.admin).toBeUndefined();
		expect(JSON.parse(JSON.stringify(copy))).toEqual(
			JSON.parse('{"__proto__": {"createdAt": "2026-10-14T08:00:00.000Z", "admin": true}, "id": 1}')
		);
	});

	it('toIso gives the same moment as ISO 8601 with Z, or null', () => {
		expect(toIso('2026-10-14 08:00:00')).toBe('2026-10-14T08:00:00.000Z');
		expect(toIso('2026-10-14T09:00:00+01:00')).toBe('2026-10-14T08:00:00.000Z');
		expect(toIso('soon')).toBeNull();
		expect(toIso(null)).toBeNull();
	});
});

describe('the v1 API answers every stored timestamp in ISO 8601 (R1)', () => {
	it('every handler under src/routes/api/v1 takes json from $lib/server/v1-json, and none from @sveltejs/kit', () => {
		const root = join(process.cwd(), 'src', 'routes', 'api', 'v1');
		const handlers = (readdirSync(root, { recursive: true }) as string[]).filter((path) => path.split(/[\\/]/).at(-1) === '+server.ts');
		expect(handlers.length).toBeGreaterThanOrEqual(40);
		const kitJson = /import\s*\{[^}]*\bjson\b[^}]*\}\s*from\s*'@sveltejs\/kit'/;
		const ownJson = /import\s*\{\s*json\s*\}\s*from\s*'\$lib\/server\/v1-json'/;
		const wrong = handlers.filter((path) => {
			const source = readFileSync(join(root, path), 'utf8');
			return kitJson.test(source) || (/\bjson\(/.test(source) && !ownJson.test(source));
		});
		expect(wrong).toEqual([]);
	});

	/** A world in which every answer of table E has a stored timestamp to give. */
	function world() {
		const admin = makeUser({ role: 'admin', username: 'admin' });
		const { board, cols } = makeBoard({ owner: admin });
		const card = makeCard(cols['To Do'], { title: 'the card' });
		const other = makeCard(cols['To Do'], { title: 'the blocker' });
		db.update(cards).set({ completedAt: '2026-10-14 08:00:00' }).where(eq(cards.id, other.id)).run();
		const comment = makeComment(card, admin, 'said');
		makeDependency({ blocked: card, blocker: other, createdBy: admin });
		const milestone = makeMilestone({ board, cards: [card, other], createdBy: admin });
		const webhook = makeWebhook(board);
		db.insert(tokenUsage).values({ cardId: card.id, tokens: 1000, model: 'claude-opus-5-5', reportedByUserId: admin.id }).run();
		sqlite
			.prepare("INSERT INTO activity_log (board_id, card_id, user_id, action, created_at) VALUES (?, ?, ?, 'card_created', ?)")
			.run(board.id, card.id, admin.id, stamp(new Date(Date.now() - 60_000)));
		sqlite
			.prepare("INSERT INTO activity_log (board_id, card_id, user_id, action, created_at) VALUES (?, ?, ?, 'card_completed', ?)")
			.run(board.id, other.id, admin.id, stamp(new Date(Date.now() - 30_000)));
		return { admin, board, cols, card, comment, milestone, webhook };
	}

	it('in each answer of table E: no value in the stored form, and the stored values in ISO 8601', async () => {
		const w = world();
		const asked: [string, string, unknown?][] = [
			['GET', '/api/v1/audit-log'],
			['GET', '/api/v1/boards'],
			['GET', `/api/v1/boards/${w.board.id}`],
			['GET', `/api/v1/boards/${w.board.id}/cards`],
			['GET', `/api/v1/boards/${w.board.id}/webhooks`],
			['GET', `/api/v1/webhooks/${w.webhook.id}`],
			['GET', `/api/v1/burndown?milestoneId=${w.milestone.id}`],
			['GET', `/api/v1/cards/${w.card.id}`],
			['PUT', `/api/v1/cards/${w.card.id}/move`, { columnId: w.cols['In Progress'].id }],
			['GET', `/api/v1/cards/${w.card.id}/comments`],
			['GET', `/api/v1/comments/${w.comment.id}`],
			['GET', `/api/v1/cards/${w.card.id}/dependencies`],
			['GET', `/api/v1/cards/${w.card.id}/tokens`],
			['GET', `/api/v1/cards/${w.card.id}/board-history`],
			['GET', '/api/v1/me/stats'],
			['GET', '/api/v1/milestones'],
			['GET', `/api/v1/milestones/${w.milestone.id}`],
			['GET', `/api/v1/milestones/${w.milestone.id}/summary`],
			['GET', '/api/v1/reports/activity?from=2026-01-01']
		];
		expect(asked).toHaveLength(19);

		const faults: string[] = [];
		// The move tells the board's webhook.
		const sent = effects();
		try {
			for (const [method, path, body] of asked) {
				const res = await api(method as 'GET', path, { user: w.admin, body });
				const text = JSON.stringify(res.body);
				if (res.status !== 200) faults.push(`${method} ${path}: ${res.status} ${text}`);
				else if (STORED_ANYWHERE.test(text)) faults.push(`${method} ${path}: holds ${STORED_ANYWHERE.exec(text)![0]}`);
				else if (!ISO_ANYWHERE.test(text)) faults.push(`${method} ${path}: holds no timestamp at all, so it tests nothing`);
			}
			await sent.settle();
		} finally {
			sent.restore();
		}
		expect(faults).toEqual([]);
	});

	it('answers a card’s stored timestamps as the moments they are', async () => {
		const w = world();
		const stored = db.select().from(cards).where(eq(cards.id, w.card.id)).get()!;

		const res = await api('GET', `/api/v1/cards/${w.card.id}`, { user: w.admin });

		expect(res.body.createdAt).toBe(toIso(stored.createdAt));
		expect(res.body.updatedAt).toBe(toIso(stored.updatedAt));
	});

	it('in a webhook body, as in the API', async () => {
		const w = world();
		const sent = effects();
		try {
			// What a card's events send today names no stored moment; whatever
			// one sends goes out as the API answers it.
			const made = await api('POST', `/api/v1/boards/${w.board.id}/cards`, { user: w.admin, body: { columnId: w.cols['Complete'].id, title: 'made done' } });
			expect(made.status).toBe(201);
			dispatchWebhook(w.board.id, 'card.updated', { cardId: w.card.id, updatedAt: '2026-10-14 08:00:00', dueDate: '2026-10-20' });
			await sent.settle();

			expect(sent.webhooks.map((hook) => hook.event)).toEqual(['card.created', 'card.completed', 'card.updated']);
			for (const hook of sent.webhooks) expect(JSON.stringify(hook.body), hook.event).not.toMatch(STORED_ANYWHERE);
			expect(sent.webhooks[2].body.data).toEqual({ cardId: w.card.id, updatedAt: '2026-10-14T08:00:00.000Z', dueDate: '2026-10-20' });
		} finally {
			sent.restore();
		}
	});

	it('and only there: the internal tree answers the stored form', async () => {
		const w = world();
		const res = await api('GET', '/api/boards', { user: w.admin });
		expect(res.status).toBe(200);
		expect(JSON.stringify(res.body)).toMatch(STORED_ANYWHERE);
	});
});

describe('the check after every test (R2)', () => {
	it('is run after every test, by tests/setup.ts', () => {
		const setup = readFileSync(join(process.cwd(), 'tests', 'setup.ts'), 'utf8');
		expect(setup).toMatch(/^afterEach\(\(\) => afterEachTimestampCheck\(sqlite\)\);$/m);
	});

	it('is made first by every test file whose own afterEach empties the database, which runs before the one in setup', () => {
		const dir = join(process.cwd(), 'tests');
		const faults: string[] = [];
		let found = 0;
		for (const file of readdirSync(dir).filter((name) => name.endsWith('.test.ts'))) {
			const source = readFileSync(join(dir, file), 'utf8');
			// Each hook, as a statement of its own: at the start of a line.
			for (const { index: at } of source.matchAll(/^\s*afterEach\(/gm)) {
				// The hook's body: from its first brace to the one that closes it.
				const open = source.indexOf('{', at);
				let depth = 0;
				let end = open;
				for (; end < source.length; end++) {
					if (source[end] === '{') depth++;
					else if (source[end] === '}' && --depth === 0) break;
				}
				const hook = source.slice(open, end);
				if (!hook.includes('resetDb()')) continue;
				found++;
				const checked = hook.indexOf('afterEachTimestampCheck(');
				if (checked === -1 || checked > hook.indexOf('resetDb()')) {
					faults.push(`${file}:${source.slice(0, at! + 1).split('\n').length}`);
				}
			}
		}
		expect(faults).toEqual([]);
		// backups 1, import-working-copy 3, migrations 1 when this was written.
		expect(found).toBeGreaterThanOrEqual(5);
	});
});

// ─── Slice 4: the pages ──────────────────────────────────────────────────────

/** The source of a file of the repository. */
function sourceOf(file: string): string {
	return readFileSync(join(process.cwd(), file), 'utf8');
}

/**
 * The body of `function name(` in `source`: from the brace that ends its first
 * line (a return type can hold braces of its own) to the one that closes it.
 */
function bodyOf(source: string, name: string): string {
	const at = source.indexOf(`function ${name}(`);
	expect(at, `function ${name}`).toBeGreaterThan(-1);
	const open = at + source.slice(at).search(/\{\r?\n/);
	let depth = 0;
	for (let end = open; end < source.length; end++) {
		if (source[end] === '{') depth++;
		else if (source[end] === '}' && --depth === 0) return source.slice(open, end + 1);
	}
	throw new Error(`function ${name} does not close`);
}

/** Every page and component, and the utilities they share. */
function pageSources(): string[] {
	const root = join(process.cwd(), 'src');
	return (readdirSync(root, { recursive: true }) as string[])
		.map((file) => file.split('\\').join('/'))
		.filter((file) => file.endsWith('.svelte') || /^lib\/utils\/[^/]+\.ts$/.test(file))
		.map((file) => `src/${file}`);
}

describe('the pages read every stored value as UTC, through parseStamp (A13 to A17, the page half of A19)', () => {
	// Each helper a page uses to show a stored moment. Each read the stored
	// form with `new Date()`, as local time, or patched it with `+ 'Z'`, which
	// made "Invalid Date" of a value that already ended in Z (A13).
	const HELPERS: [file: string, name: string][] = [
		['src/routes/+page.svelte', 'timeAgo'],
		['src/routes/account/+page.svelte', 'formatDate'],
		['src/routes/admin/+page.svelte', 'formatRelativeTime'],
		['src/routes/archived/+page.svelte', 'formatArchiveDate'],
		['src/routes/audit/+page.svelte', 'fmtTime'],
		['src/routes/audit/+page.svelte', 'fmtDateTime'],
		['src/routes/inbox/+page.svelte', 'timeAgo'],
		['src/routes/reports/+page.svelte', 'formatDateTime'],
		['src/routes/request/[id]/reply/+page.svelte', 'timeAgo'],
		['src/lib/components/CardModal.svelte', 'commentTimeAgo'],
		['src/lib/utils/date-utils.ts', 'parseUTC']
	];

	it.each(HELPERS)('%s %s reads the value with parseStamp, and never with new Date()', (file, name) => {
		const body = bodyOf(sourceOf(file), name);
		expect(body).toContain('parseStamp(');
		// `new Date()` (now) and `new Date(NaN)` (an invalid date) parse nothing.
		expect(body).not.toMatch(/new Date\(\s*(?!NaN\))[^)\s]/);
	});

	// A milestone's target date is a day too, read the same wrong way. Card 2259
	// mends its readers and is not built yet, so these are the ones known today:
	// the sweep fails on any other, and on one of these once it is gone.
	const TARGET_DATE_SITES_FOR_2259 = ['src/routes/plan/[id]/+page.svelte parses a target date'];
	// And the helpers that are handed a target date as `d`, which the sweep cannot see.
	const TARGET_DATE_HELPERS_FOR_2259: [file: string, name: string][] = [
		['src/routes/plan/+page.svelte', 'formatDate'],
		['src/routes/plan/+page.svelte', 'daysUntil'],
		['src/routes/plan/[id]/+page.svelte', 'formatDate']
	];

	it('no page, component or shared utility parses a stored moment with new Date(), or patches its zone by hand', () => {
		const faults: string[] = [];
		const targetDateSites: string[] = [];
		for (const file of pageSources()) {
			const lines = sourceOf(file).split('\n');
			lines.forEach((line, i) => {
				// A field that holds a moment, straight into the Date constructor:
				// card.createdAt, card.archivedAt, a.lastActivity, entry.timestamp.
				if (/new Date\(\s*[\w.?!]*(?:At|_at|timestamp|lastActivity)\b/.test(line)) faults.push(`${file}:${i + 1} new Date(<a moment>)`);
				// A due date, which is a day and not a moment: `new Date('2026-10-19')`
				// is midnight UTC, the day before west of UTC (card 2241).
				if (/new Date\(\s*[\w.?!]*dueDate\b/.test(line)) faults.push(`${file}:${i + 1} new Date(<a due date>)`);
				// `Date.parse` reads it the same way.
				if (/Date\.parse\(\s*[\w.?!]*dueDate\b/.test(line)) faults.push(`${file}:${i + 1} Date.parse(<a due date>)`);
				if (/(?:new Date|Date\.parse)\(\s*[\w.?!]*targetDate\b/.test(line)) targetDateSites.push(`${file} parses a target date`);
				// The workarounds of table D, each a guess at the form a value is in.
				if (/\+\s*['"]Z['"]|endsWith\(\s*['"]Z['"]\s*\)|replace\(\s*['"] ['"]\s*,\s*['"]T['"]\s*\)/.test(line)) faults.push(`${file}:${i + 1} a zone patched by hand`);
			});
		}
		expect(faults).toEqual([]);
		expect(targetDateSites).toEqual(TARGET_DATE_SITES_FOR_2259);
		for (const [file, name] of TARGET_DATE_HELPERS_FOR_2259) {
			expect(bodyOf(sourceOf(file), name), `${file} ${name}: card 2259 mended it, so take it off the list`).toContain('new Date(d)');
		}
		// The board page, the card window, the board's statistics and the dashboard read theirs inline.
		expect(sourceOf('src/routes/board/[id]/+page.svelte')).toContain('parseStamp(card.archivedAt)');
		expect(sourceOf('src/routes/board/[id]/+page.svelte')).toContain('parseStamp(activity.createdAt)');
		expect(sourceOf('src/lib/components/CardModal.svelte')).toContain('parseStamp(card.createdAt)');
		expect(sourceOf('src/lib/components/board/StatsPanel.svelte')).toContain('parseStamp(c.createdAt)');
		expect(sourceOf('src/routes/+page.svelte')).toContain('parseStamp(a.lastActivity)');
	});

	it('the card window writes an edited comment’s time in the stored form, as the server does', () => {
		const modal = sourceOf('src/lib/components/CardModal.svelte');
		expect(modal).toContain('updatedAt: stamp()');
		expect(modal).not.toContain('toISOString()');
	});

	it('parseUTC, which the board, the all-tasks page and the list row use, is parseStamp: either form, one moment, in any zone', async () => {
		await inZone('Asia/Tokyo', async () => {
			expect(parseUTC('2026-10-14 08:00:00').toISOString()).toBe('2026-10-14T08:00:00.000Z');
			expect(parseUTC('2026-10-14T08:00:00.000Z').toISOString()).toBe('2026-10-14T08:00:00.000Z');
			expect(parseUTC('2026-10-14T09:00:00+01:00').toISOString()).toBe('2026-10-14T08:00:00.000Z');
			expect(Number.isNaN(parseUTC('not a date').getTime())).toBe(true);
			// An empty value is now, as it was: a card with no time shows "just now".
			expect(Math.abs(parseUTC('').getTime() - Date.now())).toBeLessThan(1000);
		});
	});

	it('sorts cards by when they were made as UTC, whatever the zone and the form, and by id within a second (A17)', async () => {
		const card = (id: number, createdAt: string) => ({ id, createdAt, pinned: false }) as unknown as CardType;
		// 08:00 UTC in the stored form, and 07:30 UTC in ISO: in Tokyo, read as
		// local time, the first was 23:00 UTC the day before, and sorted first.
		const stored = card(1, '2026-10-14 08:00:00');
		const iso = card(2, '2026-10-14T07:30:00.000Z');
		await inZone('Asia/Tokyo', async () => {
			expect(sortCards([stored, iso], 'date-asc', []).map((c) => c.id)).toEqual([2, 1]);
			expect(sortCards([iso, stored], 'date-desc', []).map((c) => c.id)).toEqual([1, 2]);
		});
		// Two cards made in one second: the order they were made in, by id.
		const later = card(4, '2026-10-14 08:00:00');
		const earlier = card(3, '2026-10-14 08:00:00');
		expect(sortCards([later, earlier], 'date-asc', []).map((c) => c.id)).toEqual([3, 4]);
		expect(sortCards([earlier, later], 'date-desc', []).map((c) => c.id)).toEqual([4, 3]);
	});

	it('the audit page sends the last day of its range as the date chosen, which the route reads as the whole day (A8)', () => {
		const audit = sourceOf('src/routes/audit/+page.svelte');
		expect(audit).toContain("params.set('to', fTo);");
		expect(audit).not.toContain('T23:59:59');
	});

	it('the reports page sends a custom range as the dates chosen, so the last day is in the report (A19)', () => {
		const custom = bodyOf(sourceOf('src/routes/reports/+page.svelte'), 'getPeriodDates');
		expect(custom).toContain('start: genCustomStart || endStr, end: genCustomEnd || endStr');
		expect(custom).not.toMatch(/new Date\(genCustom/);
	});
});

// ─── Due dates are calendar days (card 2241) ─────────────────────────────────

/** Runs `body` with the clock at `iso` and the process in time zone `zone`. */
function onDayIn<T>(zone: string, iso: string, body: () => T): Promise<T> {
	clockAt(iso);
	return inZone(zone, async () => body());
}

/** What a badge shows for `dueDate`: its words, its colour and the days to it. */
function badge(dueDate: string) {
	return [getDueRelative(dueDate, 0), getDueStatus(dueDate), daysUntilDue(dueDate)];
}

describe('a due date is a calendar day, counted from the viewer’s own today (card 2241)', () => {
	const LONG = { day: 'numeric', month: 'short', year: 'numeric' } as const;

	it('west of UTC: at 11:00 in New York on 19 October, a card due that day is due today, and its date is the 19th', async () => {
		// `new Date('2026-10-19')` is midnight UTC, 20:00 on the 18th in New York:
		// the badge read "1d overdue", red, and its title "18 Oct 2026".
		await onDayIn('America/New_York', '2026-10-19T15:00:00Z', () => {
			expect(badge('2026-10-19')).toEqual(['today', 'today', 0]);
			expect(badge('2026-10-20')).toEqual(['tomorrow', 'soon', 1]);
			expect(badge('2026-10-18')).toEqual(['1d overdue', 'overdue', -1]);
			expect(formatDueDate('2026-10-19', LONG)).toBe('19 Oct 2026');
			expect(formatDueDate('2026-10-19')).toBe('19 Oct 2026');
		});
	});

	it('east of UTC and in London, the same day reads the same, and Tokyo’s today is its own', async () => {
		await onDayIn('Asia/Tokyo', '2026-10-19T10:00:00Z', () => {
			expect(badge('2026-10-19')).toEqual(['today', 'today', 0]);
			expect(badge('2026-10-20')).toEqual(['tomorrow', 'soon', 1]);
			expect(badge('2026-10-18')).toEqual(['1d overdue', 'overdue', -1]);
			expect(formatDueDate('2026-10-19', LONG)).toBe('19 Oct 2026');
		});
		// 01:00 on the 20th in Tokyo, still the 19th in UTC: Tokyo is a day on.
		await onDayIn('Asia/Tokyo', '2026-10-19T16:00:00Z', () => {
			expect(badge('2026-10-20')).toEqual(['today', 'today', 0]);
			expect(badge('2026-10-19')).toEqual(['1d overdue', 'overdue', -1]);
		});
		await onDayIn('Europe/London', '2026-10-19T15:00:00Z', () => {
			expect(badge('2026-10-19')).toEqual(['today', 'today', 0]);
			expect(badge('2026-10-20')).toEqual(['tomorrow', 'soon', 1]);
			expect(badge('2026-10-18')).toEqual(['1d overdue', 'overdue', -1]);
			expect(formatDueDate('2026-10-19', LONG)).toBe('19 Oct 2026');
		});
	});

	it('across the October clock change in London, a 25-hour day counts once', async () => {
		// The clocks go back on Sunday 25 October 2026. Counted in hours over
		// local midnights, the 26th was "in 3d" and lost its "soon" colour.
		await onDayIn('Europe/London', '2026-10-24T12:00:00Z', () => {
			expect(badge('2026-10-25')).toEqual(['tomorrow', 'soon', 1]);
			expect(badge('2026-10-26')).toEqual(['in 2d', 'soon', 2]);
			expect(badge('2026-10-27')).toEqual(['in 3d', null, 3]);
		});
		// And the 23-hour day in March, which the old count happened to get right.
		await onDayIn('Europe/London', '2026-03-28T12:00:00Z', () => {
			expect(badge('2026-03-30')).toEqual(['in 2d', 'soon', 2]);
		});
	});

	it('reads the stored YYYY-MM-DD and nothing else: anything that is not a day has no count and no colour', () => {
		expect(dueDay('2026-10-19')).toEqual({ year: 2026, month: 10, day: 19 });
		// A time after the day (an older row) is read as that day, as
		// dueDateToCopy also accepts one.
		expect(dueDay('2026-10-19 08:00:00')).toEqual({ year: 2026, month: 10, day: 19 });
		expect(dueDay('2026-10-14T09:00:00Z')).toEqual({ year: 2026, month: 10, day: 14 });
		// A trailing digit makes it not a day, and so does a year below 1000,
		// which `Date.UTC` reads as 1900 and on (0024 as 1924), and which no date
		// input writes.
		for (const value of ['', 'soon', '19/10/2026', '2026-1-9', '2026-02-30', '2026-13-01', '2026-10-199', '0024-03-01']) {
			expect(dueDay(value), value).toBeNull();
			expect(daysUntilDue(value), value).toBeNull();
			expect(getDueStatus(value), value).toBeNull();
			// Shown as it is, as All To Do's title always did.
			expect(formatDueDate(value), value).toBe(value);
		}
		// A leap day is a day.
		expect(dueDay('2028-02-29')).toEqual({ year: 2028, month: 2, day: 29 });
	});

	it('getDueRelative, getDueStatus and daysUntilDue read the day without the Date constructor', () => {
		const utils = sourceOf('src/lib/utils/date-utils.ts');
		for (const name of ['getDueRelative', 'getDueStatus', 'daysUntilDue']) {
			const body = bodyOf(utils, name);
			expect(body, name).not.toMatch(/new Date\(\s*[^)\s]/);
			expect(body, name).not.toContain('setHours');
		}
		expect(bodyOf(utils, 'getDueRelative')).toContain('daysUntilDue(');
		expect(bodyOf(utils, 'getDueStatus')).toContain('daysUntilDue(');
		expect(bodyOf(utils, 'formatDueDate')).toContain("timeZone: 'UTC'");
	});

	it('every page shows a due date through the one helper: badges, the card window, the dashboard and All To Do', () => {
		for (const file of ['src/routes/all/+page.svelte', 'src/routes/board/[id]/+page.svelte', 'src/lib/components/board/CardListRow.svelte', 'src/routes/todo/+page.svelte']) {
			expect(sourceOf(file), file).toContain('title="Due {formatDueDate(card.dueDate)}"');
		}
		// The card window: a subtask is overdue from the day after its due day.
		const modal = sourceOf('src/lib/components/CardModal.svelte');
		expect(modal).not.toContain('new Date(subtask.dueDate)');
		expect(modal).toContain('class:overdue={(daysUntilDue(subtask.dueDate) ?? 0) < 0}');
		const formatDue = bodyOf(modal, 'formatDue');
		expect(formatDue).toContain('daysUntilDue(d)');
		expect(formatDue).toContain('formatDueDate(d, ');
		expect(formatDue).not.toMatch(/new Date\(/);
		// The dashboard's own counters, renamed so that they do not hide the helper.
		const dashboard = sourceOf('src/routes/+page.svelte');
		expect(dashboard).not.toMatch(/function (daysUntilDue|formatDueDate)\(/);
		expect(dashboard).not.toContain('new Date(dateStr');
		expect(bodyOf(dashboard, 'dueText')).toContain('daysUntilDue(');
		expect(bodyOf(dashboard, 'deadlineDays')).toContain('daysUntilDue(');
		expect(dashboard).toContain('formatDueDate(dl.dueDate, ');
		// Upcoming Deadlines is chosen by the server's day, so a deadline it calls
		// today can already be yesterday for the viewer: that reads as overdue, in
		// dueText's words, and only the day itself reads "Today".
		const dueLabel = bodyOf(dashboard, 'dueLabel');
		expect(dueLabel).toContain('if (d < 0) return `${-d}d overdue`;');
		expect(dueLabel).toContain("if (d === 0) return 'Today';");
		expect(dueLabel).not.toContain('d <= 0');
	});
});
