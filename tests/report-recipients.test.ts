/**
 * Who a mailed report reaches (card 2182).
 *
 * `POST /api/reports/email` sent a report to any number of addresses, as
 * often as it was asked; a schedule held as many as it was given, and an
 * account as many schedules as it liked. A schedule's list was split on
 * commas only, so one typed with semicolons was one mail to all of them, each
 * in view of the others, and one typed an address to a line reached only the
 * first. Now:
 *
 *   - one reading of a list, `reportRecipients` in `$lib/report-recipients`:
 *     commas, semicolons and white space between addresses, each once, and an
 *     address held to what the mailer sends to that address and no other;
 *   - at most 10 addresses a call and 10 a schedule (400), 20 schedules an
 *     account (409);
 *   - at most 100 addresses a day from one account (429), paid by each report
 *     emailed by hand and by each schedule made, turned on or re-timed, since
 *     each of those can bring a send forward (the plan's R1);
 *   - a schedule kept from before with more than 10 is switched off at its
 *     next run, says why in the log, and sends nothing;
 *   - the scheduled mail names the account that set it up.
 *
 * The mail server is the recording transport of `effects()`. Nothing leaves.
 */
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import PDFDocument from 'pdfkit';
import { eq } from 'drizzle-orm';
import { db, sqlite } from '$lib/server/db';
import { reportSchedules } from '$lib/server/db/schema';
import type { SessionUser } from '$lib/server/auth';
import { MAX_REPORT_RECIPIENTS, reportRecipients } from '$lib/report-recipients';
import { resetAllRateLimits, takeAllowance } from '$lib/server/rate-limit';
import { runDueReportSchedules } from '$lib/server/reports';
import { api } from './helpers/api';
import { effects, type Effects } from './helpers/effects';
import { makeBoard, makeSmtp, makeUser, resetDb, type BoardFixture } from './helpers/fixtures';
import { expectUnchanged, snapshotDb } from './helpers/snapshot';

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

/** `n` distinct addresses, `a1@x.test` onwards, or from `start`. */
const addresses = (n: number, start = 1) => Array.from({ length: n }, (_, i) => `a${start + i}@x.test`);

const email = (recipients: unknown, caller = owner, scopeId = A.board.id) =>
	api('POST', '/api/reports/email', {
		user: caller,
		body: { scope: 'board', scopeId, periodStart: '2026-10-01', periodEnd: '2026-10-08', recipients }
	});

const schedule = (recipients: string, caller = owner, extra: Record<string, unknown> = {}) =>
	api('POST', '/api/report-schedules', {
		user: caller,
		body: { name: 'Weekly', scope: 'board', scopeId: A.board.id, frequency: 'weekly', recipients, ...extra }
	});

const change = (id: number, body: Record<string, unknown>, caller = owner) =>
	api('PUT', `/api/report-schedules/${id}`, { user: caller, body });

/** A schedule written straight to the table, as one made before there was a cap. */
function stored(recipients: string, values: Partial<typeof reportSchedules.$inferInsert> = {}): number {
	return db
		.insert(reportSchedules)
		.values({ userId: owner.id, name: 'Weekly', scope: 'board', scopeId: A.board.id, recipients, ...values })
		.returning()
		.get().id;
}

const row = (id: number) => db.select().from(reportSchedules).where(eq(reportSchedules.id, id)).get()!;

const reportLines = () =>
	sqlite.prepare("SELECT level, message, user_id AS userId FROM system_logs WHERE context = 'REPORTS' ORDER BY id").all() as {
		level: string;
		message: string;
		userId: number | null;
	}[];

/** The meta of the day-limit line. */
const warnedMeta = () =>
	(sqlite.prepare("SELECT meta FROM system_logs WHERE context = 'REPORTS' AND message LIKE '%reached its limit%'").get() as { meta: string }).meta;

