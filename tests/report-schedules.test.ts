/**
 * A report schedule is sent once, at the time it shows, in its own time zone
 * (cards 2144 and 2159).
 *
 * The scheduler sent a due schedule's report first and worked out its next run
 * after: a time it could not read was sent at every minute's tick, a weekly day
 * of -2 gave a next run in the past and did the same, and a run slower than a
 * minute was sent again by the next tick. A schedule's time was set with
 * `setHours` on the server's clock, so 09:00 was 10:00 all summer on a server
 * on UTC, and changing a schedule's time, or turning it back on, left its next
 * run where it was.
 *
 * Now each schedule holds its zone (`time_zone`, migration 0058), and
 * `nextRunAfter` in `$lib/report-schedule-time` works out every run in it, from
 * now. The scheduler works the next run out first: a schedule it cannot date is
 * switched off with one ERROR line and sends nothing; one with no next run is
 * given one and sends nothing; any other is claimed by one conditional write
 * before its report is built, so two runs cannot both send it. The routes date
 * a schedule with the same function, and a `PUT` that turns one on or re-times
 * it works the next run out again.
 *
 * The zone answers are checked with the process's own zone set to three
 * different zones in turn: the server's zone must not matter. The mail server
 * is the recording transport of `effects()`. Nothing leaves.
 */
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { readFileSync } from 'node:fs';
import { join } from 'node:path';
import { eq } from 'drizzle-orm';
import { db, sqlite } from '$lib/server/db';
import { reportSchedules } from '$lib/server/db/schema';
import { EXPECTED_SCHEMA } from '$lib/server/db/expected-schema';
import type { SessionUser } from '$lib/server/auth';
import { resetAllRateLimits } from '$lib/server/rate-limit';
import { claimScheduleRun, getPeriodForSchedule, initReportScheduler, runDueReportSchedules } from '$lib/server/reports';
import {
	canonicalTimeZone,
	DEFAULT_SCHEDULE_TIME_ZONE,
	nextRunAfter,
	type ScheduleTiming
} from '$lib/report-schedule-time';
import { stamp } from '$lib/timestamps';
import { api } from './helpers/api';
import { effects, type Effects } from './helpers/effects';
import { makeBoard, makeSmtp, makeUser, resetDb, type BoardFixture } from './helpers/fixtures';

/** The process zones every zone answer is checked under. */
const PROCESS_ZONES = ['UTC', 'Europe/London', 'America/New_York'];

/** Run `body` with the process's zone set to each of `PROCESS_ZONES`, and put it back. */
async function underEachProcessZone(body: (zone: string) => void | Promise<void>): Promise<void> {
	const was = process.env.TZ;
	try {
		for (const zone of PROCESS_ZONES) {
			process.env.TZ = zone;
			await body(zone);
		}
	} finally {
		if (was === undefined) delete process.env.TZ;
		else process.env.TZ = was;
	}
}

const weekly = (dayOfWeek: unknown, timeOfDay: unknown, timeZone: unknown = 'Europe/London'): ScheduleTiming => ({
	frequency: 'weekly',
	dayOfWeek,
	dayOfMonth: 1,
	timeOfDay,
	timeZone
});

const monthly = (dayOfMonth: unknown, timeOfDay: unknown, timeZone: unknown = 'Europe/London'): ScheduleTiming => ({
	frequency: 'monthly',
	dayOfWeek: 1,
	dayOfMonth,
	timeOfDay,
	timeZone
});

/** The next run after `from`, as ISO to the minute, or the fault. */
function next(timing: ScheduleTiming, from: string): string {
	const found = nextRunAfter(timing, new Date(from));
	return 'at' in found ? found.at.toISOString().slice(0, 16) : found.fault;
}

// ─── nextRunAfter ────────────────────────────────────────────────────────────

