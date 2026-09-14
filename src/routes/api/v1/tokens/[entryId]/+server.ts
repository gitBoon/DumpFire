import { json, error } from '@sveltejs/kit';
import { deleteTokenEntry, getCardTokenTotal, TokenError } from '$lib/server/tokens';
import { emit } from '$lib/server/events';
import type { RequestHandler } from './$types';

/**
 * DELETE /api/v1/tokens/:entryId — remove one ledger entry.
 *
 * For an over-report, a negative entry is usually the better correction: it
 * leaves the original visible, so the history still shows what was believed at
 * the time. Use this for an entry that should never have existed at all — one
 * posted against the wrong card, say.
 */
export const DELETE: RequestHandler = async ({ params, locals }) => {
	if (!locals.user) throw error(401, 'Not authenticated');

	const entryId = Number(params.entryId);
	if (isNaN(entryId)) throw error(400, 'Invalid entry ID');

	try {
		const { cardId, boardId } = deleteTokenEntry(locals.user, entryId);
		emit(boardId, 'update', { type: 'card' });
		const total = getCardTokenTotal(cardId);
		return json({ deleted: entryId, cardId, recorded: total.entries > 0, ...total });
	} catch (e) {
		if (e instanceof TokenError) throw error(e.status, e.message);
		throw e;
	}
};
