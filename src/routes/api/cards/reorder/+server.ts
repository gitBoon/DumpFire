import { json } from '@sveltejs/kit';
import { requireUser } from '$lib/server/route-guards';
import { moveCards } from '$lib/server/cards';
import { linkBaseUrl } from '$lib/server/email';
import { readBody } from '$lib/server/request-body';
import { writeAs } from '$lib/server/write-as';
import type { RequestHandler } from './$types';

/**
 * PUT /api/cards/reorder — persist the result of a drag and drop.
 *
 * Body: `{ updates: [{ id, columnId, position }] }`. The board page's drop
 * sends every card of the column dropped into and of the column the card came
 * from, not only the one it moved (card 2213: it sent every card of the
 * board, twice); a bulk move sends the cards selected. Any subset of one
 * board's cards is taken. Each entry is an object, its `id` and `columnId`
 * ids and its `position` a number, if sent (card 2117):
 * `updates[<n>].position must be a number`. Text was stored as a position,
 * and an entry that was not an object was a 500.
 *
 * Two caps (card 2209, `card-moves.ts`): at most `MAX_REORDER_ENTRIES`
 * entries, checked before any row is read, and at most
 * `MAX_CARDS_MOVED_AT_ONCE` of them moving a card to another column, checked
 * once every card and column is known to be the caller's, before the first
 * move. Either is 400 and moves nothing. Only a bulk move of more than 100
 * selected cards meets the second from the page.
 *
 * And each card once (the review's S5), checked with the first cap: a card
 * named over and over, to and fro between two columns, was one count of the
 * second cap for every other entry and a real move for each, so 200 entries
 * were 200 moves. The page never names a card twice.
 *
 * The work is `moveCards` in `$lib/server/cards`, which shares its moves with
 * the v1 move (card 2012). The body is read there, after the session is asked
 * for again (card 2012, S2).
 *
 * Answers `{ success: true, committed, returnedToOptions }`: the ids of the
 * cards the drop took across the commitment point, out of the Options column
 * and back into it (milestone 22), for the page to say so. Each is empty for
 * any other drop.
 */
export const PUT: RequestHandler = async ({ request, url, locals }) => {
	requireUser(locals.user);
	const body = await readBody(request);
	const baseUrl = linkBaseUrl(url);

	// One transaction from the first check to the last write. The checks read
	// the rows the moves then change, so nothing can alter them in between, and
	// a refusal or a failed write leaves the board as it was. It asks first
	// whether the session is still open, and who its account is now (card
	// 2253).
	const moves = writeAs(locals, (caller) => moveCards(caller, {}, body, { source: 'ui', baseUrl }));

	return json({
		success: true,
		committed: moves.filter((move) => move.committed).map((move) => move.card.id),
		returnedToOptions: moves.filter((move) => move.returnedToOptions).map((move) => move.card.id)
	});
};