describe('nextRunAfter, the next run in the schedule’s own zone', () => {
	/** Each: the timing, from when, and the run expected (UTC, to the minute). */
	const CASES: [string, ScheduleTiming, string, string][] = [
		// 1. British summer time.
		['weekly Monday 09:00 London, in BST', weekly(1, '09:00'), '2026-10-14T06:00:00Z', '2026-10-19T08:00'],
		// 2. Across the autumn change, and from a run, worked out afresh: not seven days on.
		['across the autumn change', weekly(1, '09:00'), '2026-10-24T12:00:00Z', '2026-10-26T09:00'],
		['from the run of 19 October', weekly(1, '09:00'), '2026-10-19T08:00:30Z', '2026-10-26T09:00'],
		// 3. Across the spring change.
		['across the spring change', weekly(1, '09:00'), '2027-03-27T12:00:00Z', '2027-03-29T08:00'],
		// 4. A time that does not exist is an hour later by the clock; one that happens twice is sent once, at the first.
		['01:30 on the day the clocks go forward', weekly(0, '01:30'), '2027-03-27T12:00:00Z', '2027-03-28T01:30'],
		['01:30 on the day the clocks go back', weekly(0, '01:30'), '2026-10-24T12:00:00Z', '2026-10-25T00:30'],
		['01:30 again, from just after its first', weekly(0, '01:30'), '2026-10-25T00:30:30Z', '2026-11-01T01:30'],
		// 6. Monthly.
		['monthly day 31, read as 28, an empty time read as 09:00', monthly(31, ''), '2026-10-14T06:00:00Z', '2026-10-28T09:00'],
		['monthly day 1, from mid-December', monthly(1, '09:00'), '2026-12-15T00:00:00Z', '2027-01-01T09:00'],
		// 7. Other zones: New York, Lord Howe (clocks move by half an hour), and
		// three whose clocks change at local midnight (the review's R2).
		['weekly Wednesday 09:00 New York', weekly(3, '09:00', 'America/New_York'), '2026-11-01T12:00:00Z', '2026-11-04T14:00'],
		['weekly Monday 09:00 Lord Howe', weekly(1, '09:00', 'Australia/Lord_Howe'), '2026-10-03T00:00:00Z', '2026-10-04T22:00'],
		['Santiago Sunday 00:30, skipped at midnight', weekly(0, '00:30', 'America/Santiago'), '2026-09-05T12:00:00Z', '2026-09-06T04:30'],
		['Santiago Saturday 23:30, twice', weekly(6, '23:30', 'America/Santiago'), '2027-04-03T12:00:00Z', '2027-04-04T02:30'],
		['Santiago Saturday 23:30, from just after its first', weekly(6, '23:30', 'America/Santiago'), '2027-04-04T02:30:30Z', '2027-04-11T03:30'],
		['Cairo Thursday 23:30, twice', weekly(4, '23:30', 'Africa/Cairo'), '2026-10-29T12:00:00Z', '2026-10-29T20:30'],
		['Cairo Thursday 23:30, from just after its first', weekly(4, '23:30', 'Africa/Cairo'), '2026-10-29T20:30:30Z', '2026-11-05T21:30']
	];

	// 5. The same answers whatever zone the server runs in.
	it('gives each run, whatever zone the server process runs in', async () => {
		await underEachProcessZone((zone) => {
			for (const [said, timing, from, expected] of CASES) expect(next(timing, from), `${said}, process in ${zone}`).toBe(expected);
		});
	});

	// 8. Each fault names its field and its value.
	it('names the field and the value it cannot use', () => {
		const from = '2026-10-17T12:00:00Z';
		for (const time of ['9', '24:00', '9:5']) {
			expect(next(weekly(1, time), from)).toBe(`its time of day "${time}" is not a time from 00:00 to 23:59`);
		}
		for (const day of [-2, 7, 1.5]) {
			expect(next(weekly(day, '09:00'), from)).toBe(`its day of the week ${day} is not a whole number from 0 (Sunday) to 6 (Saturday)`);
		}
		expect(next(weekly('1', '09:00'), from)).toBe('its day of the week "1" is not a whole number from 0 (Sunday) to 6 (Saturday)');
		expect(next(monthly(0, '09:00'), from)).toBe('its day of the month 0 is not a whole number of 1 or more');
		expect(next({ ...weekly(1, '09:00'), frequency: 'daily' }, from)).toBe('its frequency "daily" is not weekly or monthly');
		expect(next(weekly(1, '09:00', 'Mars/Base'), from)).toBe('its time zone "Mars/Base" is not one this server knows');
	});

	// 9. A zone, as the server names it.
	it('takes a zone the server knows, by the name it gives it, and nothing else', () => {
		expect(canonicalTimeZone('europe/london')).toBe('Europe/London');
		expect(canonicalTimeZone('Etc/UTC')).toBe('UTC');
		expect(canonicalTimeZone('Etc/GMT+1')).toBe('Etc/GMT+1');
		for (const value of ['Mars/Base', 5, '', 'E'.repeat(65), '+01:00', '-05:00', null]) {
			expect(canonicalTimeZone(value), JSON.stringify(value)).toBeNull();
		}
		// Node reads an offset written with the minus sign U+2212 as `-01:00`
		// (the review's S-S2): the name it hands back is checked as well.
		for (const value of ['\u221201:00', '\u22120100', '\u221201']) {
			expect(canonicalTimeZone(value), JSON.stringify(value)).toBeNull();
		}
	});

	// The review's S-N5: a fault is written in the ERROR line, the 400 and the page.
	it('names at most 80 characters of a stored value, and says it was cut', () => {
		const from = '2026-10-17T12:00:00Z';
		expect(next(weekly(1, 'x'.repeat(5000)), from)).toBe(`its time of day "${'x'.repeat(80)}…" is not a time from 00:00 to 23:59`);
		expect(next(weekly(1, 'x'.repeat(80)), from)).toBe(`its time of day "${'x'.repeat(80)}" is not a time from 00:00 to 23:59`);
		expect(next(weekly(1, '09:00', 'Z'.repeat(81)), from)).toBe(`its time zone "${'Z'.repeat(80)}…" is not one this server knows`);
	});

	it('is the same literal for a schedule with no zone in the routes, the model and migration 0058', () => {
		expect(DEFAULT_SCHEDULE_TIME_ZONE).toBe('UTC');
		const migration = readFileSync(join(process.cwd(), 'drizzle', '0058_add_report_schedule_time_zone.sql'), 'utf-8');
		expect(migration).toContain(`ADD COLUMN \`time_zone\` text DEFAULT '${DEFAULT_SCHEDULE_TIME_ZONE}' NOT NULL;`);
		const table = EXPECTED_SCHEMA.find((statement) => statement.startsWith('CREATE TABLE `report_schedules`')) ?? '';
		expect(table).toContain(`\`time_zone\` text DEFAULT '${DEFAULT_SCHEDULE_TIME_ZONE}' NOT NULL`);
	});
});

