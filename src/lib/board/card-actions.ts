/**
 * card-actions.ts — Card-level mutations and context menu actions.
 *
 * Handles card CRUD, duplication, pinning, and sub-board management.
 * All functions accept IDs/data as parameters and return promises.
 */

import * as api from '$lib/api';
import { firstOpenColumn, isCompleteColumnTitle } from '$lib/column-role';
import type { CardType, ColumnType, SubBoardType } from '$lib/types';
import { categoryToCopy, colourToCopy, dueDateToCopy, priorityToCopy } from '$lib/utils/card-utils';

// ─── Card CRUD ───────────────────────────────────────────────────────────────

/**
 * A label from a new card's template that was not put on it: see `saveCard`.
 * The page names the label, which it holds and this does not.
 */
export type LabelFailure = {
	labelId: number;
	/** The server's words for the refusal, or what is said when there was no answer. */
	message: string;
};

/**
 * Saves a card — either creates a new one or updates an existing one.
 * Also handles creating pending subtasks for newly created cards, and putting
 * on a new card the labels of the template it was made from (card 2163).
 *
 * No colour tag is sent: the card window has no control for one, and it sent
 * an empty one with every save, which cleared a tag set through the API
 * (card 2147).
 *
 * Each of `pendingLabelIds` is put on the new card with `PUT /api/labels`,
 * which adds a label a card does not have, as a new card has none. Each answer
 * is read, and a label that was not put on comes back in `labelFailures`, for
 * the page to say. The card is kept whatever becomes of a label, as it is
 * whatever becomes of a pending subtask.
 *
 * A create the server refuses, or that gets no answer, makes no card: it is
 * given back as `failure`, the server's words where it gave them, with
 * `isNew` false, and nothing else is sent. It used to come back as created.
 *
 * @returns `{ isNew, title }` for activity logging by the caller, with the new
 * card's id and `labelFailures` when a card was created, and `failure` when
 * one was not.
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
		categoryId: number | null;
		dueDate: string | null;
		onHoldNote?: string;
		businessValue?: string;
		// Reporting fields travel straight through to the API with the rest of
		// the card; null clears a value, undefined leaves it alone.
		summary?: string | null;
		theme?: string | null;
		customerImpact?: string | null;
		closeReason?: string | null;
		releaseState?: string | null;
		pendingSubtasks?: string[];
		/** A new card's labels, from the template it was made from: put on once it is made. */
		pendingLabelIds?: number[];
	}
): Promise<{ isNew: boolean; title: string; cardId?: number; labelFailures?: LabelFailure[]; failure?: string }> {
	const { pendingSubtasks, pendingLabelIds, ...rest } = cardData;
	if (editingCard) {
		// Update existing card
		await api.updateCard(editingCard.id, { ...rest, boardId });
		return { isNew: false, title: editingCard.title };
	} else if (cardModalColumnId) {
		// Create new card
		const col = columns.find((c) => c.id === cardModalColumnId);
		const maxPos = col && col.cards.length > 0 ? Math.max(...col.cards.map((c) => c.position)) + 1 : 0;
		let res: Response;
		try {
			res = await api.createCard({
				columnId: cardModalColumnId,
				position: maxPos,
				boardId,
				...rest
			});
		} catch {
			return { isNew: false, title: cardData.title, failure: 'No answer from the server. The card may not have been created.' };
		}
		if (!res.ok) {
			return { isNew: false, title: cardData.title, failure: await api.failureMessage(res, 'The card was not created.') };
		}
		const labelFailures: LabelFailure[] = [];
		const newCard = await res.json();
		// Create pending subtasks for the new card
		if (pendingSubtasks && pendingSubtasks.length > 0) {
			for (let i = 0; i < pendingSubtasks.length; i++) {
				const stData = JSON.parse(pendingSubtasks[i]);
				await api.createSubtask({
					cardId: newCard.id,
					title: stData.title,
					description: stData.description || '',
					priority: stData.priority || 'medium',
					// Only a colour the server takes (card 2162, decision 4), so a
					// pending subtask is made even if its colour tag is no colour.
					colorTag: colourToCopy(stData.colorTag),
					dueDate: stData.dueDate || null,
					completed: false,
					boardId
				});
			}
		}
		// The template's labels, each once: a second toggle of one would take it off.
		for (const labelId of new Set(pendingLabelIds ?? [])) {
			let put: Response;
			try {
				put = await api.toggleLabel(newCard.id, labelId, boardId);
			} catch {
				labelFailures.push({ labelId, message: 'No answer from the server, so it may be on the card after all.' });
				continue;
			}
			if (!put.ok) labelFailures.push({ labelId, message: await api.failureMessage(put, 'It was refused.') });
		}
		return { isNew: true, title: cardData.title, cardId: newCard.id, labelFailures };
	}
	return { isNew: false, title: '' };
}

