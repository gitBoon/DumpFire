/**
 * Report Schedules API — List and create report schedules.
 *
 * GET  /api/report-schedules      — List schedules for the current user
 * POST /api/report-schedules      — Create a new schedule
 */

import { json } from '@sveltejs/kit';
import { db } from '$lib/server/db';
import { reportSchedules, boards, boardCategories } from '$lib/server/db/schema';
import { eq, desc } from 'drizzle-orm';
import { canViewBoard, getAccessibleBoardIds } from '$lib/server/board-access';
import type { RequestHandler } from './$types';

export const GET: RequestHandler = async ({ locals }) => {
	const user = locals.user;
	if (!user) return json({ error: 'Unauthorized' }, { status: 401 });

	const schedules = db.select().from(reportSchedules)
		.where(eq(reportSchedules.userId, user.id))
		.orderBy(desc(reportSchedules.createdAt))
		.all();

	return json(schedules);
};

export const POST: RequestHandler = async ({ locals, request }) => {
	const user = locals.user;
	if (!user) return json({ error: 'Unauthorized' }, { status: 401 });

	const body = await request.json();
	const { name, scope, scopeId, frequency, dayOfWeek, dayOfMonth, timeOfDay, recipients, periodDays, detailLevel: rawDetailLevel } = body;
	const detailLevel = rawDetailLevel === 'summary' ? 'summary' : 'detailed';

	if (!name || !scope || !frequency) {
		return json({ error: 'Missing required fields: name, scope, frequency' }, { status: 400 });
	}

	if (!['board', 'category', 'all'].includes(scope)) {
		return json({ error: 'Invalid scope' }, { status: 400 });
	}

	if (!['weekly', 'monthly'].includes(frequency)) {
		return json({ error: 'Invalid frequency. Must be: weekly or monthly' }, { status: 400 });
	}

	// Validate access
	if (scope === 'board') {
		if (!scopeId) return json({ error: 'scopeId required for board scope' }, { status: 400 });
		if (!canViewBoard(user, scopeId)) {
			return json({ error: 'No access to this board' }, { status: 403 });
		}
	}

	if (scope === 'category') {
		if (!scopeId) return json({ error: 'scopeId required for category scope' }, { status: 400 });
		const cat = db.select().from(boardCategories).where(eq(boardCategories.id, scopeId)).get();
		if (!cat) return json({ error: 'Category not found' }, { status: 404 });
		// Check at least one board in this category is accessible
		const accessibleIds = getAccessibleBoardIds(user);
		const catBoards = db.select().from(boards).where(eq(boards.categoryId, scopeId)).all();
		const hasAccess = accessibleIds === null || catBoards.some(b => accessibleIds.includes(b.id));
		if (!hasAccess) return json({ error: 'No accessible boards in this category' }, { status: 403 });
	}

	if (scope === 'all' && user.role !== 'admin' && user.role !== 'superadmin') {
		return json({ error: 'Only admins can schedule all-boards reports' }, { status: 403 });
	}

	// Calculate next run
	const now = new Date();
	const [h, m] = (timeOfDay || '09:00').split(':').map(Number);
	let nextRunAt: Date;

	if (frequency === 'weekly') {
		const dow = dayOfWeek ?? 1;
		nextRunAt = new Date(now);
		nextRunAt.setHours(h, m, 0, 0);
		const diff = (dow - nextRunAt.getDay() + 7) % 7;
		nextRunAt.setDate(nextRunAt.getDate() + (diff === 0 && nextRunAt <= now ? 7 : diff));
	} else {
		const dom = Math.min(dayOfMonth ?? 1, 28);
		nextRunAt = new Date(now);
		nextRunAt.setHours(h, m, 0, 0);
		nextRunAt.setDate(dom);
		if (nextRunAt <= now) nextRunAt.setMonth(nextRunAt.getMonth() + 1);
	}

	const result = db.insert(reportSchedules).values({
		userId: user.id,
		name,
		scope,
		scopeId: scopeId || null,
		frequency,
		dayOfWeek: dayOfWeek ?? 1,
		dayOfMonth: dayOfMonth ?? 1,
		timeOfDay: timeOfDay || '09:00',
		enabled: true,
		recipients: recipients || '',
		periodDays: periodDays || 7,
		detailLevel,
		nextRunAt: nextRunAt.toISOString()
	}).run();

	const created = db.select().from(reportSchedules)
		.where(eq(reportSchedules.id, Number(result.lastInsertRowid)))
		.get();

	return json(created, { status: 201 });
};