// ─── The scheduler ───────────────────────────────────────────────────────────

let owner: SessionUser;
let A: BoardFixture;
let sent: Effects;

beforeEach(() => {
	resetDb();
	resetAllRateLimits();
	makeSmtp();
	owner = makeUser();
	A = makeBoard({ owner, name: 'Sales' });
	sent = effects();
});

afterEach(() => {
	sent.restore();
	resetAllRateLimits();
	vi.useRealTimers();
	vi.restoreAllMocks();
});

/** A schedule of `owner`'s on board A, written straight to the table, due long ago unless said. */
function stored(values: Partial<typeof reportSchedules.$inferInsert> = {}): number {
	return db
		.insert(reportSchedules)
		.values({
			userId: owner.id,
			name: 'Weekly',
			scope: 'board',
			scopeId: A.board.id,
			recipients: 'a@example.test',
			nextRunAt: '2000-01-01 00:00:00',
			...values
		})
		.returning()
		.get().id;
}

const row = (id: number) => db.select().from(reportSchedules).where(eq(reportSchedules.id, id)).get()!;

/** What the image before card 2144 wrote as the next run of a time it could not read. */
const NAN = 'NaN-NaN-NaN NaN:NaN:NaN';

const errorLines = () =>
	sqlite.prepare("SELECT message, user_id AS userId FROM system_logs WHERE context = 'REPORTS' AND level = 'ERROR' ORDER BY id").all() as {
		message: string;
		userId: number | null;
	}[];

