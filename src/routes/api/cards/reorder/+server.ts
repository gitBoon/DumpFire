import { json, error } from '@sveltejs/kit';
import { db } from '$lib/server/db';
import { cards } from '$lib/server/db/schema';
import { eq } from 'drizzle-orm';
import { requireColumn, requireUser } from '$lib/server/route-guards';
import { linkBaseUrl } from '$lib/server/email';
import {
	applyCardMove,
	announceCardMoves,
	recordUnblockedByMoves,
	CardMoveError,
	MAX_CARDS_MOVED_AT_ONCE,
	MAX_REORDER_ENTRIES,
	reorderTooLarge,
	tooManyMoved,
	type CardMove
} from '$lib/server/card-moves';
import { readBody, readId, readNumber, readObjects } from '$lib/server/request-body';
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
 */
export const PUT: RequestHandler = async ({ request, url, locals }) => {
	requireUser(locals.user);
	const body = await readBody(request);

	const updates = readObjects(body, 'updates', {
		required: true,
		says: { missing: 'updates must be an array', type: 'updates must be an array' }
	});
	if (updates.length === 0) return json({ success: true });
	// Before any row is read: it says nothing about any card.
	if (updates.length > MAX_REORDER_ENTRIES) error(400, reorderTooLarge(updates.length));
	const cardIds = updates.map((update, i) => readId(update, 'id', { required: true, says: `updates[${i}].id must be an id` }));
	const named = new Set<number>();
	for (const cardId of cardIds) {
		if (named.has(cardId)) error(400, `updates names card ${cardId} more than once`);
		named.add(cardId);
	}

	const baseUrl = linkBaseUrl(url);

	// One transaction from the first check to the last write. The checks read
	// the rows the moves then change, so nothing can alter them in between, and
	// a refusal or a failed write leaves the board as it was. It asks first
	// whether the session is still open, and who its account is now (card
	// 2253).
	try {
		writeAs(locals, (caller) => {
			const user = requireUser(caller);
			// Work out which board this reorder is on from the rows themselves: the
			// column each card is in now, and the column each is going to. The body's
			// `boardId` is ignored. It used to be the only thing checked, and when it
			// was left out nothing was checked at all — any signed-in user could move
			// any card on any board by omitting it.
			//
			// Checked once per distinct column, not once per card: a drop re-sends the
			// position of every card in the columns it touched.
			const columnBoards = new Map<number, number>();
			const editableBoardOf = (columnId: number): number => {
				let found = columnBoards.get(columnId);
				if (found === undefined) {
					found = requireColumn(user, columnId, 'edit').boardId;
					columnBoards.set(columnId, found);
				}
				return found;
			};

			// Each entry names two rows that are guarded, its card and the column it
			// goes to, so their ids are read first.
			const boardIds = new Set<number>();
			const drops = updates.map((update, i) => {
				const cardId = cardIds[i];
				const card = db
					.select({ columnId: cards.columnId })
					.from(cards)
					.where(eq(cards.id, cardId))
					.get();
				if (!card) throw error(404, `Card ${cardId} not found`);
				boardIds.add(editableBoardOf(card.columnId));
				const toColumnId = readId(update, 'columnId', { required: true, says: `updates[${i}].columnId must be an id` });
				boardIds.add(editableBoardOf(toColumnId));
				return { cardId, fromColumnId: card.columnId, toColumnId };
			});

			// A drag and drop happens on one board. Moving a card to another board is a
			// different operation with its own routes.
			if (boardIds.size !== 1) throw error(400, 'A reorder must stay within one board');

			// Then each position, once every card and column is known to be the caller's.
			const positions = updates.map((update, i) =>
				readNumber(update, 'position', { says: `updates[${i}].position must be a number` })
			);

			// Then how many cards it moves to another column, each of which is an
			// activity entry, a delivery to every webhook of the board and mail.
			// The column each is in now is the one read above, in this transaction.
			const moved = drops.filter((drop) => drop.toColumnId !== drop.fromColumnId).length;
			if (moved > MAX_CARDS_MOVED_AT_ONCE) throw error(400, tooManyMoved(moved));

			// Every card in the drop moves or none does. One that cannot be completed —
			// open subtasks, say — rolls the whole drop back, so the board never ends up
			// showing half of what was dragged.
			const moves: CardMove[] = [];
			for (const [i, drop] of drops.entries()) {
				moves.push(
					applyCardMove({
						cardId: drop.cardId,
						toColumnId: drop.toColumnId,
						position: positions[i],
						actor: user,
						source: 'ui'
					})
				);
			}

			// After the last move, so that a card this drop both unblocked and
			// completed gets no notice. Nothing is announced before the commit.
			const unblocked = recordUnblockedByMoves(moves, user);
			announceCardMoves(moves, unblocked, user, 'ui', baseUrl);
		});
	} catch (e) {
		if (e instanceof CardMoveError) throw error(e.status, e.message);
		throw e;
	}

	return json({ success: true });
};
