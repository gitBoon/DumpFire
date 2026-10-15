/**
 * Report Schedule detail API — Update or delete a schedule.
 *
 * PUT    /api/report-schedules/:id  — Update schedule (enable/disable, change frequency)
 * DELETE /api/report-schedules/:id  — Delete a schedule
 */

import { json, error } from '@sveltejs/kit';
import { db } from '$lib/server/db';
import { reportSchedules } from '$lib/server/db/schema';
import { eq, and } from 'drizzle-orm';
import { REPORT_STATUS_FILTERS } from '$lib/server/reports';
import { inTransaction } from '$lib/server/db/transaction';
import {
	pathId,
	readBody,
	readBoolean,
	readChoice,
	readEmailText,
	readNumber,
	readText,
	readTime
} from '$lib/server/request-body';
import type { RequestHandler } from './$types';

/** How often a schedule may run: the two the scheduler works out a next run for. */
const FREQUENCIES = ['weekly', 'monthly'] as const;

export const PUT: RequestHandler = async ({ locals, params, request }) => {
	const user = locals.user;
	if (!user) throw error(401, 'Unauthorized');

	const scheduleId = pathId(params.id, 'schedule');
	const body = await readBody(request);

	// The schedule is looked for among the caller's own in the transaction
	// that changes it, once the body has arrived, and the answer is the row
	// as that transaction wrote it.
	const updated = inTransaction(() => {
		const schedule = db.select().from(reportSchedules)
			.where(and(eq(reportSchedules.id, scheduleId), eq(reportSchedules.userId, user.id)))
			.get();
		if (!schedule) throw error(404, 'Schedule not found');

		// Each as the scheduler reads it. A value stored before these were checked
		// is kept when the page sends it back. `frequency` keeps the words of the
		// route that creates a schedule; an unknown one used to be ignored, and
		// `dayOfMonth` above 28 was read as 28.
		const updates: Partial<typeof reportSchedules.$inferInsert> = { updatedAt: new Date().toISOString() };
		const enabled = readBoolean(body, 'enabled', { keep: schedule.enabled });
		if (enabled !== undefined) updates.enabled = enabled;
		const name = readText(body, 'name', { trim: true, min: 1, max: 200, keep: schedule.name });
		if (name !== undefined) updates.name = name;
		const frequency = readChoice(body, 'frequency', {
			from: FREQUENCIES,
			keep: schedule.frequency,
			says: 'Invalid frequency. Must be: weekly or monthly'
		});
		if (frequency !== undefined) updates.frequency = frequency;
		const dayOfWeek = readNumber(body, 'dayOfWeek', { whole: true, min: 0, max: 6, keep: schedule.dayOfWeek });
		if (dayOfWeek !== undefined) updates.dayOfWeek = dayOfWeek;
		const dayOfMonth = readNumber(body, 'dayOfMonth', { whole: true, min: 1, max: 28, keep: schedule.dayOfMonth });
		if (dayOfMonth !== undefined) updates.dayOfMonth = dayOfMonth;
		// Empty is 09:00, as the scheduler reads it.
		const timeOfDay = readTime(body, 'timeOfDay', { empty: '09:00', keep: schedule.timeOfDay });
		if (timeOfDay !== undefined) updates.timeOfDay = timeOfDay;
		const recipients = readEmailText(body, 'recipients', { keep: schedule.recipients });
		if (recipients !== undefined) updates.recipients = recipients;
		const statusFilter = readChoice(body, 'statusFilter', { from: REPORT_STATUS_FILTERS, keep: schedule.statusFilter });
		if (statusFilter !== undefined) updates.statusFilter = statusFilter;

		return db.update(reportSchedules)
			.set(updates)
			.where(eq(reportSchedules.id, scheduleId))
			.returning()
			.get();
	});

	return json(updated);
};

export const DELETE: RequestHandler = async ({ locals, params }) => {
	const user = locals.user;
	if (!user) throw error(401, 'Unauthorized');

	const scheduleId = pathId(params.id, 'schedule');
	const schedule = db.select().from(reportSchedules)
		.where(and(eq(reportSchedules.id, scheduleId), eq(reportSchedules.userId, user.id)))
		.get();

	if (!schedule) throw error(404, 'Schedule not found');

	db.delete(reportSchedules).where(eq(reportSchedules.id, scheduleId)).run();
	return json({ success: true });
};
