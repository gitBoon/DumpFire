import { json } from '@sveltejs/kit';
import { db } from '$lib/server/db';
import { cards, columns, boards } from '$lib/server/db/schema';
import { isNotNull, eq } from 'drizzle-orm';
import { getAccessibleBoardIds } from '$lib/server/board-access';
import type { RequestHandler } from './$types';

/** GET — list all archived cards across accessible boards */
export const GET: RequestHandler = async ({ locals }) => {
	if (!locals.user) return json([]);

	const accessibleIds = getAccessibleBoardIds(locals.user);

	const allBoards = accessibleIds === null
		? db.select().from(boards).all()
		: db.select().from(boards).all().filter(b => accessibleIds.includes(b.id));

	const boardMap = new Map(allBoards.map(b => [b.id, b.name]));

	const allCols = db.select().from(columns).all()
		.filter(c => boardMap.has(c.boardId));
	const colToBoardMap = new Map(allCols.map(c => [c.id, c.boardId]));
	const colIds = allCols.map(c => c.id);
	if (colIds.length === 0) return json([]);

	const archived = db.select().from(cards)
		.where(isNotNull(cards.archivedAt))
		.all()
		.filter(c => colToBoardMap.has(c.columnId));

	return json(archived.map(c => ({
		id: c.id,
		title: c.title,
		archivedAt: c.archivedAt,
		boardName: boardMap.get(colToBoardMap.get(c.columnId)!) || 'Unknown'
	})));
};
