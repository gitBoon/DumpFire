<script lang="ts">
	/**
	 * All Tasks Page — A cross-board view of every card in the system.
	 *
	 * Groups cards into swim-lane "buckets" (To Do, On Hold, In Progress, Complete)
	 * and provides search and board-level filtering. Supports editing and moving cards.
	 * Live-updates via global SSE and shows celebrations on task completion.
	 */
	import type { PageData } from './$types';
	import { onMount, onDestroy } from 'svelte';
	import { goto, invalidateAll } from '$app/navigation';
	import { browser } from '$app/environment';
	import CardModal from '$lib/components/CardModal.svelte';
	import { PageCardWindow } from '$lib/board/page-card-window.svelte';
	import type { CardWindowSave } from '$lib/board/card-window.svelte';
	import ConfirmModal from '$lib/components/ConfirmModal.svelte';
	import Toast from '$lib/components/Toast.svelte';
	import { toasts } from '$lib/stores/toast';
	import type { CardType, ColumnType, CategoryType, SortOption } from '$lib/types';
	import StatsPanel from '$lib/components/board/StatsPanel.svelte';
	import { sortCards, getSortLabel } from '$lib/utils/card-utils';
	import { boardPlaces as placesOf, chosenBoardId, inBoardFilter } from '$lib/board-tree';
	import { cardArchivedMessage, cardArchiveWarning } from '$lib/api';
	import { isOptionsColumn } from '$lib/column-role';
	import { keepStreamOpen } from '$lib/live-stream';
	import { attachmentsChanged, commentsChanged } from '$lib/board/sse';
	import { refreshSchedule } from '$lib/board/refresh-schedule';
	import { playCreateSound, playNotifySound } from '$lib/utils/sounds';
	import { drawnColour } from '$lib/colours';
	// All Tasks' parts (card 2281, slice C3a-2), each drawn where its markup was.
	import AllTasksHeader from '$lib/components/tasks/AllTasksHeader.svelte';
	import AllTaskCard from '$lib/components/tasks/AllTaskCard.svelte';
	import TasksActivityPanel from '$lib/components/tasks/TasksActivityPanel.svelte';
	import TasksArchivePanel from '$lib/components/tasks/TasksArchivePanel.svelte';
	import MoveCardModal from '$lib/components/tasks/MoveCardModal.svelte';
	import LiveToasts from '$lib/components/tasks/LiveToasts.svelte';

	let { data }: { data: PageData } = $props();

	let tick = $state(0);
	let tickInterval: ReturnType<typeof setInterval> | null = null;

	// ─── SSE Live Updates ─────────────────────────────────────────────────
	// Opening the stream again after a failure, and how long to wait first, is
	// $lib/live-stream.ts's: it backs off, and does not open again a stream
	// that was refused because the session has ended.
	let closeStream: (() => void) | null = null;
	/** How often the stream has said the open card's comments may have changed: the card window's `commentsTold` (card 2282). */
	let commentsTold = $state(0);
	/** The same for the open card's files: the card window's `attachmentsTold` (card 2337). */
	let attachmentsTold = $state(0);

	/** The live notices and the fireworks, which the stream's events are handed to. */
	let liveToasts = $state<ReturnType<typeof LiveToasts>>();

	/**
	 * When a live event re-reads the page (card 2281, slice C3b): the board
	 * page's schedule, so a burst of events (a bulk archive is one per card)
	 * is one re-read, sent 250 ms after the last event and no later than about
	 * a second after the first, and never two at once. Its 250 ms is also what
	 * lets a `celebrate` event start the fireworks before the page is drawn
	 * again. No holds and no generations: the page's own writes re-read the
	 * page themselves, and `invalidateAll` draws its own answer, so there is no
	 * answer here to drop.
	 */
	const liveRefresh = refreshSchedule(async () => {
		await Promise.all([invalidateAll(), activityOpen ? activityPanel?.fetchActivity() : undefined]);
	});

	/** The page's listeners, put on each stream as it is opened. */
	function listenToGlobalSSE(eventSource: EventSource) {
		eventSource.addEventListener('update', (e) => {
			try {
				const d = JSON.parse(e.data);
				// Show toast for card creation
				if (d.action === 'created' && d.cardTitle) {
					liveToasts?.addLiveToast({ type: 'created', cardTitle: d.cardTitle, userName: d.userName || 'Someone', userEmoji: d.userEmoji || '👤' });
					playCreateSound();
				}
				// Show toast for card movement
				if (d.action === 'moved' && d.cardTitle) {
					liveToasts?.addLiveToast({ type: 'moved', cardTitle: d.cardTitle, userName: d.userName || 'Someone', userEmoji: d.userEmoji || '👤', fromColumn: d.fromColumn, toColumn: d.toColumn });
					playNotifySound();
				}
				// The open card's comments changed: its window reads them again (card 2282).
				if (d && commentsChanged(d, cardWindow.cardId)) commentsTold++;
				// And its files (card 2337).
				if (d && attachmentsChanged(d, cardWindow.cardId)) attachmentsTold++;
			} catch { /* fallback — still refresh */ }
			// Each event's notice is its own; the re-read is the burst's.
			liveRefresh.schedule();
		});

		eventSource.addEventListener('celebrate', (e) => {
			try {
				const d = JSON.parse(e.data);
				// Queue celebrations so each one shows sequentially
				liveToasts?.celebrate({
					cardTitle: d.cardTitle || '',
					userName: d.userName || 'Someone',
					userEmoji: d.userEmoji || '👤',
					xpGained: d.xpGained || 0
				});
			} catch {
				// Ignore parse errors
			}
		});
	}

	/**
	 * The other moment this page can be behind. A backgrounded tab can have its
	 * stream torn down without an error the page ever sees, so coming back to the
	 * front is its own reason to re-read — which is also what makes a figure
	 * recorded in a terminal current on alt-tab.
	 */
	function onVisibilityChange() {
		if (document.visibilityState === 'visible') caughtUp();
	}

	/**
	 * After a gap (a reconnect, a return to the tab) in which events may have
	 * been missed: the page is read again, and the open card window reads its
	 * comments again, one of them perhaps being about its card (card 2282),
	 * and its files, once it has read them (card 2337).
	 */
	function caughtUp() {
		commentsTold++;
		attachmentsTold++;
		invalidateAll();
	}

	onMount(() => {
		tickInterval = setInterval(() => { tick++; }, 15000);
		if (browser) {
			// A dropped stream misses every event sent while it was down and
			// nothing replays them, so every open after the first re-reads,
			// rather than waiting for the next change. Without this a figure
			// recorded during the gap stays stale.
			closeStream = keepStreamOpen('/api/events', listenToGlobalSSE, caughtUp);
			document.addEventListener('visibilitychange', onVisibilityChange);
		}
	});

	onDestroy(() => {
		if (browser) document.removeEventListener('visibilitychange', onVisibilityChange);
		if (tickInterval) clearInterval(tickInterval);
		closeStream?.();
		closeStream = null;
		liveRefresh.dispose();
	});

	let searchQuery = $state('');
	let boardFilter = $state('all');
	let hideBlocked = $state(false);

	/**
	 * Where each board sits in the tree (card 1990): the boards above it that
	 * the caller can open, built from the nearest parent the load sends, and
	 * the category the filter counts it in. Choosing a board takes in its
	 * sub-boards at every depth, and choosing a category takes in the
	 * sub-boards under its boards.
	 */
	const boardPlaces = $derived(placesOf(data.boards));

	/**
	 * The board chosen in the filter, or 0: Planning, Export to CSV and
	 * Statistics cover that board alone, not its sub-boards (decision 8).
	 * Read through `chosenBoardId`, which takes the filter's value as a string
	 * or a number: a number in it once made `startsWith` throw.
	 */
	const chosenBoard = $derived(chosenBoardId(boardFilter));

	/**
	 * Open dependency blockers per card, computed server-side in one pass over
	 * every board this user can see. Absent means nothing is blocking the card.
	 */
	const dependencyBlockers = $derived(
		(data.blockedState ?? {}) as Record<number, { id: number; title: string; columnTitle: string; boardName: string; boardId: number | null; withheld: boolean }[]>
	);

	function blockersFor(cardId: number) {
		return dependencyBlockers[cardId] ?? [];
	}

	const bucketColors: Record<string, string> = { 'To Do': '#6366f1', 'On Hold': '#ef4444', 'In Progress': '#f59e0b', 'Complete': '#10b981' };

	function matchesFilters(card: any): boolean {
		// Folded in here rather than at the render site so a column's count, which
		// reads the cards this lets through, cannot misreport a filtered bucket.
		if (hideBlocked && blockersFor(card.id).length > 0) return false;
		if (!inBoardFilter(card.boardId, boardFilter, boardPlaces)) return false;
		if (!searchQuery.trim()) return true;
		const q = searchQuery.trim().toLowerCase();

		// Exact card-ID match: "#123" matches only card 123
		const hashMatch = q.match(/^#(\d+)$/);
		if (hashMatch) {
			return card.id === parseInt(hashMatch[1], 10);
		}

		const idStr = String(card.id);
		return idStr.includes(q) || card.title.toLowerCase().includes(q) || card.description?.toLowerCase().includes(q);
	}

	// ─── Column Sorting ─────────────────────────────────────────────────
	let bucketSorts = $state<Record<string, SortOption>>({ 'Complete': 'date-desc' });
	let openSortDropdown = $state<string | null>(null);

	function setBucketSort(bucketTitle: string, sort: SortOption) {
		bucketSorts = { ...bucketSorts, [bucketTitle]: sort };
		openSortDropdown = null;
	}

	function getSortedCards(cards: any[], bucketTitle: string): any[] {
		const sort = bucketSorts[bucketTitle];
		if (!sort || sort === 'none') return cards;
		return sortCards([...cards] as CardType[], sort, data.categories as any);
	}

	// ─── Card Editing ────────────────────────────────────────────────────
	/**
	 * The cards drawn: the load's, with a save from the card window shown on
	 * its card at once and taken back if refused. Each re-read replaces them.
	 */
	let buckets = $derived(data.buckets);

	/**
	 * The card window (card 2281, slice C3a-1): opened, saved and archived
	 * through the board page's controller, over the buckets above. A save
	 * sends only the fields changed in the window, so a change someone else
	 * made to the card meanwhile is not sent back. The window is handed the
	 * row as the page loaded it, with the fall-backs it reads (card 2186;
	 * `windowCard`).
	 */
	const cardWindow = new PageCardWindow({ get: () => buckets, set: (next) => (buckets = next) }, () => invalidateAll());

	/** The Move window, which each card's Move button opens. */
	let moveCardModal = $state<ReturnType<typeof MoveCardModal>>();

	function openCard(card: any) {
		cardWindow.openCard(card, card.boardId);
		loadBoardUsers(card.id);
	}

	// The window's people are those of the card's own board, as the board page
	// gives them: a mention is drawn as a chip only for someone it can mail
	// (card 2198), and the assignee list is the board's. Every account was
	// given before. Until the card's context answers, or if it does not, the
	// window names nobody.
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
	 * Saves the card window through its controller: only the fields changed
	 * in it, shown on the card at once. The window closes only when the
	 * server says the card is saved; a refusal, or no answer, is said and
	 * keeps the window open with what was typed, and the card put back. A
	 * save with nothing changed sends nothing, closes the window and says
	 * nothing. Once saved, the page is read again, as before.
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
	 * Archive the open card, once it is confirmed, as the board page does: a
	 * DELETE with no `permanent` archives, and it can be restored. Sent by
	 * the card window's controller, which takes the card off the page and
	 * closes its window only once the server says it is archived.
	 */
	function archiveFromWindow() {
		const cardId = cardWindow.cardId;
		if (cardId === null) return;
		// An option's archive is a discard, said before and after (milestone 22,
		// the S3 review's E6): a card in an Options column. The boards this page
		// reads carry no kind, so a card on an ideas board is not told apart here
		// until ideas boards can be made (card 2463).
		const title = cardWindow.card?.title;
		const column = data.columns.find((c) => c.id === cardWindow.card?.columnId);
		const discards = column !== undefined && isOptionsColumn(column);
		showConfirm('Archive Card', cardArchiveWarning(title, discards), 'Archive Card', async () => {
			const started = toasts.navigation();
			const failure = await cardWindow.archive(cardId);
			confirmState.show = false;
			if (failure) {
				// The card is still where it was, so its window stays open.
				toasts.add(failure, 'error', started);
				return;
			}
			toasts.add(cardArchivedMessage(title, discards), 'info');
			await invalidateAll();
		});
	}

	let loadingMore = $state(false);
	// The load gives at most 500 completed cards, and says there are more to
	// load only below that (card 2366): at the cap, with more completed, the
	// bucket says how many it shows in place of the button.
	const completedCapped = $derived(!data.hasMoreCompleted && data.totalCompletedCount > data.completedLimit);
	/**
	 * Whether a search, the board filter or Hide blocked is on. Show More then
	 * says no number (card 2370): it counted the loaded cards they hide as
	 * still to come, and how many older completed cards match is the server's
	 * to know, not the page's. With none on, every loaded card is shown and
	 * the number is right.
	 */
	const filtering = $derived(searchQuery.trim() !== '' || String(boardFilter) !== 'all' || hideBlocked);

	/**
	 * Fifty more completed cards (card 2300). The limit is in the address, and
	 * the load reads it there, so the address is written with goto and
	 * replaceState: a navigation in place of this history entry, which runs the
	 * load at the new address and keeps SvelteKit's state in the entry, as the
	 * To Do page writes its filters. It was written with the browser's
	 * `history.replaceState({}, …)`, which threw that state away, and the page
	 * re-read with `invalidateAll`, which SvelteKit runs at the address it
	 * holds, never moved by the browser's call: the load got the old limit,
	 * and the list stayed as it was.
	 */
	async function loadMoreCompleted() {
		loadingMore = true;
		const newLimit = (data.completedLimit || 50) + 50;
		const url = new URL(window.location.href);
		url.searchParams.set('completedLimit', String(newLimit));
		try {
			await goto(url, { replaceState: true, keepFocus: true, noScroll: true });
		} finally {
			loadingMore = false;
		}
	}

	function closeSortDropdowns() {
		openSortDropdown = null;
	}

	let activityOpen = $state(false);
	/** The Activity Log, which the More menu opens and the live stream reads again. */
	let activityPanel = $state<ReturnType<typeof TasksActivityPanel>>();

	// More menu & panel state
	let showMoreMenu = $state(false);
	let showStatsPanel = $state(false);
	let showArchivePanel = $state(false);
	/** Archived Cards, which the More menu opens. */
	let archivePanel = $state<ReturnType<typeof TasksArchivePanel>>();

	onMount(() => {
		if (browser) {
			activityOpen = localStorage.getItem('df-activity-open') === 'true';
			if (activityOpen) activityPanel?.fetchActivity(true);
		}
	});

	function toggleStatsPanel() {
		showStatsPanel = !showStatsPanel;
	}
</script>

<svelte:head>
	<title>DumpFire — All Tasks</title>
</svelte:head>

<svelte:window onclick={closeSortDropdowns} />

<div class="all-page-wrapper" onclick={() => { showMoreMenu = false; }}>
<div class="all-page">
	<AllTasksHeader
		{data}
		{chosenBoard}
		{activityOpen}
		{showStatsPanel}
		{showArchivePanel}
		toggleActivity={() => activityPanel?.toggleActivity()}
		{toggleStatsPanel}
		toggleArchivePanel={() => archivePanel?.toggleArchivePanel()}
		bind:boardFilter
		bind:searchQuery
		bind:hideBlocked
		bind:showMoreMenu
	/>

	<div class="kanban-scroll">
		<div class="kanban-track">
			{#each buckets as bucket}
				{@const filteredCards = getSortedCards(bucket.cards.filter(matchesFilters), bucket.title)}
				<div class="column">
					<div class="column-header">
						<div class="column-title-row">
							<span class="column-color-dot" style="background: {drawnColour(bucketColors[bucket.title] || '#8b5cf6')}"></span>
							<h2 class="column-title">{bucket.title}</h2>
							<span class="column-count">
								{#if bucket.title === 'Complete' && (data.hasMoreCompleted || completedCapped)}
									{filteredCards.length} of {data.totalCompletedCount}
								{:else}
									{filteredCards.length}
								{/if}
							</span>
							<div class="sort-wrapper">
								{#if bucketSorts[bucket.title] && bucketSorts[bucket.title] !== 'none'}
									<button class="sort-active-badge" onclick={(e) => { e.stopPropagation(); setBucketSort(bucket.title, 'none'); }} title="Clear sort">
										{getSortLabel(bucketSorts[bucket.title])} ✕
									</button>
								{/if}
								<!-- svelte-ignore a11y_click_events_have_key_events -->
								<!-- svelte-ignore a11y_no_static_element_interactions -->
								<button class="sort-btn" class:sort-btn-active={openSortDropdown === bucket.title} onclick={(e) => { e.stopPropagation(); openSortDropdown = openSortDropdown === bucket.title ? null : bucket.title; }} title="Sort cards">
									<svg width="12" height="12" viewBox="0 0 12 12" fill="none"><path d="M2 3h8M3 6h6M4 9h4" stroke="currentColor" stroke-width="1.3" stroke-linecap="round"/></svg>
								</button>
								{#if openSortDropdown === bucket.title}
									<!-- svelte-ignore a11y_click_events_have_key_events -->
									<!-- svelte-ignore a11y_no_static_element_interactions -->
									<div class="sort-dropdown" onclick={(e) => e.stopPropagation()}>
										<div class="sort-dropdown-label">Sort by</div>
										<button class="sort-dropdown-item" class:sort-active={bucketSorts[bucket.title] === 'date-asc'} onclick={() => setBucketSort(bucket.title, 'date-asc')}>↑ Oldest first</button>
										<button class="sort-dropdown-item" class:sort-active={bucketSorts[bucket.title] === 'date-desc'} onclick={() => setBucketSort(bucket.title, 'date-desc')}>↓ Newest first</button>
										<button class="sort-dropdown-item" class:sort-active={bucketSorts[bucket.title] === 'priority'} onclick={() => setBucketSort(bucket.title, 'priority')}>⚡ Priority</button>
										<button class="sort-dropdown-item" class:sort-active={bucketSorts[bucket.title] === 'category'} onclick={() => setBucketSort(bucket.title, 'category')}>🏷 Category</button>
										<button class="sort-dropdown-item" class:sort-active={bucketSorts[bucket.title] === 'assignee'} onclick={() => setBucketSort(bucket.title, 'assignee')}>👤 Assignee</button>
										{#if bucketSorts[bucket.title] && bucketSorts[bucket.title] !== 'none'}
											<button class="sort-dropdown-item" onclick={() => setBucketSort(bucket.title, 'none')}>✕ Clear sort</button>
										{/if}
									</div>
								{/if}
							</div>
						</div>
					</div>
					<div class="card-list">
						{#each filteredCards as card (card.id)}
							<AllTaskCard
								{data}
								{card}
								{bucket}
								{tick}
								{boardPlaces}
								{blockersFor}
								{openCard}
								openMoveModal={(toMove) => moveCardModal?.openMoveModal(toMove)}
							/>
						{:else}
							<div class="column-empty">No tasks</div>
						{/each}
						{#if bucket.title === 'Complete' && data.hasMoreCompleted}
							<button class="load-more-btn" onclick={loadMoreCompleted} disabled={loadingMore} id="load-more-completed">
								{#if loadingMore}
									<span class="spinner"></span> Loading…
								{:else if filtering}
									Show More
								{:else}
									Show More ({data.totalCompletedCount - filteredCards.length} remaining)
								{/if}
							</button>
						{:else if bucket.title === 'Complete' && completedCapped}
							<p class="completed-capped" id="completed-capped">Showing the latest {data.completedLimit} of {data.totalCompletedCount} completed cards</p>
						{/if}
					</div>
				</div>
			{/each}
		</div>
	</div>
</div> <!-- /.all-page -->
<div class="all-panels-area">
<TasksActivityPanel bind:this={activityPanel} bind:activityOpen />
{#if showStatsPanel}
	{@const syntheticColumns = buckets.map((b, i) => ({
		id: i + 1,
		boardId: 0,
		title: b.title,
		position: i,
		color: b.title === 'Complete' ? '#10b981' : b.title === 'In Progress' ? '#6366f1' : b.title === 'On Hold' ? '#f59e0b' : '#64748b',
		showAddCard: false,
		wipLimit: 0,
		role: null,
		cards: b.cards as unknown as CardType[]
	} satisfies ColumnType))}
	<StatsPanel
		boardColumns={syntheticColumns}
		boardCategories={data.categories as unknown as CategoryType[]}
		boardId={chosenBoard}
		onClose={() => (showStatsPanel = false)}
	/>
{/if}
<TasksArchivePanel bind:this={archivePanel} {showConfirm} bind:showArchivePanel />
</div> <!-- /.all-panels-area -->
</div> <!-- /all-page-wrapper -->

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
		{commentsTold}
		{attachmentsTold}
	/>
	{/key}
{/if}

<!-- Confirm Modal: archiving the open card, and deleting an archived one for good -->
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

<!-- Move Card Modal -->
<MoveCardModal bind:this={moveCardModal} {data} />

<!-- Fireworks celebration, and the live toasts -->
<LiveToasts bind:this={liveToasts} />

<style>
	/* Flex wrapper for page + activity panel */
	.all-page-wrapper {
		display: flex;
		height: 100vh;
		overflow: hidden;
	}
	.all-panels-area { display: flex; flex-shrink: 0; }
	.all-page {
		display: flex;
		flex-direction: column;
		flex: 1;
		min-width: 0;
		height: 100vh;
		overflow: hidden;
		transition: flex 0.2s ease;
	}

	/* Kanban */
	.kanban-scroll {
		flex: 1;
		overflow-x: auto;
		overflow-y: hidden;
		padding: var(--space-lg) var(--space-xl) var(--space-xl);
	}

	.kanban-track {
		display: flex;
		gap: var(--space-lg);
		height: 100%;
		min-width: 100%;
	}

	.column {
		flex: 1;
		min-width: 250px;
		display: flex;
		flex-direction: column;
		border-radius: var(--radius-lg);
		overflow: hidden;
		height: 100%;
		background: var(--bg-surface);
		border: 1px solid var(--glass-border);
	}

	.column-header {
		padding: var(--space-md) var(--space-lg);
		flex-shrink: 0;
	}

	.column-title-row {
		display: flex;
		align-items: center;
		gap: var(--space-sm);
	}

	.column-color-dot {
		width: 10px;
		height: 10px;
		border-radius: 50%;
		flex-shrink: 0;
	}

	.column-title {
		font-size: 0.85rem;
		font-weight: 700;
		flex: 1;
	}

	.column-count {
		font-size: 0.7rem;
		font-weight: 600;
		color: var(--text-tertiary);
		background: var(--bg-base);
		padding: 1px 6px;
		border-radius: var(--radius-full);
	}


	/* A list's scroll ends above the user badge (card 2239), or its last card is under it. */
	.card-list {
		flex: 1;
		overflow-y: auto;
		padding: 0 var(--space-md) var(--user-badge-space);
		display: flex;
		flex-direction: column;
		gap: var(--space-sm);
	}

	.load-more-btn {
		display: flex;
		align-items: center;
		justify-content: center;
		gap: var(--space-sm);
		width: 100%;
		padding: var(--space-md);
		border-radius: var(--radius-md);
		background: var(--bg-elevated);
		color: var(--text-secondary);
		font-size: 0.75rem;
		font-weight: 600;
		border: 1px dashed var(--glass-border);
		cursor: pointer;
		transition: all var(--duration-normal) var(--ease-out);
		flex-shrink: 0;
	}

	.load-more-btn:hover:not(:disabled) {
		background: var(--accent-purple-glow);
		color: var(--accent-purple);
		border-color: var(--accent-purple);
	}

	.load-more-btn:disabled {
		opacity: 0.6;
		cursor: wait;
	}

	.load-more-btn .spinner {
		width: 14px;
		height: 14px;
		border: 2px solid var(--glass-border);
		border-top-color: var(--accent-purple);
		border-radius: 50%;
		animation: spin 0.6s linear infinite;
	}

	@keyframes spin {
		to { transform: rotate(360deg); }
	}

	.completed-capped {
		margin: 0;
		padding: var(--space-md);
		text-align: center;
		color: var(--text-tertiary);
		font-size: 0.75rem;
		flex-shrink: 0;
	}

	.column-empty {
		text-align: center;
		color: var(--text-tertiary);
		font-size: 0.8rem;
		padding: var(--space-xl);
	}

	/* Sort dropdown */
	.sort-wrapper {
		position: relative; display: flex; align-items: center; gap: 4px; margin-left: auto;
	}
	.sort-btn {
		width: 24px; height: 24px; display: flex; align-items: center; justify-content: center;
		border-radius: var(--radius-sm); background: transparent; border: none;
		color: var(--text-tertiary); cursor: pointer; transition: all var(--duration-fast) var(--ease-out);
	}
	.sort-btn:hover, .sort-btn-active { color: var(--text-primary); background: var(--glass-hover); }
	.sort-active-badge {
		display: inline-flex; align-items: center; gap: 4px;
		font-size: 0.6rem; font-weight: 600; padding: 1px 6px;
		border-radius: var(--radius-sm); background: rgba(99, 102, 241, 0.1);
		color: var(--accent-indigo); border: 1px solid rgba(99, 102, 241, 0.2);
		cursor: pointer; white-space: nowrap;
	}
	.sort-active-badge:hover { background: rgba(99, 102, 241, 0.2); }
	.sort-dropdown {
		position: absolute; top: 100%; right: 0; z-index: 100;
		background: var(--bg-card); border: 1px solid var(--glass-border);
		border-radius: var(--radius-md); padding: var(--space-xs);
		box-shadow: var(--shadow-lg); min-width: 140px; margin-top: 4px;
	}
	.sort-dropdown-label {
		font-size: 0.6rem; font-weight: 700; text-transform: uppercase;
		letter-spacing: 0.05em; color: var(--text-tertiary);
		padding: 4px 8px;
	}
	.sort-dropdown-item {
		display: block; width: 100%; text-align: left; padding: 6px 8px;
		font-size: 0.78rem; font-weight: 500; color: var(--text-secondary);
		background: transparent; border: none; border-radius: var(--radius-sm);
		cursor: pointer; font-family: var(--font-family);
		transition: all var(--duration-fast) var(--ease-out);
	}
	.sort-dropdown-item:hover { background: var(--glass-hover); color: var(--text-primary); }
	.sort-dropdown-item.sort-active {
		background: rgba(99, 102, 241, 0.1); color: var(--accent-indigo); font-weight: 600;
	}

	/*
	 * The two side panels, the Activity Log and Archived Cards, share these
	 * (card 2281, slice C3a-2): each is a component of its own, out of reach
	 * of the page's scoped rules, and drawn in the panels area.
	 */
	.all-panels-area :global(.activity-panel) {
		width: 360px;
		height: 100vh;
		background: var(--bg-surface);
		border-left: 1px solid var(--glass-border);
		z-index: 10;
		display: flex;
		flex-direction: column;
		flex-shrink: 0;
		animation: slideInPanel 0.2s ease-out;
	}
	@keyframes slideInPanel {
		from { transform: translateX(100%); }
		to { transform: translateX(0); }
	}
	.all-panels-area :global(.activity-panel-header) {
		display: flex;
		align-items: center;
		justify-content: space-between;
		padding: 16px 20px;
		border-bottom: 1px solid var(--glass-border);
		flex-shrink: 0;
	}
	.all-panels-area :global(.activity-panel-header h3) {
		margin: 0;
		font-size: 0.9rem;
		color: var(--text-primary);
		display: flex;
		align-items: center;
		gap: 8px;
	}
	.all-panels-area :global(.activity-refresh-btn) {
		background: none;
		border: none;
		color: var(--text-secondary);
		cursor: pointer;
		padding: 4px;
		border-radius: 4px;
		transition: color 0.15s;
	}
	.all-panels-area :global(.activity-refresh-btn:hover) { color: var(--text-primary); }
	.all-panels-area :global(.activity-list) {
		flex: 1;
		overflow-y: auto;
		padding: 8px 0;
	}
	.all-panels-area :global(.activity-empty) {
		padding: 40px 20px;
		text-align: center;
		color: var(--text-secondary);
		font-size: 0.82rem;
	}
	.all-panels-area :global(.activity-loading) {
		padding: 30px 20px;
		text-align: center;
		color: var(--text-secondary);
		font-size: 0.8rem;
	}
	/* A panel's read that failed (card 2317), in place of "nothing" */
	.all-panels-area :global(.activity-error) {
		margin: 12px 16px;
		padding: 10px 12px;
		border-radius: var(--radius-sm);
		background: rgba(244, 63, 94, 0.1);
		border: 1px solid rgba(244, 63, 94, 0.3);
		color: var(--text-primary);
		font-size: 0.78rem;
		line-height: 1.4;
		overflow-wrap: anywhere;
	}
</style>
