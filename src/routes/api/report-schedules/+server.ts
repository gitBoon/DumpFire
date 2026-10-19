/**
 * Report Schedules API — List and create report schedules.
 *
 * GET  /api/report-schedules      — List schedules for the current user
 * POST /api/report-schedules      — Create a new schedule
 */

import { json, error } from '@sveltejs/kit';
import { db } from '$lib/server/db';
import { reportSchedules, boards, boardCategories } from '$lib/server/db/schema';
import { count, eq, desc } from 'drizzle-orm';
import { getAccessibleBoardIds } from '$lib/server/board-access';
import { inTransaction } from '$lib/server/db/transaction';
import { REPORT_DETAIL_LEVELS, REPORT_SCOPES, REPORT_STATUS_FILTERS, takeReportMail } from '$lib/server/reports';
import { readBody, readChoice, readId, readNumber, readReportRecipients, readText, readTime, readTimeZone } from '$lib/server/request-body';
import { requireBoard } from '$lib/server/route-guards';
import { stillAuthenticated } from '$lib/server/auth';
import { MAX_REPORT_RECIPIENTS, reportRecipients } from '$lib/report-recipients';
import { DEFAULT_SCHEDULE_TIME_ZONE, nextRunAfter } from '$lib/report-schedule-time';
import { stamp } from '$lib/timestamps';
import type { RequestHandler } from './$types';

/** How often a schedule may run: the two the scheduler works out a next run for. */
const FREQUENCIES = ['weekly', 'monthly'] as const;
const MISSING = 'Missing required fields: name, scope, frequency';
/**
 * The most schedules one account may have (card 2182). A scheduled run takes
 * nothing from the account's 100 addresses a day (`takeReportMail`); making a
 * schedule, turning it on, re-timing it or adding addresses to it does, as
 * each can bring a send forward. So 20 weekly schedules of 10 send 200 a week
 * on their own timetables, and what is brought forward is within the day's 100.
 */
const SCHEDULES_PER_ACCOUNT = 20;

export const GET: RequestHandler = async ({ locals }) => {
	const user = locals.user;
	if (!user) throw error(401, 'Unauthorized');

	const schedules = db.select().from(reportSchedules)
		.where(eq(reportSchedules.userId, user.id))
		.orderBy(desc(reportSchedules.createdAt))
		.all();

	return json(schedules);
};

/**
 * POST — make a schedule.
 *
 * What it reports on is read first, and the caller checked for it (card 2117,
 * R1): a board that is not there is 404, one the caller cannot see 403, and a
 * grouping likewise. The other fields are read after, each as the scheduler
 * reads it, as `PUT /api/report-schedules/[id]` reads them. Each was stored as
 * it was sent: a time of "9", from which the scheduler cannot work out a next
 * run, sent the report every minute, and an unknown detail level or status
 * filter was stored as another.
 *
 * When it is sent (cards 2144 and 2159): `timeZone`, an IANA name, is the zone
 * its time is read in, stored as the server names it; none is UTC, and a name
 * the server does not know is 400. The first run is worked out in that zone
 * by `nextRunAfter`, as the scheduler works out every run after it.
 *
 * Who it may reach (card 2182): `recipients` is read as the scheduler sends
 * it (`readReportRecipients`), at most 10 addresses (400); an account has at
 * most 20 schedules (409); and the new schedule's addresses are taken from
 * the account's report mail for the day (429), last, immediately before the
 * write: a schedule made for the next minute brings a send forward.
 */
