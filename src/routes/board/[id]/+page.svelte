<script lang="ts">
	/**
	 * Board Page — The main Kanban board view.
	 *
	 * This file is a thin orchestration layer: it declares reactive state,
	 * delegates all business logic to extracted modules, and wires up the
	 * template. Heavy lifting lives in:
	 *   - board-actions.ts (board/column/category CRUD)
	 *   - card-actions.ts  (card CRUD, duplicate, pin, sub-boards)
	 *   - dnd-handlers.ts  (drag-and-drop orchestration)
	 *   - bulk-actions.ts  (multi-select operations)
	 *   - xp-utils.ts      (XP levelling calculations)
	 *   - sse.ts           (Server-Sent Events connection)
	 *   - board-state.svelte.ts (what the page draws, and the re-read of the
	 *     board's contents alone, coalesced and held; card 2280, slice B2a;
	 *     and every write: shown at once, put back on a refusal or no answer
	 *     with the server's words said, slice B2b)
	 *   - board-patches.ts (each write's change to the columns, and its undo)
	 *   - card-window.svelte.ts (the card window: the card it is open on, as
	 *     the board has it now, its save of only the fields changed since it
	 *     opened, and its archive; slice B2c)
	 *
	 * What it draws is in components (slice B3, a move): the header with its
	 * XP bars and More menu, each column's head and each card's body, and the
	 * Activity Log and Archived Cards panels, under $lib/components/board/.
	 * Each is handed what it shows and calls back into this page, which keeps
	 * every write, the board state, the card window, the columns and cards
	 * themselves (the direct children of their keyed `{#each}`, which
	 * `animate:flip` and the drag zones need) and the windows.
	 */
	import type { PageData } from './$types';
	import { afterNavigate, invalidateAll, replaceState } from '$app/navigation';
	// Svelte's `tick` under another name: the page has a `tick` of its own, the live timestamps' counter.
	import { onMount, onDestroy, tick as nextTick, untrack } from 'svelte';
	import { browser } from '$app/environment';
	import { page } from '$app/stores';
	import { dndzone, SOURCES, TRIGGERS } from 'svelte-dnd-action';
	import { flip } from 'svelte/animate';
	import { toasts } from '$lib/stores/toast';

	// Shared types
	import type { CardType, CategoryType, ColumnType, ActivityType, SortOption, XpEntry, BlockedState, OnHoldState } from '$lib/types';

	// Shared utilities
	import { FLIP_DURATION_MS } from '$lib/utils/constants';
	import { isStale } from '$lib/utils/date-utils';
	import { isCompleteColumn, isOnHoldColumn, matchesSearch } from '$lib/utils/card-utils';
	import { playMoveSound, playCompleteSound } from '$lib/utils/sounds';

	// Board-specific modules
	import * as api from '$lib/api';
	import * as boardActions from '$lib/board/board-actions';
	import * as cardActions from '$lib/board/card-actions';
	import * as dndHandlers from '$lib/board/dnd-handlers';
	import * as bulkOps from '$lib/board/bulk-actions';
	import { loadXp as fetchXpData } from '$lib/board/xp-utils';
	import { connectSSE } from '$lib/board/sse';
	import { BoardState, type WriteWords } from '$lib/board/board-state.svelte';
	import { CARD_GONE, CardWindow, type CardWindowSave } from '$lib/board/card-window.svelte';
	import { copyColumns, insertColumn, moveCards, patchCard, removeColumn, reorderColumns, undoDrag, withCurrentCards } from '$lib/board/board-patches';
	import { BULK_HOLD_MS, type Release } from '$lib/board/refresh-schedule';
	import type { BoardContentsData } from '$lib/board/contents-answer';
	import { openingView, readBoardView, resolveListColumn, viewFromUrl, withViewParams, writeBoardView, type BoardViewChoice } from '$lib/board/board-view';

	// Components
	import CardModal from '$lib/components/CardModal.svelte';
	import ConfirmModal from '$lib/components/ConfirmModal.svelte';
	import ShareModal from '$lib/components/ShareModal.svelte';
	import Toast from '$lib/components/Toast.svelte';
	import StatsPanel from '$lib/components/board/StatsPanel.svelte';
	import BulkActionBar from '$lib/components/board/BulkActionBar.svelte';
	import ContextMenu from '$lib/components/board/ContextMenu.svelte';
	import FireworksCelebration from '$lib/components/board/FireworksCelebration.svelte';
	import AddColumnModal from '$lib/components/board/AddColumnModal.svelte';
	import CategoryModal from '$lib/components/board/CategoryModal.svelte';
	import OnHoldModal from '$lib/components/board/OnHoldModal.svelte';
	import CompletionPromptModal from '$lib/components/board/CompletionPromptModal.svelte';
	import ColumnListView from '$lib/components/board/ColumnListView.svelte';
	import BoardHeader from '$lib/components/board/BoardHeader.svelte';
	import XpLeaderboard from '$lib/components/board/XpLeaderboard.svelte';
	import BoardMoreMenu from '$lib/components/board/BoardMoreMenu.svelte';
	import KanbanColumnHeader from '$lib/components/board/KanbanColumnHeader.svelte';
	import KanbanCardBody from '$lib/components/board/KanbanCardBody.svelte';
	import ActivityPanel from '$lib/components/board/ActivityPanel.svelte';
	import ArchivePanel from '$lib/components/board/ArchivePanel.svelte';

	// ─── Props & Core State ──────────────────────────────────────────────────

	let { data }: { data: PageData } = $props();

	/**
	 * What the page draws: the board, its columns and cards, categories,
	 * labels, members, blocked state, costs and goals, made once from the load
	 * (`./+layout.svelte` makes the page, and so this, afresh for each board).
	 * It reads the board's contents again when the board changes, a burst as
	 * one read and none while a drag or a write of the page's own is out; the
	 * page's whole load is asked again only when that read is refused, so the
	 * load's refusal page shows (card 2280, slice B2a). Cast as the load's
	 * columns always were: the server's rows are wider than `$lib/types`.
	 */
	const boardState = new BoardState(data as unknown as BoardContentsData, { invalidate: invalidateAll });

	// A refused read asks for the load again. If that load finds the board open
	// after all (access given back meanwhile), the page stays and its new data
	// is the board: handed over then, and only then. No other load is copied
	// over what the page draws, so a read never lands under a drag in hand.
	$effect(() => {
		const next = data;
		untrack(() => {
			if (boardState.refused) boardState.take(next as unknown as BoardContentsData);
		});
	});

	/**
	 * Cost per card, keyed by id. Cards absent from this map have nothing
	 * recorded and show no badge at all — not a zero, which would assert a
	 * measurement that was never taken.
	 */
	const cardTokens = $derived(boardState.cardTokens);

	// ─── Panel State ─────────────────────────────────────────────────────────

	let showActivityPanel = $state(false);
	let activities = $state<ActivityType[]>([]);
	let loadingActivities = $state(false);
	let showStatsPanel = $state(false);

	// ─── Inline Card Editing ─────────────────────────────────────────────────
	let inlineEditCardId = $state<number | null>(null);
	let inlineEditValue = $state('');

	function startInlineEdit(card: CardType, e: MouseEvent) {
		e.stopPropagation();
		e.preventDefault();
		inlineEditCardId = card.id;
		inlineEditValue = card.title;
	}

	// The edit's text is its own state, which a read cannot overwrite: the
	// reads are held only while the title is sent (R6), by the board state's
	// write, which shows it at once and puts the old title back, and says why,
	// when it is refused or unanswered (slice B2b). It said nothing, and the
	// new title stayed until the board was next read. The blur that follows
	// Enter finds the title already shown and sends nothing. Nor does the
	// blur after Escape, which Chromium fires as the input is taken away: the
	// edit is over by then (the B2b review).
	async function saveInlineEdit(cardId: number) {
		if (inlineEditCardId !== cardId) return;
		const trimmed = inlineEditValue.trim();
		inlineEditCardId = null;
		if (!trimmed) return;
		const card = boardState.columns.flatMap((c) => c.cards).find((c) => c.id === cardId);
		if (!card || card.title === trimmed) return;
		const started = toasts.navigation();
		const written = await boardState.writeCard(cardId, { title: trimmed }, () => api.updateCard(cardId, { title: trimmed, boardId: data.board.id }), {
			refused: 'The title was not saved.',
			noAnswer: 'No answer from the server. The title may not have been saved.'
		});
		if (!written.ok) {
			toasts.add(written.failure, 'error', started);
			return;
		}
		toasts.add('Title updated');
	}

	function cancelInlineEdit() { inlineEditCardId = null; }

	function handleInlineKeydown(e: KeyboardEvent, cardId: number) {
		if (e.key === 'Enter') { e.preventDefault(); saveInlineEdit(cardId); }
		else if (e.key === 'Escape') { e.preventDefault(); cancelInlineEdit(); }
	}

	// Priority cycling for quick-edit
	const PRIORITY_CYCLE = ['low', 'medium', 'high', 'critical'] as const;

	/** What a priority change says when it is refused or unanswered: the dot, the card menu (slice B2b). */
	const PRIORITY_WORDS: WriteWords = { refused: 'The priority was not changed.', noAnswer: 'No answer from the server. The priority may not have been changed.' };

	async function cyclePriority(card: CardType, e: MouseEvent) {
		e.stopPropagation();
		const idx = PRIORITY_CYCLE.indexOf(card.priority as any);
		const next = PRIORITY_CYCLE[(idx + 1) % PRIORITY_CYCLE.length];
		const started = toasts.navigation();
		const written = await boardState.writeCard(card.id, { priority: next }, () => api.updateCard(card.id, { priority: next, boardId: data.board.id }), PRIORITY_WORDS);
		if (!written.ok) toasts.add(written.failure, 'error', started);
	}

	// ─── Bulk Selection ──────────────────────────────────────────────────────

	let selectionMode = $state(false);
	let selectedCards = $state<Set<number>>(new Set());

	function toggleSelection(cardId: number, e: Event) {
		e.stopPropagation();
		const next = new Set(selectedCards);
		if (next.has(cardId)) next.delete(cardId); else next.add(cardId);
		selectedCards = next;
	}

	function clearSelection() {
		selectionMode = false;
		selectedCards = new Set();
	}

	// The three bulk changes go through the board state (slice B2b): the cards
	// change on the screen at once, and each the server does not take is put
	// back by it, which reads the board once afterwards. A change made is not
	// read again: its own live events are. Each holds the reads until its last
	// card is answered, so a bulk change of 20 cards is not 20 reads, with a
	// hold of its own whose watchdog waits 5 minutes, not 30 s (the B2b review
	// and re-check): every card's write takes its hold at once, and a bulk
	// change of more than 30 s let reads in under the cards still out when
	// their watchdogs ran out. Its `finally` lets it go once the last card is
	// answered; `fetch` has no time limit of its own, so a request that never
	// answers is let go by the watchdog, and the board is read then.

	/**
	 * A refusal is said, and the selection kept: a move of more than 100 cards
	 * to another column at once is refused whole, and nothing moves (card 2209).
	 */
	async function handleBulkMove(targetColumnId: number) {
		const targetCol = boardState.columns.find(c => c.id === targetColumnId);
		if (!targetCol) return;
		const started = toasts.navigation();
		const release = boardState.hold({ watchdogMs: BULK_HOLD_MS });
		try {
			const failure = await bulkOps.bulkMove(selectedCards, targetColumnId, targetCol.cards.length, data.board.id, currentUser?.username || '', currentUser?.emoji || '👤', boardState);
			if (failure) {
				toasts.add(failure, 'error', started);
			} else {
				clearSelection();
			}
		} finally {
			release();
		}
	}

	async function handleBulkDelete() {
		// Each card is archived, not deleted (`api.deleteCard`).
		const started = toasts.navigation();
		const release = boardState.hold({ watchdogMs: BULK_HOLD_MS });
		try {
			const { archived, failed } = await bulkOps.bulkDelete(selectedCards, data.board.id, boardState);
			if (archived > 0) {
				toasts.add(`${archived} ${archived === 1 ? 'card' : 'cards'} archived. Restore from Archived Cards.`, 'info');
			}
			if (failed.length > 0) {
				// What the server did not archive is back on the board, and stays selected.
				toasts.add(`${failed.length} ${failed.length === 1 ? 'card' : 'cards'} not archived. ${failed[0].message}`, 'error', started);
				selectedCards = new Set(failed.map((f) => f.cardId));
			} else {
				clearSelection();
			}
		} finally {
			release();
		}
	}

	// The answers were thrown away, and the selection cleared whatever they were.
	async function handleBulkPriority(priority: string) {
		const started = toasts.navigation();
		const release = boardState.hold({ watchdogMs: BULK_HOLD_MS });
		try {
			const { failed } = await bulkOps.bulkPriority(selectedCards, priority, data.board.id, boardState);
			if (failed.length > 0) {
				// What the server did not change is put back, and stays selected.
				toasts.add(`${failed.length} ${failed.length === 1 ? 'card' : 'cards'} not changed. ${failed[0].message}`, 'error', started);
				selectedCards = new Set(failed.map((f) => f.cardId));
			} else {
				clearSelection();
			}
		} finally {
			release();
		}
	}

	// ─── Column Editing ──────────────────────────────────────────────────────

	let editingColumn = $state<number | null>(null);
	let editColumnTitle = $state('');

	function startEditColumn(col: ColumnType) {
		editingColumn = col.id;
		editColumnTitle = col.title;
	}

	/**
	 * Saves a column's new title. The title shown changes only once the server
	 * has taken it: a rename that would change whether the column is a Complete
	 * column is refused while it holds cards (card 2134), and the refusal is
	 * said in the server's words with the old title left in place. Enter and the
	 * blur that follows it both end the edit, and only the first sends it.
	 */
	async function finishEditColumn(colId: number) {
		if (editingColumn !== colId) return;
		editingColumn = null;
		const title = editColumnTitle.trim();
		if (!title) return;
		const started = toasts.navigation();
		const release = boardState.hold();
		try {
			let res: Response;
			try {
				res = await boardActions.updateColumn(colId, { title }, data.board.id);
			} catch {
				toasts.add('No answer from the server. The column may not have been renamed.', 'error', started);
				return;
			}
			if (!res.ok) {
				toasts.add(await api.failureMessage(res, 'The column was not renamed.'), 'error', started);
				return;
			}
			const col = boardState.columns.find((c) => c.id === colId);
			if (col) col.title = title;
		} finally {
			release();
		}
	}

	// ─── Card Modal ──────────────────────────────────────────────────────────

	/**
	 * The card window (card 2280, slice B2c): the card it is open on, found in
	 * the board state by its id and following it as each read arrives, and its
	 * save and archive. A save sends only the fields changed since the window
	 * opened, so a change someone else made meanwhile is not sent back.
	 */
	const cardWindow = new CardWindow(boardState, data.board.id);

	// The card an address names is opened on the first load and after every
	// navigation that keeps this page: SvelteKit keeps it for every address of
	// the route, so a dependency link to a card on this board, or on another,
	// opened no card when it was read in `onMount` alone (card 2164). A window
	// open before it is closed first when the navigation is to another board,
	// or, on this board, leaves a saved card's window with an address that
	// names no card, as Back does (Q-F's review).
	afterNavigate(({ from, to }) => {
		if (cardActions.navigationClosesWindow(from, to, cardWindow.cardId !== null)) cardWindow.close();
		openCardFromAddress(to?.url);
	});

	/**
	 * Opens the card `?card=` names, if it is on the board now shown, and takes
	 * the parameter off the address.
	 *
	 * The card is looked for in the board state, which is this board's: it is
	 * made from the load as the page is, before `afterNavigate` runs, and a
	 * link to another board makes the page, and so the state, afresh
	 * (`./+layout.svelte`; card 2280, slice B2a). A window already open is
	 * closed first, and the card opened after the next tick: the window fills
	 * its fields from its card once, when it is made, and would otherwise show
	 * the first card's fields under the second's id. What was typed in it and
	 * not saved is lost, as it is when a link leads to another page.
	 *
	 * The address is put right with SvelteKit's `replaceState`, after that tick:
	 * on the first load `afterNavigate` runs before the router counts itself
	 * started, and until then it throws. `window.history.replaceState` threw
	 * away SvelteKit's own state in the history entry.
	 */
	async function openCardFromAddress(url: URL | undefined) {
		const named = url?.searchParams.get('card');
		if (!url || !named) return;
		const cardId = Number(named);
		const card = boardState.columns.flatMap((c) => c.cards).find((c) => c.id === cardId);
		cardWindow.close();
		await nextTick();
		const shown = new URL(url);
		shown.searchParams.delete('card');
		replaceState(shown, $page.state);
		if (card) openCardModal(card);
	}

	// The board's own copy of the card, found by its id: one kept from a drag
	// or the blocked window is stale once a write is answered or taken back.
	function openCardModal(card: CardType) {
		cardWindow.openCard(card);
	}

	function openNewCardModal(columnId: number) {
		cardWindow.openNew(columnId);
	}

	/**
	 * Saves the card window through its controller (slice B2c), which holds
	 * the board's reads while it is out. A saved card sends only the fields
	 * changed since the window opened, shown on the board at once and taken
	 * back alone if refused; a new card is made with its subtasks, labels,
	 * assignees and sub-boards, and the board read once. A refusal, or no
	 * answer, keeps the window open with what was typed, and the reason is
	 * said; what was done, and each part of a new card that was not, is said
	 * in the order the controller gives it.
	 */
	async function saveCard(cardData: CardWindowSave) {
		const started = toasts.navigation();
		const written = await cardWindow.save(cardData);
		if (!written.ok) {
			toasts.add(written.failure, 'error', started);
			return;
		}
		for (const { message, failed } of written.told) {
			if (failed) toasts.add(message, 'error', started);
			else toasts.add(message);
		}
	}

	/**
	 * Archive a card, from its window or the card menu. The request is a
	 * DELETE with no `permanent`, which stamps the card as archived and
	 * touches nothing else. Restore, in the Archived Cards panel, brings it
	 * back whole. Deleting it for good is done from that panel
	 * (`permanentlyDeleteCard`). Sent only once the confirm is pressed, by the
	 * card window's controller (slice B2c), which holds the board's reads
	 * while it is out, and takes the card off the board as answered, with no
	 * read, and closes its window only once the server has archived it.
	 */
	function confirmDeleteCard(cardId: number) {
		const card = boardState.columns.flatMap(c => c.cards).find(c => c.id === cardId);
		showConfirm(
			'Archive Card',
			api.cardArchiveWarning(card?.title),
			'Archive Card',
			async () => {
				const started = toasts.navigation();
				const failure = await cardWindow.archive(cardId);
				confirmState.show = false;
				if (failure) {
					// The card is still on the board, so its window stays open.
					toasts.add(failure, 'error', started);
					return;
				}
				toasts.add('Card archived. Restore it from Archived Cards.', 'info');
			}
		);
	}

	// ─── Board Identity ──────────────────────────────────────────────────────

	// The name and emoji drawn are the board state's, so a rename by someone
	// else follows; the name being typed is the edit's own, which a read
	// cannot overwrite.
	let editingBoardName = $state(false);
	let boardNameDraft = $state('');
	const boardName = $derived(boardState.board.name);
	const boardEmoji = $derived(boardState.board.emoji || '📋');

	function startEditBoardName() {
		boardNameDraft = boardName;
		editingBoardName = true;
	}

	// Shown at once, as the name typed always was; an empty one, or the name
	// unchanged, is not sent (the blur that follows Enter sends nothing). A
	// refusal or no answer puts the old name back and says why (slice B2b): it
	// stayed until the board was next read, and nothing was said.
	async function saveBoardName() {
		const name = boardNameDraft.trim();
		const was = boardState.board.name;
		editingBoardName = false;
		if (!name || name === was) return;
		const started = toasts.navigation();
		boardState.board = { ...boardState.board, name };
		const written = await boardState.write(null, () => boardActions.saveBoardName(data.board.id, name), {
			refused: 'The board was not renamed.',
			noAnswer: 'No answer from the server. The board may not have been renamed.'
		});
		if (!written.ok) {
			// Only while it still shows this name: a rename sent after it stays (the B2b review).
			if (boardState.board.name === name) boardState.board = { ...boardState.board, name: was };
			toasts.add(written.failure, 'error', started);
		}
	}

	async function saveBoardEmoji(emoji: string) {
		const was = boardState.board.emoji;
		const started = toasts.navigation();
		boardState.board = { ...boardState.board, emoji };
		const written = await boardState.write(null, () => boardActions.saveBoardEmoji(data.board.id, emoji), {
			refused: "The board's emoji was not changed.",
			noAnswer: "No answer from the server. The board's emoji may not have been changed."
		});
		if (!written.ok) {
			if (boardState.board.emoji === emoji) boardState.board = { ...boardState.board, emoji: was };
			toasts.add(written.failure, 'error', started);
		}
	}

	// ─── Add Column Modal ────────────────────────────────────────────────────

	let showAddColumnModal = $state(false);
	let newColumnTitle = $state('');
	let newColumnColor = $state('#6366f1');
	let newColumnPosition = $state('end');

	// The column answered is put on the board, with no read; a refusal keeps
	// the window open, and says why (slice B2b).
	async function addColumn() {
		const started = toasts.navigation();
		const written = await boardState.write(null, () => boardActions.addColumn(data.board.id, newColumnTitle, newColumnColor, newColumnPosition, boardState.columns), {
			refused: 'The column was not added.',
			noAnswer: 'No answer from the server. The column may not have been added.'
		});
		if (!written.ok) {
			toasts.add(written.failure, 'error', started);
			return;
		}
		const made = written.answer as unknown as Omit<ColumnType, 'cards'> | null;
		if (typeof made?.id === 'number' && !boardState.columns.some((c) => c.id === made.id)) {
			boardState.columns = insertColumn(boardState.columns, { ...made, cards: [] }).columns;
		}
		showAddColumnModal = false;
		newColumnTitle = '';
		newColumnPosition = 'end';
	}

	// A column's colour, WIP limit and Add Task switch went through a wrapper
	// here that threw each answer away: each looked saved until the board was
	// next read. Each is sent through the board state now, shown at once and
	// put back, with the server's words, when it is refused (slice B2b).

	/** What a change to a column's settings says when it is refused or unanswered. */
	const COLUMN_WORDS: WriteWords = { refused: 'The column was not changed.', noAnswer: 'No answer from the server. The column may not have been changed.' };

	async function setColumnColor(colId: number, color: string) {
		closeDropdowns();
		const started = toasts.navigation();
		const written = await boardState.writeColumn(colId, { color }, () => boardActions.updateColumn(colId, { color }, data.board.id), COLUMN_WORDS);
		if (!written.ok) toasts.add(written.failure, 'error', started);
	}

	async function toggleShowAddCard(column: ColumnType) {
		const showAddCard = !(column.showAddCard || column.title.toLowerCase() === 'to do');
		closeDropdowns();
		const started = toasts.navigation();
		const written = await boardState.writeColumn(column.id, { showAddCard }, () => boardActions.updateColumn(column.id, { showAddCard }, data.board.id), COLUMN_WORDS);
		if (!written.ok) toasts.add(written.failure, 'error', started);
	}

	function confirmDeleteColumn(colId: number, colTitle: string) {
		showConfirm(
			'Delete Column',
			api.columnDeleteWarning(colTitle),
			'Delete Column',
			async () => {
				const started = toasts.navigation();
				const release = boardState.hold();
				try {
					const failure = await api.deleteFailure(() => boardActions.deleteColumn(colId, data.board.id), 'column');
					confirmState.show = false;
					if (failure) {
						toasts.add(failure, 'error', started);
						return;
					}
					// Taken off the board as answered, with no read (slice B2b).
					boardState.columns = removeColumn(boardState.columns, colId).columns;
				} finally {
					release();
				}
			}
		);
	}

	// ─── Category Management ─────────────────────────────────────────────────

	let showCategoryModal = $state(false);

	// The category window's add and delete. Each answer was thrown away and
	// the board read again; a refusal said nothing. The category answered is
	// put in the list, and one deleted taken out, once the server has taken it
	// (slice B2b). The cards that carried a deleted one are the reader's: its
	// live event reads the board. Whether it was added is given back, so the
	// window keeps the name typed when it was not (the B2b review).
	async function addCategory({ name, color }: { name: string; color: string }): Promise<boolean> {
		const started = toasts.navigation();
		const written = await boardState.write(null, () => api.createCategory({ boardId: data.board.id, name, color }), {
			refused: `The category "${name}" was not added.`,
			noAnswer: `No answer from the server. The category "${name}" may not have been added.`
		});
		if (!written.ok) {
			toasts.add(written.failure, 'error', started);
			return false;
		}
		const made = written.answer as unknown as CategoryType | null;
		if (typeof made?.id === 'number' && !boardState.categories.some((c) => c.id === made.id)) {
			boardState.categories = [...boardState.categories, made];
		}
		return true;
	}

	async function deleteCategory(id: number) {
		const started = toasts.navigation();
		const written = await boardState.write(null, () => api.deleteCategoryApi(id), {
			refused: 'The category was not deleted.',
			noAnswer: 'No answer from the server. The category may not have been deleted.'
		});
		if (!written.ok) {
			toasts.add(written.failure, 'error', started);
			return;
		}
		boardState.categories = boardState.categories.filter((c) => c.id !== id);
	}

	// ─── Confirm Modal ───────────────────────────────────────────────────────

	let confirmState = $state<{
		show: boolean; title: string; message: string;
		confirmText: string; onConfirm: () => void;
	}>({ show: false, title: '', message: '', confirmText: '', onConfirm: () => {} });

	function showConfirm(title: string, message: string, confirmText: string, onConfirm: () => void) {
		confirmState = { show: true, title, message, confirmText, onConfirm };
	}

	/**
	 * Warn when a card that still has open blockers is started anyway.
	 *
	 * Deliberately a toast after the fact rather than a modal that blocks the
	 * drop: the card says moving a blocked card to In Progress stays allowed, and
	 * a confirmation dialog mid-drag would make the common case (the graph is out
	 * of date, you know what you are doing) annoying enough to stop recording
	 * dependencies at all.
	 */
	function warnIfStillBlocked(card: CardType, toColumnName: string) {
		if (isCompleteColumn({ title: toColumnName } as ColumnType)) return;
		if (toColumnName.toLowerCase() === 'to do') return;
		const open = blockersFor(card.id);
		if (open.length === 0) return;
		toasts.add(
			`"${card.title}" is still blocked by ${open.map((b) => `#${b.id}`).join(', ')} — moved to ${toColumnName} anyway`,
			'warning'
		);
	}

	// ─── Dropdown & Context Menu ─────────────────────────────────────────────

	let openDropdown = $state<string | null>(null);
	let contextMenu = $state<{ show: boolean; x: number; y: number; card: CardType | null; columnId: number }>({ show: false, x: 0, y: 0, card: null, columnId: 0 });

	function toggleDropdown(id: string) { openDropdown = openDropdown === id ? null : id; }
	function closeDropdowns() { openDropdown = null; showMoreMenu = false; contextMenu = { ...contextMenu, show: false }; }

	function openContextMenu(e: MouseEvent, card: CardType, columnId: number) {
		e.preventDefault();
		e.stopPropagation();
		contextMenu = { show: true, x: e.clientX, y: e.clientY, card, columnId };
	}

	async function duplicateCard(card: CardType) {
		// A copy the server refused is said in its words, and is not "Duplicated".
		const started = toasts.navigation();
		const release = boardState.hold();
		try {
			const { title, failure, into } = await cardActions.duplicateCard(card, boardState.columns, data.board.id, boardState.categories);
			// The copy of a finished card is made in the board's first open column
			// (card 2134, R1): say which, or the copy seems to have gone nowhere.
			if (failure) {
				toasts.add(failure, 'error', started);
			} else if (title) {
				toasts.add(into ? `Duplicated "${title} (Copy)" into ${into}` : `Duplicated "${title}"`);
			}
			contextMenu = { ...contextMenu, show: false };
			boardState.refresh();
		} finally {
			release();
		}
	}

	// The card menu's pin, move and priority: each shown at once, and put back
	// with the server's words when it is refused or unanswered (slice B2b).
	// Each threw its answer away, and "Moved to X" was said whatever it was.
	async function togglePin(card: CardType) {
		contextMenu = { ...contextMenu, show: false };
		const pinned = !card.pinned;
		const started = toasts.navigation();
		const written = await boardState.writeCard(card.id, { pinned }, () => cardActions.setPinned(card.id, pinned, data.board.id), {
			refused: pinned ? 'The card was not pinned.' : 'The card was not unpinned.',
			noAnswer: pinned ? 'No answer from the server. The card may not have been pinned.' : 'No answer from the server. The card may not have been unpinned.'
		});
		if (!written.ok) {
			toasts.add(written.failure, 'error', started);
			return;
		}
		toasts.add(pinned ? `Pinned "${card.title}"` : `Unpinned "${card.title}"`);
	}

	/** To the end of another column, its WIP limit warned of once the move is taken. */
	async function moveFromMenu(card: CardType, targetColId: number) {
		const col = boardState.columns.find((c) => c.id === targetColId);
		if (!col) return;
		contextMenu = { ...contextMenu, show: false };
		const count = col.cards.length;
		const updates = [{ id: card.id, columnId: targetColId, position: count }];
		const started = toasts.navigation();
		const written = await boardState.write((columns) => moveCards(columns, updates), () => api.reorderCards(updates, data.board.id, currentUser?.username || '', currentUser?.emoji || '👤'), {
			refused: 'The card was not moved.',
			noAnswer: 'No answer from the server. The card may not have been moved.'
		});
		if (!written.ok) {
			toasts.add(written.failure, 'error', started);
			return;
		}
		toasts.add(`Moved to ${col.title}`);
		// WIP limit violation alert
		if (col.wipLimit > 0 && count + 1 > col.wipLimit) {
			toasts.add(`⚠ ${col.title} exceeds WIP limit (${count + 1}/${col.wipLimit})`, 'warning');
		}
	}

	async function setPriorityFromMenu(card: CardType, priority: string) {
		contextMenu = { ...contextMenu, show: false };
		const started = toasts.navigation();
		const written = await boardState.writeCard(card.id, { priority }, () => api.updateCard(card.id, { priority, boardId: data.board.id }), PRIORITY_WORDS);
		if (!written.ok) {
			toasts.add(written.failure, 'error', started);
			return;
		}
		toasts.add(`Priority → ${priority}`);
	}

	/** A refusal is said in the server's words: on a board nested as deep as sub-boards may be, every one is refused (card 2172). */
	async function createSubBoard(card: CardType, name?: string) {
		contextMenu = { ...contextMenu, show: false };
		const started = toasts.navigation();
		const release = boardState.hold();
		try {
			const made = await cardActions.createSubBoard(card.id, name || card.title);
			if ('message' in made) {
				toasts.add(made.message, 'error', started);
				return;
			}
			window.location.href = `/board/${made.id}`;
		} finally {
			release();
		}
	}

	/**
	 * Asks first: linking hands the board's deletion to this board's editors. A
	 * refusal is said in the server's words. The board is read at once once the
	 * link's own hold is let go: the sub-board's progress is the server's.
	 */
	function linkSubBoard(cardId: number, boardId: number) {
		const name = boardState.linkableBoards.find(b => b.id === boardId)?.name ?? 'this board';
		showConfirm('Link Board', api.subBoardLinkWarning(name), 'Link', async () => {
			const started = toasts.navigation();
			const release = boardState.hold();
			let res: Response;
			try {
				res = await cardActions.linkSubBoard(cardId, boardId);
			} catch {
				toasts.add('No answer from the server. The board may not have been linked.', 'error', started);
				return;
			} finally {
				release();
			}
			if (!res.ok) {
				toasts.add(await api.failureMessage(res, 'The board was not linked.'), 'error', started);
				return;
			}
			// The card's window shows its sub-boards from the card as this read
			// draws it: the controller finds the card by its id (slice B2c).
			await boardState.refreshNow();
			toasts.add('Board linked as sub-board');
		});
	}

	function deleteSubBoard(boardId: number) {
		const sbName = cardActions.findSubBoardName(boardId, boardState.columns);
		showConfirm(
			'Delete Sub-board',
			api.boardDeleteWarning(sbName),
			'Delete',
			async () => {
				const started = toasts.navigation();
				const release = boardState.hold();
				let failure: string | null;
				try {
					failure = await api.deleteFailure(() => cardActions.deleteSubBoard(boardId), 'sub-board');
				} finally {
					release();
				}
				if (failure) {
					toasts.add(failure, 'error', started);
					return;
				}
				// Read at once, once the delete's own hold is let go, as for a link;
				// the card's window shows the card as this read draws it.
				await boardState.refreshNow();
				toasts.add('Sub-board deleted');
			}
		);
	}

	/**
	 * The More menu's Delete Sub-board, for this board when it is a sub-board:
	 * asked first, and the page goes to the board above it only once it is
	 * deleted. Written in the menu's markup until the menu became a component
	 * (slice B3), which closes itself and then calls this.
	 */
	function confirmDeleteThisSubBoard() {
		showConfirm('Delete Sub-board', api.boardDeleteWarning(boardName), 'Delete', async () => {
			const parentHref = boardState.breadcrumbs[boardState.breadcrumbs.length - 1]?.href || '/';
			const started = toasts.navigation();
			const release = boardState.hold();
			try {
				const failure = await api.deleteFailure(() => api.deleteBoardApi(data.board.id), 'sub-board');
				if (failure) {
					toasts.add(failure, 'error', started);
					return;
				}
				window.location.href = parentHref;
			} finally {
				release();
			}
		});
	}

	// ─── Column Sort ─────────────────────────────────────────────────────────

	// The sorts are the board state's, put back on the columns after every read.
	function setColumnSort(columnId: number, sort: SortOption) {
		boardState.setSort(columnId, sort);
		openDropdown = null;
	}

	// ─── Search ──────────────────────────────────────────────────────────────

	let searchQuery = $state('');
	let filterAssigneeId = $state<number | null>(null);
	let hideBlocked = $state(false);

	/**
	 * Open dependency blockers per card, computed server-side in one pass by the
	 * board loader. Named `dependencyBlockers` and not `blockedState` — that name
	 * is already taken on this page by the completion-blocker modal, which is a
	 * different kind of "blocked" (incomplete subtasks, not an unfinished card).
	 */
	const dependencyBlockers = $derived(boardState.blockedState);

	const milestoneNameById = $derived(
		new Map(boardState.milestones.map((m: { id: number; name: string }) => [m.id, m.name]))
	);

	/** Blockers for a card that are still open, or an empty list. */
	function blockersFor(cardId: number) {
		return dependencyBlockers[cardId] ?? [];
	}

	/**
	 * Tooltip for the Blocked chip. "Blocked" on its own tells you to stop but
	 * not what to go and do, so every blocker is listed with the column it is
	 * sitting in, and its board when the blocker lives on a different one. A
	 * blocker on a board the viewer cannot open is its number and the text in
	 * place of its title, with no column or board (card 2129).
	 */
	function blockerTooltip(cardId: number): string {
		const open = blockersFor(cardId);
		if (open.length === 0) return '';
		return ['Blocked by']
			.concat(
				open.map((b) =>
					b.withheld
						? `#${b.id} ${b.title}`
						: `#${b.id} ${b.title} — ${b.columnTitle}` + (b.boardId !== data.board.id ? ` (${b.boardName})` : '')
				)
			)
			.join('\n');
	}

	/**
	 * A card is hidden by the blocked filter only when something is genuinely
	 * still blocking it — a completed blocker has already dropped out of
	 * dependencyBlockers server-side, so this never hides startable work.
	 */
	function passesBlockedFilter(cardId: number): boolean {
		return !hideBlocked || blockersFor(cardId).length === 0;
	}

	// ─── List View (card 2079) ───────────────────────────────────────────────

	// Board or list, as the address asks, so a bookmarked list is drawn as a
	// list from the first paint. What this viewer left the board as is read
	// from the browser once the page is in it, and an address that asks for
	// nothing then opens as that, after a first paint as the board.
	let boardView = $state<BoardViewChoice>(openingView(viewFromUrl($page.url), null));
	let boardViewRead = false;

	// Registered after the card window's, whose address it then keeps: a
	// `?card=` link on this board leaves the list shown and in the address.
	// The address is put right after a tick, as `openCardFromAddress` does.
	// That order holds only while both callbacks wait the same number of
	// awaits (one `nextTick`) before `replaceState`: one more here, or one
	// fewer there, and the card window's address would be written last.
	// On Back and Forward, `to.url` is the address SvelteKit stored for the
	// entry, without the view a shallow `replaceState` put in it; the
	// browser's own address has it.
	afterNavigate(async ({ to, type }) => {
		if (!to) return;
		const remembered = boardViewRead ? boardView : currentUser ? readBoardView(currentUser.id, data.board.id) : null;
		boardViewRead = true;
		const choice = openingView(viewFromUrl(type === 'popstate' ? new URL(location.href) : to.url), remembered);
		await nextTick();
		if (choice.view === 'list') setBoardView(choice);
		else boardView = choice;
	});

	/** Shows the board or the list, remembers it for this viewer and board, and puts it in the address. */
	function setBoardView(choice: BoardViewChoice) {
		const columnId = choice.view === 'list' ? resolveListColumn(boardState.columns, choice.columnId) : choice.columnId;
		boardView = { ...choice, columnId };
		if (currentUser) writeBoardView(currentUser.id, data.board.id, boardView);
		replaceState(withViewParams(new URL(location.href), boardView), $page.state);
	}

	// A column deleted while the list shows it (by anyone, live): the list
	// moves to To Do, and the address and the remembered choice with it, at
	// once. Not before the view's first navigation, when the router has not
	// started and that navigation puts the column right in any case. Nor while
	// the board is refused: its columns are emptied then, not deleted, and the
	// choice remembered is kept for the board's return (card 2280, slice B2a).
	$effect(() => {
		const columnId = resolveListColumn(boardState.columns, boardView.columnId);
		if (boardViewRead && !boardState.refused && boardView.view === 'list' && columnId !== boardView.columnId) untrack(() => setBoardView(boardView));
	});


	// ─── Archive Panel ──────────────────────────────────────────────────────────

	let showArchivePanel = $state(false);
	let archivedCards = $state<any[]>([]);
	let loadingArchive = $state(false);

	async function loadArchivedCards() {
		loadingArchive = true;
		try {
			const res = await fetch(`/api/boards/${data.board.id}/archive`);
			if (res.ok) archivedCards = await res.json();
		} finally { loadingArchive = false; }
	}

	async function toggleArchivePanel() {
		showArchivePanel = !showArchivePanel;
		if (showArchivePanel) await loadArchivedCards();
	}

	async function restoreCard(cardId: number) {
		// The card leaves the list only when the server says it is restored. A
		// refusal, a card deleted for good in another tab among them, used to
		// take the row away and say "Card restored" all the same.
		const started = toasts.navigation();
		const release = boardState.hold();
		try {
			const failure = await api.deleteFailure(
				() =>
					fetch(`/api/boards/${data.board.id}/archive`, {
						method: 'POST',
						headers: { 'Content-Type': 'application/json' },
						body: JSON.stringify({ cardId })
					}),
				'card',
				'restored'
			);
			if (failure) {
				toasts.add(failure, 'error', started);
				return;
			}
			archivedCards = archivedCards.filter(c => c.id !== cardId);
			toasts.add('Card restored');
			boardState.refresh();
		} finally {
			release();
		}
	}

	async function permanentlyDeleteCard(cardId: number) {
		// The card leaves the list only when the server says it is gone.
		const started = toasts.navigation();
		const release = boardState.hold();
		try {
			const failure = await api.deleteFailure(
				() =>
					fetch(`/api/cards/${cardId}?permanent=true`, {
						method: 'DELETE',
						headers: { 'Content-Type': 'application/json' },
						body: JSON.stringify({ boardId: data.board.id })
					}),
				'card'
			);
			if (failure) {
				toasts.add(failure, 'error', started);
				return;
			}
			archivedCards = archivedCards.filter(c => c.id !== cardId);
			toasts.add('Card permanently deleted', 'info');
		} finally {
			release();
		}
	}

	// ─── WIP Limit Editing ─────────────────────────────────────────────────────

	let editingWipColumn = $state<number | null>(null);
	let wipLimitInput = $state(0);

	function startEditWipLimit(col: ColumnType) {
		editingWipColumn = col.id;
		wipLimitInput = col.wipLimit || 0;
	}

	// Said to be set only once the server has taken it; shown at once, and put
	// back with the server's words when it is not (slice B2b).
	async function saveWipLimit(colId: number) {
		// An emptied number input is not a number. That is "no limit", which is 0.
		const limit = Number.isFinite(wipLimitInput) ? Math.max(0, Math.trunc(wipLimitInput)) : 0;
		editingWipColumn = null;
		const started = toasts.navigation();
		const written = await boardState.writeColumn(colId, { wipLimit: limit }, () => boardActions.updateColumn(colId, { wipLimit: limit }, data.board.id), {
			refused: 'The WIP limit was not saved.',
			noAnswer: 'No answer from the server. The WIP limit may not have been saved.'
		});
		if (!written.ok) {
			toasts.add(written.failure, 'error', started);
			return;
		}
		toasts.add(limit > 0 ? `WIP limit set to ${limit}` : 'WIP limit removed');
	}

	// ─── Blocked & On Hold Modals ────────────────────────────────────────────

	let blockedState = $state<BlockedState>({ show: false, card: null, incomplete: 0, reason: 'subtasks', subBoardId: null });
	let onHoldState = $state<OnHoldState>({ show: false, cardId: 0, cardTitle: '', note: '', pendingUpdates: [], pendingColumnId: 0 });

	/**
	 * The hold of the blocked window: the board is not read while it says why a
	 * card cannot be completed (R6; slice B2b), however long it is open (no
	 * watchdog: its Confirm and Cancel, Escape among them, close it).
	 */
	let blockedRelease: Release | null = null;

	function releaseBlocked() {
		blockedRelease?.();
		blockedRelease = null;
	}

	function closeBlocked() {
		blockedState.show = false;
		releaseBlocked();
	}

	// ─── Completion prompt ───────────────────────────────────────────────────
	// Asked after the move, never before it: the card is already complete and
	// skipping costs nothing. Only cards actually missing one of the two fields
	// are queued, so a card that already records them is never asked twice.
	let completionQueue = $state<{ id: number; title: string }[]>([]);
	let completionSummary = $state('');
	let completionReason = $state('');
	let completionCard = $derived(completionQueue[0] ?? null);

	function queueCompletionPrompt(card: CardType) {
		if (card.summary && card.closeReason) return;
		completionQueue = [...completionQueue, { id: card.id, title: card.title }];
	}

	function nextCompletionPrompt() {
		completionQueue = completionQueue.slice(1);
		completionSummary = '';
		completionReason = '';
	}

	async function saveCompletionPrompt() {
		const current = completionQueue[0];
		if (!current) return;
		const patch: { summary?: string; closeReason?: string } = {};
		if (completionSummary.trim()) patch.summary = completionSummary.trim();
		if (completionReason) patch.closeReason = completionReason;

		// Nothing typed is the same as skipping — do not write empty values over
		// anything already recorded.
		if (Object.keys(patch).length === 0) {
			nextCompletionPrompt();
			return;
		}
		// Put on the card as answered, with no read. A refusal keeps the prompt,
		// with what was typed, and says why (slice B2b): it was thrown away.
		const started = toasts.navigation();
		const written = await boardState.writeCard(current.id, patch, () => api.updateCard(current.id, { ...patch, boardId: data.board.id }), {
			refused: 'The summary and close reason were not saved.',
			noAnswer: 'No answer from the server. The summary and close reason may not have been saved.'
		});
		if (!written.ok) {
			toasts.add(written.failure, 'error', started);
			return;
		}
		nextCompletionPrompt();
	}

	/**
	 * The hold of the On Hold note window. Nothing is sent until the note is
	 * confirmed, so the reads are held, however long the window is open (no
	 * watchdog: B2a review), until that move is answered, or Cancel puts the
	 * card back.
	 */
	let onHoldRelease: Release | null = null;

	/**
	 * The columns as the drag into On Hold found them: Cancel, or a move the
	 * server refuses, puts the card back from them, at once (slice B2b). Null
	 * once the move is taken.
	 */
	let onHoldFrom: ColumnType[] | null = null;

	function releaseOnHold() {
		onHoldRelease?.();
		onHoldRelease = null;
	}

	/** A move into On Hold not made: the card back where the drag found it, and the board read once. */
	function putBackOnHold() {
		if (onHoldFrom) boardState.columns = undoDrag(boardState.columns, onHoldFrom, [onHoldState.cardId]);
		onHoldFrom = null;
		boardState.refresh();
	}

	// Closed as the hold is let go, answered or not: a window left open after
	// no answer would send a second Confirm unheld (B2a review). The move goes
	// first and the note only once it is taken (slice B2b; R7): a refused move
	// is said, puts the card back and writes no note. A note refused after the
	// move was taken is said, and the window kept open, held, on the note
	// typed: its Confirm sends the note alone, and Cancel leaves the card on
	// hold without it. A move made is not read again (its own echo is); a
	// throw here, which the handler does not expect, reads the board.
	async function confirmOnHold() {
		const started = toasts.navigation();
		let noteKept = false;
		try {
			const { failure, noteFailure } = await dndHandlers.confirmOnHold(onHoldState, data.board.id, currentUser?.username || '', currentUser?.emoji || '👤');
			if (failure) {
				putBackOnHold();
				toasts.add(failure, 'error', started);
				return;
			}
			// Each card of the columns the move touched takes its column and place as sent.
			boardState.columns = moveCards(boardState.columns, onHoldState.pendingUpdates).columns;
			onHoldFrom = null;
			if (noteFailure) {
				toasts.add(`"${onHoldState.cardTitle}" was put on hold, but its note was not saved. ${noteFailure}`, 'error', started);
				onHoldState = { ...onHoldState, pendingUpdates: [] };
				noteKept = true;
				return;
			}
			boardState.columns = patchCard(boardState.columns, onHoldState.cardId, { onHoldNote: onHoldState.note }).columns;
		} catch {
			toasts.add('No answer from the server. The card may not have been put on hold.', 'error', started);
			boardState.refresh();
		} finally {
			if (!noteKept) {
				onHoldState = { show: false, cardId: 0, cardTitle: '', note: '', pendingUpdates: [], pendingColumnId: 0 };
				onHoldFrom = null;
				releaseOnHold();
			}
		}
	}

	// The card back where the drag found it, with no read: nothing was sent (slice B2b).
	function cancelOnHold() {
		if (onHoldFrom) boardState.columns = undoDrag(boardState.columns, onHoldFrom, [onHoldState.cardId]);
		onHoldFrom = null;
		onHoldState = { show: false, cardId: 0, cardTitle: '', note: '', pendingUpdates: [], pendingColumnId: 0 };
		releaseOnHold();
	}

	// ─── User ────────────────────────────────────────────────────────────────

	// User from server-side auth
	let currentUser = $derived($page.data.user);
	let canManage = $derived(boardState.canManage);
	let showShareModal = $state(false);
	let showMoreMenu = $state(false);

	// ─── Fireworks ───────────────────────────────────────────────────────────

	let showFireworks = $state(false);
	let celebrateCardTitle = $state('');
	let celebrateUserName = $state('');
	let celebrateUserEmoji = $state('');
	let celebrateXpGained = $state(0);

	// ─── XP Leaderboard ──────────────────────────────────────────────────────

	let xpLeaderboard = $state<XpEntry[]>([]);

	async function refreshXp() {
		xpLeaderboard = await fetchXpData();
	}

	// ─── Live Timestamps ─────────────────────────────────────────────────────

	let tick = $state(0);
	let tickInterval: ReturnType<typeof setInterval> | null = null;

	// ─── Drag & Drop ─────────────────────────────────────────────────────────

	// A drag holds the board's reads from its first move, before the columns
	// change, until the move it makes is answered (R6): a read landing then
	// would draw the board as it was, under the user's hand.
	let dragHold: Release | null = null;

	/**
	 * The columns as the drag in hand found them, copied at its first move: a
	 * move refused, blocked or cancelled is put back from them at once, with
	 * no read (slice B2b). Nothing else changes the columns meanwhile: the
	 * drag holds the reads.
	 */
	let dragFrom: ColumnType[] | null = null;

	/**
	 * Hold the reads for the drag in hand, once; a hold the watchdog has let go
	 * is not used again. Keep the columns as the drag found them, once.
	 */
	function holdDrag() {
		if (!dragHold || dragHold.released) dragHold = boardState.hold();
		dragFrom ??= copyColumns(boardState.columns);
	}

	/** The drag's hold, for the drop that sends its move to let go once answered. */
	function takeDragHold(): Release {
		const release = dragHold && !dragHold.released ? dragHold : boardState.hold();
		dragHold = null;
		return release;
	}

	/** The columns as the drag found them, for the drop that sends its move; a drop with no first move finds them as they are. */
	function takeDragFrom(): ColumnType[] {
		const from = dragFrom ?? copyColumns(boardState.columns);
		dragFrom = null;
		return from;
	}

	/**
	 * A keyboard drag ends with a consider and no drop (svelte-dnd-action's
	 * DRAG_STOPPED, on Space, Enter, Escape or a click outside; each arrow move
	 * is a drop of its own): the drag's hold is let go there (B2a review).
	 */
	function stopDrag() {
		dragHold?.();
		dragHold = null;
		dragFrom = null;
	}

	function handleColumnDndConsider(e: CustomEvent) {
		if (e.detail.info?.trigger === TRIGGERS.DRAG_STOPPED) {
			boardState.columns = e.detail.items;
			stopDrag();
			return;
		}
		holdDrag();
		boardState.columns = e.detail.items;
	}

	// The new order is shown from the columns as the drag found them, each
	// column at its index, as sent; a refusal puts back the order and the
	// places there were, and says why (slice B2b). Its answer was thrown away.
	async function handleColumnDndFinalize(e: CustomEvent) {
		const release = takeDragHold();
		const from = takeDragFrom();
		const started = toasts.navigation();
		try {
			const order = (e.detail.items as ColumnType[]).map((c) => c.id);
			const written = await boardState.write(() => reorderColumns(from, order), () => dndHandlers.handleColumnDndFinalize(e.detail.items, data.board.id), {
				refused: 'The columns were not reordered.',
				noAnswer: 'No answer from the server. The columns may not have been reordered.'
			});
			if (!written.ok) toasts.add(written.failure, 'error', started);
		} finally {
			release();
		}
	}

	function handleCardDndConsider(columnId: number, e: CustomEvent) {
		if (e.detail.info?.trigger === TRIGGERS.DRAG_STOPPED) {
			takeCardItems(columnId, e);
			stopDrag();
			return;
		}
		holdDrag();
		takeCardItems(columnId, e);
	}

	/** A card zone's items, as the drag left them. */
	function takeCardItems(columnId: number, e: CustomEvent) {
		const col = boardState.columns.find((c) => c.id === columnId);
		if (col) col.cards = e.detail.items;
		boardState.columns = [...boardState.columns];
	}

	async function handleCardDndFinalize(columnId: number, e: CustomEvent) {
		// Clear sort on manual drag
		if (boardState.columnSorts[columnId]) boardState.setSort(columnId, 'none');
		// A drop into another column fires here twice, in either order: for the
		// column dropped into, and for the column the card left. The call for
		// the column dropped into sends both (card 2213), so the other only
		// takes its items. It used to send the whole board as well, past the On
		// Hold note and the blocked-card check, so Cancel on the note did not
		// undo the move. The drag's hold is the other call's to let go.
		if (e.detail.info?.trigger === TRIGGERS.DROPPED_INTO_ANOTHER) {
			// A keyboard drag fires the column left first, with no move between
			// one arrow's drop and the next: its columns are kept here, before
			// the card leaves, or a second hop put back would put it nowhere (the
			// B2b review). A pointer drag kept them at its first move.
			if (e.detail.info?.source === SOURCES.KEYBOARD) dragFrom ??= copyColumns(boardState.columns);
			takeCardItems(columnId, e);
			return;
		}
		const release = takeDragHold();
		const from = takeDragFrom();
		// The cards this drop carries: the one dragged, and any that came into
		// the column. Only their columns are put back, and only they may come
		// back from the copy while on the board nowhere (the B2b re-check).
		const dragged = [e.detail.info?.id, ...(e.detail.items as CardType[]).filter((c) => c.columnId !== columnId).map((c) => c.id)].filter((id): id is number => typeof id === 'number');
		const started = toasts.navigation();
		try {
			const result = await dndHandlers.handleCardDndFinalize(
				columnId, e.detail.items, boardState.columns,
				data.board.id, currentUser?.username || '', currentUser?.emoji || '👤'
			);
			switch (result.action) {
				case 'blocked':
					// Not sent: the card goes back where the drag found it, at once
					// (slice B2b), and the window holds the board while it says why,
					// out of the watchdog's reach, as the On Hold window does; taken
					// before the drag's own is let go. One left open is let go first.
					boardState.columns = undoDrag(boardState.columns, from, dragged);
					blockedState = result.blockedState;
					releaseBlocked();
					blockedRelease = boardState.hold({ watchdog: false });
					break;
				case 'on-hold':
					onHoldState = result.onHoldState;
					boardState.columns = withCurrentCards(result.updatedColumns, boardState.columns, dragged);
					onHoldFrom = from;
					// The move waits for its note. The window holds, out of the
					// watchdog's reach, until Confirm is answered or Cancel; taken
					// before the drag's own is let go, so no read slips between. One
					// left from an earlier window is let go first: unwatched, it
					// would hold the board for good.
					releaseOnHold();
					onHoldRelease = boardState.hold({ watchdog: false });
					break;
				case 'refused':
					// Not moved: the cards go back where the drag found them, at once
					// (slice B2b), the board is read once, and the server's words are
					// said. No sound, no completion prompt.
					boardState.columns = undoDrag(boardState.columns, from, dragged);
					boardState.refresh();
					toasts.add(result.message, 'error', started);
					break;
				case 'committed':
					// Each card of the columns the drop touched takes its column and
					// place as sent (R7): a card moved carried the column it was read
					// in until the board was read again. Each card as it is now: a
					// write answered or taken back while the move was out changed the
					// card on the board, not the drop's copy (the B2b review).
					boardState.columns = moveCards(withCurrentCards(result.updatedColumns, boardState.columns, dragged), result.updates).columns;
					for (const entry of result.movedCards) {
						if (entry.isComplete) {
							playCompleteSound();
							queueCompletionPrompt(entry.card);
						} else {
							playMoveSound();
						}
						// Starting something that is still waiting on another card is
						// allowed — sometimes you know better than the graph — but it
						// should never happen silently.
						warnIfStillBlocked(entry.card, entry.toName);
					}
					// Check WIP limit on destination column
					if (result.movedCards.length > 0) {
						const destCol = boardState.columns.find(c => c.id === columnId);
						if (destCol && destCol.wipLimit > 0 && destCol.cards.length > destCol.wipLimit) {
							toasts.add(`⚠ ${destCol.title} exceeds WIP limit (${destCol.cards.length}/${destCol.wipLimit})`, 'warning');
						}
					}
					break;
			}
		} finally {
			release();
		}
	}

	// ─── Activity Logging ────────────────────────────────────────────────────

	// The server writes the activity entry for every change it makes, with the
	// user's id and where it came from. This page used to write a second one for
	// each create, move, completion and delete, carrying neither.

	async function loadActivities() {
		loadingActivities = true;
		const res = await api.loadActivities(data.board.id);
		if (res.ok) activities = await res.json();
		loadingActivities = false;
	}

	// ─── Panel Toggles ───────────────────────────────────────────────────────

	async function toggleActivityPanel() {
		showActivityPanel = !showActivityPanel;
		if (showActivityPanel) await loadActivities();
	}

	function toggleStatsPanel() {
		showStatsPanel = !showStatsPanel;
	}

	// ─── Lifecycle ───────────────────────────────────────────────────────────

	let cleanupSSE: (() => void) | null = null;

	// The live stream is this page's, opened as it mounts and closed as it is
	// destroyed. `./+layout.svelte` makes the page afresh for each board, so a
	// link to another board, or Back to one, closes the first board's stream
	// and opens the second's (card 2184); a `?card=` link on this board keeps
	// the page and its stream. What the stream says is the board state's to
	// read: the access event at once, never held, so a board taken away shows
	// its refusal; any other change, a reconnect or a return to the tab, after
	// the burst and once nothing holds it (card 2280, slice B2a).
	onMount(() => {
		refreshXp();
		tickInterval = setInterval(() => { tick++; }, 15000);
		if (browser) {
			cleanupSSE = connectSSE(data.board.id, {
				onUpdate: (event) => (event?.type === 'access' ? boardState.accessChanged() : boardState.refresh()),
				onCelebrate: (d) => {
					celebrateCardTitle = d.cardTitle;
					celebrateUserName = d.userName;
					celebrateUserEmoji = d.userEmoji;
					celebrateXpGained = d.xpGained;
					showFireworks = true;
					playCompleteSound();
					setTimeout(() => (showFireworks = false), 3000);
				},
				onXpUpdate: () => refreshXp()
			});
		}
	});

	onDestroy(() => {
		if (cleanupSSE) cleanupSSE();
		if (tickInterval) clearInterval(tickInterval);
		boardState.dispose();
	});
