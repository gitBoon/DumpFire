import { json, error } from '@sveltejs/kit';
import { db } from '$lib/server/db';
import { cards, columns } from '$lib/server/db/schema';
import { eq, and, isNotNull, inArray } from 'drizzle-orm';
import { emit } from '$lib/server/events';
import type { RequestHandler } from './$types';

/** GET — list archived cards for a board */
export const GET: RequestHandler = async ({ params }) => {
	const boardId = Number(params.id);

	const boardCols = db.select({ id: columns.id })
		.from(columns)
		.where(eq(columns.boardId, boardId))
		.all();

	const colIds = boardCols.map(c => c.id);
	if (colIds.length === 0) return json([]);

	const archived = db.select()
		.from(cards)
		.where(and(
			inArray(cards.columnId, colIds),
			isNotNull(cards.archivedAt)
		))
		.all();

	return json(archived);
};

/** POST — restore a card from archive */
export const POST: RequestHandler = async ({ params, request }) => {
	const boardId = Number(params.id);
	const { cardId } = await request.json();

	const updated = db.update(cards)
		.set({ archivedAt: null, updatedAt: new Date().toISOString() })
		.where(eq(cards.id, cardId))
		.returning()
		.get();

	if (!updated) throw error(404, 'Card not found');
	emit(boardId, 'update', { type: 'card' });
	return json(updated);
};
