/**
 * card-window.svelte.ts — the card window's controller: which card the window
 * is open on, that card as the board has it now, and the window's save and
 * archive (card 2280, slice B2c of card 2012's part B; its decision 10). The
 * board page uses it on its board state; All Tasks, All To Do and the plan
 * page use it over their own lists, through `./page-card-window.svelte.ts`
 * (card 2281, slice C3a-1).
 *
 *   - **Open.** The window is opened on a card by its id, and shows the
 *     board's own copy of it (`card`), not the copy it was opened from: a
 *     drag's or the blocked window's copy is stale once a write is answered
 *     or taken back (the B2b review). It follows the board as each read
 *     arrives, so a sub-board linked or deleted shows in the window. Each of
 *     the window's twelve typed fields that the user has not touched follows
 *     it too, and one touched stays as typed: the window hands its follow
 *     `$effect` the controller's `edits` (`WindowEdits`, slice B5d), which
 *     brings back only untouched fields. Its subtask list is filled once per
 *     card. A card the board loses (archived, deleted, moved to another board
 *     by someone else) is kept as last found, `gone` says so, and a save of
 *     it is refused with no request.
 *   - **Save.** A saved card sends only the fields the user touched and
 *     changed (`changedFields`, against what `edits` says each started from),
 *     so a change someone else made to a field while the window was open is
 *     not sent back over theirs (the lost update card 2183 noted; found
 *     nearby B3 of the plan). A field both changed is still the last save's
 *     (a touched field is sent when it differs from what it showed when the
 *     user touched it). It goes through the board state's
 *     `writeCard`: shown on the board at once, held while it is out, on
 *     success the answer's value of each field sent taken (and no other), on
 *     a refusal or no answer those fields alone put back, each only while the
 *     board still shows what this save set, and the server's words given back
 *     for the page to say, with the window left open on what was typed. A
 *     new card is made with its pending subtasks, labels, assignees and
 *     sub-boards, each answer read and each refusal named; the board is then
 *     read once, since a new card with all that is the reader's to draw.
 *   - **Archive**, once the page's confirm is pressed: the card is taken off
 *     the board and its window closed only once the server has archived it.
 *
 * The controller says nothing itself: what to tell the reader comes back in
 * order (`told`), and the page puts it in its toasts.
 */
import * as api from '$lib/api';
import * as cardActions from '$lib/board/card-actions';
import type { CardType } from '$lib/types';
import { removeCard } from './board-patches';
import type { BoardState, WriteWords } from './board-state.svelte';

/** What the card window hands its `onSave`: the object `save()` in `CardModal.svelte` builds. */
export type CardWindowSave = {
	title: string;
	description: string;
	priority: string;
	categoryId: number | null;
	dueDate: string | null;
	onHoldNote?: string;
	businessValue?: string;
	summary?: string | null;
	theme?: string | null;
	customerImpact?: string | null;
	closeReason?: string | null;
	releaseState?: string | null;
	pendingSubtasks?: string[];
	pendingAssigneeIds?: number[];
	pendingSubBoards?: string[];
	pendingLabelIds?: number[];
};

/** The card's own fields the window edits and a save sends. */
export const WINDOW_FIELDS = [
	'title',
	'description',
	'priority',
	'categoryId',
	'dueDate',
	'onHoldNote',
	'businessValue',
	'summary',
	'theme',
	'customerImpact',
	'closeReason',
	'releaseState'
] as const;

export type WindowField = (typeof WINDOW_FIELDS)[number];

/** The value of each of `WINDOW_FIELDS` a window shows. */
export type WindowFields = Record<WindowField, string | number | null>;

/**
 * The fields as the window fills them when it opens on `card`: CardModal's
 * own initialisers (`let title = $state(card?.title || '')` and the rest),
 * which `tests/card-window.test.ts` runs from its source to hold the two
 * alike.
 */
export function windowFields(card: CardType): WindowFields {
	return {
		title: card.title || '',
		description: card.description || '',
		priority: card.priority || 'medium',
		categoryId: card.categoryId ?? null,
		dueDate: card.dueDate || '',
		onHoldNote: card.onHoldNote || '',
		businessValue: card.businessValue || '',
		summary: card.summary || '',
		theme: card.theme || '',
		customerImpact: card.customerImpact || '',
		closeReason: card.closeReason || '',
		releaseState: card.releaseState || ''
	};
}

