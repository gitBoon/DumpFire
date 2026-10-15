import { json, error } from '@sveltejs/kit';
import { db } from '$lib/server/db';
import { cards, columns } from '$lib/server/db/schema';
import { eq, and, isNotNull, inArray } from 'drizzle-orm';
import { inTransaction } from '$lib/server/db/transaction';
import { restoreCard } from '$lib/server/card-restore';
import { emit } from '$lib/server/events';
import { pathId, readBody, readId } from '$lib/server/request-body';
import { requireBoard, requireCard, requireUser } from '$lib/server/route-guards';
import type { RequestHandler } from './$types';

/** GET — list archived cards for a board */
export const GET: RequestHandler = async ({ params, locals }) => {
	const boardId = requireBoard(locals.user, pathId(params.id, 'board'), 'view').id;

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

/**
 * POST — restore a card from archive. Body: `{ cardId }`, an id (card 2117):
 * one that was not was read with `Number()`, and looked for as a card. A card
 * that is not archived is answered 200 as it is, with nothing written and
 * nobody told.
 */
export const POST: RequestHandler = async ({ params, request, locals }) => {
	const user = requireUser(locals.user);
	const pathBoardId = pathId(params.id, 'board');
	const body = await readBody(request);

	// One transaction: the card is read and the caller checked in the one that
	// restores it. The same routine as POST /api/cards/:id/restore.
	const updated = inTransaction(() => {
		// The card the body names is the row guarded, so its id is read first.
		const cardId = readId(body, 'cardId', { required: true, says: 'Invalid card ID' });

		// The card decides which board is checked, not the URL: this route used to
		// restore whichever card was named, on any board, for anyone.
		const { boardId } = requireCard(user, cardId, 'edit');
		if (boardId !== pathBoardId) throw error(404, 'Card not found on this board');

		const restore = restoreCard(cardId, user, 'ui');
		if (!restore) throw error(404, 'Card not found');
		if (restore.restored) emit(boardId, 'update', { type: 'card' });
		return restore.card;
	});
	return json(updated);
};
