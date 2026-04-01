import { db } from '$lib/server/db';
import { boards, columns, cards } from '$lib/server/db/schema';
import { desc, eq, inArray } from 'drizzle-orm';
import type { PageServerLoad } from './$types';

export const load: PageServerLoad = async () => {
	const allBoards = db.select().from(boards).orderBy(desc(boards.createdAt)).all();

	// Enrich each board with card stats
	const enriched = allBoards.map(board => {
		const boardCols = db.select().from(columns).where(eq(columns.boardId, board.id)).all();
		const colIds = boardCols.map(c => c.id);
		if (colIds.length === 0) {
			return { ...board, totalCards: 0, completedCards: 0, lastActivity: board.updatedAt };
		}

		const boardCards = db.select().from(cards).where(inArray(cards.columnId, colIds)).all();
		const completeCols = boardCols.filter(c => c.title.toLowerCase() === 'complete' || c.title.toLowerCase() === 'done');
		const completeColIds = new Set(completeCols.map(c => c.id));
		const completedCards = boardCards.filter(c => completeColIds.has(c.columnId)).length;

		let lastActivity = board.updatedAt;
		for (const c of boardCards) {
			if (c.updatedAt > lastActivity) lastActivity = c.updatedAt;
		}

		return {
			...board,
			totalCards: boardCards.length,
			completedCards,
			lastActivity
		};
	});

	return { boards: enriched };
};
