import { json, error } from '@sveltejs/kit';
import { db } from '$lib/server/db';
import { boards, columns, cards } from '$lib/server/db/schema';
import { eq, inArray } from 'drizzle-orm';
import type { RequestHandler } from './$types';

export const PUT: RequestHandler = async ({ params, request }) => {
	const id = Number(params.id);
	const data = await request.json();
	const updated = db
		.update(boards)
		.set({ ...data, updatedAt: new Date().toISOString() })
		.where(eq(boards.id, id))
		.returning()
		.get();
	if (!updated) throw error(404, 'Board not found');
	return json(updated);
};

export const DELETE: RequestHandler = async ({ params }) => {
	const id = Number(params.id);
	deleteBoardCascade(id);
	return json({ success: true });
};

function deleteBoardCascade(boardId: number) {
	// Find all cards on this board
	const boardCols = db.select().from(columns).where(eq(columns.boardId, boardId)).all();
	const colIds = boardCols.map(c => c.id);

	if (colIds.length > 0) {
		const boardCards = db.select().from(cards).where(inArray(cards.columnId, colIds)).all();
		const cardIds = boardCards.map(c => c.id);

		if (cardIds.length > 0) {
			// Find sub-boards linked to these cards and recursively delete them
			const childBoards = db.select().from(boards).where(inArray(boards.parentCardId, cardIds)).all();
			for (const child of childBoards) {
				deleteBoardCascade(child.id);
			}
		}
	}

	// Now delete the board itself (columns, cards, subtasks etc. cascade via SQLite FK)
	db.delete(boards).where(eq(boards.id, boardId)).run();
}