/** Run `body` with WARN lines kept: the suite keeps ERROR and above. */
async function loggingWarnings<T>(body: () => Promise<T>): Promise<T> {
	const level = process.env.LOG_LEVEL;
	process.env.LOG_LEVEL = 'WARN';
	try {
		return await body();
	} finally {
		if (level === undefined) delete process.env.LOG_LEVEL;
		else process.env.LOG_LEVEL = level;
	}
}

describe('reportRecipients, the one reading of a list', () => {
	it('splits on commas, semicolons, spaces and lines, drops repeats in any case, and tells addresses from the rest', () => {
		expect(reportRecipients('a@x.test, b@x.test;c@x.test\nd@x.test e@x.test,,')).toEqual({
			addresses: ['a@x.test', 'b@x.test', 'c@x.test', 'd@x.test', 'e@x.test'],
			notAddresses: []
		});
		expect(reportRecipients('A@x.test, a@x.test\ta@X.TEST')).toEqual({ addresses: ['a@x.test'], notAddresses: [] });
		expect(reportRecipients('a@x.test@y.test nobody')).toEqual({ addresses: [], notAddresses: ['a@x.test@y.test', 'nobody'] });
		// A list, as the email route takes one, and the same as one text, as a schedule keeps it.
		expect(reportRecipients(['a@x.test', 'b@x.test; c@x.test'])).toEqual(reportRecipients('a@x.test, b@x.test, c@x.test'));
		expect(reportRecipients('')).toEqual({ addresses: [], notAddresses: [] });
		expect(MAX_REPORT_RECIPIENTS).toBe(10);
	});

	it('takes an address written <address>, and not a part the mailer would send to someone other than it shows (R3)', () => {
		expect(reportRecipients('<a@x.test> a@x.test').addresses).toEqual(['a@x.test']);
		expect(reportRecipients('Alice Smith <alice@x.test>')).toEqual({ addresses: ['alice@x.test'], notAddresses: ['alice', 'smith'] });
		// Each of these the mailer reads as a mail to another address, or to none.
		const misread = ['a@b.c<x>', 'abc<def>@x.com', 'x<y>z@w.com', 'x@y.z<p>q<r>', 'a(b@c.d)e', '"x"<v@e.com>', 'g:a@b.com'];
		for (const part of misread) {
			expect(reportRecipients(part), part).toEqual({ addresses: [], notAddresses: [part] });
		}
		// Something, an @, something, a dot and something.
		expect(reportRecipients('a@localhost').addresses).toEqual([]);
	});

	it('takes no address holding a control or format character, so what is shown is what is mailed (review N6)', () => {
		// U+202E turns the text after it round on the page; NUL and U+0085
		// (a line end in some readers, and not white space in JavaScript's).
		for (const part of ['a‮tset.y@x.test','a‮@x.test', 'a\u0000b@x.test', 'a@x.test\u0085b@x.test', 'a@x.te​st']) {
			expect(reportRecipients(part), JSON.stringify(part)).toEqual({ addresses: [], notAddresses: [part] });
		}
		// Beside an address, such a part is left out and the address kept.
		expect(reportRecipients('a@x.test, b‮@x.test').addresses).toEqual(['a@x.test']);
	});
});