describe('the scheduler, runDueReportSchedules', () => {
	// 10.
	it('switches off a schedule whose time it cannot read, says so once, and sends nothing', { timeout: 30_000 }, async () => {
		const id = stored({ name: 'Weekly sales', timeOfDay: '9' });

		await runDueReportSchedules(new Date('2026-10-17T12:00:00Z'));
		await runDueReportSchedules(new Date('2026-10-17T12:01:00Z'));
		await sent.settle();

		expect(sent.all).toEqual([]);
		expect(errorLines()).toEqual([
			{
				message:
					`Report schedule ${id} "Weekly sales", owner "${owner.username}" (user ${owner.id}), was switched off: ` +
					'its time of day "9" is not a time from 00:00 to 23:59, so its next run cannot be worked out. ' +
					'Nothing was sent. Its owner can turn it on again with a time, day and zone that can be read, or delete it and make it again.',
				userId: owner.id
			}
		]);
		expect(row(id)).toMatchObject({ enabled: false, lastRunAt: null, nextRunAt: '2000-01-01 00:00:00', updatedAt: '2026-10-17 12:00:00' });
	});

	// 11.
	it('does the same for a weekly day of -2, which gave a next run in the past', { timeout: 30_000 }, async () => {
		const id = stored({ dayOfWeek: -2 });

		// Saturday.
		await runDueReportSchedules(new Date('2026-10-17T12:00:00Z'));
		await runDueReportSchedules(new Date('2026-10-17T12:01:00Z'));
		await sent.settle();

		expect(sent.all).toEqual([]);
		expect(errorLines().map((line) => line.message)).toEqual([
			expect.stringContaining('was switched off: its day of the week -2 is not a whole number from 0 (Sunday) to 6 (Saturday)')
		]);
		expect(row(id)).toMatchObject({ enabled: false, lastRunAt: null });
	});

	// 12, as the review's R3 has it: two due schedules, two runs.
	it('sends each due schedule once when a second run starts while the first is building its report', { timeout: 30_000 }, async () => {
		const first = stored({ name: 'First', recipients: 'first@example.test' });
		const second = stored({ name: 'Second', recipients: 'second@example.test' });
		const now = new Date('2026-10-17T12:00:00Z');

		// Run A claims the first and waits on its PDF; run B, started then, finds
		// the first claimed, claims the second and sends it; A then reaches the
		// second with the row it selected at its start, claims nothing, and
		// sends nothing.
		const runA = runDueReportSchedules(now);
		expect(row(first).lastRunAt).toBe(stamp(now));
		const runB = runDueReportSchedules(now);
		await Promise.all([runA, runB]);

		expect(sent.emails.map((mail) => mail.to).sort()).toEqual(['first@example.test', 'second@example.test']);
		for (const id of [first, second]) {
			// Monday 09:00 UTC, the default zone, after Saturday noon.
			expect(row(id)).toMatchObject({ lastRunAt: '2026-10-17 12:00:00', nextRunAt: '2026-10-19 09:00:00' });
		}
	});

	it('claims nothing with a row another run has claimed since it was read', () => {
		const id = stored();
		const now = new Date('2026-10-17T12:00:00Z');
		const later = new Date('2026-10-19T09:00:00Z');

		expect(claimScheduleRun(id, now, later)).toMatchObject({ id, lastRunAt: '2026-10-17 12:00:00', nextRunAt: '2026-10-19 09:00:00' });
		// The same claim again, as a run holding the row it read before: no row changes.
		expect(claimScheduleRun(id, now, later)).toBeUndefined();
		// Nor for a schedule switched off.
		const off = stored({ enabled: false });
		expect(claimScheduleRun(off, now, later)).toBeUndefined();
		expect(row(off).lastRunAt).toBeNull();
	});

	// 13.
	it('gives a schedule with no next run its first, and sends nothing', { timeout: 30_000 }, async () => {
		const id = stored({ nextRunAt: null, timeZone: 'Europe/London' });

		await runDueReportSchedules(new Date('2026-10-14T06:00:00Z'));
		await sent.settle();

		expect(sent.all).toEqual([]);
		expect(row(id)).toMatchObject({ enabled: true, lastRunAt: null, nextRunAt: '2026-10-19 08:00:00' });
	});

	// 15.
	it('runs a schedule in Europe/London at its moment, and not a second before', { timeout: 30_000 }, async () => {
		const id = stored({ timeZone: 'Europe/London', nextRunAt: '2026-10-19 08:00:00' });

		await runDueReportSchedules(new Date('2026-10-19T07:59:59Z'));
		await sent.settle();
		expect(sent.emails).toEqual([]);

		await runDueReportSchedules(new Date('2026-10-19T08:00:00Z'));
		expect(sent.emails.map((mail) => mail.to)).toEqual(['a@example.test']);
		// Next Monday, after the clocks go back: 09:00 GMT.
		expect(row(id)).toMatchObject({ lastRunAt: '2026-10-19 08:00:00', nextRunAt: '2026-10-26 09:00:00' });
	});

	// The review's O-S1: the image before card 2144 wrote this for a time it
	// could not read. Compared as text it is after every moment, so it was
	// never due: neither sent nor switched off, and named at every start.
	it('reads a next run it cannot read as none: switches the schedule off, says so once, and clears the value', { timeout: 30_000 }, async () => {
		const id = stored({ name: 'Weekly sales', timeOfDay: '9', nextRunAt: NAN });

		await runDueReportSchedules(new Date('2026-10-17T12:00:00Z'));
		await runDueReportSchedules(new Date('2026-10-17T12:01:00Z'));
		await sent.settle();

		expect(sent.all).toEqual([]);
		expect(errorLines()).toEqual([
			{
				message: expect.stringContaining(
					`Report schedule ${id} "Weekly sales", owner "${owner.username}" (user ${owner.id}), was switched off: its time of day "9"`
				),
				userId: owner.id
			}
		]);
		expect(row(id)).toMatchObject({ enabled: false, lastRunAt: null, nextRunAt: null });
	});

	it('gives a schedule it can date, whose next run it cannot read, its first run, and sends nothing', { timeout: 30_000 }, async () => {
		const id = stored({ nextRunAt: NAN, timeZone: 'UTC' });

		await runDueReportSchedules(new Date('2026-10-17T12:00:00Z'));
		await sent.settle();

		expect(sent.all).toEqual([]);
		// Monday 09:00 UTC, after Saturday noon.
		expect(row(id)).toMatchObject({ enabled: true, lastRunAt: null, nextRunAt: '2026-10-19 09:00:00' });
	});

	// The review's O-N4: the claim was made, so the schedule waits for its next run.
	it('says a run that failed after its claim is not sent again before its next run', { timeout: 30_000 }, async () => {
		stored({ name: 'Weekly sales' });
		// The first read is of the schedules due; the second, of the owner, comes after the claim.
		const select = db.select.bind(db);
		let reads = 0;
		vi.spyOn(db, 'select').mockImplementation(((...args: Parameters<typeof db.select>) => {
			reads += 1;
			if (reads === 2) throw new Error('The database went away');
			return select(...args);
		}) as typeof db.select);

		await runDueReportSchedules(new Date('2026-10-17T12:00:00Z'));
		vi.restoreAllMocks();
		await sent.settle();

		expect(sent.all).toEqual([]);
		expect(errorLines().map((line) => line.message)).toEqual([
			'Failed to run scheduled report "Weekly sales". It is not sent again before its next run.'
		]);
	});
});

