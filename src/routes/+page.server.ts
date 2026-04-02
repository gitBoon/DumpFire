import { db } from '$lib/server/db';
import { boards, columns, cards } from '$lib/server/db/schema';
import { desc, eq, inArray, isNull, isNotNull } from 'drizzle-orm';
import type { PageServerLoad } from './$types';

export const load: PageServerLoad = async () => {
	const allBoards = db.select().from(boards).where(isNull(boards.parentCardId)).orderBy(desc(boards.createdAt)).all();

	// Get all sub-boards in one query
	const allSubBoards = db.select().from(boards).where(isNotNull(boards.parentCardId)).all();

	// Map: cardId -> sub-board
	const subBoardsByCard = new Map<number, typeof allSubBoards>();
	for (const sb of allSubBoards) {
		if (!sb.parentCardId) continue;
		const list = subBoardsByCard.get(sb.parentCardId) || [];
		list.push(sb);
		subBoardsByCard.set(sb.parentCardId, list);
	}

	// Enrich each board with card stats and sub-board info
	const enriched = allBoards.map(board => {
		const boardCols = db.select().from(columns).where(eq(columns.boardId, board.id)).all();
		const colIds = boardCols.map(c => c.id);
		if (colIds.length === 0) {
			return { ...board, totalCards: 0, completedCards: 0, lastActivity: board.updatedAt, subBoards: [] as any[] };
		}

		const boardCards = db.select().from(cards).where(inArray(cards.columnId, colIds)).all();
		const completeCols = boardCols.filter(c => c.title.toLowerCase() === 'complete' || c.title.toLowerCase() === 'done');
		const completeColIds = new Set(completeCols.map(c => c.id));
		const completedCards = boardCards.filter(c => completeColIds.has(c.columnId)).length;

		let lastActivity = board.updatedAt;
		for (const c of boardCards) {
			if (c.updatedAt > lastActivity) lastActivity = c.updatedAt;
		}

		// Find sub-boards for cards on this board
		const subBoardsForBoard: { id: number; name: string; emoji: string; parentCardTitle: string; done: number; total: number }[] = [];
		for (const card of boardCards) {
			const subs = subBoardsByCard.get(card.id);
			if (!subs) continue;
			for (const sb of subs) {
				const sbCols = db.select().from(columns).where(eq(columns.boardId, sb.id)).all();
				const sbColIds = sbCols.map(c => c.id);
				let done = 0, total = 0;
				if (sbColIds.length > 0) {
					const sbCards = db.select().from(cards).where(inArray(cards.columnId, sbColIds)).all();
					total = sbCards.length;
					const sbCompleteCols = sbCols.filter(c => c.title.toLowerCase() === 'complete' || c.title.toLowerCase() === 'done');
					const sbCompleteColIds = new Set(sbCompleteCols.map(c => c.id));
					done = sbCards.filter(c => sbCompleteColIds.has(c.columnId)).length;
				}
				subBoardsForBoard.push({
					id: sb.id,
					name: sb.name,
					emoji: sb.emoji || '🗂️',
					parentCardTitle: card.title,
					done,
					total
				});
			}
		}

		return {
			...board,
			totalCards: boardCards.length,
			completedCards,
			lastActivity,
			subBoards: subBoardsForBoard
		};
	});

	return { boards: enriched };
};
