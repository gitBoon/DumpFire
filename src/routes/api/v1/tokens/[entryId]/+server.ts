import { error } from '@sveltejs/kit';
import { json } from '$lib/server/v1-json';
import { deleteTokenEntry, getCardTokenTotal, TokenError } from '$lib/server/tokens';
import { emit } from '$lib/server/events';
import { pathId } from '$lib/server/request-body';
import { requireUser } from '$lib/server/route-guards';
import { writeAs } from '$lib/server/write-as';
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
	requireUser(locals.user);

	const entryId = pathId(params.entryId, 'entry');

	try {
		// The entry read, the caller checked and the entry removed in one
		// transaction that asks first whether the key or session is still open,
		// and who its account is now (card 2253). They were separate steps with
		// no transaction around them.
		const { cardId, boardId } = writeAs(locals, (caller) => deleteTokenEntry(requireUser(caller), entryId));
		emit(boardId, 'update', { type: 'card' });
		const total = getCardTokenTotal(cardId);
		return json({ deleted: entryId, cardId, recorded: total.entries > 0, ...total });
	} catch (e) {
		if (e instanceof TokenError) throw error(e.status, e.message);
		throw e;
	}
};