// The review's O-S4.
describe('getPeriodForSchedule, the days a scheduled report covers', () => {
	it('starts at the same time by the schedule’s clock periodDays earlier, across a clock change, whatever zone the server runs in', async () => {
		await underEachProcessZone((zone) => {
			// Monday 26 October 2026, 09:00:30 GMT, after the UK's clocks went back: from Monday 19 October, 09:00:30 BST.
			expect(getPeriodForSchedule({ periodDays: 7, timeZone: 'Europe/London' }, new Date('2026-10-26T09:00:30Z')), zone).toEqual({
				start: '2026-10-19 08:00:30',
				end: '2026-10-26 09:00:30'
			});
			// Monday 5 October 2026, 09:00 AEDT, after Sydney's clocks went forward: from Monday 28 September, 09:00 AEST.
			expect(getPeriodForSchedule({ periodDays: 7, timeZone: 'Australia/Sydney' }, new Date('2026-10-04T22:00:00Z')), zone).toEqual({
				start: '2026-09-27 23:00:00',
				end: '2026-10-04 22:00:00'
			});
		});
	});

	it('writes the period in the mail in the schedule’s zone', { timeout: 30_000 }, async () => {
		const was = process.env.TZ;
		process.env.TZ = 'UTC';
		try {
			// Monday 5 October 2026, 09:00 in Sydney, is still 4 October in UTC.
			stored({ timeZone: 'Australia/Sydney', dayOfWeek: 1, timeOfDay: '09:00', periodDays: 3, nextRunAt: '2026-10-04 22:00:00' });

			await runDueReportSchedules(new Date('2026-10-04T22:00:00Z'));

			expect(sent.emails).toHaveLength(1);
			expect(sent.emails[0].html).toContain('Period: 2 Oct 2026 - 5 Oct 2026');
		} finally {
			if (was === undefined) delete process.env.TZ;
			else process.env.TZ = was;
		}
	});
});

