import { json, error } from '@sveltejs/kit';
import { db } from '$lib/server/db';
import { cards, columns, userXp } from '$lib/server/db/schema';
import { eq } from 'drizzle-orm';
import { emit } from '$lib/server/events';
import { canEditBoard } from '$lib/server/board-access';
import { notifyCardMoved, notifyRequesterProgress } from '$lib/server/notifications';
import { resolveBaseUrl } from '$lib/server/email';
import { getCompletionBlocker, isCompleteColumnTitle } from '$lib/server/card-completion';
import { applyUnblockEffects } from '$lib/server/planning';
import { logUiActivity, actorOf, ACTIONS } from '$lib/server/logActivity';
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

	// Snapshot old column assignments to detect moves to Complete.
	//
	// Every card that completes in this request is collected, not just the last
	// one. These were single variables, each overwritten by the next qualifying
	// card, so dragging two cards to Complete in one drop stamped `completedAt`
	// on one of them, awarded XP once and ran the unblock hook once — and the
	// other card sat in the Complete column with no completion date, invisible
	// to every report that buckets by `completedAt`.
	const completions: {
		id: number;
		title: string;
		priority: string;
		alreadyCompleted: boolean;
	}[] = [];

	if (boardId) {
		const completeColumns = db
			.select({ id: columns.id, title: columns.title })
			.from(columns)
			.where(eq(columns.boardId, boardId))
			.all()
			.filter((col) => isCompleteColumnTitle(col.title))
			.map((c) => c.id);

		if (completeColumns.length > 0) {
			for (const update of updates) {
				if (completeColumns.includes(update.columnId)) {
					// Check if this card was previously NOT in a complete column
					const existing = db.select().from(cards).where(eq(cards.id, update.id)).get();
					if (existing && !completeColumns.includes(existing.columnId)) {
						// Block completion if subtasks or sub-boards are incomplete
						const blocker = getCompletionBlocker(update.id);
						if (blocker) {
							throw error(409, blocker);
						}
						completions.push({
							id: existing.id,
							title: existing.title,
							priority: existing.priority,
							// Already completed once before — no XP, to close the
							// out-and-back-in exploit.
							alreadyCompleted: !!existing.completedAt
						});
					}
				}
			}
		}
	}

	const movedToComplete = completions.length > 0;
	const completedIds = new Set(completions.map((c) => c.id));

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

				// Record EVERY card that changed column, not just the last one the
				// loop happened to see. This is the write that was missing entirely:
				// a card dragged to Complete in the UI produced notifications, XP and
				// a celebration, but no audit entry — so the log said 103 completions
				// where the cards said 145.
				const completing = isCompleteColumnTitle(toCol.title);
				logUiActivity({
					boardId,
					cardId: update.id,
					action: completing ? ACTIONS.cardCompleted : ACTIONS.cardMoved,
					detail: `${existingCard.title}: ${fromCol.title} → ${toCol.title}`,
					...actorOf(locals.user)
				});
				notifyCardMoved(boardId, update.id, existingCard.title, userName, fromCol.title, toCol.title, baseUrl);

				// Notify the original requester about progress
				notifyRequesterProgress({
					cardId: update.id,
					action: completedIds.has(update.id) ? 'completed' : 'moved',
					summary: `${fromCol.title} → ${toCol.title}`,
					actorName: userName,
					baseUrl,
					fromColumn: fromCol.title,
					toColumn: toCol.title,
					actorUserId: locals.user.id
				});
			}
		}
	}

	// Stamp completedAt on every card that completed, not just one of them.
	// Reports bucket by this field, so a card that lands in Complete without it
	// is delivered work that no report will ever count.
	if (movedToComplete) {
		const completedAt = new Date().toISOString();
		const baseUrl = resolveBaseUrl(request, url);
		for (const c of completions) {
			db.update(cards).set({ completedAt }).where(eq(cards.id, c.id)).run();

			// Anything that was waiting on this card may now be startable.
			applyUnblockEffects(c.id, locals.user, baseUrl);
		}
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
		// XP for every first-time completion in this request, summed. Cards
		// completed once before earn nothing, which is what closes the
		// out-of-Complete-and-back-in exploit.
		if (movedToComplete && userName) {
			const xpMap: Record<string, number> = { low: 50, medium: 100, high: 150, critical: 200 };
			const xpAmount = completions
				.filter((c) => !c.alreadyCompleted)
				.reduce((sum, c) => sum + (xpMap[c.priority] || 100), 0);

			if (xpAmount > 0) {
				const existing = db.select().from(userXp).where(eq(userXp.name, userName)).get();
				if (existing) {
					db.update(userXp)
						.set({ xp: existing.xp + xpAmount, emoji: userEmoji || existing.emoji })
						.where(eq(userXp.name, userName)).run();
				} else {
					db.insert(userXp).values({ name: userName, xp: xpAmount, emoji: userEmoji || '👤' }).run();
				}
				emit(boardId, 'xp-update', {});
			}

			// One celebration names the last card completed, as it always did.
			emit(boardId, 'celebrate', {
				type: 'complete',
				cardTitle: completions[completions.length - 1].title,
				userName: userName,
				userEmoji: userEmoji || '👤',
				xpGained: xpAmount
			});
		}
	}
	return json({ success: true });
};
