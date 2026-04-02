/**
 * bulk-actions.ts — Bulk card operations (move, delete, priority).
 *
 * These are used by the BulkActionBar component and accept the
 * board state as parameters instead of accessing Svelte $state directly.
 */

import * as api from '$lib/api';

/**
 * Moves all selected cards into a target column.
 * Positions them at the end of the target column.
 */
export async function bulkMove(
	selectedCardIds: Set<number>,
	targetColumnId: number,
	targetColumnCardCount: number,
	boardId: number,
	userName: string,
	userEmoji: string
): Promise<void> {
	const updates: { id: number; columnId: number; position: number }[] = [];
	let pos = targetColumnCardCount;
	for (const cardId of selectedCardIds) {
		updates.push({ id: cardId, columnId: targetColumnId, position: pos++ });
	}
	await api.reorderCards(updates, boardId, userName, userEmoji);
}

/**
 * Deletes all selected cards one-by-one.
 * Sequential to avoid race conditions on the server.
 */
export async function bulkDelete(
	selectedCardIds: Set<number>,
	boardId: number
): Promise<void> {
	for (const cardId of selectedCardIds) {
		await api.deleteCard(cardId, boardId);
	}
}

/**
 * Sets the priority on all selected cards.
 */
export async function bulkPriority(
	selectedCardIds: Set<number>,
	priority: string,
	boardId: number
): Promise<void> {
	for (const cardId of selectedCardIds) {
		await api.updateCard(cardId, { priority, boardId });
	}
}
