<script lang="ts">
	/**
	 * All To Do (card 2240): the cards in the To Do column of every board the
	 * caller can open, as one table.
	 *
	 * The load sends every such card, read as All Tasks reads them; this page
	 * filters and sorts them in the browser through `$lib/todo-table`, so a
	 * filter change is instant and re-runs no load. The filters and the sort
	 * live in the address, written with `goto(…, { replaceState: true })`, so
	 * a filtered view can be bookmarked or sent and Back from a board comes
	 * back to it, and they survive the live re-read, which keeps the page
	 * current as cards come and go.
	 *
	 * At 1000 px and wider the cards are a table with sortable headers; below
	 * that each row is a block and the filters fold behind "Filters (n)", with
	 * no sideways scroll at any width. A row opens the card window here, as All
	 * Tasks does, so a run through the queue keeps its filters and its place;
	 * the board path on a row opens the card on its own board.
	 */
	import type { PageData } from './$types';
	import { onMount, onDestroy, untrack } from 'svelte';
	import { goto, invalidateAll } from '$app/navigation';
	import { page } from '$app/state';
	import CardModal from '$lib/components/CardModal.svelte';
	import { PageCardWindow } from '$lib/board/page-card-window.svelte';
	import type { CardWindowSave } from '$lib/board/card-window.svelte';
	import ConfirmModal from '$lib/components/ConfirmModal.svelte';
	import Toast from '$lib/components/Toast.svelte';
	import { toasts } from '$lib/stores/toast';
	import ThemePicker from '$lib/components/ThemePicker.svelte';
	import BoardFilterSelect from '$lib/components/BoardFilterSelect.svelte';
	import type { CardType } from '$lib/types';
	import { getDueRelative, getDueStatus, formatDueDate } from '$lib/utils/date-utils';
	import { subtaskProgress } from '$lib/utils/card-utils';
	import { boardPathText, chosenBoardId, inBoardFilter } from '$lib/board-tree';
	import { cardArchiveWarning } from '$lib/api';
	import { connectLiveRefresh } from '$lib/live-refresh';
	import { drawnColour } from '$lib/colours';
	import {
		dropUnknownChoices,
		filterChoices,
		filtersFromUrl,
		filtersToUrl,
		isBlocked,
		isFiltering,
		keepKnownFilters,
		knownBoardFilters,
		NO_FILTERS,
		passesTodoFilters,
		sortTodoRows,
		todoContext,
		TODO_PRIORITIES,
		TODO_SORTS,
		type TodoFilters,
		type TodoSort
	} from '$lib/todo-table';

	let { data }: { data: PageData } = $props();

	type Row = PageData['cards'][number];

	/**
	 * The cards drawn: the load's, with a save from the card window shown on
	 * its row at once and taken back if refused. Each re-read replaces them.
	 * The filters' choices, and the check of the filters after a re-read, go
	 * by the load's alone.
	 */
	let cards = $derived(data.cards);

	/** Who is viewing: what the Assignee filter's "Me" means. */
	const viewerId = $derived(data.user?.id ?? 0);
	const ctx = $derived(todoContext(data, viewerId));

	/**
	 * The filters in the address the page is at. A board the caller cannot
	 * open, or that does not exist, is dropped and said so in the same words
	 * either way, and so is a grouping that holds none of the caller's boards;
	 * a category, label, person or milestone no card in scope has is dropped
	 * quietly.
	 */
	function readAddress() {
		const read = filtersFromUrl(page.url, knownBoardFilters(data));
		const choices = filterChoices(data.cards, read.filters.board, todoContext(data, data.user?.id ?? 0));
		return { filters: dropUnknownChoices(read.filters, choices).filters, boardRefused: read.boardRefused };
	}

	/**
	 * The board the page was opened for, from a board's header or from All
	 * Tasks (`?board=` and nothing else), or `all`. Clear filters goes back to
	 * it, which is the filter that page asked for; from there, to every board.
	 */
	const openedForOf = (read: TodoFilters) => (read.board !== 'all' && !isFiltering({ ...read, board: 'all' }) ? read.board : 'all');

	const arrival = readAddress();
	let filters = $state<TodoFilters>(arrival.filters);
	let boardRefused = $state(arrival.boardRefused);
	let openedFor = $state(openedForOf(arrival.filters));

	function clearFilters() {
		const back = filters.board === openedFor && !isFiltering({ ...filters, board: 'all' }) ? 'all' : openedFor;
		filters = { ...NO_FILTERS, board: back, sort: filters.sort, dir: filters.dir };
		boardRefused = false;
	}

	/** A board chosen: the other filters' choices are those of its cards, so one no card there has goes back to "any". */
	function chooseBoard(board: string) {
		filters = dropUnknownChoices({ ...filters, board }, filterChoices(data.cards, board, ctx)).filters;
		boardRefused = false;
	}

	/** A header clicked: sort by it, and a second click reverses it. */
	function sortBy(column: TodoSort) {
		if (filters.sort === column) filters.dir = filters.dir === 'asc' ? 'desc' : 'asc';
		else filters = { ...filters, sort: column, dir: 'asc' };
	}

	function ariaSort(column: TodoSort): 'ascending' | 'descending' | 'none' {
		if (filters.sort !== column) return 'none';
		return filters.dir === 'asc' ? 'ascending' : 'descending';
	}

	const SORT_LABELS: Record<TodoSort, string> = {
		priority: 'Priority',
		title: 'Title',
		board: 'Board',
		category: 'Category',
		due: 'Due',
		subtasks: 'Open subtasks',
		milestone: 'Milestone',
		blocked: 'Blocked'
	};

	const choices = $derived(filterChoices(data.cards, filters.board, ctx));
	const rows = $derived(sortTodoRows(cards.filter((card) => passesTodoFilters(card, filters, ctx)), filters.sort, filters.dir, ctx));
	const filtering = $derived(isFiltering(filters));
	/** How many of the folded filters are on: the search box stays in view, so it is not counted. */
	const foldedOn = $derived(
		[filters.board !== 'all', filters.priority, filters.category, filters.label, filters.assignee, filters.milestone, filters.state].filter(Boolean).length
	);

	const todoBoards = $derived(data.boards.filter((b) => b.hasTodo));
	const noTodoBoards = $derived(data.boards.filter((b) => !b.hasTodo));
	const scopeBoards = $derived(data.boards.filter((b) => inBoardFilter(b.id, filters.board, ctx.places)));
	const scopeCards = $derived(cards.filter((card) => inBoardFilter(card.boardId, filters.board, ctx.places)));
	const chosenBoard = $derived(chosenBoardId(filters.board));

	/** The board filter's choice in words, for the empty state of a board with no To Do column. */
	const scopeName = $derived.by(() => {
		if (filters.board.startsWith('cat:')) {
			const grouping = data.boardCategories.find((c) => `cat:${c.id}` === filters.board);
			return { grouping: true, name: grouping?.name ?? 'this grouping' };
		}
		const board = data.boards.find((b) => String(b.id) === filters.board);
		return { grouping: false, name: board ? `${board.emoji} ${board.name}` : 'This board' };
	});

	const plural = (n: number, one: string, many = `${one}s`) => `${n} ${n === 1 ? one : many}`;

	// ─── The address ──────────────────────────────────────────────────────
	// Written a moment after the last change, so typing in the search is one
	// entry, not one per key (a browser refuses a page that replaces its
	// address too often). It is written with goto and replaceState, a real
	// navigation in place of this history entry: a shallow replaceState left
	// page.url, and the entry SvelteKit keeps, at the address the page was
	// opened with, so Back from a board opened here lost the filters. No load
	// runs again, since neither this page's load nor the layout's reads `url`;
	// the focus stays in the search box and the page does not scroll.
	let addressTimer: ReturnType<typeof setTimeout> | null = null;
	/** The address this page last wrote, so that its own write is not read back as a visit. */
	let written = page.url.search;
	$effect(() => {
		const next = filtersToUrl(page.url, filters);
		if (addressTimer) clearTimeout(addressTimer);
		addressTimer = setTimeout(() => {
			addressTimer = null;
			if (next.search === page.url.search) return;
			written = next.search;
			goto(next, { replaceState: true, keepFocus: true, noScroll: true });
		}, 250);
	});

	// A visit to /todo while on /todo (Back or Forward between two of its
	// entries) keeps this page, so the filters are read again whenever the
	// address changes other than by the page's own write. A write still
	// waiting is dropped: it was for the filters the visit replaces.
	$effect(() => {
		const search = page.url.search;
		untrack(() => {
			if (search === written) return;
			written = search;
			if (addressTimer) clearTimeout(addressTimer);
			addressTimer = null;
			const read = readAddress();
			filters = read.filters;
			boardRefused = read.boardRefused;
			openedFor = openedForOf(read.filters);
		});
	});

	// After a live re-read, the filters are checked against the fresh load: a
	// board the caller can no longer open goes back to every board, with the
	// same notice as for an address, and a choice no card in scope has any
	// more goes back on "any", as on arrival.
	$effect(() => {
		const known = knownBoardFilters(data);
		const cards = data.cards;
		const context = ctx;
		untrack(() => {
			const kept = keepKnownFilters(filters, cards, known, context);
			if (kept.dropped.length === 0) return;
			filters = kept.filters;
			if (kept.boardRefused) {
				boardRefused = true;
				openedFor = 'all';
			}
		});
	});

	// ─── Live re-read, and the due dates' clock ───────────────────────────
	let tick = $state(0);
	let tickInterval: ReturnType<typeof setInterval> | null = null;
	let closeLive: (() => void) | null = null;

	onMount(() => {
		closeLive = connectLiveRefresh(() => invalidateAll());
		tickInterval = setInterval(() => { tick++; }, 60000);
	});

	onDestroy(() => {
		closeLive?.();
		closeLive = null;
		if (tickInterval) clearInterval(tickInterval);
		if (addressTimer) clearTimeout(addressTimer);
	});

	let filtersOpen = $state(false);

	// ─── What a row shows ─────────────────────────────────────────────────
	const priorityEmoji: Record<string, string> = { critical: '🔴', high: '🟠', medium: '🟡', low: '🟢' };
	const categoryById = $derived(new Map(data.categories.map((c) => [c.id, c])));
	const labelById = $derived(new Map(data.labels.map((l) => [l.id, l])));

	/** A card's board path: the boards its board hangs beneath, then its board. */
	function boardTag(card: Row): string {
		return boardPathText(ctx.places.get(card.boardId)?.path ?? [], { emoji: card.boardEmoji, name: card.boardName });
	}

	/** A board in the "no To Do column" list, by its path. */
	function boardLabel(board: (typeof data.boards)[number]): string {
		return boardPathText(ctx.places.get(board.id)?.path ?? [], board);
	}

	const blockersFor = (cardId: number) =>
		(data.blockedState[cardId] ?? []) as { id: number; title: string; columnTitle: string; boardName: string; withheld: boolean }[];

	/**
	 * The Blocked chip's tooltip, as All Tasks words it: each blocker with its
	 * board and column, or its number and the text in place of its title when
	 * it is on a board the viewer cannot open (card 2129).
	 */
	function blockerTooltip(cardId: number): string {
		const open = blockersFor(cardId);
		if (open.length === 0) return '';
		return ['Blocked by']
			.concat(open.map((b) => (b.withheld ? `#${b.id} ${b.title}` : `#${b.id} ${b.title} — ${b.boardName} / ${b.columnTitle}`)))
			.join('\n');
	}

	// ─── Card Editing ────────────────────────────────────────────────────
	// The card window, as All Tasks opens and saves it (cards 2186 and 2109):
	// through the board page's controller, over the rows above (card 2281,
	// slice C3a-1). A save sends only the fields changed in the window, so a
	// change someone else made to the card meanwhile is not sent back. No Move
	// window: a card leaves To Do from its board.
	const cardWindow = new PageCardWindow({ get: () => [{ cards }], set: (next) => (cards = next[0]?.cards ?? []) }, () => invalidateAll());

	function openCard(card: any) {
		cardWindow.openCard(card, card.boardId);
		loadBoardUsers(card.id);
	}

	// The window's people are those of the card's own board, as All Tasks and
	// the board page give them: a mention is drawn as a chip only for someone
	// it can mail (card 2198), and the assignee list is the board's. Until the
	// card's context answers, or if it does not, the window names nobody.
	let editingBoardUsers = $state<{ id: number; username: string; emoji: string }[]>([]);

	async function loadBoardUsers(cardId: number) {
		editingBoardUsers = [];
		const started = toasts.navigation();
		try {
			const res = await fetch(`/api/cards/${cardId}/context`);
			if (!res.ok) {
				if (cardWindow.cardId === cardId) toasts.add("The people of this card's board could not be read.", 'error', started);
				return;
			}
			const body = await res.json();
			// An answer for a card no longer open is not used.
			if (cardWindow.cardId === cardId) editingBoardUsers = body.boardUsers;
		} catch {
			if (cardWindow.cardId === cardId) toasts.add("No answer from the server: the people of this card's board are not shown.", 'error', started);
		}
	}

	/**
	 * Saves the card window through its controller, as All Tasks does: only
	 * the fields changed in it, shown on the row at once. A refusal, or no
	 * answer, is said and keeps the window open with what was typed, and the
	 * row put back; nothing changed sends nothing and says nothing. Once
	 * saved, the page is read again, as before.
	 */
	async function saveFromWindow(cardData: CardWindowSave) {
		const started = toasts.navigation();
		const written = await cardWindow.save(cardData);
		if (!written.ok) {
			toasts.add(written.failure, 'error', started);
			return;
		}
		if (written.told.length === 0) return;
		for (const { message, failed } of written.told) {
			if (failed) toasts.add(message, 'error', started);
			else toasts.add(message);
		}
		await invalidateAll();
	}

	// ─── Confirmations ────────────────────────────────────────────────────
	let confirmState = $state<{ show: boolean; title: string; message: string; confirmText: string; onConfirm: () => void }>({
		show: false, title: '', message: '', confirmText: '', onConfirm: () => {}
	});

	function showConfirm(title: string, message: string, confirmText: string, onConfirm: () => void) {
		confirmState = { show: true, title, message, confirmText, onConfirm };
	}

	/**
	 * Archive the open card, once it is confirmed, as the board page and All
	 * Tasks do: a DELETE with no `permanent` archives, and it can be restored.
	 * Sent by the card window's controller, which takes the card off the page
	 * and closes its window only once the server says it is archived.
	 */
	function archiveFromWindow() {
		const cardId = cardWindow.cardId;
		if (cardId === null) return;
		showConfirm('Archive Card', cardArchiveWarning(cardWindow.card?.title), 'Archive Card', async () => {
			const started = toasts.navigation();
			const failure = await cardWindow.archive(cardId);
			confirmState.show = false;
			if (failure) {
				// The card is still where it was, so its window stays open.
				toasts.add(failure, 'error', started);
				return;
			}
			toasts.add('Card archived. Restore it from Archived Cards.', 'info');
			await invalidateAll();
		});
	}
