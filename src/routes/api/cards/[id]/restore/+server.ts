import { json } from '@sveltejs/kit';
import { restoreCardFor } from '$lib/server/cards';
import { pathId } from '$lib/server/request-body';
import { writeAs } from '$lib/server/write-as';
import type { RequestHandler } from './$types';

/**
 * POST — restore a card from archive by ID. A card that is not archived is
 * answered 200 as it is, with nothing written and nobody told. Restoring is
 * an edit to the card's board.
 */
export const POST: RequestHandler = async ({ params, locals }) => {
	const cardId = pathId(params.id, 'card');

	// One transaction: the card is read and the caller checked in the one that
	// restores it, which asks first whether the session is still open, and who
	// its account is now (card 2253). The same routine as
	// POST /api/boards/:id/archive: `restoreCardFor` in $lib/server/cards.
	const updated = writeAs(locals, (caller) => restoreCardFor(caller, { cardId }, null, { source: 'ui' }));
	return json(updated);
};
