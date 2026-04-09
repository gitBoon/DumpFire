import { json, error } from '@sveltejs/kit';
import { db } from '$lib/server/db';
import { cards, columns, userXp } from '$lib/server/db/schema';
import { eq } from 'drizzle-orm';
import { emit } from '$lib/server/events';
import { canEditBoard } from '$lib/server/board-access';
import { notifyCardMoved } from '$lib/server/notifications';
import { resolveBaseUrl } from '$lib/server/email';
import type { RequestHandler } from './$types';

export const PUT: RequestHandler = async ({ request, url, locals }) => {
	if (!locals.user) throw error(401, 'Not authenticated');

	const { updates, boardId } = await request.json();

	// Use authenticated user identity — never trust client-supplied userName
	const userName = locals.user.username;
	const userEmoji = locals.user.emoji || '👤';

	// Verify board access
	if (boardId && !canEditBoard(locals.user, boardId)) {
		throw error(403, 'No edit access to this board');
	}

	// Snapshot old column assignments to detect moves to Complete
	let movedToComplete = false;
	let completedCardTitle = '';
	let completedCardPriority = 'medium';
	let completedCardId = 0;
	let cardAlreadyCompleted = false;

	if (boardId) {
		const completeColumns = db
			.select({ id: columns.id })
			.from(columns)
			.where(eq(columns.boardId, boardId))
			.all()
			.filter((col) => {
				const full = db.select().from(columns).where(eq(columns.id, col.id)).get();
				return full && full.title.toLowerCase() === 'complete';
			})
			.map((c) => c.id);

		if (completeColumns.length > 0) {
			for (const update of updates) {
				if (completeColumns.includes(update.columnId)) {
					// Check if this card was previously NOT in a complete column
					const existing = db.select().from(cards).where(eq(cards.id, update.id)).get();
					if (existing && !completeColumns.includes(existing.columnId)) {
						movedToComplete = true;
						completedCardTitle = existing.title;
						completedCardPriority = existing.priority;
						completedCardId = existing.id;
						// Check if it was already completed before (XP exploit prevention)
						cardAlreadyCompleted = !!existing.completedAt;
					}
				}
			}
		}
	}

	// Track the most recent cross-column move for toast notification
	let movedCardTitle = '';
	let movedFromCol = '';
	let movedToCol = '';

	for (const update of updates) {
		// Track column changes for notifications
		const existingCard = db.select().from(cards).where(eq(cards.id, update.id)).get();
		const movedColumn = existingCard && existingCard.columnId !== update.columnId;

		db.update(cards)
			.set({ columnId: update.columnId, position: update.position })
			.where(eq(cards.id, update.id))
			.run();

		// Fire move notification if card changed columns
		if (movedColumn && existingCard && boardId) {
			const fromCol = db.select({ title: columns.title }).from(columns).where(eq(columns.id, existingCard.columnId)).get();
			const toCol = db.select({ title: columns.title }).from(columns).where(eq(columns.id, update.columnId)).get();
			if (fromCol && toCol) {
				movedCardTitle = existingCard.title;
				movedFromCol = fromCol.title;
				movedToCol = toCol.title;
				const baseUrl = resolveBaseUrl(request, url);
				notifyCardMoved(boardId, update.id, existingCard.title, userName, fromCol.title, toCol.title, baseUrl);
			}
		}
	}

	// Set completedAt timestamp when moved to Complete (only if not already set)
	if (movedToComplete && completedCardId) {
		db.update(cards)
			.set({ completedAt: new Date().toISOString() })
			.where(eq(cards.id, completedCardId))
			.run();
	}

	if (boardId) {
		emit(boardId, 'update', {
			type: 'card',
			action: movedCardTitle ? 'moved' : 'reorder',
			cardTitle: movedCardTitle || undefined,
			fromColumn: movedFromCol || undefined,
			toColumn: movedToCol || undefined,
			userName,
			userEmoji
		});
		// Only award XP on FIRST completion (not re-completions)
		if (movedToComplete && userName && !cardAlreadyCompleted) {
			// Award XP based on priority
			const xpMap: Record<string, number> = { low: 50, medium: 100, high: 150, critical: 200 };
			const xpAmount = xpMap[completedCardPriority] || 100;

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
				cardTitle: completedCardTitle,
				userName: userName,
				userEmoji: userEmoji || '👤',
				xpGained: xpAmount
			});
			emit(boardId, 'xp-update', {});
		} else if (movedToComplete && userName && cardAlreadyCompleted) {
			// Show celebration but no XP (already earned)
			emit(boardId, 'celebrate', {
				type: 'complete',
				cardTitle: completedCardTitle,
				userName: userName,
				userEmoji: userEmoji || '👤',
				xpGained: 0
			});
		}
	}
	return json({ success: true });
};
