/**
 * work-access.ts — which board a piece of work lives on.
 *
 * Dependencies can now span cards and subtasks, and every endpoint that writes
 * one has to answer "may this user edit both ends". A subtask has no board of
 * its own; it inherits its parent card's. Keeping that in one place stops the
 * four routes that need it from each deriving it slightly differently.
 */

import { db } from './db';
import { cards, columns, subtasks } from './db/schema';
import { eq } from 'drizzle-orm';
import type { WorkRef } from './planning';

export function getCardBoardId(cardId: number): number | null {
	const card = db.select({ columnId: cards.columnId }).from(cards).where(eq(cards.id, cardId)).get();
	if (!card) return null;
	const col = db
		.select({ boardId: columns.boardId })
		.from(columns)
		.where(eq(columns.id, card.columnId))
		.get();
	return col?.boardId ?? null;
}

/** The card a subtask belongs to, or null if there is no such subtask. */
export function getSubtaskCardId(subtaskId: number): number | null {
	const sub = db.select({ cardId: subtasks.cardId }).from(subtasks).where(eq(subtasks.id, subtaskId)).get();
	return sub?.cardId ?? null;
}

/** The board a piece of work lives on — a subtask inherits its card's. */
export function getWorkBoardId(ref: WorkRef): number | null {
	if (ref.kind === 'card') return getCardBoardId(ref.id);
	const cardId = getSubtaskCardId(ref.id);
	return cardId === null ? null : getCardBoardId(cardId);
}

/** "#123" for a card, "subtask #45" for a subtask — used in messages. */
export function describeWork(ref: WorkRef): string {
	return ref.kind === 'subtask' ? `subtask #${ref.id}` : `#${ref.id}`;
}
