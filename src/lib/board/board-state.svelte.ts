/**
 * board-state.svelte.ts — what the board page draws, and the three ways it
 * changes (card 2280, slice B1 of card 2012's part B; no page uses it yet:
 * slice B2a moves the board page onto it).
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
 *
 * It reaches nothing of the browser but what it is given, so the tests make
 * one with a fetch that answers as they choose.
 */
import { failureMessage } from '$lib/api';
import type { Fetch } from '$lib/signed-out';
import type { CategoryType, ColumnType, LabelType, MilestoneType, SortOption } from '$lib/types';
import { sortCards } from '$lib/utils/card-utils';
import type { Patched } from './board-patches';
import { askForContents, type BoardBlockerType, type BoardContentsData, type BreadcrumbType } from './contents-answer';
import { refreshSchedule, type RefreshSchedule, type RefreshTiming } from './refresh-schedule';

export type BoardStateOptions = RefreshTiming & {
	/** Asks the page's whole load again: the page's `invalidateAll`, used only when the read is refused. */
	invalidate: () => Promise<unknown>;
	fetch?: Fetch;
};

/** What a write came to: the answer, or the words to say. */
export type WriteResult = { ok: true; res: Response } | { ok: false; failure: string };

export class BoardState {
	board = $state<BoardContentsData['board']>({ id: 0, name: '', emoji: null, parentCardId: null });
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

	/** Hold the reads (a drag, a write, the on-hold or blocked window). Returns the release. */
	hold(): () => void {
		return this.#schedule.hold();
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
	 * say. On success the answer is returned for the page to take what it
	 * needs from it.
	 */
	async write(
		change: ((columns: ColumnType[]) => Patched<ColumnType>) | null,
		send: () => Promise<Response>,
		words: { refused: string; noAnswer: string }
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
			return { ok: true, res };
		} finally {
			// Settled first: a read already out began before this write ended.
			this.#schedule.settled();
			release();
		}
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
