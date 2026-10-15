import { json, error } from '@sveltejs/kit';
import { inTransaction } from '$lib/server/db/transaction';
import { restoreCard } from '$lib/server/card-restore';
import { emit } from '$lib/server/events';
import { requireCard, requireUser } from '$lib/server/route-guards';
import { pathId } from '$lib/server/request-body';
import type { RequestHandler } from './$types';

/**
 * POST — restore a card from archive by ID. A card that is not archived is
 * answered 200 as it is, with nothing written and nobody told.
 */
export const POST: RequestHandler = async ({ params, locals }) => {
	const cardId = pathId(params.id, 'card');

	// One transaction: the card is read and the caller checked in the one that
	// restores it. The same routine as POST /api/boards/:id/archive.
	const updated = inTransaction(() => {
		const user = requireUser(locals.user);
		// Restoring is an edit to the card's board. There was no check here at all.
		const { boardId } = requireCard(user, cardId, 'edit');

		const restore = restoreCard(cardId, user, 'ui');
		if (!restore) throw error(404, 'Card not found');
		if (restore.restored) emit(boardId, 'update', { type: 'card' });
		return restore.card;
	});
	return json(updated);
};