/** The fields the window's save trims before it sends them. */
const TRIMMED: readonly WindowField[] = ['title', 'summary', 'customerImpact'];

/**
 * A field's value as a save and an opened window are compared: empty, null
 * and left out are one value (the window sends an emptied box as `''` or
 * `null` and an untouched empty one as either, or not at all), and a field
 * the window trims is compared trimmed.
 */
function comparable(field: WindowField, value: string | number | null | undefined): string | number | null {
	if (value === undefined || value === null || value === '') return null;
	if (typeof value === 'string' && TRIMMED.includes(field)) return value.trim() || null;
	return value;
}

/**
 * Of what the window saves, the fields that differ from what it started them
 * from (`WindowEdits.started`; what it opened on, for a window that does not
 * follow its card), each as the window sends it: what a save of a saved card
 * sends, and all it sends.
 */
export function changedFields(opened: WindowFields, saved: CardWindowSave): Partial<Pick<CardWindowSave, WindowField>> {
	const changed: Partial<Record<WindowField, unknown>> = {};
	for (const field of WINDOW_FIELDS) {
		const value = saved[field];
		if (value === undefined) continue;
		if (comparable(field, value) !== comparable(field, opened[field])) changed[field] = value;
	}
	return changed as Partial<Pick<CardWindowSave, WindowField>>;
}

/**
 * What a window that follows its card started each typed field from, and
 * which of them the user has touched (card 2280, slice B5d; the B2c review's
 * note 4). The board page hands its window the controller's (`edits`), and
 * the window calls `follow` from its one follow `$effect`, as it is made and
 * again after each read of the board and each change typed.
 *
 *   - A field is **touched** once the window shows a value for it other than
 *     the one it last gave it (filled with, or brought by a read), and stays
 *     touched until the window closes, even typed back: it is never brought
 *     again, so it stays as typed. (Picking the value already shown changes
 *     nothing, so is no touch.)
 *   - An **untouched** field follows the board: `follow` brings back each one
 *     whose value on the board has changed, for the window to show, and takes
 *     that as the value the field started from.
 *   - A save is compared with `started` (`changedFields`). An untouched field
 *     equals it, so is never sent: a field only someone else changed is not
 *     sent back (the lost update stays closed). A touched one is sent when it
 *     differs from the value it had when it was touched, so picking again a
 *     value someone else changed away from is sent; and when it is set back
 *     to that value while the board's has moved since, since what the window
 *     shows is the user's choice (`#update`, the B5d review).
 */
export class WindowEdits {
	/** The value each field started from: what the window was filled with, then, for an untouched field, each value a read brought. */
	started: WindowFields | null = null;
	/** The fields the user has touched since the window opened. */
	readonly touched = new Set<WindowField>();
	#begun = false;

	/**
	 * Given the fields as the window shows them and the card's as the board has
	 * it now (null for a New Task window), marks each field shown with a value
	 * other than the one it started from as touched, and brings back the
	 * untouched fields the board has changed: all the window may set. `held`,
	 * the field whose box has the focus, is not brought, nor started from,
	 * until a call without it (the B5d review): a value set into the box being
	 * typed in moves its caret. The focus alone is no touch.
	 */
	follow(shown: WindowFields, now: WindowFields | null, held: WindowField | null = null): Partial<WindowFields> {
		// The first call is the window just made, with its fields as it filled them.
		if (!this.#begun) {
			this.#begun = true;
			this.started = { ...shown };
		}
		const started = this.started!;
		for (const field of WINDOW_FIELDS) {
			if (shown[field] !== started[field]) this.touched.add(field);
		}
		const brought: Partial<WindowFields> = {};
		if (!now) return brought;
		for (const field of WINDOW_FIELDS) {
			if (this.touched.has(field) || field === held || now[field] === started[field]) continue;
			started[field] = now[field];
			brought[field] = now[field];
		}
		return brought;
	}
}

/** One thing to tell the reader: a failure, or what was done. */
export type Told = { message: string; failed: boolean };

/** What a save came to: the words for a save that made or changed nothing, or what to tell the reader of one that did. */
export type SaveResult = { ok: false; failure: string } | { ok: true; told: Told[] };

/** What the controller needs of the board state: the board page's `BoardState`. */
export type CardWindowBoard = Pick<BoardState, 'columns' | 'labels' | 'boardUsers' | 'writeCard' | 'hold' | 'refresh'>;

/** Said in the window, and given back for a save, while the card it is open on is no longer on the board (the B2c review). */
export const CARD_GONE = 'This card is no longer on this board.';