export const POST: RequestHandler = async ({ locals, request }) => {
	const user = locals.user;
	if (!user) throw error(401, 'Unauthorized');
	const body = await readBody(request);

	// One transaction: the session is asked again (a reset that ended it while
	// the body was arriving is a 401), and the board or the grouping is looked
	// for, and the caller checked, in the one that makes the schedule.
	const created = inTransaction(() => {
		stillAuthenticated(locals);
		const scope = readChoice(body, 'scope', {
			required: true,
			from: REPORT_SCOPES,
			says: { missing: MISSING, type: 'Invalid scope', invalid: 'Invalid scope' }
		});
		const scopeId = readId(body, 'scopeId', { nullable: true }) ?? null;

		if (scope === 'board') {
			if (scopeId === null) throw error(400, 'scopeId required for board scope');
			// Looked for first: an administrator was let schedule a board that is not there.
			requireBoard(user, scopeId, 'view');
		}

		if (scope === 'category') {
			if (scopeId === null) throw error(400, 'scopeId required for category scope');
			const cat = db.select().from(boardCategories).where(eq(boardCategories.id, scopeId)).get();
			if (!cat) throw error(404, 'Category not found');
			// Check at least one board in this category is accessible
			const accessibleIds = getAccessibleBoardIds(user);
			const catBoards = db.select().from(boards).where(eq(boards.categoryId, scopeId)).all();
			const hasAccess = accessibleIds === null || catBoards.some(b => accessibleIds.includes(b.id));
			if (!hasAccess) throw error(403, 'No accessible boards in this category');
		}

		if (scope === 'all' && user.role !== 'admin' && user.role !== 'superadmin') {
			throw error(403, 'Only admins can schedule all-boards reports');
		}

		const name = readText(body, 'name', { required: true, trim: true, min: 1, max: 200, says: { missing: MISSING, empty: MISSING } });
		const FREQUENCY = 'Invalid frequency. Must be: weekly or monthly';
		const frequency = readChoice(body, 'frequency', {
			required: true,
			from: FREQUENCIES,
			says: { missing: MISSING, type: FREQUENCY, invalid: FREQUENCY }
		});
		const dayOfWeek = readNumber(body, 'dayOfWeek', { whole: true, min: 0, max: 6 }) ?? 1;
		const dayOfMonth = readNumber(body, 'dayOfMonth', { whole: true, min: 1, max: 28 }) ?? 1;
		// Empty is 09:00, as the scheduler reads it.
		const timeOfDay = readTime(body, 'timeOfDay', { empty: '09:00' }) ?? '09:00';
		const recipients = readReportRecipients(body, 'recipients', {}) ?? '';
		const addressCount = reportRecipients(recipients).addresses.length;
		if (addressCount > MAX_REPORT_RECIPIENTS) {
			throw error(400, `A schedule can be sent to at most ${MAX_REPORT_RECIPIENTS} addresses, and this names ${addressCount}. The schedule was not saved.`);
		}
		const periodDays = readNumber(body, 'periodDays', { whole: true, min: 1, max: 366 }) ?? 7;
		const detailLevel = readChoice(body, 'detailLevel', { from: REPORT_DETAIL_LEVELS }) ?? 'detailed';
		const statusFilter = readChoice(body, 'statusFilter', { from: REPORT_STATUS_FILTERS }) ?? 'all';

		// The zone the time is read in (card 2159): the page sends its creator's
		// browser zone. A caller that sends none gets UTC, which is what such a
		// caller got when the time was read on the server's clock, on UTC.
		const timeZone = readTimeZone(body, 'timeZone', {}) ?? DEFAULT_SCHEDULE_TIME_ZONE;

		// Dated by the scheduler's own function, in the schedule's zone (cards
		// 2144 and 2159). The time was set with `setHours` on the server's clock,
		// so 09:00 was 10:00 in British summer time on a server on UTC. Card
		// 2117's readers have refused a bad field by now; a fault left is a 400
		// all the same, never the 500 of a time `setHours` could not read.
		const next = nextRunAfter({ frequency, dayOfWeek, dayOfMonth, timeOfDay, timeZone }, new Date());
		if ('fault' in next) throw error(400, `The schedule was not saved: ${next.fault}`);

		// An account that already has more keeps them all, and makes no more.
		const held = db.select({ n: count() }).from(reportSchedules).where(eq(reportSchedules.userId, user.id)).get()?.n ?? 0;
		if (held >= SCHEDULES_PER_ACCOUNT) {
			throw error(
				409,
				held === SCHEDULES_PER_ACCOUNT
					? `You have ${held} report schedules, the most one account may have. Delete one first.`
					: `You have ${held} report schedules, and the most one account may have is ${SCHEDULES_PER_ACCOUNT}. Delete ${held - SCHEDULES_PER_ACCOUNT + 1} first.`
			);
		}

		// Last, with nothing awaited before the write.
		takeReportMail(user, addressCount, 'new schedule');

		return db.insert(reportSchedules).values({
			userId: user.id,
			name,
			scope,
			scopeId,
			frequency,
			dayOfWeek,
			dayOfMonth,
			timeOfDay,
			timeZone,
			enabled: true,
			recipients,
			periodDays,
			detailLevel,
			statusFilter,
			// The stored form, as the scheduler compares it (card 2095).
			nextRunAt: stamp(next.at)
		}).returning().get();
	});

	return json(created, { status: 201 });
};
