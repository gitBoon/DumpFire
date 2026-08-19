import { json, error } from '@sveltejs/kit';
import { db } from '$lib/server/db';
import { activityLog, boards } from '$lib/server/db/schema';
import { eq, desc, and, gte, lte, like } from 'drizzle-orm';
import type { RequestHandler } from './$types';

/**
 * GET /api/audit — Query the system-wide activity log (session auth).
 *
 * Internal twin of /api/v1/audit-log for the /audit page.
 * Filters: ?boardId=N &action=string (suffix * for prefix match) &userId=N
 *          &from=ISO &to=ISO &limit=N (default 100, max 500) &offset=N
 *
 * Requires admin or superadmin role.
 */
export const GET: RequestHandler = async ({ url, locals }) => {
	if (!locals.user) throw error(401, 'Not authenticated');
	if (locals.user.role !== 'admin' && locals.user.role !== 'superadmin') {
		throw error(403, 'Admin access required');
	}

	const boardId = url.searchParams.get('boardId');
	const action = url.searchParams.get('action');
	const userId = url.searchParams.get('userId');
	const from = url.searchParams.get('from');
	const to = url.searchParams.get('to');
	const limit = Math.min(Number(url.searchParams.get('limit')) || 100, 500);
	const offset = Number(url.searchParams.get('offset')) || 0;

	const conditions = [];
	if (boardId) conditions.push(eq(activityLog.boardId, Number(boardId)));
	if (userId) conditions.push(eq(activityLog.userId, Number(userId)));
	if (action) {
		if (action.endsWith('*')) {
			conditions.push(like(activityLog.action, action.replace('*', '%')));
		} else {
			conditions.push(eq(activityLog.action, action));
		}
	}
	if (from) conditions.push(gte(activityLog.createdAt, from));
	if (to) conditions.push(lte(activityLog.createdAt, to));

	const where = conditions.length > 0 ? and(...conditions) : undefined;

	const entries = db.select()
		.from(activityLog)
		.where(where)
		.orderBy(desc(activityLog.createdAt))
		.limit(limit)
		.offset(offset)
		.all();

	// Enrich with board names
	const boardNames = new Map<number, string>();
	for (const entry of entries) {
		if (!boardNames.has(entry.boardId)) {
			const b = db.select({ name: boards.name }).from(boards).where(eq(boards.id, entry.boardId)).get();
			boardNames.set(entry.boardId, b?.name || 'Unknown');
		}
	}

	const enriched = entries.map(e => ({
		...e,
		boardName: boardNames.get(e.boardId) || 'Unknown'
	}));

	return json({
		data: enriched,
		pagination: { limit, offset, count: enriched.length }
	});
};
