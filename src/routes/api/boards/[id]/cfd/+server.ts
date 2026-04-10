import { json, error } from '@sveltejs/kit';
import { db } from '$lib/server/db';
import { boards, columns, dailySnapshots } from '$lib/server/db/schema';
import { eq, and, gte, inArray, asc } from 'drizzle-orm';
import { getBoardRole } from '$lib/server/board-access';
import type { RequestHandler } from './$types';

/**
 * GET /api/boards/:id/cfd — Cumulative flow diagram data.
 *
 * Returns daily card counts per column over the last N days.
 * Query params: ?days=N (default: 30, max: 365)
 */
export const GET: RequestHandler = async ({ params, locals, url }) => {
	const boardId = Number(params.id);
	const user = locals.user!;

	const board = db.select().from(boards).where(eq(boards.id, boardId)).get();
	if (!board) throw error(404, 'Board not found');

	const role = getBoardRole(user, boardId);
	if (!role) throw error(403, 'No access to this board');

	const days = Math.min(Math.max(Number(url.searchParams.get('days')) || 30, 1), 365);
	const cutoff = new Date(Date.now() - days * 86400000).toISOString().slice(0, 10);

	// Get columns metadata
	const boardCols = db.select()
		.from(columns)
		.where(eq(columns.boardId, boardId))
		.orderBy(asc(columns.position))
		.all();

	if (boardCols.length === 0) return json({ days, columns: [], data: [] });

	const colIds = boardCols.map(c => c.id);

	// Get snapshot data
	const snapshots = db.select()
		.from(dailySnapshots)
		.where(and(
			eq(dailySnapshots.boardId, boardId),
			inArray(dailySnapshots.columnId, colIds),
			gte(dailySnapshots.date, cutoff)
		))
		.orderBy(asc(dailySnapshots.date))
		.all();

	// Group by date
	const dateMap = new Map<string, Map<number, number>>();
	for (const snap of snapshots) {
		if (!dateMap.has(snap.date)) dateMap.set(snap.date, new Map());
		dateMap.get(snap.date)!.set(snap.columnId, snap.cardCount);
	}

	// Build response
	const data = Array.from(dateMap.entries())
		.sort(([a], [b]) => a.localeCompare(b))
		.map(([date, colCounts]) => ({
			date,
			columns: boardCols.map(col => ({
				columnId: col.id,
				count: colCounts.get(col.id) || 0
			}))
		}));

	return json({
		days,
		columns: boardCols.map(c => ({ id: c.id, title: c.title, color: c.color })),
		data
	});
};
