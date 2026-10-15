/**
 * Report Schedules API — List and create report schedules.
 *
 * GET  /api/report-schedules      — List schedules for the current user
 * POST /api/report-schedules      — Create a new schedule
 */

import { json, error } from '@sveltejs/kit';
import { db } from '$lib/server/db';
import { reportSchedules, boards, boardCategories } from '$lib/server/db/schema';
import { eq, desc } from 'drizzle-orm';
import { getAccessibleBoardIds } from '$lib/server/board-access';
import { inTransaction } from '$lib/server/db/transaction';
import { REPORT_DETAIL_LEVELS, REPORT_SCOPES, REPORT_STATUS_FILTERS } from '$lib/server/reports';
import { readBody, readChoice, readEmailText, readId, readNumber, readText, readTime } from '$lib/server/request-body';
import { requireBoard } from '$lib/server/route-guards';
import type { RequestHandler } from './$types';

/** How often a schedule may run: the two the scheduler works out a next run for. */
const FREQUENCIES = ['weekly', 'monthly'] as const;
const MISSING = 'Missing required fields: name, scope, frequency';

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
 */
export const POST: RequestHandler = async ({ locals, request }) => {
	const user = locals.user;
	if (!user) throw error(401, 'Unauthorized');
	const body = await readBody(request);

	// One transaction: the board or the grouping is looked for, and the caller
	// checked, in the one that makes the schedule.
	const created = inTransaction(() => {
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
		const recipients = readEmailText(body, 'recipients', {}) ?? '';
		const periodDays = readNumber(body, 'periodDays', { whole: true, min: 1, max: 366 }) ?? 7;
		const detailLevel = readChoice(body, 'detailLevel', { from: REPORT_DETAIL_LEVELS }) ?? 'detailed';
		const statusFilter = readChoice(body, 'statusFilter', { from: REPORT_STATUS_FILTERS }) ?? 'all';

		// Calculate next run
		const now = new Date();
		const [h, m] = timeOfDay.split(':').map(Number);
		let nextRunAt: Date;

		if (frequency === 'weekly') {
			nextRunAt = new Date(now);
			nextRunAt.setHours(h, m, 0, 0);
			const diff = (dayOfWeek - nextRunAt.getDay() + 7) % 7;
			nextRunAt.setDate(nextRunAt.getDate() + (diff === 0 && nextRunAt <= now ? 7 : diff));
		} else {
			nextRunAt = new Date(now);
			nextRunAt.setHours(h, m, 0, 0);
			nextRunAt.setDate(dayOfMonth);
			if (nextRunAt <= now) nextRunAt.setMonth(nextRunAt.getMonth() + 1);
		}

		return db.insert(reportSchedules).values({
			userId: user.id,
			name,
			scope,
			scopeId,
			frequency,
			dayOfWeek,
			dayOfMonth,
			timeOfDay,
			enabled: true,
			recipients,
			periodDays,
			detailLevel,
			statusFilter,
			nextRunAt: nextRunAt.toISOString()
		}).returning().get();
	});

	return json(created, { status: 201 });
};