describe('initReportScheduler, as the server starts', () => {
	// 14.
	it('never throws: dates a schedule with no next run, and switches off one it cannot date, once', () => {
		vi.useFakeTimers({ toFake: ['setInterval', 'clearInterval'] });
		const unreadable = stored({ name: 'Unreadable', nextRunAt: null, timeOfDay: '9' });
		const fine = stored({ name: 'Fine', nextRunAt: null });

		expect(() => initReportScheduler()).not.toThrow();

		expect(row(unreadable)).toMatchObject({ enabled: false, nextRunAt: null, lastRunAt: null });
		expect(row(fine).nextRunAt).toMatch(/^\d{4}-\d{2}-\d{2} 09:00:00$/);
		expect(errorLines().map((line) => line.message)).toEqual([
			expect.stringContaining(`Report schedule ${unreadable} "Unreadable", owner "${owner.username}" (user ${owner.id}), was switched off: its time of day "9"`)
		]);

		// The next start meets it again, switched off with no next run, and says nothing more.
		expect(() => initReportScheduler()).not.toThrow();
		expect(errorLines()).toHaveLength(1);
	});

	// The review's O-S1.
	it('reads a next run it cannot read as none, enabled or not, and clears it where it cannot date the schedule', () => {
		vi.useFakeTimers({ toFake: ['setInterval', 'clearInterval', 'Date'] });
		// Saturday noon.
		vi.setSystemTime(new Date('2026-10-17T12:00:00Z'));
		const unreadable = stored({ name: 'Unreadable', timeOfDay: '9', timeZone: 'UTC', nextRunAt: NAN });
		const off = stored({ name: 'Off', timeOfDay: '9', timeZone: 'UTC', enabled: false, nextRunAt: NAN });
		const fine = stored({ name: 'Fine', timeZone: 'UTC', nextRunAt: NAN });

		expect(() => initReportScheduler()).not.toThrow();

		expect(row(unreadable)).toMatchObject({ enabled: false, nextRunAt: null });
		expect(row(off)).toMatchObject({ enabled: false, nextRunAt: null });
		expect(row(fine)).toMatchObject({ enabled: true, nextRunAt: '2026-10-19 09:00:00' });
		// One line, for the one this start switched off.
		expect(errorLines().map((line) => line.message)).toEqual([expect.stringContaining(`Report schedule ${unreadable} "Unreadable"`)]);
	});
});

