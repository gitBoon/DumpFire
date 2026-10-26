/**
 * board-state.svelte.ts — what the board page draws, and the three ways it
 * changes (card 2280, slice B1 of card 2012's part B; slice B2a moved the
 * board page onto it, and slice B2b sends its writes through it).
 *
 *   - **Navigation**: the page makes one from its load's data, once per board
 *     (`board/[id]/+layout.svelte` makes the page afresh for each).
 *   - **A re-read of the board's contents** (`refresh`), from the board
 *     stream's events, its reconnect and a return to the tab: sent when
 *     `./refresh-schedule.ts` says, never under a drag or a write in flight,
 *     and taken whole, with the viewer's column sorts put back on it. A
 *     refusal of the read (401, 403, 404) empties the state and asks for the
 *     load's refusal page once, through `invalidate` (the page's
 *     `invalidateAll`): the one whole re-read left on the board.
 *   - **A write's own answer** (`write`): the change is shown at once, sent,
 *     and on a refusal or no answer only that change is taken back, the
 *     server's words returned for the page to say, and the board read once.
 *     On success the answer's value of each field sent is taken (`writeCard`,
 *     `writeColumn`; slice B2b), and the board is not read again: the
 *     write's own live event is.
 *
 * It reaches nothing of the browser but what it is given, so the tests make
 * one with a fetch that answers as they choose.
 */
import { answerBody, failureMessage } from '$lib/api';
import type { Fetch } from '$lib/signed-out';
import type { CardType, CategoryType, ColumnType, LabelType, MilestoneType, SortOption } from '$lib/types';
import { sortCards } from '$lib/utils/card-utils';
import { answeredFields, patchCard, patchCardStill, patchColumn, patchColumnStill, type Patched } from './board-patches';
import { askForContents, type BoardBlockerType, type BoardContentsData, type BreadcrumbType } from './contents-answer';
import { refreshSchedule, type HoldOptions, type RefreshSchedule, type RefreshTiming, type Release } from './refresh-schedule';

export type BoardStateOptions = RefreshTiming & {
	/** Asks the page's whole load again: the page's `invalidateAll`, used only when the read is refused. */
	invalidate: () => Promise<unknown>;
	fetch?: Fetch;
};

/**
 * What a write came to: the answer, with its body read (null when it is not a
 * JSON object), or the words to say.
 */
export type WriteResult = { ok: true; res: Response; answer: Record<string, unknown> | null } | { ok: false; failure: string };

/** What a write says when it is refused (the server's words, where it gives none) and when it gets no answer. */
export type WriteWords = { refused: string; noAnswer: string };

export class BoardState {
	board = $state<BoardContentsData['board']>({ id: 0, name: '', emoji: null, parentCardId: null, kind: 'delivery' });
	breadcrumbs = $state<BreadcrumbType[]>([]);
	columns = $state<ColumnType[]>([]);
	categories = $state<CategoryType[]>([]);
	labels = $state<LabelType[]>([]);
	linkableBoards = $state<BoardContentsData['linkableBoards']>([]);
	canEdit = $state(false);
	canManage = $state(false);
	userBoardRole = $state('');
	boardUsers = $state<BoardContentsData['boardUsers']>([]);
	blockedState = $state<Record<number, BoardBlockerType[]>>({});
	cardTokens = $state<BoardContentsData['cardTokens']>({});
	boardTokenSummary = $state<BoardContentsData['boardTokenSummary']>(null);
	milestones = $state<MilestoneType[]>([]);
	/** How the viewer sorted each column, put back on every refresh. */
	columnSorts = $state<Record<number, SortOption>>({});
	/** The server refused the board: the state is empty and the load's refusal page was asked for. */
	refused = $state(false);

	#boardId: number;
	#fetch: Fetch;
	#invalidate: () => Promise<unknown>;
	#schedule: RefreshSchedule;
	#timing: RefreshTiming;

	constructor(data: BoardContentsData, options: BoardStateOptions) {
		this.#boardId = data.board.id;
		this.#fetch = options.fetch ?? ((input, init) => fetch(input, init));
		this.#invalidate = options.invalidate;
		this.#timing = options;
		this.#schedule = refreshSchedule(() => this.#read(), options);
		this.take(data);
	}

	/**
	 * Draw `data`: the load's, or a refresh's answer. Given the board after a
	 * refusal (the load the refusal asked for found the board open to the
	 * caller after all), the state follows the board again, with a new
	 * schedule (B1 review).
	 */
	take(data: BoardContentsData) {
		if (this.refused) {
			this.refused = false;
			this.#schedule = refreshSchedule(() => this.#read(), this.#timing);
		}
		this.board = data.board;
		this.breadcrumbs = data.breadcrumbs;
		this.categories = data.categories;
		this.labels = data.labels ?? [];
		this.linkableBoards = data.linkableBoards;
		this.canEdit = data.canEdit;
		this.canManage = data.canManage;
		this.userBoardRole = data.userBoardRole;
		this.boardUsers = data.boardUsers;
		this.blockedState = data.blockedState ?? {};
		this.cardTokens = data.cardTokens ?? {};
		this.boardTokenSummary = data.boardTokenSummary ?? null;
		this.milestones = data.milestones ?? [];
		this.columns = this.#sorted(data.columns);
	}

