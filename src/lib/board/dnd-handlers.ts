/**
 * dnd-handlers.ts — Drag-and-drop orchestration for columns and cards.
 *
 * Contains the complex DnD finalize logic including:
 * - Subtask/sub-board validation when moving to the Complete column
 * - On Hold note prompting when moving to the On Hold column
 * - On Hold note clearing when moving out of On Hold, on the page only: the
 *   server clears the stored note in the move itself (card 2208)
 * - Activity logging for card movements
 * - Position persistence via the API, for the columns a drop touched alone
 *   (card 2213)
 * - A toast for a card the drop took across the commitment point, out of the
 *   Options column or back into it, as the server's answer says (milestone 22)
 *
 * These functions accept board state as parameters and return
 * action descriptors that the board page uses to update its $state.
 */

import { TRIGGERS } from 'svelte-dnd-action';
import * as api from '$lib/api';
import { toasts } from '$lib/stores/toast';
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
 * The positions a drop saves (card 2213): every card of the column dropped
 * into, and of each column one of `newItems` came from, numbered from 0 in
 * the order the page holds them, and no card of any other column.
 *
 * A drop used to send every card of the board. Each column is sent whole,
 * not just the cards moved, so that the column dropped into is numbered again
 * with no gap and no two cards at one position. `columns` already holds
 * `newItems` in the target column. A card still carries the column it was
 * read in until the board is read again, which is how the columns it came
 * from are known.
 */
export function touchedUpdates(
	columns: ColumnType[],
	targetColumnId: number,
	newItems: CardType[]
): { id: number; columnId: number; position: number }[] {
	const touched = new Set<number>([targetColumnId]);
	for (const card of newItems) touched.add(card.columnId);

	const updates: { id: number; columnId: number; position: number }[] = [];
	for (const column of columns) {
		if (!touched.has(column.id)) continue;
		for (let i = 0; i < column.cards.length; i++) {
			updates.push({ id: column.cards[i].id, columnId: column.id, position: i });
		}
	}
	return updates;
}

/**
 * What a drop's answer says of the commitment point (milestone 22, card
 * 2460), as the toasts to show: `Committed "<title>"` for a card taken out of
 * the Options column into a committed one, `Returned "<title>" to Options` for
 * one taken back, and the count for several. Nothing for any other drop, or
 * an answer that names neither list. The server decides, from the columns as
 * they are; `moved` gives the titles.
 */
export function commitmentToasts(answer: unknown, moved: readonly CardType[]): string[] {
	const ids = (key: string): number[] => {
		const listed = answer !== null && typeof answer === 'object' ? (answer as Record<string, unknown>)[key] : undefined;
		return Array.isArray(listed) ? listed.filter((id): id is number => typeof id === 'number') : [];
	};
	const say = (cardIds: number[], one: (title: string) => string, many: (n: number) => string): string[] => {
		if (cardIds.length === 0) return [];
		const title = cardIds.length === 1 ? moved.find((card) => card.id === cardIds[0])?.title : undefined;
		return [title !== undefined ? one(title) : many(cardIds.length)];
	};
	return [
		...say(ids('committed'), (title) => `Committed "${title}"`, (n) => `Committed ${n === 1 ? '1 card' : `${n} cards`}`),
		...say(ids('returnedToOptions'), (title) => `Returned "${title}" to Options`, (n) => `Returned ${n === 1 ? '1 card' : `${n} cards`} to Options`)
	];
}

/**
 * The folded Options strip (card 2535): its cards are hidden, so where the
 * library puts a card dropped on it means nothing; the drop's index was
 * worked out from cards no one can see. A card dropped on the folded strip
 * goes last, whatever index was reported. `folded` false (an open Options
 * column, or any other) gives the items as dropped, so a card lands where it
 * was pointed. Only the dragged card moves; the others keep their order.
 */
export function foldedDropItems<T extends { id: number }>(items: T[], draggedId: unknown, folded: boolean): T[] {
	if (!folded) return items;
	const dragged = items.find((card) => card.id === draggedId);
	if (!dragged) return items;
	return [...items.filter((card) => card !== dragged), dragged];
}

/**
 * Whether the folded strip shows that it will take the card (card 2535),
 * from the trigger of the consider event its list has just had: lit while a
 * card is over it (DRAGGED_ENTERED, and DRAGGED_OVER_INDEX as the card moves
 * about on it), out on anything else (DRAGGED_LEFT, a drag stopped). A drop
 * puts it out too: the page does that in its finalize.
 */
export function foldedDropOver(trigger: unknown): boolean {
	return trigger === TRIGGERS.DRAGGED_ENTERED || trigger === TRIGGERS.DRAGGED_OVER_INDEX;
}