</script>

<svelte:head>
	<title>DumpFire — All To Do</title>
</svelte:head>

<div class="todo-page">
	<header class="todo-header">
		<div class="todo-header-left">
			<a href="/" class="back-btn btn-ghost" id="back-to-dashboard" aria-label="Back to the dashboard">
				<svg width="18" height="18" viewBox="0 0 18 18" fill="none"><path d="M11 4L6 9l5 5" stroke="currentColor" stroke-width="2" stroke-linecap="round" stroke-linejoin="round"/></svg>
			</a>
			<span class="todo-icon">📝</span>
			<div class="todo-heading">
				<h1 class="todo-title">All To Do</h1>
				<p class="todo-subtitle">
					{#if filtering}
						{rows.length} of {plural(cards.length, 'card')} in To Do
					{:else}
						{plural(cards.length, 'card')} in To Do across {plural(todoBoards.length, 'board')}
					{/if}
				</p>
			</div>
		</div>
		<div class="todo-header-right">
			<a
				href={chosenBoard ? `/plan?board=${chosenBoard}` : '/plan'}
				class="hdr-control hdr-action"
				title="Planning — critical path and what is startable{chosenBoard ? ' (the chosen board alone, not its sub-boards)' : ''}"
			>
				<svg width="14" height="14" viewBox="0 0 16 16" fill="none">
					<circle cx="3.5" cy="8" r="1.8" stroke="currentColor" stroke-width="1.2"/>
					<circle cx="8" cy="4" r="1.8" stroke="currentColor" stroke-width="1.2"/>
					<circle cx="12.5" cy="8" r="1.8" stroke="currentColor" stroke-width="1.2"/>
					<path d="M5.2 7.1L6.4 4.9M9.6 4.9l1.2 2.2" stroke="currentColor" stroke-width="1.1" stroke-linecap="round"/>
					<path d="M5.3 8.9l5.4 2.6" stroke="currentColor" stroke-width="1.1" stroke-linecap="round" stroke-dasharray="1.5 1.5"/>
				</svg>
				Planning
			</a>
			<ThemePicker />
		</div>
	</header>

	{#if noTodoBoards.length > 0 && data.boards.length > 0}
		<details class="no-todo">
			<summary>{plural(noTodoBoards.length, 'board')} {noTodoBoards.length === 1 ? 'has' : 'have'} no To Do column</summary>
			<ul>
				{#each noTodoBoards as board (board.id)}
					<li><a href="/board/{board.id}">{boardLabel(board)}</a></li>
				{/each}
			</ul>
		</details>
	{/if}

	{#if boardRefused}
		<p class="todo-notice" role="status">
			The board in the address is not one you can open. Showing every board.
			<button class="notice-close" onclick={() => (boardRefused = false)} aria-label="Dismiss">✕</button>
		</p>
	{/if}

	{#if data.boards.length > 0}
		<div class="toolbar">
			<div class="search-wrapper hdr-search">
				<svg width="14" height="14" viewBox="0 0 14 14" fill="none" aria-hidden="true">
					<circle cx="6" cy="6" r="4.5" stroke="currentColor" stroke-width="1.5"/>
					<path d="M10 10l3 3" stroke="currentColor" stroke-width="1.5" stroke-linecap="round"/>
				</svg>
				<input type="search" placeholder="Search cards or #id..." aria-label="Search" bind:value={filters.q} />
			</div>
			<button class="hdr-control filters-toggle" class:is-on={filtersOpen} aria-expanded={filtersOpen} onclick={() => (filtersOpen = !filtersOpen)}>
				<svg width="13" height="13" viewBox="0 0 16 16" fill="none" aria-hidden="true"><path d="M2 3h12l-4.5 5.5V13l-3 1.5v-6L2 3z" stroke="currentColor" stroke-width="1.3" stroke-linejoin="round"/></svg>
				Filters{#if foldedOn > 0}&nbsp;({foldedOn}){/if}
			</button>
			<div class="filter-panel" class:open={filtersOpen}>
				<BoardFilterSelect boards={data.boards} groupings={data.boardCategories} bind:value={filters.board} onchange={chooseBoard} />
				<select class="hdr-control" aria-label="Priority" bind:value={filters.priority}>
					<option value="">Any priority</option>
					{#each TODO_PRIORITIES as priority}
						<option value={priority}>{priorityEmoji[priority]} {priority[0].toUpperCase() + priority.slice(1)}</option>
					{/each}
				</select>
				<select class="hdr-control" aria-label="Category" bind:value={filters.category}>
					<option value="">Any category</option>
					{#each choices.categories as name}
						<option value={name}>{name}</option>
					{/each}
				</select>
				<select class="hdr-control" aria-label="Label" bind:value={filters.label}>
					<option value="">Any label</option>
					{#each choices.labels as name}
						<option value={name}>{name}</option>
					{/each}
				</select>
				<select class="hdr-control" aria-label="Assignee" bind:value={filters.assignee}>
					<option value="">Anyone</option>
					<option value="me">Me</option>
					<option value="none">Unassigned</option>
					{#each choices.assignees as person (person.id)}
						<option value={String(person.id)}>{person.emoji || '👤'} {person.username}</option>
					{/each}
				</select>
				<select class="hdr-control" aria-label="Milestone" bind:value={filters.milestone}>
					<option value="">Any milestone</option>
					<option value="none">No milestone</option>
					{#each choices.milestones as milestone (milestone.id)}
						<option value={String(milestone.id)}>🎯 {milestone.name}</option>
					{/each}
				</select>
				<select class="hdr-control" aria-label="State" bind:value={filters.state}>
					<option value="">Blocked or not</option>
					<option value="blocked">Blocked</option>
					<option value="startable">Startable</option>
				</select>
				<!-- Below 1000 px there are no headers to click, so the sort is chosen here. -->
				<div class="sort-controls">
					<select
						class="hdr-control"
						aria-label="Sort by"
						value={filters.sort ?? ''}
						onchange={(e) => {
							const sort = e.currentTarget.value;
							filters = { ...filters, sort: sort === '' ? null : (sort as TodoSort), dir: 'asc' };
						}}
					>
						<option value="">Default order</option>
						{#each TODO_SORTS as sort}
							<option value={sort}>Sort: {SORT_LABELS[sort]}</option>
						{/each}
					</select>
					{#if filters.sort !== null}
						<button class="hdr-control" onclick={() => (filters.dir = filters.dir === 'asc' ? 'desc' : 'asc')} aria-label="Reverse the order">
							{filters.dir === 'asc' ? '↑ Ascending' : '↓ Descending'}
						</button>
					{/if}
				</div>
				{#if filtering}
					<button class="hdr-control hdr-action clear-filters" onclick={clearFilters}>Clear filters</button>
				{/if}
			</div>
		</div>
	{/if}

	{#if data.boards.length === 0}
		<div class="todo-empty">
			<p>You have no boards yet.</p>
			<a href="/" class="btn-ghost">Go to the dashboard</a>
		</div>
	{:else if todoBoards.length === 0}
		<div class="todo-empty">
			<p>None of your boards has a column called To Do. Rename a column to To Do to list its cards here.</p>
		</div>
	{:else if !scopeBoards.some((b) => b.hasTodo)}
		<div class="todo-empty">
			{#if scopeName.grouping}
				<p>None of the boards in {scopeName.name} has a column called To Do.</p>
			{:else}
				<p>{scopeName.name} has no column called To Do, and neither have its sub-boards.</p>
			{/if}
			<button class="hdr-control" onclick={() => chooseBoard('all')}>Show every board</button>
		</div>
	{:else if scopeCards.length === 0}
		<div class="todo-empty">
			<!-- Every column empty is said only of every board; a chosen board's own To Do may be empty while others are not. -->
			{#if filters.board === 'all'}
				<p>Nothing to do: every To Do column is empty.</p>
			{:else}
				<p>{scopeName.name} has nothing in To Do.</p>
				<button class="hdr-control" onclick={() => chooseBoard('all')}>Show every board</button>
			{/if}
		</div>
	{:else if rows.length === 0}
		<div class="todo-empty">
			<p>No cards match these filters.</p>
			<button class="hdr-control" onclick={clearFilters}>Clear filters</button>
		</div>
	{:else}
		<!-- Wider than the window between 1000 px and about 1400 px: it scrolls in its own box, which the keyboard can scroll too, where the page would have cut it off. -->
		<!-- A region that scrolls must take the focus, or a keyboard cannot scroll it (WCAG 2.1.1; axe's scrollable-region-focusable). -->
		<!-- svelte-ignore a11y_no_noninteractive_tabindex -->
		<div class="table-scroll" tabindex="0" role="region" aria-label="To Do cards">
			<table class="todo-table">
				<thead>
					<tr>
						<th aria-sort={ariaSort('title')}><button class="sort-head" onclick={() => sortBy('title')}>Title{#if filters.sort === 'title'}<span aria-hidden="true">{filters.dir === 'asc' ? ' ↑' : ' ↓'}</span>{/if}</button></th>
						<th aria-sort={ariaSort('priority')}><button class="sort-head" onclick={() => sortBy('priority')}>Priority{#if filters.sort === 'priority'}<span aria-hidden="true">{filters.dir === 'asc' ? ' ↑' : ' ↓'}</span>{/if}</button></th>
						<th aria-sort={ariaSort('board')}><button class="sort-head" onclick={() => sortBy('board')}>Board{#if filters.sort === 'board'}<span aria-hidden="true">{filters.dir === 'asc' ? ' ↑' : ' ↓'}</span>{/if}</button></th>
						<th aria-sort={ariaSort('category')}><button class="sort-head" onclick={() => sortBy('category')}>Category{#if filters.sort === 'category'}<span aria-hidden="true">{filters.dir === 'asc' ? ' ↑' : ' ↓'}</span>{/if}</button></th>
						<th>Labels</th>
						<th>Assignees</th>
						<th aria-sort={ariaSort('due')}><button class="sort-head" onclick={() => sortBy('due')}>Due{#if filters.sort === 'due'}<span aria-hidden="true">{filters.dir === 'asc' ? ' ↑' : ' ↓'}</span>{/if}</button></th>
						<th aria-sort={ariaSort('subtasks')}><button class="sort-head" onclick={() => sortBy('subtasks')}>Subtasks{#if filters.sort === 'subtasks'}<span aria-hidden="true">{filters.dir === 'asc' ? ' ↑' : ' ↓'}</span>{/if}</button></th>
						<th aria-sort={ariaSort('milestone')}><button class="sort-head" onclick={() => sortBy('milestone')}>Milestone{#if filters.sort === 'milestone'}<span aria-hidden="true">{filters.dir === 'asc' ? ' ↑' : ' ↓'}</span>{/if}</button></th>
						<th aria-sort={ariaSort('blocked')}><button class="sort-head" onclick={() => sortBy('blocked')}>Blocked{#if filters.sort === 'blocked'}<span aria-hidden="true">{filters.dir === 'asc' ? ' ↑' : ' ↓'}</span>{/if}</button></th>
					</tr>
				</thead>
				<tbody>
					{#each rows as card (card.id)}
						{@const category = card.categoryId !== null ? categoryById.get(card.categoryId) : undefined}
						{@const progress = subtaskProgress(card as unknown as CardType)}
						{@const blockers = blockersFor(card.id)}
						{@const milestoneName = card.milestoneId !== null ? data.milestoneNames[card.milestoneId] : undefined}
						<!-- The title is the row's button; a click anywhere else on the row does the same. -->
						<!-- svelte-ignore a11y_click_events_have_key_events -->
						<!-- svelte-ignore a11y_no_noninteractive_element_interactions -->
						<tr class="todo-row" onclick={() => openCard(card)}>
							<td class="c-title">
								<button class="row-title" onclick={(e) => { e.stopPropagation(); openCard(card); }}>
									<span class="card-id">#{card.id}</span> {card.title}
								</button>
								{#if card.pinned}<span class="pin" title="Pinned on its board">📌</span>{/if}
							</td>
							<td class="c-priority">
								<span class="priority-badge priority-{card.priority}">{priorityEmoji[card.priority] || '🟡'} {card.priority.toUpperCase()}</span>
							</td>
							<td class="c-board">
								<a href="/board/{card.boardId}?card={card.id}" class="board-link" title="Open on its board: {boardTag(card)}" onclick={(e) => e.stopPropagation()}>{boardTag(card)}</a>
								{#if card.boardCategoryName}
									<span class="chip" style="background: {drawnColour(card.boardCategoryColor)}20; color: {drawnColour(card.boardCategoryColor)}; border-color: {drawnColour(card.boardCategoryColor)}40">{card.boardCategoryName}</span>
								{/if}
							</td>
							<td class="c-category" class:is-empty={!category}>
								{#if category}
									<span class="chip" style="background: {drawnColour(category.color)}20; color: {drawnColour(category.color)}; border-color: {drawnColour(category.color)}40">{category.name}</span>
								{/if}
							</td>
							<td class="c-labels" class:is-empty={card.labelIds.length === 0}>
								{#each card.labelIds as labelId}
									{@const label = labelById.get(labelId)}
									{#if label}
										<span class="chip" style="background: {drawnColour(label.color)}25; color: {drawnColour(label.color)}; border-color: {drawnColour(label.color)}40">{label.name}</span>
									{/if}
								{/each}
							</td>
							<td class="c-assignees" class:is-empty={card.assignees.length === 0}>
								{#each card.assignees as assignee (assignee.id)}
									<span class="chip chip-plain">{assignee.emoji || '👤'} {assignee.username}</span>
								{/each}
							</td>
							<td class="c-due" class:is-empty={!card.dueDate}>
								{#if card.dueDate}
									{@const dueStatus = getDueStatus(card.dueDate)}
									<span class="chip chip-plain due" class:due-overdue={dueStatus === 'overdue'} class:due-today={dueStatus === 'today'} class:due-soon={dueStatus === 'soon'} title="Due {formatDueDate(card.dueDate)}">
										{#if dueStatus === 'overdue'}⚠️{:else if dueStatus === 'today'}🔥{:else}📅{/if}
										{getDueRelative(card.dueDate, tick)}
									</span>
								{/if}
							</td>
							<td class="c-subtasks" class:is-empty={!progress}>
								{#if progress}
									<span class="chip chip-plain" class:all-done={progress.done === progress.total} title="{progress.total - progress.done} open of {progress.total}">☑ {progress.done}/{progress.total}</span>
								{/if}
							</td>
							<td class="c-milestone" class:is-empty={!milestoneName}>
								{#if card.milestoneId !== null && milestoneName}
									<a href="/plan/{card.milestoneId}" class="milestone-badge" title="Milestone: {milestoneName} — open the planning view" onclick={(e) => e.stopPropagation()}>🎯 {milestoneName}</a>
								{/if}
							</td>
							<td class="c-blocked" class:is-empty={!isBlocked(card, ctx)}>
								{#if blockers.length > 0}
									<span class="blocked-badge" title={blockerTooltip(card.id)}>
										<svg width="10" height="10" viewBox="0 0 10 10" fill="none" aria-hidden="true">
											<circle cx="5" cy="5" r="4" stroke="currentColor" stroke-width="1.4"/>
											<path d="M2.2 7.8L7.8 2.2" stroke="currentColor" stroke-width="1.4" stroke-linecap="round"/>
										</svg>
										Blocked{#if blockers.length > 1}&nbsp;({blockers.length}){/if}
									</span>
								{/if}
							</td>
						</tr>
					{/each}
				</tbody>
			</table>
		</div>
	{/if}
</div>

<!-- Card Edit Modal -->
{#if cardWindow.open && cardWindow.card}
	{#key cardWindow.edits}
	<CardModal
		card={cardWindow.card}
		categories={data.categories.filter((c: any) => c.boardId === cardWindow.boardId || c.boardId === null) as any}
		labels={data.labels.filter((l: any) => l.boardId === cardWindow.boardId) as any}
		boardId={cardWindow.boardId}
		boardUsers={editingBoardUsers}
		onSave={saveFromWindow}
		onDelete={archiveFromWindow}
		onClose={() => cardWindow.close()}
		edits={cardWindow.edits}
	/>
	{/key}
{/if}

<!-- Confirm Modal: archiving the open card -->
{#if confirmState.show}
	<ConfirmModal
		title={confirmState.title}
		message={confirmState.message}
		confirmText={confirmState.confirmText}
		onConfirm={() => { confirmState.show = false; confirmState.onConfirm(); }}
		onCancel={() => (confirmState.show = false)}
	/>
{/if}

<Toast />

<style>
	/* The page scrolls as a whole, and its foot ends clear of the user badge (card 2239). */
	.todo-page {
		min-height: 100vh;
		padding: 0 var(--space-xl) var(--user-badge-space);
		box-sizing: border-box;
		max-width: 100%;
		overflow-wrap: anywhere;
	}

	.todo-header {
		display: flex;
		align-items: center;
		justify-content: space-between;
		flex-wrap: wrap;
		gap: var(--space-md);
		padding: var(--space-lg) 0;
		border-bottom: 1px solid var(--glass-border);
	}
	.todo-header-left { display: flex; align-items: center; gap: var(--space-md); min-width: 0; }
	.todo-header-right { display: flex; align-items: center; gap: var(--space-sm); flex-wrap: wrap; }
	.todo-heading { min-width: 0; }
	.todo-icon { font-size: 1.75rem; }
	.todo-title {
		font-size: 1.25rem;
		background: linear-gradient(135deg, var(--text-primary), var(--accent-purple));
		-webkit-background-clip: text;
		-webkit-text-fill-color: transparent;
		background-clip: text;
	}
	.todo-subtitle { font-size: 0.75rem; color: var(--text-secondary); margin-top: 1px; }
	.back-btn { font-size: 0; padding: var(--space-sm); color: var(--text-secondary); }
	.back-btn:hover { color: var(--text-primary); }

	.no-todo { margin-top: var(--space-md); font-size: 0.78rem; color: var(--text-secondary); }
	.no-todo summary { cursor: pointer; width: fit-content; }
	.no-todo ul { margin: var(--space-xs) 0 0; padding-left: var(--space-lg); display: flex; flex-direction: column; gap: 2px; }
	.no-todo a { color: var(--accent-purple); text-decoration: none; }
	.no-todo a:hover { text-decoration: underline; }

	.todo-notice {
		display: flex;
		align-items: center;
		gap: var(--space-sm);
		margin-top: var(--space-md);
		padding: var(--space-sm) var(--space-md);
		border-radius: var(--radius-md);
		background: rgba(245, 158, 11, 0.12);
		border: 1px solid rgba(245, 158, 11, 0.3);
		color: var(--text-primary);
		font-size: 0.8rem;
	}
	.notice-close { margin-left: auto; background: none; border: none; color: var(--text-secondary); cursor: pointer; }

	/* The filters: one wrapping bar at 1000 px and wider; below it, folded behind "Filters (n)". */
	.toolbar {
		display: flex;
		align-items: center;
		flex-wrap: wrap;
		gap: var(--space-sm);
		margin: var(--space-md) 0;
	}
	.search-wrapper input { width: 220px; max-width: 100%; }
	.filter-panel { display: flex; align-items: center; flex-wrap: wrap; gap: var(--space-sm); min-width: 0; }
	.filter-panel select { max-width: 200px; }
	.filters-toggle { display: none; }
	.sort-controls { display: none; gap: var(--space-sm); flex-wrap: wrap; }

	.todo-empty {
		display: flex;
		flex-direction: column;
		align-items: flex-start;
		gap: var(--space-sm);
		margin-top: var(--space-xl);
		padding: var(--space-xl);
		border: 1px dashed var(--glass-border);
		border-radius: var(--radius-lg);
		color: var(--text-secondary);
		font-size: 0.85rem;
	}

	/*
	 * The table, at 1000 px and wider. Its chips do not wrap, so between 1000
	 * and about 1400 px it can be wider than the page, whose body hides what
	 * overflows sideways: it scrolls inside its own box instead, and the
	 * title wraps rather than holding the table wide.
	 */
	.table-scroll { overflow-x: auto; max-width: 100%; border-radius: var(--radius-md); }
	.table-scroll:focus-visible { outline: 2px solid var(--accent-purple); outline-offset: 2px; }
	.todo-table { width: 100%; border-collapse: collapse; font-size: 0.78rem; }
	.todo-table th {
		text-align: left;
		font-size: 0.68rem;
		font-weight: 700;
		text-transform: uppercase;
		letter-spacing: 0.04em;
		color: var(--text-tertiary);
		padding: var(--space-sm);
		border-bottom: 1px solid var(--glass-border);
		white-space: nowrap;
	}
	.sort-head {
		background: none;
		border: none;
		padding: 0;
		font: inherit;
		color: inherit;
		text-transform: inherit;
		letter-spacing: inherit;
		cursor: pointer;
	}
	.sort-head:hover, .sort-head:focus-visible { color: var(--text-primary); }
	.todo-table td { padding: var(--space-sm); border-bottom: 1px solid var(--glass-border); vertical-align: top; }
	.todo-row { cursor: pointer; transition: background var(--duration-fast) var(--ease-out); }
	.todo-row:hover { background: var(--glass-hover); }
	.c-title { min-width: 10rem; }
	.row-title {
		background: none;
		border: none;
		padding: 0;
		font: inherit;
		font-weight: 600;
		color: var(--text-primary);
		text-align: left;
		cursor: pointer;
	}
	.row-title:hover, .row-title:focus-visible { color: var(--accent-purple); text-decoration: underline; }
	.card-id { color: var(--text-tertiary); font-weight: 500; }
	.pin { font-size: 0.65rem; margin-left: 4px; }
	.c-labels .chip, .c-assignees .chip { margin: 0 3px 3px 0; }

	.board-link {
		display: inline-block;
		max-width: 220px;
		overflow: hidden;
		text-overflow: ellipsis;
		white-space: nowrap;
		vertical-align: bottom;
		font-weight: 600;
		color: var(--accent-purple);
		text-decoration: none;
	}
	.board-link:hover { text-decoration: underline; }

	.chip {
		display: inline-flex;
		align-items: center;
		gap: 3px;
		padding: 1px 8px;
		border-radius: var(--radius-full);
		border: 1px solid transparent;
		font-size: 0.68rem;
		font-weight: 600;
		white-space: nowrap;
		max-width: 100%;
		overflow: hidden;
		text-overflow: ellipsis;
	}
	.chip-plain { background: var(--bg-surface); border-color: var(--glass-border); color: var(--text-secondary); }
	.chip-plain.all-done { color: #22c55e; }
	.due-overdue { color: #ef4444; border-color: rgba(239, 68, 68, 0.35); }
	.due-today { color: #f97316; border-color: rgba(249, 115, 22, 0.35); }
	.due-soon { color: #eab308; border-color: rgba(234, 179, 8, 0.35); }

	/* Blocked, milestone and priority chips, as All Tasks and the board draw them. */
	.blocked-badge {
		display: inline-flex; align-items: center; gap: 3px;
		padding: 1px 8px; border-radius: var(--radius-full);
		font-size: 0.68rem; font-weight: 700; white-space: nowrap;
		background: rgba(245, 158, 11, 0.14); color: #f59e0b;
		border: 1px solid rgba(245, 158, 11, 0.3);
		cursor: help;
	}
	.milestone-badge {
		display: inline-flex; align-items: center; gap: 3px;
		padding: 1px 8px; border-radius: var(--radius-full);
		font-size: 0.66rem; font-weight: 600; text-decoration: none;
		max-width: 170px; overflow: hidden; text-overflow: ellipsis; white-space: nowrap;
		background: rgba(139, 92, 246, 0.1); color: #a78bfa;
		border: 1px solid rgba(139, 92, 246, 0.22);
	}
	.milestone-badge:hover { background: rgba(139, 92, 246, 0.2); border-color: rgba(139, 92, 246, 0.45); }
	.priority-badge {
		display: inline-flex; align-items: center; gap: 4px;
		font-size: 0.65rem; font-weight: 600;
		padding: 2px 8px; border-radius: var(--radius-full);
		text-transform: uppercase; letter-spacing: 0.04em; white-space: nowrap;
	}
	.priority-critical { background: rgba(239, 68, 68, 0.15); color: #ef4444; border: 1px solid rgba(239, 68, 68, 0.25); }
	.priority-high { background: rgba(249, 115, 22, 0.15); color: #f97316; border: 1px solid rgba(249, 115, 22, 0.25); }
	.priority-medium { background: rgba(234, 179, 8, 0.15); color: #eab308; border: 1px solid rgba(234, 179, 8, 0.25); }
	.priority-low { background: rgba(34, 197, 94, 0.15); color: #22c55e; border: 1px solid rgba(34, 197, 94, 0.25); }

	/* Below 1000 px: each row a block, the filters folded, a 16 px gutter, nothing scrolling sideways. */
	@media (max-width: 999px) {
		.todo-page { padding: 0 16px var(--user-badge-space); }
		.filters-toggle { display: inline-flex; }
		.filter-panel { display: none; width: 100%; }
		.filter-panel.open { display: flex; }
		.filter-panel select, .filter-panel :global(.board-filter) { max-width: 100%; }
		.sort-controls { display: flex; }
		.search-wrapper { flex: 1 1 180px; min-width: 0; }
		.search-wrapper input { width: 100%; }

		.todo-table, .todo-table tbody, .todo-table tr, .todo-table td { display: block; }
		.todo-table thead { display: none; }
		.todo-table tr.todo-row {
			display: flex;
			flex-wrap: wrap;
			align-items: center;
			gap: var(--space-xs) var(--space-sm);
			padding: var(--space-md);
			margin-bottom: var(--space-sm);
			border: 1px solid var(--glass-border);
			border-radius: var(--radius-md);
			background: var(--bg-card);
		}
		.todo-table td { padding: 0; border: none; order: 3; min-width: 0; }
		.todo-table td.is-empty { display: none; }
		.todo-table td.c-title { order: 0; flex: 1 1 0; min-width: 0; }
		.todo-table td.c-priority { order: 1; }
		.todo-table td.c-board { order: 2; flex-basis: 100%; display: flex; flex-wrap: wrap; gap: var(--space-xs); align-items: center; }
		.board-link { max-width: 100%; }
		.c-labels .chip, .c-assignees .chip { margin: 0 3px 0 0; }
	}
</style>
