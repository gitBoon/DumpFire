import { error } from '@sveltejs/kit';
import { json } from '$lib/server/v1-json';
import { canViewBoard } from '$lib/server/board-access';
import { getCardBoardHistory } from '$lib/server/activity-report';
import { pathId } from '$lib/server/request-body';
import { requireCard } from '$lib/server/route-guards';
import type { RequestHandler } from './$types';

/**
 * GET /api/v1/cards/:cardId/board-history — which board this card was on, when.
 *
 * Per-board activity totals were unreliable because a card that changes board
 * mid-window appears in the audit log under two different `boardId`s — 13 cards
 * did in one 30-day window — with no way to tell which board it was on at the
 * time of any given event. The events always recorded the board correctly; what
 * was missing was a way to read the sequence back.
 *
 * Returns spans oldest first, each with the board, when the card arrived, and
 * when it left (`to: null` on the span it is in now).
 */
export const GET: RequestHandler = async ({ params, locals }) => {
	if (!locals.user) throw error(401, 'Not authenticated');

	const cardId = pathId(params.cardId, 'card');

	// 404 for a card that is not there, and for one on a board the key's user
	// cannot open alike (card 2719).
	requireCard(locals.user, cardId, 'view');

	const history = getCardBoardHistory(cardId);

	// A board the caller cannot open is kept in the sequence by its dates, and
	// neither its id nor its name: hiding the hop entirely would make the
	// sequence lie, and its id would tell that the board exists (card 2719's
	// code review, CS2). It is `boardId: null` and `withheld: true`, as a loop's
	// hidden node is. Nowhere else gives its name: since card 2181 the move's own
	// entries and live events name neither board.
	const visible = history.map((h) =>
		canViewBoard(locals.user!, h.boardId)
			? h
			: { ...h, boardId: null, boardName: 'Board not visible to you', withheld: true as const }
	);

	return json({ cardId, history: visible });
};
