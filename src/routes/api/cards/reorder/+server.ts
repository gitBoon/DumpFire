import { json, error } from '@sveltejs/kit';
import { db } from '$lib/server/db';
import { inTransaction } from '$lib/server/db/transaction';
import { cards } from '$lib/server/db/schema';
import { eq } from 'drizzle-orm';
import { requireColumn, requireUser } from '$lib/server/route-guards';
import { linkBaseUrl } from '$lib/server/email';
import {
	applyCardMove,
	announceCardMoves,
	recordUnblockedByMoves,
	CardMoveError,
	type CardMove
} from '$lib/server/card-moves';
import { readBody, readId, readNumber, readObjects } from '$lib/server/request-body';
import type { RequestHandler } from './$types';

/**
 * PUT /api/cards/reorder — persist the result of a drag and drop.
 *
 * Body: `{ updates: [{ id, columnId, position }] }` — every card whose column
 * or position the drop changed. Each entry is an object, its `id` and
 * `columnId` ids and its `position` a number, if sent (card 2117):
 * `updates[<n>].position must be a number`. Text was stored as a position,
 * and an entry that was not an object was a 500.
 */
export const PUT: RequestHandler = async ({ request, url, locals }) => {
	const user = requireUser(locals.user);
	const body = await readBody(request);

	const updates = readObjects(body, 'updates', {
		required: true,
		says: { missing: 'updates must be an array', type: 'updates must be an array' }
	});
	if (updates.length === 0) return json({ success: true });

	const baseUrl = linkBaseUrl(url);

	// One transaction from the first check to the last write. The checks read
	// the rows the moves then change, so nothing can alter them in between, and
	// a refusal or a failed write leaves the board as it was.
	try {
		inTransaction(() => {
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
				const cardId = readId(update, 'id', { required: true, says: `updates[${i}].id must be an id` });
				const card = db
					.select({ columnId: cards.columnId })
					.from(cards)
					.where(eq(cards.id, cardId))
					.get();
				if (!card) throw error(404, `Card ${cardId} not found`);
				boardIds.add(editableBoardOf(card.columnId));
				const toColumnId = readId(update, 'columnId', { required: true, says: `updates[${i}].columnId must be an id` });
				boardIds.add(editableBoardOf(toColumnId));
				return { cardId, toColumnId };
			});

			// A drag and drop happens on one board. Moving a card to another board is a
			// different operation with its own routes.
			if (boardIds.size !== 1) throw error(400, 'A reorder must stay within one board');

			// Then each position, once every card and column is known to be the caller's.
			const positions = updates.map((update, i) =>
				readNumber(update, 'position', { says: `updates[${i}].position must be a number` })
			);

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
