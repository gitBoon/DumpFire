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
 * Archives all selected cards one-by-one (`api.deleteCard` archives).
 * Sequential to avoid race conditions on the server.
 *
 * @returns How many the server said were archived, and each card that was
 * not, with what to tell the reader about it.
 */
export async function bulkDelete(
	selectedCardIds: Set<number>,
	boardId: number
): Promise<{ archived: number; failed: { cardId: number; message: string }[] }> {
	let archived = 0;
	const failed: { cardId: number; message: string }[] = [];
	for (const cardId of selectedCardIds) {
		const message = await api.deleteFailure(() => api.deleteCard(cardId, boardId), 'card', 'archived');
		if (message) failed.push({ cardId, message });
		else archived++;
	}
	return { archived, failed };
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
