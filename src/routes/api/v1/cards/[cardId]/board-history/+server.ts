import { json, error } from '@sveltejs/kit';
import { db } from '$lib/server/db';
import { cards, columns } from '$lib/server/db/schema';
import { eq } from 'drizzle-orm';
import { canViewBoard } from '$lib/server/board-access';
import { getCardBoardHistory } from '$lib/server/activity-report';
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

	const cardId = Number(params.cardId);
	if (!Number.isInteger(cardId)) throw error(400, 'Invalid card ID');

	const card = db.select({ columnId: cards.columnId }).from(cards).where(eq(cards.id, cardId)).get();
	if (!card) throw error(404, 'Card not found');
	const col = db.select({ boardId: columns.boardId }).from(columns).where(eq(columns.id, card.columnId)).get();
	if (!col) throw error(404, 'Card not found');

	if (!canViewBoard(locals.user, col.boardId)) {
		throw error(403, 'No access to this card\'s board');
	}

	const history = getCardBoardHistory(cardId);

	// A board the caller cannot see is named but not detailed: hiding the hop
	// entirely would make the sequence lie, and naming the board is no more than
	// the card's own move already tells them.
	const visible = history.map((h) =>
		canViewBoard(locals.user!, h.boardId) ? h : { ...h, boardName: 'Board not visible to you' }
	);

	return json({ cardId, history: visible });
};
