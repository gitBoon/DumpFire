/**
 * dnd-handlers.ts — Drag-and-drop orchestration for columns and cards.
 *
 * Contains the complex DnD finalize logic including:
 * - Subtask/sub-board validation when moving to the Complete column
 * - On Hold note prompting when moving to the On Hold column
 * - On Hold note clearing when moving out of On Hold, on the page only: the
 *   server clears the stored note in the move itself (card 2208)
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
	| { action: 'committed'; movedCards: { card: CardType; fromName: string; toName: string; isComplete: boolean }[]; updatedColumns: ColumnType[] }
	/** The server did not take the move, in its own words: the page puts the columns back and says so. */
	| { action: 'refused'; message: string };

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
				// The sub-board the modal offers to open: one on the card with open
				// cards. None when only sub-boards the caller cannot open hold it back.
				const subBoardId = reason === 'subboard' ? (card.subBoards.find((sb) => sb.done < sb.total)?.id ?? null) : null;
				return {
					action: 'blocked',
					blockedState: { show: true, card, incomplete: count, reason, subBoardId }
				};
			}
		}
	}

	// ── Check: cards moving OUT of On Hold → clear the page's copy of the note ──
	// The server clears the note itself, in the move (card 2208). The page used
	// to send a second request to clear it, before the move and without reading
	// the answer, which wrote an entry and a `card.updated` of its own. Its own
	// copy is cleared so the card's face shows no note before the board is read
	// again.
	if (!isOnHoldColumn(targetCol.title)) {
		for (const card of newItems) {
			if (card.columnId !== columnId) {
				const oldCol = columns.find((c) => c.id === card.columnId);
				if (oldCol && isOnHoldColumn(oldCol.title) && card.onHoldNote) {
					card.onHoldNote = '';
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

	// The answer is read: a move the server refused (a card it will not
	// complete, a board the caller may not edit) was shown as done, with its
	// sound, and was put back by the next reload without a word.
	let res: Response;
	try {
		res = await api.reorderCards(updates, boardId, userName, userEmoji);
	} catch {
		return { action: 'refused', message: 'No answer from the server. The move may not have been saved.' };
	}
	if (!res.ok) return { action: 'refused', message: await api.failureMessage(res, 'The move was not saved.') };

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