/** Where a navigation came from or went to, as SvelteKit's `afterNavigate` gives it: the parts read here. */
type NavigatedTo = { params: Record<string, string> | null; url: URL } | null;

/**
 * Whether a navigation closes the board page's card window before the card
 * the new address names, if any, is opened (Q-F's review).
 *
 * - A navigation to another board closes it, a card named or not. A link
 *   back to another board left the first board's card open over it, with the
 *   wrong board's labels, and its pickers were refused. (Card 2184's layout
 *   now makes the page afresh for each board, which closes it too.)
 * - On the same board, a saved card's window is closed when the new address
 *   names no card: Back after a link that opened it left it open.
 *
 * A New Task window is kept on the same board: no address names it. A first
 * load, with no `from`, has no window to close.
 */
export function navigationClosesWindow(from: NavigatedTo, to: NavigatedTo, openOnACard: boolean): boolean {
	if (from?.params?.id !== to?.params?.id) return true;
	return openOnACard && !to?.url.searchParams.has('card');
}

/** Archives a card (`api.deleteCard`). Returns the answer, for the caller to check. */
export async function deleteCard(cardId: number, boardId: number): Promise<Response> {
	return api.deleteCard(cardId, boardId);
}

// ─── Card Actions ────────────────────────────────────────────────────────────

/** What became of a duplicate: see `duplicateCard`. */
export type DuplicateResult = {
	/** The title of the card that was copied, once the copy is made, and null when it was not. */
	title: string | null;
	/** What to tell the reader when the copy, or one of its subtasks, was not made: the server's words where it gave them. */
	failure: string | null;
	/**
	 * The title of the column the copy was made in, when it is not the
	 * original's: the copy of a card in a Complete column goes to the board's
	 * first open column (`columnForCopy`), and the reader is told where. Absent
	 * when the copy is beside the original, or was not made.
	 */
	into?: string;
};

/**
 * The column a copy of a card in `col` is made in: `col`, unless it is a
 * Complete column (card 2134, R1).
 *
 * A card created in a Complete column is completed as it is created: the
 * date, XP and fireworks for whoever made it, and a `card_completed` entry.
 * A copy is new work, and the copy of a finished card would be counted as
 * delivered work nobody did; dragged back to be worked on, it would earn
 * nothing when it was really finished. So it goes to the board's first column,
 * by position, that is not a Complete column. A board with no such column
 * keeps it beside the original, where it is completed.
 */
export function columnForCopy(col: ColumnType, columns: ColumnType[]): ColumnType {
	if (!isCompleteColumnTitle(col.title)) return col;
	return firstOpenColumn(columns) ?? col;
}

/**
 * Duplicates a card (including its subtasks) and places the copy at the
 * end of the same column, or for a card in a Complete column at the end of
 * the board's first open column (`columnForCopy`).
 *
 * The copy is a new card made from the stored values of the old one, and the
 * server checks it as it checks any new card, so it can be refused. It used
 * to be said to be "Duplicated" whatever the answer was. Each subtask is then
 * copied in turn, and the first that is refused stops the rest: the copy is
 * kept, and the failure says how many of its subtasks it has.
 *
 * A value stored before the server's rules, which the copy would have refused,
 * is not copied, and the server's default is taken: a colour tag that is not
 * `#rrggbb`, a priority not one of the four, a due date not `YYYY-MM-DD` (but
 * the date at the start of a timestamp), and a category that is neither the
 * board's nor shared, which is why `categories` is the board's list.
 */
