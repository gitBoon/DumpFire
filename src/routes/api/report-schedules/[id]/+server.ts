/**
 * Report Schedule detail API — Update or delete a schedule.
 *
 * PUT    /api/report-schedules/:id  — Update schedule (enable/disable, change frequency)
 * DELETE /api/report-schedules/:id  — Delete a schedule
 */

import { json } from '@sveltejs/kit';
import { db } from '$lib/server/db';
import { reportSchedules } from '$lib/server/db/schema';
import { eq, and } from 'drizzle-orm';
import type { RequestHandler } from './$types';

export const PUT: RequestHandler = async ({ locals, params, request }) => {
	const user = locals.user;
	if (!user) return json({ error: 'Unauthorized' }, { status: 401 });

	const scheduleId = Number(params.id);
	const schedule = db.select().from(reportSchedules)
		.where(and(eq(reportSchedules.id, scheduleId), eq(reportSchedules.userId, user.id)))
		.get();

	if (!schedule) return json({ error: 'Schedule not found' }, { status: 404 });

	const body = await request.json();
	const updates: Record<string, any> = { updatedAt: new Date().toISOString() };

	if (body.enabled !== undefined) updates.enabled = body.enabled;
	if (body.name !== undefined) updates.name = body.name;
	if (body.frequency !== undefined && ['weekly', 'monthly'].includes(body.frequency)) {
		updates.frequency = body.frequency;
	}
	if (body.dayOfWeek !== undefined) updates.dayOfWeek = body.dayOfWeek;
	if (body.dayOfMonth !== undefined) updates.dayOfMonth = Math.min(body.dayOfMonth, 28);
	if (body.timeOfDay !== undefined) updates.timeOfDay = body.timeOfDay;
	if (body.recipients !== undefined) updates.recipients = body.recipients;

	db.update(reportSchedules)
		.set(updates)
		.where(eq(reportSchedules.id, scheduleId))
		.run();

	const updated = db.select().from(reportSchedules)
		.where(eq(reportSchedules.id, scheduleId))
		.get();

	return json(updated);
};

export const DELETE: RequestHandler = async ({ locals, params }) => {
	const user = locals.user;
	if (!user) return json({ error: 'Unauthorized' }, { status: 401 });

	const scheduleId = Number(params.id);
	const schedule = db.select().from(reportSchedules)
		.where(and(eq(reportSchedules.id, scheduleId), eq(reportSchedules.userId, user.id)))
		.get();

	if (!schedule) return json({ error: 'Schedule not found' }, { status: 404 });

	db.delete(reportSchedules).where(eq(reportSchedules.id, scheduleId)).run();
	return json({ success: true });
};