describe('POST /api/reports/email: at most 10 addresses at a time', () => {
	it('refuses 11, before the report is built, and sends 10, one mail to each', { timeout: 30_000 }, async () => {
		const built = vi.spyOn(PDFDocument.prototype, 'end');
		const before = snapshotDb();

		const over = await email(addresses(11));
		expect(over.status).toBe(400);
		expect(over.body).toEqual({ message: 'A report can be emailed to at most 10 addresses at a time, and this names 11. Nothing was sent.' });
		expect(built).not.toHaveBeenCalled();
		await sent.settle();
		expect(sent.all).toEqual([]);
		expectUnchanged(before);

		const ten = await email(addresses(10));
		expect(ten.status).toBe(200);
		expect(sent.emails.map((m) => m.to)).toEqual(addresses(10));
	});

	it('sends an address written twice, in either case, once; and counts eleven entries that are ten addresses as ten', { timeout: 30_000 }, async () => {
		expect((await email(['a@x.test', 'A@x.test'])).status).toBe(200);
		expect(sent.emails.map((m) => m.to)).toEqual(['a@x.test']);

		sent.clear();
		expect((await email([...addresses(10), 'A1@X.TEST'])).status).toBe(200);
		expect(sent.emails).toHaveLength(10);
	});

	it('refuses an entry the mailer would send to someone else, in the words of any entry that is not an address', async () => {
		const res = await email(['a@x.test', 'a@b.c<x>']);
		expect(res.status).toBe(400);
		expect(res.body).toEqual({ message: 'recipients[1] must be an email address' });
		await sent.settle();
		expect(sent.all).toEqual([]);
	});
});

describe('POST /api/reports/email: at most 100 addresses a day from one account', () => {
	it(
		'sends ten reports of 10, refuses the next, lets another account send, and sends again a day after the first',
		{ timeout: 60_000 },
		async () => {
			vi.useFakeTimers({ toFake: ['Date'] });
			vi.setSystemTime(new Date('2026-10-14T09:00:00.000Z'));
			const other = makeUser();
			const B = makeBoard({ owner: other });
			const theirs = makeBoard({ owner: makeUser() });

			await loggingWarnings(async () => {
				// Refused before the allowance is reached: neither spends any of it.
				expect((await email(addresses(11))).status).toBe(400);
				expect((await email(['a@x.test'], owner, theirs.board.id)).status).toBe(403);

				for (let call = 0; call < 10; call++) {
					const res = await email(addresses(10, call * 10 + 1));
					expect(res.status, `call ${call + 1}`).toBe(200);
				}
				expect(sent.emails).toHaveLength(100);

				const before = snapshotDb();
				sent.clear();
				for (const n of [1, 1]) {
					const refused = await email(addresses(n, 500));
					expect(refused.status).toBe(429);
					expect(refused.body).toEqual({
						message: 'Reports can be emailed to at most 100 addresses a day from one account, and this would make 101. Try again in 24 hour(s).'
					});
				}
				await sent.settle();
				expect(sent.all).toEqual([]);
				expectUnchanged(before);
			});

			// One WARN line, at the first refusal, naming the account: none for the second.
			// The account is the line's user, as the Audit page filters it (review O2).
			const warned = reportLines().filter((line) => line.message.includes('reached its limit'));
			expect(warned).toEqual([
				{
					level: 'WARN',
					message:
						`Account "${owner.username}" (user ${owner.id}) reached its limit of 100 report mail addresses a day: ` +
						'report mail, and schedules made, turned on, re-timed or given new addresses, are refused until the day is up',
					userId: owner.id
				}
			]);
			expect(JSON.parse(warnedMeta())).toEqual({ used: 100, asked: 1, retryAfterSecs: 86400 });

			// Another account's allowance is its own.
			expect((await email(['b@x.test'], other, B.board.id)).status).toBe(200);

			// A day and a second after the first send, the window has ended.
			vi.setSystemTime(new Date('2026-10-15T09:00:01.000Z'));
			expect((await email(['c@x.test'])).status).toBe(200);
		}
	);
});