export async function duplicateCard(
	card: CardType,
	columns: ColumnType[],
	boardId: number,
	categories: { id: number; boardId: number | null }[]
): Promise<DuplicateResult> {
	const col = columns.find(c => c.cards.some(cc => cc.id === card.id));
	if (!col) return { title: null, failure: null };
	const to = columnForCopy(col, columns);
	/** Once the copy is made: the original's title, what failed, and where the copy is when not beside it. */
	const made = (failure: string | null): DuplicateResult => ({
		title: card.title,
		failure,
		...(to.id === col.id ? {} : { into: to.title })
	});
	const maxPos = to.cards.length;
	let res: Response;
	try {
		res = await api.createCard({
			columnId: to.id,
			position: maxPos,
			boardId,
			// A title is at most 500 characters: one of 494 or more, with " (Copy)", would be refused.
			title: `${card.title.slice(0, 500 - ' (Copy)'.length)} (Copy)`,
			description: card.description || '',
			priority: priorityToCopy(card.priority),
			colorTag: colourToCopy(card.colorTag),
			categoryId: categoryToCopy(card.categoryId, boardId, categories),
			dueDate: dueDateToCopy(card.dueDate)
		});
	} catch {
		return { title: null, failure: 'No answer from the server. The card may not have been duplicated.' };
	}
	if (!res.ok) {
		return { title: null, failure: await api.failureMessage(res, 'The card was not duplicated.') };
	}

	const subtasks = card.subtasks ?? [];
	if (subtasks.length === 0) return made(null);
	const copyId = (await api.answerBody(res))?.id;
	if (typeof copyId !== 'number') {
		return made(`"${card.title}" was duplicated without its subtasks: the answer did not say which card is the copy.`);
	}
	let copied = 0;
	for (const st of subtasks) {
		let sent: Response | null;
		try {
			sent = await api.createSubtask({
				cardId: copyId,
				title: st.title,
				description: st.description || '',
				priority: priorityToCopy(st.priority),
				colorTag: colourToCopy(st.colorTag),
				dueDate: dueDateToCopy(st.dueDate),
				completed: false,
				boardId
			});
		} catch {
			sent = null;
		}
		if (!sent?.ok) {
			const why = sent ? await api.failureMessage(sent, 'It was refused.') : 'No answer from the server.';
			const after = subtasks.length - copied - 1;
			return made(
				`"${card.title}" was duplicated with ${copied} of its ${subtasks.length} subtasks. Subtask "${st.title}" was not copied${after > 0 ? `, nor the ${after} after it` : ''}. ${why}`
			);
		}
		copied++;
	}
	return made(null);
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
 *
 * The name is held to a board's 200 characters: it is the card's title, of up
 * to 500, from the board's menu, and the server refuses a longer one.
 * @returns The new board's ID for navigation, or what to tell the reader when
 * it was not made: the server's words (a card on a board nested as deep as
 * sub-boards may be is refused, card 2172), or that there was no answer. It
 * returned null for either, and the page then did nothing.
 */
export async function createSubBoard(cardId: number, name: string): Promise<{ id: number } | { message: string }> {
	let res: Response;
	try {
		res = await api.createBoard({
			name: name.slice(0, 200),
			emoji: '🗂️',
			parentCardId: cardId
		});
	} catch {
		return { message: 'No answer from the server. The sub-board may not have been made.' };
	}
	if (res.ok) {
		const board = await res.json();
		return { id: board.id };
	}
	return { message: await api.failureMessage(res, 'The sub-board was not made.') };
}

/**
 * Puts an existing board under a card, as a sub-board. Returns the answer,
 * for the caller to check: the board's owner or an administrator may, and a
 * board cannot go under a card on itself or beneath itself.
 */
export async function linkSubBoard(cardId: number, boardId: number): Promise<Response> {
	return api.updateBoard(boardId, { parentCardId: cardId });
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

/** Deletes a sub-board via the API. Returns the answer, for the caller to check. */
export async function deleteSubBoard(boardId: number): Promise<Response> {
	return api.deleteBoardApi(boardId);
}
