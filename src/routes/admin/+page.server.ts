import type { PageServerLoad } from './$types';
import { db } from '$lib/server/db';
import { boards, columns, cards, subtasks, categories } from '$lib/server/db/schema';
import { count, eq } from 'drizzle-orm';

export const load: PageServerLoad = async () => {
	const allBoards = db.select().from(boards).all();
	const stats = allBoards.map((board) => {
		const colCount = db.select({ count: count() }).from(columns).where(eq(columns.boardId, board.id)).get();
		const cardCount = db
			.select({ count: count() })
			.from(cards)
			.innerJoin(columns, eq(cards.columnId, columns.id))
			.where(eq(columns.boardId, board.id))
			.get();
		const catCount = db.select({ count: count() }).from(categories).where(eq(categories.boardId, board.id)).get();
		return {
			...board,
			columnCount: colCount?.count || 0,
			cardCount: cardCount?.count || 0,
			categoryCount: catCount?.count || 0
		};
	});

	return { boards: stats };
};