describe('report schedules: 10 addresses each, 20 an account', () => {
	it('refuses a schedule of 11, or with a part that is not an address, and makes one of 10', async () => {
		const before = snapshotDb();
		const over = await schedule(addresses(11).join(', '));
		expect(over.status).toBe(400);
		expect(over.body).toEqual({ message: 'A schedule can be sent to at most 10 addresses, and this names 11. The schedule was not saved.' });
		const named = await schedule('bob@x.test, smith');
		expect(named.status).toBe(400);
		expect(named.body).toEqual({ message: 'recipients holds "smith", which is not an email address' });
		expectUnchanged(before);

		// Separated as the scheduler separates them, and kept as it will send them.
		const made = await schedule(`${addresses(9).join('; ')}\nA1@x.test a10@x.test`);
		expect(made.status, JSON.stringify(made.body)).toBe(201);
		expect(row(made.body.id).recipients).toBe(addresses(10).join(', '));
	});

	it('refuses a 21st schedule of one account, and not another account’s first', async () => {
		for (let n = 1; n <= 20; n++) expect((await schedule(`s${n}@x.test`)).status).toBe(201);

		const before = snapshotDb();
		const refused = await schedule('s21@x.test');
		expect(refused.status).toBe(409);
		expect(refused.body).toEqual({ message: 'You have 20 report schedules, the most one account may have. Delete one first.' });
		expectUnchanged(before);

		const other = makeUser();
		const B = makeBoard({ owner: other });
		expect((await schedule('t@x.test', other, { scopeId: B.board.id })).status).toBe(201);
	});

	it('refuses a change to 11, and turning on a schedule kept with 12 unless the same change sends 10', async () => {
		const made = await schedule(addresses(3).join(', '));
		const before = snapshotDb();
		const over = await change(made.body.id, { recipients: addresses(11).join(', ') });
		expect(over.status).toBe(400);
		expect(over.body).toEqual({ message: 'A schedule can be sent to at most 10 addresses, and this names 11. The schedule was not changed.' });
		expectUnchanged(before);

		const kept = stored(addresses(12).join(', '), { enabled: false });
		// The list's data holds every address, for the page to show (R2).
		const listed = (await api('GET', '/api/report-schedules', { user: owner })).body.find((s: { id: number }) => s.id === kept);
		expect(reportRecipients(listed.recipients).addresses).toEqual(addresses(12));

		const keptBefore = snapshotDb();
		const on = await change(kept, { enabled: true });
		expect(on.status).toBe(400);
		expect(on.body).toEqual({
			message: 'This schedule cannot be turned on: it is sent to 12 addresses, and the most is 10. Delete it and make it again with at most 10.'
		});
		expectUnchanged(keptBefore);
		// The row sent back as it is, to switch it off, is taken.
		expect((await change(kept, { recipients: row(kept).recipients, enabled: false })).status).toBe(200);

		const fixed = await change(kept, { recipients: addresses(10).join(', '), enabled: true });
		expect(fixed.status, JSON.stringify(fixed.body)).toBe(200);
		expect(row(kept)).toMatchObject({ enabled: true, recipients: addresses(10).join(', ') });
	});

	it('lets a page that sends the row back rename a schedule kept on with 12: only turning one on is refused (review O4)', async () => {
		const kept = stored(addresses(12).join(', '), { enabled: true });
		const sentBack = { ...row(kept), name: 'Renamed' };

		const renamed = await change(kept, sentBack);
		expect(renamed.status, JSON.stringify(renamed.body)).toBe(200);
		expect(row(kept)).toMatchObject({ name: 'Renamed', enabled: true, recipients: addresses(12).join(', ') });
	});

	it('takes each schedule made, turned on or re-timed from the day’s 100, and nothing for any other change (R1)', async () => {
		const ids: number[] = [];
		for (let n = 0; n < 10; n++) {
			const made = await schedule(addresses(10, n * 10 + 1).join(', '));
			expect(made.status, `schedule ${n + 1}`).toBe(201);
			ids.push(made.body.id);
		}

		const before = snapshotDb();
		const eleventh = await schedule(addresses(10, 200).join(', '));
		expect(eleventh.status).toBe(429);
		expect(eleventh.body).toEqual({
			message:
				"Report mail can reach at most 100 addresses a day from one account, and this schedule's 10 would make 110. " +
				'The schedule was not saved. Try again in 24 hour(s).'
		});
		expectUnchanged(before);

		// Switched off takes nothing; switched on again, or re-timed, would bring a send forward.
		expect((await change(ids[0], { enabled: false })).status).toBe(200);
		const offBefore = snapshotDb();
		const NOT_CHANGED =
			"Report mail can reach at most 100 addresses a day from one account, and this schedule's 10 would make 110. " +
			'The schedule was not changed. Try again in 24 hour(s).';
		for (const body of [{ enabled: true }, { timeOfDay: '10:30' }, { frequency: 'monthly' }, { dayOfWeek: 3 }]) {
			const res = await change(ids[0], body);
			expect(res.status, JSON.stringify(body)).toBe(429);
			expect(res.body).toEqual({ message: NOT_CHANGED });
		}
		expectUnchanged(offBefore);

		// A new name, a list cut down or the same time sent back: nothing taken, so taken.
		expect((await change(ids[1], { name: 'Renamed' })).status).toBe(200);
		expect((await change(ids[1], { recipients: addresses(2, 11).join(', ') })).status).toBe(200);
		expect((await change(ids[1], { timeOfDay: row(ids[1]).timeOfDay, enabled: true })).status).toBe(200);
		// And the email route shares the account's allowance.
		expect((await email(['z@x.test'])).status).toBe(429);
	});
});

