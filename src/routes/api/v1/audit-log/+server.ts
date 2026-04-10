import { json, error } from '@sveltejs/kit';
import { db } from '$lib/server/db';
import { activityLog, boards } from '$lib/server/db/schema';
import { eq, desc, and, gte, lte, like } from 'drizzle-orm';
import type { RequestHandler } from './$types';

/**
 * GET /api/v1/audit-log — Query system-wide activity log.
 *
 * Filters:
 *   ?boardId=N       — Filter by board
 *   ?action=string   — Filter by action type (exact match or prefix with *)
 *   ?userId=N        — Filter by user
 *   ?from=ISO        — From date (inclusive)
 *   ?to=ISO          — To date (inclusive)
 *   ?limit=N         — Max results (default 100, max 500)
 *   ?offset=N        — Pagination offset
 *
 * Requires admin role.
 */
export const GET: RequestHandler = async ({ url, locals }) => {
	if (!locals.user) throw error(401, 'Not authenticated');
	if (locals.user.role !== 'admin') throw error(403, 'Admin access required');

	const boardId = url.searchParams.get('boardId');
	const action = url.searchParams.get('action');
	const userId = url.searchParams.get('userId');
	const from = url.searchParams.get('from');
	const to = url.searchParams.get('to');
	const limit = Math.min(Number(url.searchParams.get('limit')) || 100, 500);
	const offset = Number(url.searchParams.get('offset')) || 0;

	// Build conditions array
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

	const entries = db.select({
		id: activityLog.id,
		boardId: activityLog.boardId,
		cardId: activityLog.cardId,
		userId: activityLog.userId,
		action: activityLog.action,
		detail: activityLog.detail,
		userName: activityLog.userName,
		userEmoji: activityLog.userEmoji,
		createdAt: activityLog.createdAt
	})
	.from(activityLog)
	.where(where)
	.orderBy(desc(activityLog.createdAt))
	.limit(limit)
	.offset(offset)
	.all();

	// Enrich with board name
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
