/**
 * dnd-handlers.ts — Drag-and-drop orchestration for columns and cards.
 *
 * Contains the complex DnD finalize logic including:
 * - Subtask/sub-board validation when moving to the Complete column
 * - On Hold note prompting when moving to the On Hold column
 * - On Hold note clearing when moving out of On Hold
 * - Activity logging for card movements
 * - Position persistence via the API
 *
 * These functions accept board state as parameters and return
 * action descriptors that the board page uses to update its $state.
 */

import * as api from '$lib/api';
import type { CardType, ColumnType, OnHoldState, BlockedState } from '$lib/types';
import {
	isCompleteColumn,
	isOnHoldColumn,
	isCardBlocked,
	hasIncompleteSubBoard,
	incompleteCount,
	subBoardIncompleteCount
} from '$lib/utils/card-utils';

/**
 * Result of processing a card DnD finalize event.
 * The board page reads this to decide what state updates to apply.
 */
export type DndFinalizeResult =
	| { action: 'blocked'; blockedState: BlockedState }
	| { action: 'on-hold'; onHoldState: OnHoldState; updatedColumns: ColumnType[] }
	| { action: 'committed'; movedCards: { card: CardType; fromName: string; toName: string; isComplete: boolean }[]; updatedColumns: ColumnType[] };

/**
 * Processes a card DnD finalize event with all the complex business logic.
 *
 * @param columnId — The target column ID where cards were dropped.
 * @param newItems — The new card array from svelte-dnd-action.
 * @param boardColumns — The current board columns (will be cloned, not mutated).
 * @param boardId — The board ID for API calls.
 * @param userName — Current user name for activity logging.
 * @param userEmoji — Current user emoji for activity logging.
 */
export async function handleCardDndFinalize(
	columnId: number,
	newItems: CardType[],
	boardColumns: ColumnType[],
	boardId: number,
	userName: string,
	userEmoji: string
): Promise<DndFinalizeResult> {
	const columns = boardColumns.map(c => ({ ...c, cards: [...c.cards] }));
	const targetCol = columns.find((c) => c.id === columnId);
	if (!targetCol) {
		return { action: 'committed', movedCards: [], updatedColumns: columns };
	}

	// ── Check: blocked cards moving to Complete ──
	if (isCompleteColumn(targetCol)) {
		for (const card of newItems) {
			if (card.columnId !== columnId && isCardBlocked(card)) {
				const reason = hasIncompleteSubBoard(card) ? 'subboard' as const : 'subtasks' as const;
				const count = reason === 'subboard' ? subBoardIncompleteCount(card) : incompleteCount(card);
				return {
					action: 'blocked',
					blockedState: { show: true, card, incomplete: count, reason }
				};
			}
		}
	}

	// ── Check: cards moving OUT of On Hold → clear the note ──
	if (!isOnHoldColumn(targetCol.title)) {
		for (const card of newItems) {
			if (card.columnId !== columnId) {
				const oldCol = columns.find((c) => c.id === card.columnId);
				if (oldCol && isOnHoldColumn(oldCol.title) && card.onHoldNote) {
					card.onHoldNote = '';
					api.updateCard(card.id, { onHoldNote: '', boardId });
				}
			}
		}
	}

	// ── Check: cards moving INTO On Hold → prompt for note ──
	if (isOnHoldColumn(targetCol.title)) {
		for (const card of newItems) {
			if (card.columnId !== columnId) {
				// Build the full updates array for later commit
				const allUpdates: { id: number; columnId: number; position: number }[] = [];
				targetCol.cards = newItems;
				for (const column of columns) {
					for (let i = 0; i < column.cards.length; i++) {
						allUpdates.push({ id: column.cards[i].id, columnId: column.id, position: i });
					}
				}
				return {
					action: 'on-hold',
					onHoldState: {
						show: true,
						cardId: card.id,
						cardTitle: card.title,
						note: card.onHoldNote || '',
						pendingUpdates: allUpdates,
						pendingColumnId: columnId
					},
					updatedColumns: columns
				};
			}
		}
	}

	// ── Normal commit: update positions and log movements ──
	targetCol.cards = newItems;
	const movedCards = newItems.filter(card => card.columnId !== columnId);

	const updates: { id: number; columnId: number; position: number }[] = [];
	for (const column of columns) {
		for (let i = 0; i < column.cards.length; i++) {
			updates.push({ id: column.cards[i].id, columnId: column.id, position: i });
		}
	}

	await api.reorderCards(updates, boardId, userName, userEmoji);

	const movedEntries = movedCards.map(card => {
		const fromCol = columns.find(c => c.id === card.columnId);
		return {
			card,
			fromName: fromCol?.title || '?',
			toName: targetCol.title,
			isComplete: isCompleteColumn(targetCol)
		};
	});

	return { action: 'committed', movedCards: movedEntries, updatedColumns: columns };
}

/**
 * Confirms an On Hold move — saves the note and commits the card reorder.
 */
export async function confirmOnHold(
	onHoldState: OnHoldState,
	boardId: number,
	userName: string,
	userEmoji: string
): Promise<void> {
	await api.updateCard(onHoldState.cardId, { onHoldNote: onHoldState.note });
	await api.reorderCards(onHoldState.pendingUpdates, boardId, userName, userEmoji);
}

/**
 * Persists a new column ordering after drag-and-drop.
 */
export async function handleColumnDndFinalize(
	columns: ColumnType[],
	boardId: number
): Promise<void> {
	const updates = columns.map((col, i) => ({ id: col.id, position: i }));
	await api.reorderColumns(updates, boardId);
}