describe('the scheduled run', () => {
	const due = { nextRunAt: '2000-01-01T00:00:00.000Z' };

	it('switches off a schedule kept with more than 10, sends nothing, and says so once', { timeout: 30_000 }, async () => {
		const id = stored(addresses(12).join(', '), due);

		await runDueReportSchedules(new Date());
		expect(row(id).enabled).toBe(false);
		await sent.settle();
		expect(sent.all).toEqual([]);
		const switchedOff = [
			{
				level: 'ERROR',
				message:
					`Report schedule ${id} "Weekly", owner "${owner.username}" (user ${owner.id}), was switched off: it is sent to 12 addresses, and the most is 10. ` +
					'Nothing was sent. Its owner can delete it and make it again with at most 10.',
				// Its owner is the line's user, as the Audit page filters it (review O2).
				userId: owner.id
			}
		];
		expect(reportLines()).toEqual(switchedOff);

		await runDueReportSchedules(new Date());
		expect(reportLines()).toEqual(switchedOff);
		expect(sent.all).toEqual([]);
	});

	it('sends one mail to each address of a list typed with semicolons, or one to a line', { timeout: 30_000 }, async () => {
		stored('a@x.test;b@x.test', due);
		stored('c@x.test\nd@x.test', due);

		await runDueReportSchedules(new Date());

		expect(sent.emails.map((m) => m.to)).toEqual(['a@x.test', 'b@x.test', 'c@x.test', 'd@x.test']);
	});

	it('sends to the address in "Name <address>", and names the parts it left out', { timeout: 30_000 }, async () => {
		stored('Alice Smith <alice@x.test>', due);

		await loggingWarnings(() => runDueReportSchedules(new Date()));

		expect(sent.emails.map((m) => m.to)).toEqual(['alice@x.test']);
		expect(reportLines()).toEqual([
			{
				level: 'WARN',
				message: 'Scheduled report emailed: "Weekly" to 1 of 1 recipient(s). Left out, as not email addresses: "alice", "smith".',
				userId: null
			}
		]);
	});

	it('names the account that set it up, escaped', { timeout: 30_000 }, async () => {
		const marked = makeUser({ username: '<b>pat</b>' });
		const B = makeBoard({ owner: marked });
		stored('a@x.test', { ...due, userId: marked.id, scopeId: B.board.id });

		await runDueReportSchedules(new Date());

		const [mail] = sent.emails;
		expect(mail.html).toContain('Set up by &lt;b&gt;pat&lt;/b&gt;');
		expect(mail.html).not.toContain('<b>pat</b>');
	});
});