</script>

<svelte:head>
	<title>{boardEmoji} {boardName} — DumpFire</title>
</svelte:head>

<svelte:window onclick={closeDropdowns} />

<div class="board-page-wrapper">
<div class="board-page">
	<!-- The header (slice B3: a component). The name typed, the search and the
	     filters are this page's, bound; the XP bars and the More menu are
	     drawn in it from here, each with what it needs of this page. -->
	<BoardHeader
		boardId={data.board.id}
		{boardName}
		{boardEmoji}
		breadcrumbs={boardState.breadcrumbs}
		tokenSummary={boardState.boardTokenSummary}
		editingName={editingBoardName}
		bind:nameDraft={boardNameDraft}
		bind:searchQuery
		bind:filterAssigneeId
		bind:hideBlocked
		{currentUser}
		boardUsers={boardState.boardUsers}
		view={boardView.view}
		onEmoji={(emoji) => saveBoardEmoji(emoji)}
		onStartRename={startEditBoardName}
		onRename={saveBoardName}
		onViewChange={(view) => setBoardView({ ...boardView, view })}
		onAddColumn={() => (showAddColumnModal = true)}
	>
		{#snippet xp()}
			<!-- XP Leaderboard -->
			<XpLeaderboard entries={xpLeaderboard} />
		{/snippet}
		{#snippet more()}
			<BoardMoreMenu
				bind:open={showMoreMenu}
				{showActivityPanel}
				{showStatsPanel}
				{showArchivePanel}
				{selectionMode}
				{canManage}
				isSubBoard={boardState.breadcrumbs && boardState.breadcrumbs.length > 0}
				boardId={data.board.id}
				onToggleActivity={toggleActivityPanel}
				onToggleStats={toggleStatsPanel}
				onToggleArchive={toggleArchivePanel}
				onManageCategories={() => (showCategoryModal = true)}
				onToggleSelection={() => { selectionMode = !selectionMode; if (!selectionMode) clearSelection(); }}
				onShare={() => (showShareModal = true)}
				onDeleteSubBoard={confirmDeleteThisSubBoard}
			/>
		{/snippet}
	</BoardHeader>

	<!-- One column at a time, for a portrait monitor (card 2079); the Kanban block below is left as it was. -->
	{#if boardView.view === 'list'}
	<ColumnListView
		columns={boardState.columns}
		categories={boardState.categories}
		filter={{ search: searchQuery, assigneeId: filterAssigneeId, hideBlocked }}
		blockerCount={(cardId) => blockersFor(cardId).length}
		{blockerTooltip}
		{milestoneNameById}
		{cardTokens}
		{tick}
		{selectedCards}
		{selectionMode}
		choice={boardView}
		onOpen={(card, e) => (selectionMode ? toggleSelection(card.id, e) : openCardModal(card))}
		onContextMenu={openContextMenu}
		onChange={setBoardView}
	/>
	{:else}
	<!-- Kanban columns -->
	<div class="kanban-container">
		<div
			class="columns-wrapper"
			use:dndzone={{
				items: boardState.columns,
				flipDurationMs: FLIP_DURATION_MS,
				type: 'columns',
				dropTargetStyle: { outline: '2px solid rgba(99, 102, 241, 0.4)', borderRadius: '14px' }
			}}
			onconsider={handleColumnDndConsider}
			onfinalize={handleColumnDndFinalize}
		>
			{#each boardState.columns as column (column.id)}
				<div class="kanban-column glass" class:wip-warning={column.wipLimit > 0 && column.cards.length >= column.wipLimit} animate:flip={{ duration: FLIP_DURATION_MS }}>
					<!-- The column's head (slice B3: a component). The column being
					     renamed and the WIP limit being typed are this page's, one at a
					     time for the whole board, bound; so is the dropdown open. -->
					<KanbanColumnHeader
						{column}
						{canManage}
						editing={editingColumn === column.id}
						bind:editTitle={editColumnTitle}
						editingWip={editingWipColumn === column.id}
						bind:wipLimitInput
						sort={boardState.columnSorts[column.id]}
						visibleCount={searchQuery.trim() || filterAssigneeId !== null || hideBlocked ? column.cards.filter(c => matchesSearch(c, searchQuery, boardState.categories) && (filterAssigneeId === null || c.assignees?.some(a => a.id === filterAssigneeId)) && passesBlockedFilter(c.id)).length : null}
						colorOpen={openDropdown === `color-${column.id}`}
						menuOpen={openDropdown === `menu-${column.id}`}
						onStartRename={startEditColumn}
						onFinishRename={finishEditColumn}
						onSort={setColumnSort}
						onAddCard={openNewCardModal}
						onToggleDropdown={toggleDropdown}
						onColor={setColumnColor}
						onToggleAddCard={toggleShowAddCard}
						onStartWip={startEditWipLimit}
						onSaveWip={saveWipLimit}
						onCancelWip={() => (editingWipColumn = null)}
						onDelete={confirmDeleteColumn}
						onCloseDropdowns={closeDropdowns}
					/>



					<div
						class="column-cards"
						use:dndzone={{
							items: column.cards,
							flipDurationMs: FLIP_DURATION_MS,
							type: 'cards',
							dropTargetStyle: { outline: 'none' },
							dropTargetClasses: ['drop-target-active']
						}}
						onconsider={(e) => handleCardDndConsider(column.id, e)}
						onfinalize={(e) => handleCardDndFinalize(column.id, e)}
						ondblclick={(e: MouseEvent) => { if ((column.title.toLowerCase() === 'to do' || column.showAddCard) && !(e.target as HTMLElement).closest('.kanban-card')) openNewCardModal(column.id); }}
					>
						{#if column.cards.length === 0}
							<div class="empty-column-prompt">
								<span class="empty-icon">✨</span>
								<span class="empty-text">No cards yet</span>
								{#if column.title.toLowerCase() === 'to do' || column.showAddCard}
									<span class="empty-hint">Double-click to add one</span>
								{/if}
							</div>
						{/if}
						{#each column.cards as card (card.id)}
							<!-- svelte-ignore a11y_click_events_have_key_events -->
							<div
								class="kanban-card"
								class:card-completed={isCompleteColumn(column)}
								class:card-on-hold={isOnHoldColumn(column.title)}
								class:card-hidden={!matchesSearch(card, searchQuery, boardState.categories) || (filterAssigneeId !== null && !card.assignees?.some(a => a.id === filterAssigneeId)) || !passesBlockedFilter(card.id)}
								class:card-stale={isStale(card.createdAt) && !isCompleteColumn(column)}
								class:card-selected={selectedCards.has(card.id)}
								class:card-pinned={card.pinned}
								animate:flip={{ duration: FLIP_DURATION_MS }}
								onclick={(e) => inlineEditCardId === card.id ? null : (selectionMode ? toggleSelection(card.id, e) : openCardModal(card))}
								oncontextmenu={(e) => openContextMenu(e, card, column.id)}
								role="button"
								tabindex="0"
								id="card-{card.id}"
							>
								<!-- What the card shows (slice B3: a component). The title being
								     typed is this page's, bound. -->
								<KanbanCardBody
									{card}
									isComplete={isCompleteColumn(column)}
									isOnHold={isOnHoldColumn(column.title)}
									categories={boardState.categories}
									labels={boardState.labels}
									{blockersFor}
									{blockerTooltip}
									{milestoneNameById}
									{cardTokens}
									{tick}
									{selectionMode}
									selected={selectedCards.has(card.id)}
									editing={inlineEditCardId === card.id}
									bind:editValue={inlineEditValue}
									onStartEdit={startInlineEdit}
									onSaveEdit={saveInlineEdit}
									onEditKeydown={handleInlineKeydown}
									onCyclePriority={cyclePriority}
								/>
							</div>
						{/each}
					</div>
				</div>
			{/each}
		</div>
	</div>
	{/if}
</div> <!-- /.board-page -->
<div class="board-panels-area">
{#if showActivityPanel}
	<ActivityPanel {activities} loading={loadingActivities} onClose={() => (showActivityPanel = false)} />
{/if}
{#if showStatsPanel}
	<StatsPanel
		boardColumns={boardState.columns}
		boardCategories={boardState.categories}
		boardId={data.board.id}
		onClose={() => (showStatsPanel = false)}
	/>
{/if}
{#if showArchivePanel}
	<ArchivePanel
		cards={archivedCards}
		loading={loadingArchive}
		onClose={() => (showArchivePanel = false)}
		onRestore={(cardId) => restoreCard(cardId)}
		onDeleteForever={(card) => {
			showConfirm('Delete Permanently', api.cardDeleteWarning(card.title), 'Delete Forever', async () => {
				await permanentlyDeleteCard(card.id);
				confirmState.show = false;
			});
		}}
	/>
{/if}
</div> <!-- /.board-panels-area -->
</div> <!-- /.board-page-wrapper -->


<!-- Bulk Action Bar -->
{#if selectionMode && selectedCards.size > 0}
	<BulkActionBar
		selectedCount={selectedCards.size}
		columns={boardState.columns}
		onMove={handleBulkMove}
		onPriority={handleBulkPriority}
		onDelete={handleBulkDelete}
		onClear={clearSelection}
	/>
{/if}

<!-- Context Menu -->
{#if contextMenu.show && contextMenu.card}
	<ContextMenu
		card={contextMenu.card}
		columnId={contextMenu.columnId}
		x={contextMenu.x}
		y={contextMenu.y}
		columns={boardState.columns}
		onClose={closeDropdowns}
		onMove={moveFromMenu}
		onPriority={setPriorityFromMenu}
		onTogglePin={(card) => togglePin(card)}
		onDuplicate={(card) => duplicateCard(card)}
		onCreateSubBoard={(card) => createSubBoard(card)}
		onDelete={(cardId) => confirmDeleteCard(cardId)}
	/>
{/if}

<Toast />

<!-- Card Modal -->
{#if cardWindow.open}
	<CardModal
		card={cardWindow.card}
		categories={boardState.categories}
		labels={boardState.labels}
		boardId={data.board.id}
		boardUsers={boardState.boardUsers.map(u => ({ ...u, emoji: u.emoji || '👤' }))}
		onSave={saveCard}
		onDelete={cardWindow.card ? () => confirmDeleteCard(cardWindow.cardId!) : undefined}
		onClose={() => cardWindow.close()}
		onCreateSubBoard={cardWindow.card ? (name) => createSubBoard(cardWindow.card!, name) : undefined}
		onDeleteSubBoard={cardWindow.card ? (boardId) => deleteSubBoard(boardId) : undefined}
		onLinkSubBoard={cardWindow.card ? (boardId) => linkSubBoard(cardWindow.cardId!, boardId) : undefined}
		notice={cardWindow.gone ? CARD_GONE : ''}
		availableBoards={boardState.linkableBoards.map(b => ({ id: b.id, name: b.name, emoji: b.emoji || '📋' }))}
		milestones={boardState.milestones}
	/>
{/if}

<!-- Confirm Modal -->
{#if confirmState.show}
	<ConfirmModal
		title={confirmState.title}
		message={confirmState.message}
		confirmText={confirmState.confirmText}
		onConfirm={() => { confirmState.show = false; confirmState.onConfirm(); }}
		onCancel={() => (confirmState.show = false)}
	/>
{/if}

<!-- Blocked by subtasks/sub-board modal -->
{#if blockedState.show}
	<ConfirmModal
		title="Cannot Complete"
		message={blockedState.reason === 'subtasks'
			? `This card has ${blockedState.incomplete} incomplete subtask${blockedState.incomplete > 1 ? 's' : ''}. All subtasks must be completed before moving it to the Complete column.`
			: blockedState.subBoardId === null
				? `This card has ${blockedState.incomplete} incomplete task${blockedState.incomplete > 1 ? 's' : ''} on a sub-board you cannot open. All sub-board tasks must be completed first. Ask this board's owner.`
				: `This card has ${blockedState.incomplete} incomplete task${blockedState.incomplete > 1 ? 's' : ''} on its sub-board. All sub-board tasks must be completed first.`
		}
		confirmText={blockedState.subBoardId !== null ? 'Open Sub-board' : 'Open Card'}
		confirmDanger={false}
		onConfirm={() => {
			closeBlocked();
			if (blockedState.card) {
				// A sub-board the caller cannot open is not offered: it is counted, not named.
				if (blockedState.subBoardId !== null) {
					window.location.href = `/board/${blockedState.subBoardId}`;
				} else {
					openCardModal(blockedState.card);
				}
			}
		}}
		onCancel={closeBlocked}
	/>
{/if}

<!-- Add Column Modal -->
{#if showAddColumnModal}
	<AddColumnModal
		columns={boardState.columns}
		onAdd={({ title, position, color }) => {
			newColumnTitle = title;
			newColumnPosition = position;
			newColumnColor = color;
			addColumn();
		}}
		onClose={() => (showAddColumnModal = false)}
	/>
{/if}

<!-- Completion prompt: summary and close reason, asked once per completed card -->
{#if completionCard}
	<CompletionPromptModal
		cardTitle={completionCard.title}
		bind:summary={completionSummary}
		bind:closeReason={completionReason}
		remaining={completionQueue.length - 1}
		onSave={saveCompletionPrompt}
		onSkip={nextCompletionPrompt}
	/>
{/if}

<!-- On Hold Note Modal -->
{#if onHoldState.show}
	<OnHoldModal
		cardTitle={onHoldState.cardTitle}
		bind:note={onHoldState.note}
		onConfirm={confirmOnHold}
		onCancel={cancelOnHold}
	/>
{/if}

<!-- Category Modal -->
{#if showCategoryModal}
	<!-- Not one a card here carries from a board the caller cannot open (card 2128): it is not theirs to manage. -->
	<CategoryModal
		categories={boardState.categories.filter((c) => !c.carried)}
		onAdd={addCategory}
		onDeleteCategory={deleteCategory}
		onClose={() => (showCategoryModal = false)}
	/>
{/if}

<!-- Fireworks celebration -->
{#if showFireworks}
	<FireworksCelebration
		cardTitle={celebrateCardTitle}
		userName={celebrateUserName}
		userEmoji={celebrateUserEmoji}
		xpGained={celebrateXpGained}
	/>
{/if}

<!-- Share modal -->
{#if showShareModal}
	<ShareModal boardId={data.board.id} boardName={boardName} canManage={boardState.canManage} onClose={() => { showShareModal = false; boardState.refresh(); }} />
{/if}

<style>
	/* Flex wrapper: board + side panels */
	.board-page-wrapper { display: flex; height: 100vh; overflow: hidden; }
	.board-page { height: 100vh; display: flex; flex-direction: column; overflow: hidden; flex: 1; min-width: 0; }
	.board-panels-area { display: flex; flex-shrink: 0; }

	/* The header, its XP bars and More menu, each column's head, each card's
	   body and the two side panels style themselves, in their components
	   (slice B3). What a component draws that is styled by a state of an
	   element this page keeps (a column's or a card's hover, a pinned card, a
	   column over its WIP limit) is styled here, `:global` under that element. */

	/* Card hidden by search */
	.kanban-card.card-hidden {
		display: none;
	}

	.kanban-container { flex: 1; display: flex; padding: var(--space-lg); overflow: hidden; min-height: 0; }
	.columns-wrapper { display: flex; gap: var(--space-lg); flex: 1; height: 100%; min-height: 0; }

	.kanban-column {
		flex: 1; min-width: 240px; height: 100%; min-height: 0;
		display: flex; flex-direction: column; border-radius: var(--radius-lg);
	}
	/* The column's actions (in its head, `KanbanColumnHeader.svelte`) show on its hover. */
	.kanban-column:hover :global(.column-actions) { opacity: 1; }

	/* A list's scroll ends above the user badge (card 2239), or its last card is under it. */
	.column-cards {
		flex: 1; overflow-y: auto; padding: 0 var(--space-md) var(--user-badge-space);
		min-height: 0; display: flex; flex-direction: column; gap: var(--space-sm);
		/* Firefox scrollbar - hidden by default */
		scrollbar-width: auto;
		scrollbar-color: transparent transparent;
		transition: scrollbar-color 0.2s ease;
	}
	/* Show Firefox scrollbar on column hover */
	.kanban-column:hover .column-cards {
		scrollbar-color: var(--text-tertiary) rgba(128, 128, 128, 0.08);
	}
	/* Webkit scrollbar - wider, prettier */
	.column-cards::-webkit-scrollbar { width: 8px; }
	.column-cards::-webkit-scrollbar-track {
		background: transparent;
		border-radius: var(--radius-full);
		margin: 4px 0;
		transition: background 0.2s ease;
	}
	.kanban-column:hover .column-cards::-webkit-scrollbar-track {
		background: rgba(128, 128, 128, 0.08);
	}
	.column-cards::-webkit-scrollbar-thumb {
		background: transparent;
		border-radius: var(--radius-full);
		border: 1.5px solid transparent;
		background-clip: padding-box;
		transition: background 0.2s ease, box-shadow 0.2s ease;
	}
	/* Show webkit scrollbar thumb on column hover */
	.kanban-column:hover .column-cards::-webkit-scrollbar-thumb {
		background: var(--text-tertiary);
		border-radius: var(--radius-full);
		border: 1.5px solid transparent;
		background-clip: padding-box;
	}
	.kanban-column:hover .column-cards::-webkit-scrollbar-thumb:hover {
		background: var(--text-secondary);
		border: 1.5px solid transparent;
		background-clip: padding-box;
		box-shadow: 0 0 6px rgba(99, 102, 241, 0.3);
	}
	:global(.drop-target-active) { background: rgba(99, 102, 241, 0.05) !important; border-radius: var(--radius-md); }

	.kanban-card {
		background: var(--bg-card); border: 1px solid var(--glass-border);
		border-radius: var(--radius-md); padding: var(--space-md); cursor: pointer;
		transition: all var(--duration-normal) var(--ease-out); position: relative; overflow: hidden;
		flex-shrink: 0;
	}
	.kanban-card:hover { border-color: var(--glass-border); transform: translateY(-1px); box-shadow: var(--shadow-md); }
	.kanban-card.card-completed {
		background: rgba(16, 185, 129, 0.06);
		border-color: rgba(16, 185, 129, 0.15);
	}
	.kanban-card.card-completed:hover {
		border-color: rgba(16, 185, 129, 0.25);
		box-shadow: 0 4px 12px rgba(16, 185, 129, 0.1);
	}
	.kanban-card.card-on-hold {
		background: rgba(239, 68, 68, 0.05);
		border-color: rgba(239, 68, 68, 0.15);
	}
	.kanban-card.card-on-hold:hover {
		border-color: rgba(239, 68, 68, 0.25);
		box-shadow: 0 4px 12px rgba(239, 68, 68, 0.1);
	}
	/* The drag handle (in the card's body, `KanbanCardBody.svelte`) shows on the card's hover. */
	.kanban-card:hover :global(.drag-handle) { opacity: 0.4; }
	.kanban-card:hover :global(.drag-handle:hover) { opacity: 0.8; }
	.kanban-card { padding-left: calc(var(--space-md) + 12px); }

	/* Stale card */
	.kanban-card.card-stale { border-left: 2px solid rgba(136, 136, 170, 0.3); }

	.kanban-card.card-selected { outline: 2px solid var(--accent-indigo); outline-offset: -2px; }

	/* Empty column */
	.empty-column-prompt {
		display: flex; flex-direction: column; align-items: center;
		padding: var(--space-xl) var(--space-md);
		color: var(--text-tertiary); pointer-events: none;
	}
	.empty-icon { font-size: 1.5rem; margin-bottom: var(--space-xs); opacity: 0.5; }
	.empty-text { font-size: 0.78rem; font-weight: 600; }
	.empty-hint { font-size: 0.65rem; opacity: 0.6; }

	.kanban-card.card-pinned { border-top: 2px solid var(--accent-indigo); }
	/* A pinned card's New badge (in its body) moves left of the pin. */
	.kanban-card.card-pinned :global(.new-badge) { right: 22px; }

	/* Drag shadow */
	:global(.kanban-card[aria-grabbed="true"]) {
		transform: rotate(2deg) scale(1.03);
		box-shadow: 0 12px 40px rgba(0,0,0,0.3);
		opacity: 0.9;
	}

	/* ─── WIP Limit Styles ──────────────────────────────────────────────── */
	.wip-warning { box-shadow: inset 0 0 0 2px rgba(245, 158, 11, 0.35); }
	/* The colour bar is in the column's head; the keyframes are this page's. */
	.wip-warning :global(.column-top-bar) { animation: wip-pulse 2s ease-in-out infinite; }
	@keyframes wip-pulse { 0%, 100% { opacity: 1; } 50% { opacity: 0.5; } }

	/* ─── Mobile Responsive ──────────────────────────────────────────────── */

	@media (max-width: 768px) {
		.kanban-container {
			padding: var(--space-sm);
			overflow-x: auto;
			-webkit-overflow-scrolling: touch;
		}
		.columns-wrapper {
			gap: var(--space-md);
			overflow-x: auto;
			scroll-snap-type: x mandatory;
			-webkit-overflow-scrolling: touch;
			padding-bottom: var(--space-md);
		}
		.kanban-column {
			flex: 0 0 85vw;
			min-width: 260px;
			max-width: 85vw;
			scroll-snap-align: start;
		}
		.kanban-card {
			padding: var(--space-md) var(--space-lg) !important;
		}

		/* Side panels become full-width on mobile */
		.board-page-wrapper { flex-direction: column; }
	}

	@media (max-width: 480px) {
		.kanban-column {
			flex: 0 0 92vw;
			max-width: 92vw;
		}
	}
</style>