// ─── The routes ──────────────────────────────────────────────────────────────

const make = (body: Record<string, unknown> = {}) =>
	api('POST', '/api/report-schedules', {
		user: owner,
		body: { name: 'Weekly', scope: 'board', scopeId: A.board.id, frequency: 'weekly', dayOfWeek: 4, timeOfDay: '09:00', ...body }
	});

const change = (id: number, body: Record<string, unknown>) => api('PUT', `/api/report-schedules/${id}`, { user: owner, body });

describe('POST /api/report-schedules, in the schedule’s zone', () => {
	beforeEach(() => {
		vi.useFakeTimers({ toFake: ['Date'] });
		// Wednesday, in British summer time.
		vi.setSystemTime(new Date('2026-10-14T06:00:00Z'));
	});

	// 16.
	it('reads Thursday 09:00 in the zone sent, whatever zone the server runs in', async () => {
		await underEachProcessZone(async (zone) => {
			const made = await make({ timeZone: 'Europe/London' });
			expect(made.status, zone).toBe(201);
			expect(made.body).toMatchObject({ timeZone: 'Europe/London', nextRunAt: '2026-10-15 08:00:00' });
			db.delete(reportSchedules).run();
		});
	});

	// 17.
	it('reads it in UTC when no zone is sent', async () => {
		const made = await make();

		expect(made.status).toBe(201);
		expect(made.body).toMatchObject({ timeZone: 'UTC', nextRunAt: '2026-10-15 09:00:00' });
	});

	// 18.
	it('stores a zone by the name the server gives it, and refuses one it does not know', async () => {
		const made = await make({ timeZone: 'europe/london' });
		expect(made.body.timeZone).toBe('Europe/London');

		for (const timeZone of ['Mars/Base', 5, '', '+01:00']) {
			const refused = await make({ timeZone });
			expect(refused.status, JSON.stringify(timeZone)).toBe(400);
		}
		expect((await make({ timeOfDay: '9' })).status).toBe(400);
		expect(db.select().from(reportSchedules).all()).toHaveLength(1);
	});
});

