import { json, error } from '@sveltejs/kit';
import { db } from '$lib/server/db';
import { boards, columns, dailySnapshots } from '$lib/server/db/schema';
import { eq, and, gte, inArray, asc } from 'drizzle-orm';
import { getBoardRole } from '$lib/server/board-access';
import { pathId } from '$lib/server/request-body';
import { requireUser } from '$lib/server/route-guards';
import { COLUMN_ORDER } from '$lib/server/card-order';
import { isUpstreamColumn } from '$lib/column-role';
import type { RequestHandler } from './$types';

/**
 * GET /api/boards/:id/cfd — Cumulative flow diagram data.
 *
 * Returns daily card counts per column over the last N days.
 * Query params: ?days=N (default: 30, max: 365)
 *
 * Milestone 22 (card 2462, ruling h): the flow of a delivery board is its
 * committed work, so its Options column is left out unless the viewer asks
 * for it with `?upstream=true` (the panel's "Show upstream", off by default).
 * Asked for, it is drawn first, at the bottom of the stack, where it already
 * is as the leftmost column; the top edge of its band is the commitment
 * point. An ideas board is all upstream and draws its own columns whatever
 * is asked. Each column says whether it is `upstream`; `kind` is the board's,
 * `hasUpstream` whether it has any upstream column to show, and
 * `upstreamShown` whether they are in this answer. Snapshots are captured for
 * every column as before, so turning it on shows the history.
 */
export const GET: RequestHandler = async ({ params, locals, url }) => {
	// A caller who is not signed in is 401, where `locals.user!` threw and
	// only the gate stood in front of it (card 2117).
	const user = requireUser(locals.user);
	const boardId = pathId(params.id, 'board');

	const board = db.select().from(boards).where(eq(boards.id, boardId)).get();
	if (!board) throw error(404, 'Board not found');

	const role = getBoardRole(user, boardId);
	if (!role) throw error(403, 'No access to this board');

	const days = Math.min(Math.max(Number(url.searchParams.get('days')) || 30, 1), 365);
	const cutoff = new Date(Date.now() - days * 86400000).toISOString().slice(0, 10);

	// Get columns metadata, each marked upstream or not, and the upstream
	// ones left out of a delivery board's flow unless asked for.
	const everyCol = db.select()
		.from(columns)
		.where(eq(columns.boardId, boardId))
		.orderBy(...COLUMN_ORDER)
		.all()
		.map(c => ({ ...c, upstream: isUpstreamColumn(c, board.kind) }));
	const hasUpstream = everyCol.some(c => c.upstream);
	const upstreamShown = hasUpstream && (board.kind === 'ideas' || url.searchParams.get('upstream') === 'true');
	const boardCols = upstreamShown ? everyCol : everyCol.filter(c => !c.upstream);
	const shape = { kind: board.kind, hasUpstream, upstreamShown };

	if (boardCols.length === 0) return json({ days, columns: [], data: [], ...shape });

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
		columns: boardCols.map(c => ({ id: c.id, title: c.title, color: c.color, upstream: c.upstream })),
		data,
		...shape
	});
};
