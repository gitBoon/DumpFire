import { error } from '@sveltejs/kit';
import { json } from '$lib/server/v1-json';
import { inTransaction } from '$lib/server/db/transaction';
import { requireCard, requireColumn, requireUser } from '$lib/server/route-guards';
import {
	applyCardMove,
	announceCardMoves,
	recordUnblockedByMoves,
	CardMoveError,
	type CardMove
} from '$lib/server/card-moves';
import { linkBaseUrl } from '$lib/server/email';
import { pathId, readBody, readId, readNumber } from '$lib/server/request-body';
import type { RequestHandler } from './$types';

/**
 * PUT /api/v1/cards/:cardId/move — Move a card to a different column.
 *
 * Body: { columnId: number, position?: number }
 *
 * Supports both within-board and cross-board moves. For cross-board moves,
 * the user must have edit access to both the source and target boards. The
 * source board's labels are removed from the card, and so is a category that
 * belongs to another board; a shared category stays.
 *
 * Completion, reopening, XP and the activity entry are handled by the same
 * service as a drag in the web UI — see `$lib/server/card-moves`.
 *
 * `columnId` is an id and `position` a number, or one written as text: a
 * position that was not a number used to be ignored, and the card kept the
 * position it had (`request.position ?? before.position` in card-moves.ts).
 * It is a 400 now.
 */
export const PUT: RequestHandler = async ({ params, request, locals, url }) => {
	const user = requireUser(locals.user);
	const cardId = pathId(params.cardId, 'card');

	const body = await readBody(request);
	const baseUrl = linkBaseUrl(url);

	// One transaction: both access checks read the rows the move then changes,
	// and the move, its activity entry and the "Unblocked" notices are saved
	// together or not at all.
	let move: CardMove;
	try {
		move = inTransaction(() => {
			requireCard(user, cardId, 'edit');
			const targetColumnId = readId(body, 'columnId', { required: true, says: { missing: 'columnId is required' } });
			const position = readNumber(body, 'position', {});

			// Edit access to the board the card is going to, as well as the one it is on.
			const target = requireColumn(user, targetColumnId, 'edit');

			const applied = applyCardMove({
				cardId,
				toColumnId: target.column.id,
				position,
				actor: user,
				source: 'api'
			});

			// Nothing is announced before the commit, or at all if this rolls back.
			const unblocked = recordUnblockedByMoves([applied], user);
			announceCardMoves([applied], unblocked, user, 'api', baseUrl);
			return applied;
		});
	} catch (e) {
		if (e instanceof CardMoveError) throw error(e.status, e.message);
		throw e;
	}

	return json({
		...move.card,
		columnTitle: move.toColumn.title,
		boardId: move.toBoardId
	});
};