describe('PUT /api/report-schedules/[id], when the next run moves', () => {
	beforeEach(() => {
		vi.useFakeTimers({ toFake: ['Date'] });
		vi.setSystemTime(new Date('2026-10-14T06:00:00Z'));
	});

	// 19.
	it('works the next run out again for a new zone or time, and leaves it for a new name', async () => {
		const id = (await make({ timeZone: 'Europe/London' })).body.id as number;
		expect(row(id).nextRunAt).toBe('2026-10-15 08:00:00');

		// The same zone, spelt another way, is no change.
		expect((await change(id, { timeZone: 'europe/london' })).body.nextRunAt).toBe('2026-10-15 08:00:00');
		expect((await change(id, { timeZone: 'America/New_York' })).body).toMatchObject({
			timeZone: 'America/New_York',
			nextRunAt: '2026-10-15 13:00:00'
		});
		expect((await change(id, { timeOfDay: '17:30' })).body.nextRunAt).toBe('2026-10-15 21:30:00');
		expect((await change(id, { name: 'Renamed' })).body).toMatchObject({ name: 'Renamed', nextRunAt: '2026-10-15 21:30:00' });
	});

	// 20.
	it('gives a schedule turned back on its coming run, and sends nothing for the one missed while it was off', { timeout: 30_000 }, async () => {
		const id = (await make({ timeZone: 'Europe/London' })).body.id as number;
		expect((await change(id, { enabled: false })).status).toBe(200);

		// A week on, past the run it missed (Thursday 15 October).
		vi.setSystemTime(new Date('2026-10-21T12:00:00Z'));
		const on = await change(id, { enabled: true });

		expect(on.status).toBe(200);
		expect(on.body).toMatchObject({ enabled: true, nextRunAt: '2026-10-22 08:00:00' });
		await runDueReportSchedules(new Date());
		await sent.settle();
		expect(sent.emails).toEqual([]);
	});

	// 21.
	it('refuses to turn on a schedule switched off because it cannot be dated, and it stays off', { timeout: 30_000 }, async () => {
		const id = stored({ timeOfDay: '9' });
		await runDueReportSchedules(new Date());
		expect(row(id).enabled).toBe(false);

		const on = await change(id, { enabled: true });

		expect(on.status).toBe(400);
		expect(on.body.message).toBe(
			'This schedule cannot be turned on: its time of day "9" is not a time from 00:00 to 23:59. ' +
				'Turn it on with a time, day and zone that can be read, or delete it and make it again.'
		);
		expect(row(id).enabled).toBe(false);

		// The review's S-N3: sent a time that can be read, it is turned on again.
		const mended = await change(id, { enabled: true, timeOfDay: '10:00' });
		expect(mended.status).toBe(200);
		// Monday (the default day) at 10:00 UTC, from Wednesday 14 October.
		expect(mended.body).toMatchObject({ enabled: true, timeOfDay: '10:00', nextRunAt: '2026-10-19 10:00:00' });
	});

	// The review's O-N1.
	it('keeps the day’s run when only the zone changes and the time is still to come in the new zone', async () => {
		// Thursday, 07:00 in London.
		vi.setSystemTime(new Date('2026-10-15T06:00:00Z'));
		const id = (await make({ timeZone: 'Europe/London' })).body.id as number;
		expect(row(id).nextRunAt).toBe('2026-10-15 08:00:00');

		// 09:00 in New York is still to come today: today's run, not next week's.
		expect((await change(id, { timeZone: 'America/New_York' })).body.nextRunAt).toBe('2026-10-15 13:00:00');
		// 09:00 in Tokyo has gone (00:00 UTC): next week's.
		expect((await change(id, { timeZone: 'Asia/Tokyo' })).body.nextRunAt).toBe('2026-10-22 00:00:00');
	});

	// The review's O-N2 and S-S1.
	it('takes nothing from the day’s report mail for a schedule re-timed while it is off', async () => {
		const tenFrom = (first: number) => Array.from({ length: 10 }, (_, i) => `r${first + i}@example.test`).join(', ');
		const ids: number[] = [];
		for (let n = 0; n < 10; n++) {
			const made = await make({ recipients: tenFrom(n * 10) });
			expect(made.status, `schedule ${n + 1}`).toBe(201);
			ids.push(made.body.id as number);
		}
		// The day's 100 are taken.
		expect((await change(ids[0], { enabled: false })).status).toBe(200);

		// Off, a new time or zone brings nothing forward.
		const retimed = await change(ids[0], { timeOfDay: '10:30', timeZone: 'America/New_York' });
		expect(retimed.status, JSON.stringify(retimed.body)).toBe(200);
		expect(retimed.body).toMatchObject({ enabled: false, timeOfDay: '10:30', timeZone: 'America/New_York' });

		// On, either can bring a send forward, and is refused.
		expect((await change(ids[0], { enabled: true })).status).toBe(429);
		expect((await change(ids[1], { timeOfDay: '10:30' })).status).toBe(429);
	});
});

// ─── The Reports page ────────────────────────────────────────────────────────

describe('the Reports page’s schedules', () => {
	const page = readFileSync(join(process.cwd(), 'src', 'routes', 'reports', '+page.svelte'), 'utf-8');

	// The review's O-S3, O-N2 and S-S1.
	it('offers Use my time zone only to a schedule it can date, says what it does, and gives Next in the viewer’s time too', () => {
		expect(page).toContain('{#if !fault && inAnotherZone(schedule.timeZone)}');
		expect(page).toMatch(/<span class="zone-hint">[^<]*works its next run out again[^<]*<\/span>/);
		expect(page).toContain('Next: {formatDateTime(schedule.nextRunAt, schedule.timeZone)}{viewerTime(schedule.nextRunAt, schedule.timeZone)}');
		expect(page).toContain('your time)');
	});
});
