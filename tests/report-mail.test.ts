/**
 * An emailed report is said to be sent only when it was (card 2113).
 *
 * `POST /api/reports/email` answered 200, "Report sent to N recipient(s)",
 * whatever `sendEmailWithAttachment` returned: with no mail set up, and when
 * the mail server refused every address. The scheduled report logged
 * "emailed ... to N recipient(s)" the same way, and a schedule that produced
 * no report at all logged nothing.
 *
 * Now the route answers 503 with no mail set up, before the PDF is built;
 * 200 when the report went to at least one recipient, with a message naming
 * the others; and 502 when it went to none. The scheduler logs one WARN line
 * when every recipient had it, one ERROR line naming each address it did not
 * reach, and a WARN line for a schedule that produced no report. Its timer
 * skips a tick while the last run is still going
 * (`runDueReportSchedulesOnce`), so a run slower than a minute is not
 * overtaken by the next, which found its schedule still due and sent it again.
 *
 * The mail server is the recording transport of `effects()`, told which
 * addresses to refuse with `refuseMailTo`. Nothing leaves.
 */
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import PDFDocument from 'pdfkit';
import { eq } from 'drizzle-orm';
import { db, sqlite } from '$lib/server/db';
import { boardCategories, boards, reportSchedules } from '$lib/server/db/schema';
import type { SessionUser } from '$lib/server/auth';
import { runDueReportSchedules, runDueReportSchedulesOnce } from '$lib/server/reports';
import { stamp } from '$lib/timestamps';
import { api } from './helpers/api';
import { effects, type Effects } from './helpers/effects';
import { makeBoard, makeSmtp, makeUser, resetDb, type BoardFixture } from './helpers/fixtures';
import { expectUnchanged, snapshotDb } from './helpers/snapshot';

/** What the answer says of a recipient the mail server refused. */
const REFUSED = 'The mail server did not accept it. An administrator can see the reason in the system log.';

let owner: SessionUser;
let A: BoardFixture;
let sent: Effects | null = null;

beforeEach(() => {
	resetDb();
	owner = makeUser();
	A = makeBoard({ owner, name: 'Sales' });
});

afterEach(() => {
	sent?.restore();
	sent = null;
	vi.restoreAllMocks();
});

/** Install the recording transport, refusing mail to `refuse`. */
function mailServer(refuse: string[] = []): Effects {
	sent = effects({ refuseMailTo: refuse });
	return sent;
}

const email = (recipients: string[]) =>
	api('POST', '/api/reports/email', {
		user: owner,
		body: { scope: 'board', scopeId: A.board.id, periodStart: '2026-10-01', periodEnd: '2026-10-08', recipients }
	});

describe('POST /api/reports/email', () => {
	it('answers 200 when every recipient was sent the report', { timeout: 30_000 }, async () => {
		makeSmtp();
		const mail = mailServer();

		const res = await email(['a@example.test', 'b@example.test']);

		expect(res.status).toBe(200);
		expect(res.body).toEqual({
			message: 'Report sent to 2 recipient(s)',
			results: [
				{ email: 'a@example.test', success: true },
				{ email: 'b@example.test', success: true }
			]
		});
		expect(mail.emails.map((m) => m.to)).toEqual(['a@example.test', 'b@example.test']);
	});

	it('answers 200 for a report that reached some, naming the address it did not reach', { timeout: 30_000 }, async () => {
		makeSmtp();
		const mail = mailServer(['b@example.test']);

		const res = await email(['a@example.test', 'b@example.test']);

		// Not a failure status: the page would offer to send it again, and
		// a@example.test would have it twice. The page reads `results`, and
		// leaves only b@example.test in the box to be sent again.
		expect(res.status).toBe(200);
		expect(res.body).toEqual({
			message: `Report sent to 1 of 2 recipients. Not sent to b@example.test. ${REFUSED}`,
			results: [
				{ email: 'a@example.test', success: true },
				{ email: 'b@example.test', success: false, message: REFUSED }
			]
		});
		expect(mail.emails.map((m) => m.to)).toEqual(['a@example.test']);
		expect(mail.refusedMail.map((m) => m.to)).toEqual(['b@example.test']);
	});

	it('answers 502 when the mail server refused every recipient', { timeout: 30_000 }, async () => {
		makeSmtp();
		const mail = mailServer(['a@example.test', 'b@example.test']);

		const res = await email(['a@example.test', 'b@example.test']);

		expect(res.status).toBe(502);
		expect(res.body).toEqual({
			message: `The report was not sent. ${REFUSED}`,
			results: [
				{ email: 'a@example.test', success: false, message: REFUSED },
				{ email: 'b@example.test', success: false, message: REFUSED }
			]
		});
		expect(mail.emails).toEqual([]);
		expect(mail.refusedMail.map((m) => m.to)).toEqual(['a@example.test', 'b@example.test']);
	});

	it('answers 503 with no mail set up, builds no PDF and sends nothing', { timeout: 30_000 }, async () => {
		const mail = mailServer();
		const built = vi.spyOn(PDFDocument.prototype, 'end');
		const before = snapshotDb();

		const res = await email(['a@example.test']);

		expect(res.status).toBe(503);
		expect(res.body).toEqual({
			message: 'Mail is not set up on this server, so the report was not sent. An administrator sets it up on the admin page.'
		});
		expect(built).not.toHaveBeenCalled();
		await mail.settle();
		expect(mail.all).toEqual([]);
		expect(mail.refusedMail).toEqual([]);
		expectUnchanged(before);

		// The same request once mail is set up builds the PDF the watch above would have seen.
		makeSmtp();
		expect((await email(['a@example.test'])).status).toBe(200);
		expect(built).toHaveBeenCalledTimes(1);
	});
});