/** What a saved card's save says when it is refused (the server's words, where it gives none) and when it gets no answer. */
const SAVE_WORDS: WriteWords = {
	refused: 'The card was not saved.',
	noAnswer: 'No answer from the server. The card may not have been saved.'
};

export class CardWindow {
	/** Whether the window is shown. */
	open = $state(false);
	/** The card it is open on; null for a New Task window. */
	cardId = $state<number | null>(null);
	/** The column a New Task window makes its card in; a saved card's column as it opened. */
	columnId = $state<number | null>(null);
	/**
	 * The card as last found on the board: shown if the board loses it. Not
	 * state: it changes only as `card` is read, which the window's markup
	 * does on every draw.
	 */
	#last: CardType | null = null;
	/**
	 * What the window started each field from, which a save is compared with,
	 * and which fields the user has touched (slice B5d): a new one for each
	 * window, handed to it by the page. Its `started` is first the fields of
	 * the card `card` first gives after the window is opened, which is the
	 * card the window is made with (the B2c review: taken at `openCard`, a
	 * read drawn before the window was made filled it with newer values, and
	 * a later save sent them over a third change); the window's follow takes
	 * over from there. Raw state: which `WindowEdits` it is is state, since the
	 * board page draws the window inside `{#key cardWindow.edits}`, so a new
	 * one is a new window (the B5d review); what is in it is not, since the
	 * window's follow `$effect` writes it.
	 */
	edits = $state.raw(new WindowEdits());
	#board: CardWindowBoard;
	#boardId: number;

	constructor(board: CardWindowBoard, boardId: number) {
		this.#board = board;
		this.#boardId = boardId;
	}

	/**
	 * The card the window is open on, as the board has it now, or as last
	 * found if the board has lost it; null for a New Task window.
	 */
	get card(): CardType | null {
		if (this.cardId === null) return null;
		const found = this.#find(this.cardId);
		if (found) this.#last = found;
		const card = found ?? this.#last;
		// The first read after opening is the window being made with it.
		if (card && !this.edits.started) this.edits.started = windowFields(card);
		return card;
	}

	/** Whether the card the window is open on is no longer on the board. */
	get gone(): boolean {
		return this.cardId !== null && !this.#find(this.cardId);
	}

	/** Open the window on `card`: the board's own copy of it, found by its id. */
	openCard(card: CardType) {
		const shown = this.#find(card.id) ?? card;
		this.#last = shown;
		this.edits = new WindowEdits();
		this.cardId = card.id;
		this.columnId = shown.columnId;
		this.open = true;
	}

	/** Open a New Task window, to make a card in `columnId`. */
	openNew(columnId: number) {
		this.#last = null;
		this.edits = new WindowEdits();
		this.cardId = null;
		this.columnId = columnId;
		this.open = true;
	}

	close() {
		this.open = false;
		this.cardId = null;
		this.columnId = null;
		this.#last = null;
		this.edits = new WindowEdits();
	}

	/**
	 * Save what the window hands its `onSave`. On success the window is
	 * closed; on a refusal or no answer it stays open, with what was typed,
	 * and the words to say come back.
	 */
	save(saved: CardWindowSave): Promise<SaveResult> {
		return this.cardId === null ? this.#create(saved) : this.#update(this.cardId, saved);
	}