	/** Sort a column as the viewer chose; `'none'` leaves the board's order until the next read. */
	setSort(columnId: number, sort: SortOption) {
		this.columnSorts = { ...this.columnSorts, [columnId]: sort };
		if (sort === 'none') return;
		this.columns = this.columns.map((column) =>
			column.id === columnId ? { ...column, cards: sortCards([...column.cards], sort, this.categories) } : column
		);
	}

	/** Each column's cards in the order the viewer chose for it. */
	#sorted(columns: ColumnType[]): ColumnType[] {
		return columns.map((column) => {
			const sort = this.columnSorts[column.id];
			return sort && sort !== 'none' ? { ...column, cards: sortCards([...column.cards], sort, this.categories) } : column;
		});
	}

	/** Read the board again, after the burst, once nothing holds it. */
	refresh() {
		this.#schedule.schedule();
	}

	/** Read the board again now, with no wait; resolves once the answer is drawn. */
	refreshNow(): Promise<void> {
		return this.#schedule.now();
	}

	/** The board's stream says the caller's access changed: read at once, held or not. */
	accessChanged() {
		this.#schedule.access();
	}

	/**
	 * Hold the reads (a drag, a write, the on-hold or blocked window). Returns
	 * the release, which says when it is spent; `{ watchdog: false }` for a
	 * hold a window on screen ends.
	 */
	hold(options?: HoldOptions): Release {
		return this.#schedule.hold(options);
	}

	/** Holds open now. */
	get holds(): number {
		return this.#schedule.holds;
	}

	/** Whether a read is out. */
	get inFlight(): boolean {
		return this.#schedule.inFlight;
	}

	/**
	 * Make a write: show `change` at once (or nothing, for `null`), send, and
	 * hold the reads while it is out. On a refusal or no answer only `change`
	 * is taken back, out of the columns as they are by then, the board is read
	 * once, and the server's words (or `words`) are returned for the page to
	 * say. On success the answer's body is read and returned, and `take`, when
	 * given, puts what it needs of it on the columns as they are by then
	 * (card 2280, slice B2b), before the write lets the reads go.
	 */
	async write(
		change: ((columns: ColumnType[]) => Patched<ColumnType>) | null,
		send: () => Promise<Response>,
		words: WriteWords,
		take?: (columns: ColumnType[], answer: Record<string, unknown> | null) => ColumnType[]
	): Promise<WriteResult> {
		const release = this.hold();
		let undo: Patched<ColumnType>['undo'] | null = null;
		if (change) {
			const patched = change(this.columns);
			this.columns = patched.columns;
			undo = patched.undo;
		}
		const takeBack = () => {
			if (undo) this.columns = undo(this.columns);
			this.refresh();
		};
		try {
			let res: Response;
			try {
				res = await send();
			} catch {
				takeBack();
				return { ok: false, failure: words.noAnswer };
			}
			if (!res.ok) {
				takeBack();
				return { ok: false, failure: await failureMessage(res, words.refused) };
			}
			const answer = await answerBody(res);
			if (take) this.columns = take(this.columns, answer);
			return { ok: true, res, answer };
		} finally {
			// Settled first: a read already out began before this write ended.
			this.#schedule.settled();
			release();
		}
	}

	/**
	 * Change fields of one card (card 2280, slice B2b): shown at once, sent,
	 * and on success the answer's value of each of those fields taken, and no
	 * other field of the row (`answeredFields`); on a refusal or no answer
	 * those fields alone put back, and the board read once. Either is put only
	 * on a field that still shows what this write set (the B2b review): a
	 * second change to the same field, made while this one was out, stays.
	 */
	writeCard(cardId: number, fields: Partial<CardType>, send: () => Promise<Response>, words: WriteWords): Promise<WriteResult> {
		return this.write(
			(columns) => patchCard(columns, cardId, fields),
			send,
			words,
			(columns, answer) => patchCardStill(columns, cardId, fields, answeredFields(answer, fields))
		);
	}

	/** The same for fields of one column: its title, colour, WIP limit or Add Task switch. */
	writeColumn(columnId: number, fields: Partial<Omit<ColumnType, 'cards'>>, send: () => Promise<Response>, words: WriteWords): Promise<WriteResult> {
		return this.write(
			(columns) => patchColumn(columns, columnId, fields),
			send,
			words,
			(columns, answer) => patchColumnStill(columns, columnId, fields, answeredFields(answer, fields))
		);
	}

	/** Stop reading: the page is going. */
	dispose() {
		this.#schedule.dispose();
	}

	async #read() {
		if (this.refused) return;
		const answer = await askForContents(this.#boardId, this.#fetch);
		if (answer.verdict === 'apply') return () => this.take(answer.contents);
		if (answer.verdict === 'refused') return () => this.#refuse();
		// Keep: the screen as it is, until the stream's reconnect or a return to the tab.
	}

	/** Empty what the board showed and ask for the load's refusal page, once. */
	#refuse() {
		if (this.refused) return;
		this.refused = true;
		this.breadcrumbs = [];
		this.columns = [];
		this.categories = [];
		this.labels = [];
		this.linkableBoards = [];
		this.canEdit = false;
		this.canManage = false;
		this.userBoardRole = '';
		this.boardUsers = [];
		this.blockedState = {};
		this.cardTokens = {};
		this.boardTokenSummary = null;
		this.milestones = [];
		this.#schedule.dispose();
		void this.#invalidate();
	}
}