describe('a schedule made, run and deleted, over and over (R1)', () => {
	it('is held to the day’s 100 addresses: the eleventh schedule of 10 is refused', { timeout: 60_000 }, async () => {
		vi.useFakeTimers({ toFake: ['Date'] });
		const start = new Date(2026, 9, 14, 9, 0, 30);
		vi.setSystemTime(start);
		const at = (minutes: number) => `09:${String(minutes).padStart(2, '0')}`;

		// Three rounds: made for the next minute, sent at that minute, deleted.
		for (let round = 1; round <= 3; round++) {
			const made = await schedule(addresses(10, round * 100).join(', '), owner, { dayOfWeek: start.getDay(), timeOfDay: at(round) });
			expect(made.status, `round ${round}`).toBe(201);
			vi.setSystemTime(new Date(2026, 9, 14, 9, round, 30));
			await runDueReportSchedules(new Date());
			expect((await api('DELETE', `/api/report-schedules/${made.body.id}`, { user: owner })).status).toBe(200);
		}
		expect(sent.emails).toHaveLength(30);

		// Seven more made; the eleventh is refused, however many were deleted.
		for (let n = 4; n <= 10; n++) {
			expect((await schedule(addresses(10, n * 100).join(', '))).status, `schedule ${n}`).toBe(201);
		}
		expect((await schedule(addresses(10, 1100).join(', '))).status).toBe(429);
		expect(db.select().from(reportSchedules).all()).toHaveLength(7);
	});
});

/**
 * A schedule's list changed (review B1). A change of list took nothing, so a
 * schedule made with no addresses, given ten by a change, sent and deleted
 * mailed without bound: 120 to 150 a day in the review's probe, and never a
 * 429. A change of list now takes the addresses it adds, those not already in
 * the stored list, in the transaction that writes it.
 */
describe('a schedule’s list changed', () => {
	/** What the account has taken from the day’s 100: a take of 101 is always refused, and takes nothing. */
	const used = () => {
		const took = takeAllowance(`report-mail:${owner.id}`, 101, 100, 24 * 60 * 60 * 1000);
		return took.taken ? -1 : took.used;
	};

	it('is held to the day’s 100: a schedule made empty and given ten, over and over, is refused at the eleventh', async () => {
		for (let round = 1; round <= 10; round++) {
			const made = await schedule('');
			expect(made.status, `round ${round}`).toBe(201);
			expect((await change(made.body.id, { recipients: addresses(10, round * 100).join(', ') })).status, `round ${round}`).toBe(200);
			expect((await api('DELETE', `/api/report-schedules/${made.body.id}`, { user: owner })).status).toBe(200);
		}
		expect(used()).toBe(100);

		const made = await schedule('');
		expect(made.status).toBe(201);
		const before = snapshotDb();
		const refused = await change(made.body.id, { recipients: addresses(10, 1100).join(', ') });
		expect(refused.status).toBe(429);
		expect(refused.body).toEqual({
			message:
				"Report mail can reach at most 100 addresses a day from one account, and this schedule's 10 new addresses would make 110. " +
				'The schedule was not changed. Try again in 24 hour(s).'
		});
		expectUnchanged(before);
	});

	it('takes only the addresses a change adds: one, then ten, takes nine', async () => {
		const made = await schedule('a1@x.test');
		expect(used()).toBe(1);

		expect((await change(made.body.id, { recipients: addresses(10).join(', ') })).status).toBe(200);
		expect(used()).toBe(10);
	});

	it('takes nothing for the stored list sent back in another order or case, or cut down', async () => {
		const made = await schedule(addresses(10).join(', '));
		expect(used()).toBe(10);

		const reordered = addresses(10).reverse().map((address) => address.toUpperCase()).join('; ');
		expect((await change(made.body.id, { recipients: reordered })).status).toBe(200);
		expect((await change(made.body.id, { recipients: addresses(4, 3).join(', ') })).status).toBe(200);
		expect(used()).toBe(10);
	});
});
