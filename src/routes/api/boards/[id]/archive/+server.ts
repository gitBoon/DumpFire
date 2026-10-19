import { json } from '@sveltejs/kit';
import { db } from '$lib/server/db';
import { cards, columns } from '$lib/server/db/schema';
import { eq, and, isNotNull, inArray } from 'drizzle-orm';
import { restoreCardFor } from '$lib/server/cards';
import { pathId, readBody } from '$lib/server/request-body';
import { requireBoard, requireUser } from '$lib/server/route-guards';
import { writeAs } from '$lib/server/write-as';
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
	requireUser(locals.user);
	const pathBoardId = pathId(params.id, 'board');
	const body = await readBody(request);

	// One transaction: the card is read and the caller checked in the one that
	// restores it. The same routine as POST /api/cards/:id/restore,
	// `restoreCardFor` in $lib/server/cards: the card the body names is the row
	// guarded, so its id is read first, and the card decides which board is
	// checked, not the URL (this route used to restore whichever card was
	// named, on any board, for anyone). It asks first whether the session is
	// still open, and who its account is now (card 2253).
	const updated = writeAs(locals, (caller) => restoreCardFor(caller, { boardId: pathBoardId }, body, { source: 'ui' }));
	return json(updated);
};
