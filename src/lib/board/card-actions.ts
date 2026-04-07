/**
 * card-actions.ts — Card-level mutations and context menu actions.
 *
 * Handles card CRUD, duplication, pinning, and sub-board management.
 * All functions accept IDs/data as parameters and return promises.
 */

import * as api from '$lib/api';
import type { CardType, ColumnType, SubBoardType } from '$lib/types';

// ─── Card CRUD ───────────────────────────────────────────────────────────────

/**
 * Saves a card — either creates a new one or updates an existing one.
 * Also handles creating pending subtasks for newly created cards.
 *
 * @returns `{ isNew, title }` for activity logging by the caller.
 */
export async function saveCard(
	editingCard: CardType | null,
	cardModalColumnId: number | null,
	boardId: number,
	columns: ColumnType[],
	cardData: {
		title: string;
		description: string;
		priority: string;
		colorTag: string;
		categoryId: number | null;
		dueDate: string | null;
		onHoldNote?: string;
		businessValue?: string;
		pendingSubtasks?: string[];
	}
): Promise<{ isNew: boolean; title: string; cardId?: number }> {
	const { pendingSubtasks, ...rest } = cardData;
	if (editingCard) {
		// Update existing card
		await api.updateCard(editingCard.id, { ...rest, boardId });
		return { isNew: false, title: editingCard.title };
	} else if (cardModalColumnId) {
		// Create new card
		const col = columns.find((c) => c.id === cardModalColumnId);
		const maxPos = col && col.cards.length > 0 ? Math.max(...col.cards.map((c) => c.position)) + 1 : 0;
		const res = await api.createCard({
			columnId: cardModalColumnId,
			position: maxPos,
			boardId,
			...rest
		});
		let newCardId: number | undefined;
		// Create pending subtasks for the new card
		if (res.ok) {
			const newCard = await res.json();
			newCardId = newCard.id;
			if (pendingSubtasks && pendingSubtasks.length > 0) {
				for (let i = 0; i < pendingSubtasks.length; i++) {
					const stData = JSON.parse(pendingSubtasks[i]);
					await api.createSubtask({
						cardId: newCard.id,
						title: stData.title,
						description: stData.description || '',
						priority: stData.priority || 'medium',
						colorTag: stData.colorTag || '',
						dueDate: stData.dueDate || null,
						completed: false,
						boardId
					});
				}
			}
		}
		return { isNew: true, title: cardData.title, cardId: newCardId };
	}
	return { isNew: false, title: '' };
}

/** Deletes a card and its subtasks. */
export async function deleteCard(cardId: number, boardId: number): Promise<void> {
	await api.deleteCard(cardId, boardId);
}

// ─── Card Actions ────────────────────────────────────────────────────────────

/**
 * Duplicates a card (including its subtasks) and places the copy at the
 * end of the same column.
 *
 * @returns The title of the duplicate if successful, or null on failure.
 */
export async function duplicateCard(card: CardType, columns: ColumnType[], boardId: number): Promise<string | null> {
	const col = columns.find(c => c.cards.some(cc => cc.id === card.id));
	if (!col) return null;
	const maxPos = col.cards.length;
	const res = await api.createCard({
		columnId: col.id,
		position: maxPos,
		boardId,
		title: `${card.title} (Copy)`,
		description: card.description || '',
		priority: card.priority,
		colorTag: card.colorTag || '',
		categoryId: card.categoryId,
		dueDate: card.dueDate
	});
	if (res.ok && card.subtasks?.length > 0) {
		const newCard = await res.json();
		for (const st of card.subtasks) {
			await api.createSubtask({
				cardId: newCard.id,
				title: st.title,
				description: st.description || '',
				priority: st.priority,
				colorTag: st.colorTag || '',
				dueDate: st.dueDate,
				completed: false,
				boardId
			});
		}
	}
	return card.title;
}

/** Toggles a card's pinned status. Returns the new pinned state. */
export async function togglePin(card: CardType, boardId: number): Promise<boolean> {
	const newPinned = !card.pinned;
	await api.updateCard(card.id, { pinned: newPinned, boardId });
	return newPinned;
}

// ─── Sub-boards ──────────────────────────────────────────────────────────────

/**
 * Creates a new sub-board linked to a card.
 * @returns The new board's ID for navigation, or null on failure.
 */
export async function createSubBoard(cardId: number, name: string): Promise<number | null> {
	const res = await api.createBoard({
		name,
		emoji: '🗂️',
		parentCardId: cardId
	});
	if (res.ok) {
		const board = await res.json();
		return board.id;
	}
	return null;
}

/** Links an existing board as a sub-board of a card. */
export async function linkSubBoard(cardId: number, boardId: number): Promise<void> {
	await api.updateBoard(boardId, { parentCardId: cardId });
}

/**
 * Finds the sub-board name from the column data.
 * Used to build a confirmation message before deletion.
 */
export function findSubBoardName(boardId: number, columns: ColumnType[]): string {
	for (const col of columns) {
		for (const card of col.cards) {
			const sb = card.subBoards.find((s: SubBoardType) => s.id === boardId);
			if (sb) return sb.name;
		}
	}
	return 'this sub-board';
}

/** Deletes a sub-board via the API. */
export async function deleteSubBoard(boardId: number): Promise<boolean> {
	const res = await api.deleteBoardApi(boardId);
	return res.ok;
}