describe('the scheduled report, runDueReportSchedules', () => {
	let level: string | undefined;
	beforeEach(() => {
		// The suite logs ERROR and above; the WARN lines are what is under test.
		level = process.env.LOG_LEVEL;
		process.env.LOG_LEVEL = 'WARN';
	});
	afterEach(() => {
		if (level === undefined) delete process.env.LOG_LEVEL;
		else process.env.LOG_LEVEL = level;
	});

	/** A schedule of `owner`'s on `scopeId`, due now. */
	function dueSchedule(scopeId: number, recipients: string): number {
		return db
			.insert(reportSchedules)
			.values({ userId: owner.id, name: 'Weekly', scope: 'board', scopeId, recipients, nextRunAt: '2000-01-01 00:00:00' })
			.returning()
			.get().id;
	}

	const linesOf = () =>
		sqlite.prepare("SELECT level, message FROM system_logs WHERE context = 'REPORTS' ORDER BY id").all() as {
			level: string;
			message: string;
		}[];
	const scheduleRow = (id: number) => db.select().from(reportSchedules).where(eq(reportSchedules.id, id)).get()!;

	it('logs one WARN line when every recipient was sent it', { timeout: 30_000 }, async () => {
		makeSmtp();
		const mail = mailServer();
		const id = dueSchedule(A.board.id, 'a@example.test, b@example.test');
		const now = new Date();

		await runDueReportSchedules(now);

		expect(mail.emails.map((m) => m.to)).toEqual(['a@example.test', 'b@example.test']);
		expect(linesOf()).toEqual([{ level: 'WARN', message: 'Scheduled report emailed: "Weekly" to 2 of 2 recipient(s)' }]);
		expect(scheduleRow(id).lastRunAt).toBe(stamp(now));
	});

	it('logs an ERROR line naming the address it did not reach, and moves on to its next run', { timeout: 30_000 }, async () => {
		makeSmtp();
		const mail = mailServer(['b@example.test']);
		const id = dueSchedule(A.board.id, 'a@example.test, b@example.test');
		const now = new Date();

		await runDueReportSchedules(now);

		expect(mail.emails.map((m) => m.to)).toEqual(['a@example.test']);
		expect(mail.refusedMail.map((m) => m.to)).toEqual(['b@example.test']);
		expect(linesOf()).toEqual([
			{
				level: 'ERROR',
				message:
					'Scheduled report "Weekly" was not emailed to b@example.test (1 of 2 recipient(s) reached). ' +
					"The mail server did not accept it: its reason is in the EMAIL line logged for each address. It is not sent again before its next run."
			}
		]);
		// No retry before the next run: a@example.test has it already.
		const row = scheduleRow(id);
		expect(row.lastRunAt).toBe(stamp(now));
		expect(row.nextRunAt! > stamp(now)).toBe(true);
		await runDueReportSchedules(now);
		expect(mail.emails).toHaveLength(1);
	});

	it('says so when mail is not set up, rather than that it was emailed', { timeout: 30_000 }, async () => {
		const mail = mailServer();
		dueSchedule(A.board.id, 'a@example.test');

		await runDueReportSchedules(new Date());

		expect(mail.all).toEqual([]);
		expect(linesOf()).toEqual([
			{
				level: 'ERROR',
				message:
					'Scheduled report "Weekly" was not emailed to a@example.test (0 of 1 recipient(s) reached). ' +
					'Mail is not set up on this server. It is not sent again before its next run.'
			}
		]);
	});

	it('logs a WARN line for a schedule whose board is gone, and sends nothing', async () => {
		makeSmtp();
		const mail = mailServer();
		const id = dueSchedule(9999, 'a@example.test');
		const now = new Date();

		await runDueReportSchedules(now);

		expect(mail.all).toEqual([]);
		expect(linesOf()).toEqual([
			{
				level: 'WARN',
				message:
					'Scheduled report "Weekly" produced no report, so nothing was sent: ' +
					"the board it covers (id 9999) is gone, or the schedule's owner can no longer read it"
			}
		]);
		expect(scheduleRow(id).lastRunAt).toBe(stamp(now));
	});

	it('logs the same for a board its owner can no longer read', async () => {
		makeSmtp();
		const mail = mailServer();
		const theirs = makeBoard({ owner: makeUser() });
		dueSchedule(theirs.board.id, 'a@example.test');

		await runDueReportSchedules(new Date());

		expect(mail.all).toEqual([]);
		expect(linesOf().map((line) => line.level)).toEqual(['WARN']);
		expect(linesOf()[0].message).toContain(`produced no report, so nothing was sent: the board it covers (id ${theirs.board.id})`);
	});

	it('says that a schedule with no board or grouping has none, not that one is gone', async () => {
		makeSmtp();
		const mail = mailServer();
		for (const scope of ['board', 'category']) {
			db.insert(reportSchedules)
				.values({ userId: owner.id, name: scope, scope, scopeId: null, recipients: 'a@example.test', nextRunAt: '2000-01-01 00:00:00' })
				.run();
		}

		await runDueReportSchedules(new Date());

		expect(mail.all).toEqual([]);
		expect(linesOf()).toEqual([
			{ level: 'WARN', message: 'Scheduled report "board" produced no report, so nothing was sent: the schedule has no board' },
			{ level: 'WARN', message: 'Scheduled report "category" produced no report, so nothing was sent: the schedule has no grouping' }
		]);
	});

	it('names every reason a grouping gives no report: gone, empty, or none of its boards readable', async () => {
		makeSmtp();
		const mail = mailServer();
		const grouping = db.insert(boardCategories).values({ name: 'Theirs' }).returning().get();
		const theirs = makeBoard({ owner: makeUser() });
		db.update(boards).set({ categoryId: grouping.id }).where(eq(boards.id, theirs.board.id)).run();
		db.insert(reportSchedules)
			.values({ userId: owner.id, name: 'Grouped', scope: 'category', scopeId: grouping.id, recipients: 'a@example.test', nextRunAt: '2000-01-01 00:00:00' })
			.run();

		await runDueReportSchedules(new Date());

		// The grouping is there; its one board is someone else's.
		expect(mail.all).toEqual([]);
		expect(linesOf()).toEqual([
			{
				level: 'WARN',
				message:
					'Scheduled report "Grouped" produced no report, so nothing was sent: ' +
					`the grouping it covers (id ${grouping.id}) is gone, holds no board, or holds none the schedule's owner can read`
			}
		]);
	});

	it('skips a tick while the last run is still going, so no report is sent twice', { timeout: 30_000 }, async () => {
		makeSmtp();
		const mail = mailServer();
		const id = dueSchedule(A.board.id, 'a@example.test');
		const now = new Date();

		// The first run awaits its PDF. Its schedule's run was claimed before it
		// (card 2144), so a second run would find nothing due; the tick is
		// skipped all the same.
		const first = runDueReportSchedulesOnce(now);
		expect(scheduleRow(id).lastRunAt).toBe(stamp(now));
		expect(await runDueReportSchedulesOnce(now)).toBe(false);
		expect(await first).toBe(true);

		expect(mail.emails.map((m) => m.to)).toEqual(['a@example.test']);
		expect(scheduleRow(id).lastRunAt).toBe(stamp(now));
		// The run is over, so the next tick runs, and finds nothing due.
		expect(await runDueReportSchedulesOnce(now)).toBe(true);
		expect(mail.emails).toHaveLength(1);
	});
});