/**
 * What a screen reader is told of a drop on the folded strip (card 2535):
 * `"<title>" parked in Options`, or the count for several. Nothing when a
 * commitment toast has said it already (`said`, "Returned ... to Options"),
 * as that toast is read as it shows, nor when no card came in.
 */
export function parkedInOptionsSaid(titles: readonly string[], said: readonly string[]): string {
	if (said.length > 0 || titles.length === 0) return '';
	return titles.length === 1 ? `"${titles[0]}" parked in Options` : `${titles.length} cards parked in Options`;
}

/**
 * Result of processing a card DnD finalize event.
 * The board page reads this to decide what state updates to apply.
 */
export type DndFinalizeResult =
	| { action: 'blocked'; blockedState: BlockedState }
	| { action: 'on-hold'; onHoldState: OnHoldState; updatedColumns: ColumnType[] }
	/** `updates`: each card's column and place as sent, which the page sets on its cards (card 2280, slice B2b). `said`: the commitment toasts shown (card 2535). */
	| { action: 'committed'; movedCards: { card: CardType; fromName: string; toName: string; isComplete: boolean }[]; updatedColumns: ColumnType[]; updates: { id: number; columnId: number; position: number }[]; said: string[] }
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
		return { action: 'committed', movedCards: [], updatedColumns: columns, updates: [], said: [] };
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
				// The touched columns, sent once the note is confirmed
				targetCol.cards = newItems;
				const pendingUpdates = touchedUpdates(columns, columnId, newItems);
				return {
					action: 'on-hold',
					onHoldState: {
						show: true,
						cardId: card.id,
						cardTitle: card.title,
						note: card.onHoldNote || '',
						pendingUpdates,
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

	const updates = touchedUpdates(columns, columnId, newItems);

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

	// Taken. A card that crossed the commitment point is said to have, from
	// the answer; an answer that cannot be read says nothing more.
	let answer: unknown = null;
	try {
		answer = await res.json();
	} catch {
		// Nothing more to say.
	}
	const said = commitmentToasts(answer, movedCards);
	for (const message of said) toasts.add(message);

	const movedEntries = movedCards.map(card => {
		const fromCol = columns.find(c => c.id === card.columnId);
		return {
			card,
			fromName: fromCol?.title || '?',
			toName: targetCol.title,
			isComplete: isCompleteColumn(targetCol)
		};
	});

	return { action: 'committed', movedCards: movedEntries, updatedColumns: columns, updates, said };
}

/**
 * Confirms an On Hold move: the move first, and the note only once the move
 * is taken (card 2280, slice B2b; R7). The note was sent first and neither
 * answer read, so a refused move left a note on a card that never moved and
 * said nothing. With no `pendingUpdates` (the move taken already, its note
 * refused) the note alone is sent.
 *
 * @returns `failure`: why the card was not moved, and then no note was sent;
 * `noteFailure`: why the note was not saved, the card moved. Each null when
 * there is nothing to say.
 */
export async function confirmOnHold(
	onHoldState: OnHoldState,
	boardId: number,
	userName: string,
	userEmoji: string
): Promise<{ failure: string | null; noteFailure: string | null }> {
	if (onHoldState.pendingUpdates.length > 0) {
		let moved: Response;
		try {
			moved = await api.reorderCards(onHoldState.pendingUpdates, boardId, userName, userEmoji);
		} catch {
			return { failure: 'No answer from the server. The card may not have been put on hold.', noteFailure: null };
		}
		if (!moved.ok) return { failure: await api.failureMessage(moved, 'The card was not put on hold.'), noteFailure: null };
		// An option put straight on hold is committed: said as the drop says it
		// (milestone 22, the S2 review's C7).
		const card = { id: onHoldState.cardId, title: onHoldState.cardTitle } as CardType;
		for (const message of commitmentToasts(await api.answerBody(moved), [card])) toasts.add(message);
	}
	let noted: Response;
	try {
		noted = await api.updateCard(onHoldState.cardId, { onHoldNote: onHoldState.note });
	} catch {
		return { failure: null, noteFailure: 'No answer from the server, so the note may not have been saved.' };
	}
	return { failure: null, noteFailure: noted.ok ? null : await api.failureMessage(noted, 'The note was refused.') };
}

/**
 * Persists a new column ordering after drag-and-drop. Returns the answer, for
 * the caller to check (card 2280, slice B2b).
 */
export async function handleColumnDndFinalize(
	columns: ColumnType[],
	boardId: number
): Promise<Response> {
	const updates = columns.map((col, i) => ({ id: col.id, position: i }));
	return api.reorderColumns(updates, boardId);
}
