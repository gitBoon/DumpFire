/**
 * page-card-window.svelte.ts — the card window of All Tasks, All To Do and the
 * plan page, opened, saved and archived through the board page's controller
 * (`./card-window.svelte.ts`; card 2281, slice C3a-1 of card 2012's part C).
 *
 * The controller works on a board state; these pages have none. They span
 * boards, and each draws its own list of cards from its load: All Tasks its
 * buckets, All To Do one list, the plan page the one card its window opened
 * on (read with the card's context; its tables are the plan's, re-read when
 * the window closes). So each page hands this its own list, to read and to
 * replace (`PageCards`), and this gives the controller what it needs of a
 * board state over that list (`CardWindowBoard`):
 *
 *   - **`columns`** is the page's list, in its groups (a flat list is one
 *     group). The card the window is open on stays in it, as last found,
 *     while the page's list no longer has it (a live re-read after someone
 *     moved it out of To Do, say): the window saves it as before, where the
 *     board page says it is no longer on the board.
 *   - **`writeCard`** puts the changed fields on the page's card at once,
 *     sends, and on a refusal or no answer puts back those fields alone, each
 *     only while the card still shows what this save set (a newer read that
 *     replaced the card is kept: `patchCard`'s undo), and gives back the
 *     server's words; on success it takes the answer's value of each field
 *     sent. It reads nothing again: the page does, as it did before.
 *   - **`hold`** holds nothing, since these pages schedule no reads; its
 *     release may be called once or many times.
 *   - **`refresh`** is the page's own re-read (`invalidateAll`).
 *   - **`labels`** and **`boardUsers`** are only for a New Task window, which
 *     none of these pages opens: empty.
 *
 * Each card is on a board of its own, and a controller is made for one
 * board, so a controller is made for each card opened (`openCard`).
 */
import { answerBody, failureMessage } from '$lib/api';
import type { CardType, ColumnType, LabelType } from '$lib/types';
import { answeredFields, patchCard, patchCardStill } from './board-patches';
import type { WriteResult, WriteWords } from './board-state.svelte';
import { CardWindow, type CardWindowBoard, type CardWindowSave, type SaveResult, type WindowEdits } from './card-window.svelte';
import type { BoardContentsData } from './contents-answer';
import type { Release } from './refresh-schedule';

/** A group of a page's cards as it draws them: one of All Tasks' buckets, or a flat list's one group. */
export type PageCardGroup = { cards: { id: number }[] };

/** A page's own list of cards: read as it is now, and replaced by a write. */
export type PageCards<G extends PageCardGroup> = { get(): G[]; set(next: G[]): void };

/** Marks the group that holds the open card while the page's list no longer has it. */
const KEPT = Symbol('kept');

/**
 * The card as the window is handed it: the row as the page loaded it, with
 * the fall-backs the window reads (card 2186: built field by field, it lost
 * the five reporting fields and `requestOrigin`). Kept per row, so the window
 * is handed the same object until the row changes.
 */
const windowCards = new WeakMap<object, CardType>();

export function windowCard(card: CardType): CardType {
	let shown = windowCards.get(card);
	if (!shown) {
		shown = {
			...card,
			position: card.position ?? 0,
			updatedAt: card.updatedAt || card.createdAt,
			subtasks: card.subtasks || [], labelIds: card.labelIds || [],
			pinned: card.pinned || false, onHoldNote: card.onHoldNote || '',
			businessValue: card.businessValue || '',
			subBoards: card.subBoards || [], assignees: card.assignees || [],
			archivedAt: card.archivedAt || null, coverUrl: card.coverUrl || null,
			milestoneId: card.milestoneId ?? null
		};
		windowCards.set(card, shown);
	}
	return shown;
}

function findIn(groups: ColumnType[], cardId: number): CardType | undefined {
	for (const group of groups) {
		const found = group.cards.find((card) => card.id === cardId);
		if (found) return found;
	}
	return undefined;
}

/** What the controller needs of a board state, over a page's own list. */
export class PageCardBoard<G extends PageCardGroup> implements CardWindowBoard {
	labels: LabelType[] = [];
	boardUsers: BoardContentsData['boardUsers'] = [];
	#cards: PageCards<G>;
	#refresh: () => unknown;
	#openOn: () => number | null;
	/**
	 * The open card as last found in the page's list, or as it was opened.
	 * Not state: it is taken as `columns` is read, and changed by a write only
	 * as the page's list is replaced, which is what is drawn.
	 */
	#kept: CardType | null = null;

	/** `openOn` gives the card the window is open on now, or null. */
	constructor(cards: PageCards<G>, refresh: () => unknown, openOn: () => number | null) {
		this.#cards = cards;
		this.#refresh = refresh;
		this.#openOn = openOn;
	}

