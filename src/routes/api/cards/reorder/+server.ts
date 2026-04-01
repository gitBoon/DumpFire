import { json } from '@sveltejs/kit';
import { db } from '$lib/server/db';
import { cards, columns, userXp } from '$lib/server/db/schema';
import { eq } from 'drizzle-orm';
import { emit } from '$lib/server/events';
import type { RequestHandler } from './$types';

export const PUT: RequestHandler = async ({ request }) => {
	const { updates, boardId, userName, userEmoji } = await request.json();

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

	for (const update of updates) {
		db.update(cards)
			.set({ columnId: update.columnId, position: update.position })
			.where(eq(cards.id, update.id))
			.run();
	}

	// Set completedAt timestamp when moved to Complete (only if not already set)
	if (movedToComplete && completedCardId) {
		db.update(cards)
			.set({ completedAt: new Date().toISOString() })
			.where(eq(cards.id, completedCardId))
			.run();
	}

	if (boardId) {
		emit(boardId, 'update', { type: 'card' });
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