	/**
	 * Archive a card (`api.deleteCard`), once the page's confirm is pressed:
	 * the card window's Archive, and the card menu's. Held while it is out.
	 * Only once the server has archived it is it taken off the board, as
	 * answered, and its window closed. Returns what to tell the reader when it
	 * was not archived, and null when it was.
	 */
	async archive(cardId: number): Promise<string | null> {
		const boardState = this.#board;
		const release = boardState.hold();
		try {
			const failure = await api.deleteFailure(() => cardActions.deleteCard(cardId, this.#boardId), 'card', 'archived');
			if (failure) return failure;
			if (this.cardId === cardId) this.close();
			boardState.columns = removeCard(boardState.columns, cardId).columns;
			return null;
		} finally {
			release();
		}
	}

	#find(cardId: number): CardType | undefined {
		for (const column of this.#board.columns) {
			const found = column.cards.find((card) => card.id === cardId);
			if (found) return found;
		}
		return undefined;
	}

	/**
	 * A saved card: the fields that differ from what the window started them
	 * from, and nothing else. In a window that follows its card those are the
	 * fields the user touched and changed (slice B5d); and a touched field set
	 * back to its start while the board's value has moved since, which the
	 * window shows as the user's choice (the B5d review: it was not sent, and
	 * nothing said so).
	 */
	async #update(cardId: number, saved: CardWindowSave): Promise<SaveResult> {
		const boardState = this.#board;
		// Not on the board any more: nothing is sent, and the window stays open.
		if (this.gone) return { ok: false, failure: CARD_GONE };
		const card = this.card;
		const started = this.edits.started ?? windowFields(card!);
		const changed: Partial<Record<WindowField, unknown>> = changedFields(started, saved);
		const now = windowFields(card!);
		for (const field of this.edits.touched) {
			const value = saved[field];
			if (field in changed || value === undefined) continue;
			if (comparable(field, now[field]) !== comparable(field, started[field])) changed[field] = value;
		}
		// Nothing changed: nothing is sent, and the window is closed.
		if (Object.keys(changed).length === 0) {
			this.close();
			return { ok: true, told: [] };
		}
		const written = await boardState.writeCard(cardId, changed as Partial<CardType>, () => api.updateCard(cardId, { ...changed, boardId: this.#boardId }), SAVE_WORDS);
		if (!written.ok) return { ok: false, failure: written.failure };
		if (this.cardId === cardId) this.close();
		return { ok: true, told: [{ message: 'Card updated', failed: false }] };
	}

	/**
	 * A new card, with what its window gathered before it was made: its
	 * subtasks and its template's labels (`cardActions.saveCard`), then the
	 * people chosen and its sub-boards, each answer read and each refusal
	 * named, the card kept whatever becomes of them. The board's reads are
	 * held until the last is answered, and the board is read once then.
	 */
	async #create(saved: CardWindowSave): Promise<SaveResult> {
		const boardState = this.#board;
		const release = boardState.hold();
		try {
			const result = await cardActions.saveCard(null, this.columnId, this.#boardId, boardState.columns, saved);
			// No card was made: the window stays open with what was typed.
			if (result.failure) return { ok: false, failure: result.failure };
			if (this.cardId === null) this.close();
			if (!result.isNew || !result.cardId) return { ok: true, told: [] };
			const title = saved.title;
			const told: Told[] = [{ message: `Created "${title}"`, failed: false }];

			// A label of its template that was not put on it (card 2163). One
			// deleted while the window was open is no longer among the board's,
			// and is not named by its number, which says nothing.
			for (const { labelId, message } of result.labelFailures ?? []) {
				const label = boardState.labels.find((label) => label.id === labelId);
				const named = label ? `The template's label "${label.name}"` : 'A label of the template that no longer exists';
				told.push({ message: `${named} was not put on "${title}". ${message}`, failed: true });
			}

			// A pending subtask that was not made (slice B2b).
			for (const { title: subtask, message } of result.subtaskFailures ?? []) {
				told.push({ message: `Subtask "${subtask}" was not added to "${title}". ${message}`, failed: true });
			}

			// The people chosen, each in turn (slice B2b).
			if (saved.pendingAssigneeIds?.length) {
				for (const { userId, message } of await cardActions.assignPending(result.cardId, saved.pendingAssigneeIds)) {
					const member = boardState.boardUsers.find((user) => user.id === userId);
					const named = member ? `"${member.username}"` : 'Someone no longer on this board';
					told.push({ message: `${named} was not assigned to "${title}". ${message}`, failed: true });
				}
			}

			// Its sub-boards. One refused is named in the server's words: on a
			// board nested as deep as sub-boards may be, every one is (card 2172).
			for (const name of saved.pendingSubBoards ?? []) {
				let res: Response;
				try {
					res = await fetch('/api/boards', {
						method: 'POST',
						headers: { 'Content-Type': 'application/json' },
						body: JSON.stringify({ name, parentCardId: result.cardId })
					});
				} catch {
					told.push({ message: `No answer from the server. Sub-board "${name}" may not have been made.`, failed: true });
					continue;
				}
				if (res.ok) told.push({ message: `Sub-board "${name}" created`, failed: false });
				else told.push({ message: `Sub-board "${name}" was not made. ${await api.failureMessage(res, 'The server refused it.')}`, failed: true });
			}

			// Read once: a new card with its subtasks, labels, assignees and
			// sub-boards is the reader's to draw, not a bare row's.
			boardState.refresh();
			return { ok: true, told };
		} finally {
			release();
		}
	}
}
