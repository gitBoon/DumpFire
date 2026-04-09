import { json, error } from '@sveltejs/kit';
import { db } from '$lib/server/db';
import { cards, columns, userXp } from '$lib/server/db/schema';
import { eq } from 'drizzle-orm';
import { canEditBoard } from '$lib/server/board-access';
import { emit } from '$lib/server/events';
import { getCompletionBlocker, isCompleteColumnTitle } from '$lib/server/card-completion';
import type { RequestHandler } from './$types';

/** Resolve the board that a card belongs to. */
function getCardBoardId(cardId: number): number | null {
	const card = db.select({ columnId: cards.columnId }).from(cards).where(eq(cards.id, cardId)).get();
	if (!card) return null;
	const col = db.select({ boardId: columns.boardId }).from(columns).where(eq(columns.id, card.columnId)).get();
	return col?.boardId ?? null;
}

/**
 * PUT /api/v1/cards/:cardId/move — Move a card to a different column.
 *
 * Body: { columnId: number, position?: number }
 *
 * Triggers the same completion/XP logic as the UI drag-and-drop.
 */
export const PUT: RequestHandler = async ({ params, request, locals }) => {
	if (!locals.user) throw error(401, 'Not authenticated');

	const cardId = Number(params.cardId);
	if (isNaN(cardId)) throw error(400, 'Invalid card ID');

	const boardId = getCardBoardId(cardId);
	if (!boardId) throw error(404, 'Card not found');

	if (!canEditBoard(locals.user, boardId)) {
		throw error(403, 'No edit access to this card\'s board');
	}

	const body = await request.json();
	const { columnId: targetColumnId, position } = body;

	if (!targetColumnId) throw error(400, 'columnId is required');

	// Verify target column exists and belongs to the same board
	const targetCol = db.select().from(columns).where(eq(columns.id, targetColumnId)).get();
	if (!targetCol || targetCol.boardId !== boardId) {
		throw error(400, 'Target column does not belong to this board');
	}

	// Get the card's current state
	const existingCard = db.select().from(cards).where(eq(cards.id, cardId)).get();
	if (!existingCard) throw error(404, 'Card not found');

	const isMovingColumn = existingCard.columnId !== targetColumnId;

	// Check if target column is "Complete"
	const isCompleteColumn = isCompleteColumnTitle(targetCol.title);
	const wasAlreadyCompleted = !!existingCard.completedAt;

	// Block completion if subtasks or sub-boards are incomplete
	if (isMovingColumn && isCompleteColumn) {
		const blocker = getCompletionBlocker(cardId);
		if (blocker) {
			throw error(409, blocker);
		}
	}

	// Update position and column
	const updateData: Record<string, unknown> = {
		columnId: targetColumnId,
		position: position ?? existingCard.position,
		updatedAt: new Date().toISOString()
	};

	// Set completedAt when moved to Complete column
	if (isMovingColumn && isCompleteColumn) {
		updateData.completedAt = new Date().toISOString();
	}

	db.update(cards)
		.set(updateData)
		.where(eq(cards.id, cardId))
		.run();

	// XP and celebration logic (only on first completion)
	if (isMovingColumn && isCompleteColumn) {
		const userName = locals.user.username;
		const userEmoji = locals.user.emoji || '👤';

		if (!wasAlreadyCompleted) {
			// Award XP based on priority
			const xpMap: Record<string, number> = { low: 50, medium: 100, high: 150, critical: 200 };
			const xpAmount = xpMap[existingCard.priority] || 100;

			const existing = db.select().from(userXp).where(eq(userXp.name, userName)).get();
			if (existing) {
				db.update(userXp)
					.set({ xp: existing.xp + xpAmount, emoji: userEmoji || existing.emoji })
					.where(eq(userXp.name, userName)).run();
			} else {
				db.insert(userXp).values({ name: userName, xp: xpAmount, emoji: userEmoji || '👤' }).run();
			}

			emit(boardId, 'celebrate', {
				type: 'complete',
				cardTitle: existingCard.title,
				userName,
				userEmoji,
				xpGained: xpAmount
			});
			emit(boardId, 'xp-update', {});
		} else {
			// Card was already completed before — celebrate but no XP
			emit(boardId, 'celebrate', {
				type: 'complete',
				cardTitle: existingCard.title,
				userName,
				userEmoji: userEmoji || '👤',
				xpGained: 0
			});
		}
	}

	const fromCol = db.select({ title: columns.title }).from(columns).where(eq(columns.id, existingCard.columnId)).get();
	emit(boardId, 'update', {
		type: 'card',
		action: isMovingColumn ? 'moved' : 'reorder',
		cardTitle: existingCard.title,
		fromColumn: fromCol?.title,
		toColumn: targetCol.title,
		userName: locals.user.username,
		userEmoji: locals.user.emoji || '\ud83d\udc64'
	});

	// Return the moved card with column info
	const movedCard = db.select().from(cards).where(eq(cards.id, cardId)).get();
	return json({
		...movedCard,
		columnTitle: targetCol.title,
		boardId
	});
};
