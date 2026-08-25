import { json, error } from '@sveltejs/kit';
import { db } from '$lib/server/db';
import { columns, cards } from '$lib/server/db/schema';
import { eq, inArray, isNull, and, asc } from 'drizzle-orm';
import { canViewBoard } from '$lib/server/board-access';
import type { RequestHandler } from './$types';

/**
 * GET /api/boards/[id]/cards — Columns and active cards for a board.
 *
 * Lightweight listing used by pickers (e.g. choosing a parent card when
 * creating a sub-board from the dashboard). Archived cards are excluded.
 */
export const GET: RequestHandler = async ({ params, locals }) => {
	if (!locals.user) throw error(401, 'Not authenticated');

	const boardId = Number(params.id);
	if (!canViewBoard(locals.user, boardId)) throw error(403, 'No access to this board');

	const boardCols = db.select({ id: columns.id, title: columns.title, position: columns.position })
		.from(columns)
		.where(eq(columns.boardId, boardId))
		.orderBy(asc(columns.position))
		.all();

	const colIds = boardCols.map(c => c.id);
	const colTitle = new Map(boardCols.map(c => [c.id, c.title]));

	const boardCards = colIds.length > 0
		? db.select({ id: cards.id, title: cards.title, columnId: cards.columnId, position: cards.position })
			.from(cards)
			.where(and(inArray(cards.columnId, colIds), isNull(cards.archivedAt)))
			.orderBy(asc(cards.position))
			.all()
		: [];

	return json({
		columns: boardCols,
		cards: boardCards.map(c => ({
			id: c.id,
			title: c.title,
			columnId: c.columnId,
			columnTitle: colTitle.get(c.columnId) || ''
		}))
	});
};