	/** The card a window is being opened on, as the page has it. */
	keep(card: CardType) {
		this.#kept = card;
	}

	get columns(): ColumnType[] {
		const groups = this.#cards.get() as unknown as ColumnType[];
		const openOn = this.#openOn();
		if (openOn === null || !this.#kept || this.#kept.id !== openOn) return groups;
		const found = findIn(groups, openOn);
		if (found) {
			this.#kept = found;
			return groups;
		}
		return [...groups, { [KEPT]: true, id: -1, boardId: -1, title: '', position: -1, cards: [this.#kept] } as unknown as ColumnType];
	}

	set columns(next: ColumnType[]) {
		const kept = next.find((group) => KEPT in group);
		if (kept) this.#kept = kept.cards[0] ?? null;
		this.#cards.set(next.filter((group) => group !== kept) as unknown as G[]);
	}

	/**
	 * Change fields of one card: shown at once, sent, and on success the
	 * answer's value of each field taken; on a refusal or no answer those
	 * fields alone put back, each only while the card still shows what this
	 * write set. What `BoardState.writeCard` does, with no read after.
	 */
	async writeCard(cardId: number, fields: Partial<CardType>, send: () => Promise<Response>, words: WriteWords): Promise<WriteResult> {
		const patched = patchCard(this.columns, cardId, fields);
		this.columns = patched.columns;
		let res: Response;
		try {
			res = await send();
		} catch {
			this.columns = patched.undo(this.columns);
			return { ok: false, failure: words.noAnswer };
		}
		if (!res.ok) {
			this.columns = patched.undo(this.columns);
			return { ok: false, failure: await failureMessage(res, words.refused) };
		}
		const answer = await answerBody(res);
		this.columns = patchCardStill(this.columns, cardId, fields, answeredFields(answer, fields));
		return { ok: true, res, answer };
	}

	/** Holds nothing: these pages schedule no reads. The release says it is spent once called. */
	hold(): Release {
		let spent = false;
		return Object.defineProperty(() => {
			spent = true;
		}, 'released', { get: () => spent }) as Release;
	}

	refresh() {
		void this.#refresh();
	}
}

/**
 * A page's card window: the controller for the card open now, over the
 * page's own list. The page draws `<CardModal>` from `open`, `card` and
 * `boardId`, and says what `save` and `archive` give back.
 */
export class PageCardWindow<G extends PageCardGroup = PageCardGroup> {
	/** The board the open card is on. */
	boardId = $state(0);
	/** The open window's controller: state, so the one made for a new card is drawn. */
	#window = $state.raw<CardWindow | null>(null);
	#board: PageCardBoard<G>;

	/** `cards` is the page's own list; `refresh` its re-read. */
	constructor(cards: PageCards<G>, refresh: () => unknown) {
		this.#board = new PageCardBoard(cards, refresh, () => this.#window!.cardId);
		this.#window = new CardWindow(this.#board, 0);
	}

	/** Whether the window is shown. */
	get open(): boolean {
		return this.#window!.open;
	}

	/** The card it is open on. */
	get cardId(): number | null {
		return this.#window!.cardId;
	}

	/** The card it is open on, as the page has it now, with the window's fall-backs; null when it is shut. */
	get card(): CardType | null {
		const card = this.#window!.card;
		return card ? windowCard(card) : null;
	}

	/**
	 * The open window's `WindowEdits` (slice B5d), handed to the window as the
	 * board page hands it: untouched fields follow the card as the page's list
	 * changes, and one touched stays as typed. A new one for each window; the
	 * pages draw the window inside `{#key cardWindow.edits}`, so each open is a
	 * window made afresh.
	 */
	get edits(): WindowEdits {
		return this.#window!.edits;
	}

	/** Open the window on `card`, which is on board `boardId`. */
	openCard(card: CardType, boardId: number) {
		this.#board.keep(card);
		this.boardId = boardId;
		const opened = new CardWindow(this.#board, boardId);
		this.#window = opened;
		opened.openCard(card);
	}

	close() {
		this.#window!.close();
	}

	/**
	 * Save what the window hands its `onSave`: only the fields changed in it,
	 * through `writeCard`. Closed on success, and with nothing changed (no
	 * request, and nothing to say); left open on a refusal or no answer.
	 */
	save(saved: CardWindowSave): Promise<SaveResult> {
		// These pages open no New Task window: with no card open there is nothing to save.
		if (this.#window!.cardId === null) return Promise.resolve({ ok: true, told: [] });
		return this.#window!.save(saved);
	}

	/** Archive a card, once the page's confirm is pressed: what to say when it was not archived, null when it was. */
	archive(cardId: number): Promise<string | null> {
		return this.#window!.archive(cardId);
	}
}
