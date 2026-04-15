import { json, error } from '@sveltejs/kit';
import { db } from '$lib/server/db';
import { cards, columns, userXp, cardLabels, labels, boards } from '$lib/server/db/schema';
import { eq, and, inArray } from 'drizzle-orm';
import { canEditBoard } from '$lib/server/board-access';
import { emit } from '$lib/server/events';
import { getCompletionBlocker, isCompleteColumnTitle } from '$lib/server/card-completion';
import { logActivity } from '$lib/server/logActivity';
import { notifyRequesterProgress } from '$lib/server/notifications';
import { resolveBaseUrl } from '$lib/server/email';
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
 * Supports both within-board and cross-board moves. For cross-board moves,
 * the user must have edit access to both the source and target boards.
 * Board-scoped data (categoryId, labels) is cleaned up automatically.
 *
 * Triggers the same completion/XP logic as the UI drag-and-drop.
 */
export const PUT: RequestHandler = async ({ params, request, locals, url }) => {
	if (!locals.user) throw error(401, 'Not authenticated');

	const cardId = Number(params.cardId);
	if (isNaN(cardId)) throw error(400, 'Invalid card ID');

	const sourceBoardId = getCardBoardId(cardId);
	if (!sourceBoardId) throw error(404, 'Card not found');

	if (!canEditBoard(locals.user, sourceBoardId)) {
		throw error(403, 'No edit access to this card\'s board');
	}

	const body = await request.json();
	const { columnId: targetColumnId, position } = body;

	if (!targetColumnId) throw error(400, 'columnId is required');

	// Verify target column exists
	const targetCol = db.select().from(columns).where(eq(columns.id, targetColumnId)).get();
	if (!targetCol) {
		throw error(400, 'Target column not found');
	}

	const targetBoardId = targetCol.boardId;
	const isCrossBoardMove = targetBoardId !== sourceBoardId;

	// For cross-board moves, verify edit access to the target board
	if (isCrossBoardMove && !canEditBoard(locals.user, targetBoardId)) {
		throw error(403, 'No edit access to the target board');
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

	// For cross-board moves, clean up board-scoped data
	if (isCrossBoardMove) {
		// Clear categoryId — categories are per-board
		updateData.categoryId = null;

		// Remove board-scoped labels from the card
		const sourceBoardLabels = db.select({ id: labels.id })
			.from(labels)
			.where(eq(labels.boardId, sourceBoardId))
			.all()
			.map(l => l.id);

		if (sourceBoardLabels.length > 0) {
			db.delete(cardLabels)
				.where(and(
					eq(cardLabels.cardId, cardId),
					inArray(cardLabels.labelId, sourceBoardLabels)
				))
				.run();
		}
	}

	db.update(cards)
		.set(updateData)
		.where(eq(cards.id, cardId))
		.run();

	// XP and celebration logic (only on first completion)
	// For cross-board moves, celebrate on the TARGET board
	const celebrateBoardId = isCrossBoardMove ? targetBoardId : sourceBoardId;
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

			emit(celebrateBoardId, 'celebrate', {
				type: 'complete',
				cardTitle: existingCard.title,
				userName,
				userEmoji,
				xpGained: xpAmount
			});
			emit(celebrateBoardId, 'xp-update', {});
		} else {
			// Card was already completed before — celebrate but no XP
			emit(celebrateBoardId, 'celebrate', {
				type: 'complete',
				cardTitle: existingCard.title,
				userName,
				userEmoji: userEmoji || '👤',
				xpGained: 0
			});
		}
	}

	const fromCol = db.select({ title: columns.title }).from(columns).where(eq(columns.id, existingCard.columnId)).get();

	if (isCrossBoardMove) {
		// Cross-board move: emit events to BOTH boards
		const sourceBoard = db.select({ name: boards.name }).from(boards).where(eq(boards.id, sourceBoardId)).get();
		const targetBoard = db.select({ name: boards.name }).from(boards).where(eq(boards.id, targetBoardId)).get();

		// Source board: card departed
		emit(sourceBoardId, 'update', {
			type: 'card',
			action: 'moved_away',
			cardTitle: existingCard.title,
			fromColumn: fromCol?.title,
			toBoard: targetBoard?.name || 'Unknown',
			toColumn: targetCol.title,
			userName: locals.user.username,
			userEmoji: locals.user.emoji || '\ud83d\udc64'
		});

		// Target board: card arrived
		emit(targetBoardId, 'update', {
			type: 'card',
			action: 'moved_in',
			cardTitle: existingCard.title,
			fromBoard: sourceBoard?.name || 'Unknown',
			fromColumn: fromCol?.title,
			toColumn: targetCol.title,
			userName: locals.user.username,
			userEmoji: locals.user.emoji || '\ud83d\udc64'
		});

		// Log activity on both boards
		logActivity({
			boardId: sourceBoardId,
			cardId,
			userId: locals.user.id,
			action: 'api:card_moved_away',
			detail: `"${existingCard.title}" moved to board "${targetBoard?.name || 'Unknown'}" (${fromCol?.title || 'Unknown'} → ${targetCol.title})`,
			userName: locals.user.username,
			userEmoji: locals.user.emoji || '\ud83d\udc64'
		});

		logActivity({
			boardId: targetBoardId,
			cardId,
			userId: locals.user.id,
			action: 'api:card_moved_in',
			detail: `"${existingCard.title}" moved from board "${sourceBoard?.name || 'Unknown'}" (${fromCol?.title || 'Unknown'} → ${targetCol.title})`,
			userName: locals.user.username,
			userEmoji: locals.user.emoji || '\ud83d\udc64'
		});
	} else {
		// Same-board move: existing behaviour
		emit(sourceBoardId, 'update', {
			type: 'card',
			action: isMovingColumn ? 'moved' : 'reorder',
			cardTitle: existingCard.title,
			fromColumn: fromCol?.title,
			toColumn: targetCol.title,
			userName: locals.user.username,
			userEmoji: locals.user.emoji || '\ud83d\udc64'
		});

		if (isMovingColumn) {
			logActivity({
				boardId: sourceBoardId,
				cardId,
				userId: locals.user.id,
				action: 'api:card_moved',
				detail: `"${existingCard.title}" from ${fromCol?.title || 'Unknown'} to ${targetCol.title}`,
				userName: locals.user.username,
				userEmoji: locals.user.emoji || '\ud83d\udc64'
			});
		}
	}

	// Notify the original requester about progress (both same-board and cross-board)
	if (isMovingColumn) {
		const baseUrl = resolveBaseUrl(request, url);
		notifyRequesterProgress({
			cardId,
			action: isCompleteColumn ? 'completed' : 'moved',
			summary: `${fromCol?.title || 'Unknown'} → ${targetCol.title}`,
			actorName: locals.user.username,
			baseUrl,
			fromColumn: fromCol?.title || 'Unknown',
			toColumn: targetCol.title,
			actorUserId: locals.user.id
		});
	}

	// Return the moved card with column info
	const movedCard = db.select().from(cards).where(eq(cards.id, cardId)).get();
	return json({
		...movedCard,
		columnTitle: targetCol.title,
		boardId: targetBoardId
	});
};
