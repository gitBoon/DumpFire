<script lang="ts">
	/**
	 * All Tasks Page — A cross-board view of every card in the system.
	 *
	 * Groups cards into swim-lane "buckets" (To Do, On Hold, In Progress, Complete)
	 * and provides search and board-level filtering. Supports editing and moving cards.
	 * Live-updates via global SSE and shows celebrations on task completion.
	 */
	import type { PageData } from './$types';
	import { theme } from '$lib/stores/theme';
	import { onMount, onDestroy } from 'svelte';
	import { invalidateAll } from '$app/navigation';
	import { browser } from '$app/environment';
	import CardModal from '$lib/components/CardModal.svelte';
	import ThemePicker from '$lib/components/ThemePicker.svelte';
	import FireworksCelebration from '$lib/components/board/FireworksCelebration.svelte';
	import type { CardType, ColumnType, CategoryType, SortOption } from '$lib/types';
	import StatsPanel from '$lib/components/board/StatsPanel.svelte';
	import { getRelativeAge, getDueRelative, getDueStatus, parseUTC, isNew } from '$lib/utils/date-utils';
	import { subtaskProgress, sortCards, getSortLabel } from '$lib/utils/card-utils';
	import { playMoveSound, playCompleteSound, playCreateSound, playNotifySound } from '$lib/utils/sounds';

	let { data }: { data: PageData } = $props();
	let currentTheme = $state('light');
	theme.subscribe((v) => (currentTheme = v));

	let tick = $state(0);
	let tickInterval: ReturnType<typeof setInterval> | null = null;

	// ─── SSE Live Updates ─────────────────────────────────────────────────
	let eventSource: EventSource | null = null;
	let reconnectTimeout: ReturnType<typeof setTimeout> | null = null;

	// ─── Fireworks Celebration ────────────────────────────────────────────
	let showFireworks = $state(false);
	let celebrateCardTitle = $state('');
	let celebrateUserName = $state('');
	let celebrateUserEmoji = $state('');
	let celebrateXpGained = $state(0);

	type CelebrationItem = { cardTitle: string; userName: string; userEmoji: string; xpGained: number };
	let celebrationQueue: CelebrationItem[] = [];
	let celebrationPlaying = false;

	function playNextCelebration() {
		const next = celebrationQueue.shift();
		if (!next) {
			celebrationPlaying = false;
			return;
		}
		celebrationPlaying = true;
		// Brief reset to re-trigger animation if already showing
		showFireworks = false;
		requestAnimationFrame(() => {
			celebrateCardTitle = next.cardTitle;
			celebrateUserName = next.userName;
			celebrateUserEmoji = next.userEmoji;
			celebrateXpGained = next.xpGained;
			showFireworks = true;
			playCompleteSound();
			setTimeout(() => {
				showFireworks = false;
				// Always try to drain the queue
				setTimeout(playNextCelebration, 300);
			}, 3000);
		});
	}

	// ─── Live Activity Toast ──────────────────────────────────────────────
	type LiveToast = {
		id: number;
		type: 'created' | 'moved';
		cardTitle: string;
		userName: string;
		userEmoji: string;
		fromColumn?: string;
		toColumn?: string;
	};
	let liveToasts = $state<LiveToast[]>([]);
	let toastCounter = 0;

	function addLiveToast(toast: Omit<LiveToast, 'id'>) {
		const id = ++toastCounter;
		liveToasts = [{ ...toast, id }, ...liveToasts].slice(0, 5);
		setTimeout(() => {
			liveToasts = liveToasts.filter(t => t.id !== id);
		}, 5000);
	}

	function connectGlobalSSE() {
		eventSource = new EventSource('/api/events');

		eventSource.addEventListener('update', (e) => {
			try {
				const d = JSON.parse(e.data);
				// Show toast for card creation
				if (d.action === 'created' && d.cardTitle) {
					addLiveToast({ type: 'created', cardTitle: d.cardTitle, userName: d.userName || 'Someone', userEmoji: d.userEmoji || '👤' });
					playCreateSound();
				}
				// Show toast for card movement
				if (d.action === 'moved' && d.cardTitle) {
					addLiveToast({ type: 'moved', cardTitle: d.cardTitle, userName: d.userName || 'Someone', userEmoji: d.userEmoji || '👤', fromColumn: d.fromColumn, toColumn: d.toColumn });
					playNotifySound();
				}
			} catch { /* fallback — still refresh */ }
			// Defer data refresh so celebrate event can trigger fireworks first
			setTimeout(() => {
				invalidateAll();
				if (activityOpen) fetchActivity();
			}, 250);
		});

		eventSource.addEventListener('celebrate', (e) => {
			try {
				const d = JSON.parse(e.data);
				// Queue celebrations so each one shows sequentially
				celebrationQueue.push({
					cardTitle: d.cardTitle || '',
					userName: d.userName || 'Someone',
					userEmoji: d.userEmoji || '👤',
					xpGained: d.xpGained || 0
				});
				if (!celebrationPlaying) playNextCelebration();
			} catch {
				// Ignore parse errors
			}
		});

		eventSource.onerror = () => {
			if (eventSource) eventSource.close();
			reconnectTimeout = setTimeout(connectGlobalSSE, 3000);
		};
	}

	onMount(() => {
		tickInterval = setInterval(() => { tick++; }, 15000);
		if (browser) {
			connectGlobalSSE();
		}
	});

	onDestroy(() => {
		if (tickInterval) clearInterval(tickInterval);
		if (reconnectTimeout) clearTimeout(reconnectTimeout);
		if (eventSource) {
			eventSource.close();
			eventSource = null;
		}
	});

	let searchQuery = $state('');
	let boardFilter = $state('all');

	const priorityEmoji: Record<string, string> = { critical: '🔴', high: '🟠', medium: '🟡', low: '🟢' };
	const bucketColors: Record<string, string> = { 'To Do': '#6366f1', 'On Hold': '#ef4444', 'In Progress': '#f59e0b', 'Complete': '#10b981' };

	function matchesFilters(card: any): boolean {
		if (boardFilter !== 'all') {
			if (boardFilter.startsWith('cat:')) {
				const catId = Number(boardFilter.slice(4));
				const board = data.boards.find((b: any) => b.id === card.boardId);
				if (!board || board.categoryId !== catId) return false;
			} else {
				if (card.boardId !== Number(boardFilter)) return false;
			}
		}
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

	function getFilteredCount(bucket: any): number {
		return bucket.cards.filter(matchesFilters).length;
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
	let showCardModal = $state(false);
	let editingCard = $state<CardType | null>(null);
	let editingBoardId = $state(0);
	let showMoveModal = $state(false);
	let moveCard = $state<any>(null);
	let moveBoardId = $state<number | null>(null);
	let moveColumnId = $state<number | null>(null);

	function openCard(card: any) {
		editingCard = {
			id: card.id, columnId: card.columnId, categoryId: card.categoryId,
			title: card.title, description: card.description, position: card.position ?? 0,
			priority: card.priority, colorTag: card.colorTag, dueDate: card.dueDate,
			createdAt: card.createdAt, updatedAt: card.updatedAt || card.createdAt,
			subtasks: card.subtasks || [], labelIds: card.labelIds || [],
			pinned: card.pinned || false, onHoldNote: card.onHoldNote || '',
			businessValue: card.businessValue || '',
			subBoards: card.subBoards || [], assignees: card.assignees || [],
			archivedAt: card.archivedAt || null, coverUrl: card.coverUrl || null
		};
		editingBoardId = card.boardId;
		showCardModal = true;
	}

	function openMoveModal(card: any) {
		moveCard = card;
		moveBoardId = card.boardId;
		moveColumnId = card.columnId;
		showMoveModal = true;
	}

	async function doMoveCard() {
		if (!moveCard || !moveColumnId) return;

		// Check if moving to a "complete" column for sound effect
		const targetCol = data.columns.find((c: any) => c.id === moveColumnId);
		const isCompletingMove = targetCol && ['complete', 'done'].includes(targetCol.title.toLowerCase().trim());

		await fetch(`/api/cards/${moveCard.id}`, {
			method: 'PUT',
			headers: { 'Content-Type': 'application/json' },
			body: JSON.stringify({ columnId: moveColumnId, boardId: moveBoardId })
		});

		// Play appropriate sound
		if (isCompletingMove) {
			playCompleteSound();
		} else {
			playMoveSound();
		}

		showMoveModal = false;
		moveCard = null;
		await invalidateAll();
	}

	async function saveCard(cardData: any) {
		if (!editingCard) return;
		await fetch(`/api/cards/${editingCard.id}`, {
			method: 'PUT',
			headers: { 'Content-Type': 'application/json' },
			body: JSON.stringify({
				title: cardData.title, description: cardData.description,
				priority: cardData.priority, categoryId: cardData.categoryId,
				dueDate: cardData.dueDate, onHoldNote: cardData.onHoldNote || '',
				businessValue: cardData.businessValue || '', boardId: editingBoardId
			})
		});
		showCardModal = false;
		editingCard = null;
		await invalidateAll();
	}

	async function deleteCard() {
		if (!editingCard) return;
		await fetch(`/api/cards/${editingCard.id}`, {
			method: 'DELETE',
			headers: { 'Content-Type': 'application/json' },
			body: JSON.stringify({ boardId: editingBoardId })
		});
		showCardModal = false;
		editingCard = null;
		await invalidateAll();
	}

	function getBoardColumns(boardId: number) {
		return data.columns.filter((c: any) => c.boardId === boardId);
	}

	let loadingMore = $state(false);

	async function loadMoreCompleted() {
		loadingMore = true;
		const newLimit = (data.completedLimit || 50) + 50;
		const url = new URL(window.location.href);
		url.searchParams.set('completedLimit', String(newLimit));
		window.history.replaceState({}, '', url.toString());
		await invalidateAll();
		loadingMore = false;
	}

	function closeSortDropdowns() {
		openSortDropdown = null;
	}

	let activityOpen = $state(false);
	let activityItems = $state<any[]>([]);
	let activityLoading = $state(false);
	let knownActivityIds = new Set<number>();
	let newActivityIds = $state(new Set<number>());

	// More menu & panel state
	let showMoreMenu = $state(false);
	let showStatsPanel = $state(false);
	let showArchivePanel = $state(false);
	let archivedCards = $state<any[]>([]);
	let loadingArchive = $state(false);

	onMount(() => {
		if (browser) {
			activityOpen = localStorage.getItem('df-activity-open') === 'true';
			if (activityOpen) fetchActivity(true);
		}
	});

	function toggleActivity() {
		activityOpen = !activityOpen;
		if (browser) localStorage.setItem('df-activity-open', String(activityOpen));
		if (activityOpen && activityItems.length === 0) fetchActivity(true);
	}

	function toggleStatsPanel() {
		showStatsPanel = !showStatsPanel;
	}

	async function toggleArchivePanel() {
		showArchivePanel = !showArchivePanel;
		if (showArchivePanel && archivedCards.length === 0) await loadAllArchived();
	}

	async function loadAllArchived() {
		loadingArchive = true;
		try {
			const res = await fetch('/api/cards/archived');
			if (res.ok) archivedCards = await res.json();
		} finally { loadingArchive = false; }
	}

	async function restoreArchivedCard(cardId: number) {
		await fetch(`/api/cards/${cardId}/restore`, { method: 'POST' });
		archivedCards = archivedCards.filter(c => c.id !== cardId);
		await invalidateAll();
	}

	async function permanentlyDeleteArchivedCard(cardId: number, cardTitle: string) {
		if (!window.confirm(`Permanently delete "${cardTitle}"? This cannot be undone.`)) return;
		await fetch(`/api/cards/${cardId}?permanent=true`, {
			method: 'DELETE',
			headers: { 'Content-Type': 'application/json' },
			body: JSON.stringify({})
		});
		archivedCards = archivedCards.filter(c => c.id !== cardId);
	}

	async function fetchActivity(initial = false) {
		activityLoading = true;
		try {
			const res = await fetch('/api/activity');
			if (res.ok) {
				const items = await res.json();
				if (initial) {
					// First load — seed known IDs, nothing is "new"
					knownActivityIds = new Set(items.map((i: any) => i.id));
					newActivityIds = new Set();
				} else {
					// Subsequent loads — detect new items
					const freshIds = new Set<number>();
					for (const item of items) {
						if (!knownActivityIds.has(item.id)) {
							freshIds.add(item.id);
							knownActivityIds.add(item.id);
						}
					}
					if (freshIds.size > 0) {
						newActivityIds = new Set([...newActivityIds, ...freshIds]);
						// Clear the pulse after 30 seconds
						setTimeout(() => {
							newActivityIds = new Set([...newActivityIds].filter(id => !freshIds.has(id)));
						}, 30000);
					}
				}
				activityItems = items;
			}
		} catch { /* ignore */ }
		activityLoading = false;
	}

	function formatActivityTime(dateStr: string) {
		if (!dateStr) return '';
		const d = parseUTC(dateStr);
		const now = new Date();
		const diffMs = now.getTime() - d.getTime();
		const mins = Math.floor(diffMs / 60000);
		if (mins < 1) return 'just now';
		if (mins < 60) return `${mins}m ago`;
		const hrs = Math.floor(mins / 60);
		if (hrs < 24) return `${hrs}h ago`;
		const days = Math.floor(hrs / 24);
		if (days < 7) return `${days}d ago`;
		return d.toLocaleDateString('en-GB', { day: 'numeric', month: 'short' });
	}

	function getActionLabel(action: string): string {
		const labels: Record<string, string> = {
			'api:card_updated': 'Updated card',
			'api:card_archived': 'Archived card',
			'api:card_deleted': 'Deleted card',
			'api:card_moved': 'Moved card',
			'api:assignee_added': 'Assigned user',
			'api:assignee_removed': 'Unassigned user',
			'api:comment_added': 'Added comment',
			'api:subtask_created': 'Created subtask',
			'api:board_created': 'Created board',
			'card_created': 'Created card',
			'card_moved': 'Moved card',
			'card_completed': 'Completed card',
			'subtask_toggled': 'Updated subtask',
			'comment_added': 'Added comment'
		};
		return labels[action] || action.replace(/_/g, ' ');
	}

	function isApiAction(action: string): boolean {
		return action.startsWith('api:');
	}
</script>

<svelte:head>
	<title>DumpFire — All Tasks</title>
</svelte:head>

<svelte:window onclick={closeSortDropdowns} />

<div class="all-page-wrapper" onclick={() => { showMoreMenu = false; }}>
<div class="all-page">
	<header class="all-header">
		<div class="all-header-left">
			<a href="/" class="back-btn btn-ghost" id="back-to-dashboard">
				<svg width="18" height="18" viewBox="0 0 18 18" fill="none"><path d="M11 4L6 9l5 5" stroke="currentColor" stroke-width="2" stroke-linecap="round" stroke-linejoin="round"/></svg>
			</a>
			<span class="all-icon">🌐</span>
			<div>
				<h1 class="all-title">All Tasks</h1>
				<p class="all-subtitle">{data.totalCards} total · {data.completedCards} complete · {data.totalCards - data.completedCards} remaining</p>
			</div>
		</div>
		<div class="all-header-right">
			<select class="board-filter" bind:value={boardFilter}>
				<option value="all">All Boards</option>
				{#each (data.boardCategories || []) as cat}
					{@const catBoards = data.boards.filter((b: any) => b.categoryId === cat.id)}
					{#if catBoards.length > 0}
						<optgroup label="{cat.name}">
							<option value="cat:{cat.id}">⬛ All {cat.name}</option>
							{#each catBoards as board}
								<option value={board.id}>{board.emoji} {board.name}</option>
							{/each}
						</optgroup>
					{/if}
				{/each}
				{#each [data.boards.filter((b: any) => !b.categoryId)] as uncategorizedBoards}
					{#if uncategorizedBoards.length > 0}
						<optgroup label="Uncategorized">
							{#each uncategorizedBoards as board}
								<option value={board.id}>{board.emoji} {board.name}</option>
							{/each}
						</optgroup>
					{/if}
				{/each}
			</select>
			<div class="search-wrapper">
				<svg class="search-icon" width="14" height="14" viewBox="0 0 14 14" fill="none">
					<circle cx="6" cy="6" r="4.5" stroke="currentColor" stroke-width="1.5"/>
					<path d="M10 10l3 3" stroke="currentColor" stroke-width="1.5" stroke-linecap="round"/>
				</svg>
				<input type="text" class="search-input" placeholder="Search tasks or #id..." bind:value={searchQuery} />
			</div>
			<div class="more-menu-container">
				<button class="btn-ghost nav-btn" onclick={(e) => { e.stopPropagation(); showMoreMenu = !showMoreMenu; }} title="Panels">
					<svg width="16" height="16" viewBox="0 0 16 16" fill="none"><circle cx="8" cy="3" r="1.2" fill="currentColor"/><circle cx="8" cy="8" r="1.2" fill="currentColor"/><circle cx="8" cy="13" r="1.2" fill="currentColor"/></svg>
					More
				</button>
				{#if showMoreMenu}
					<!-- svelte-ignore a11y_click_events_have_key_events -->
					<!-- svelte-ignore a11y_no_static_element_interactions -->
					<div class="more-dropdown" onclick={(e) => e.stopPropagation()}>
						<div class="more-dropdown-section">
							<div class="more-dropdown-label">Panels</div>
							<button class="more-dropdown-item" class:more-active={activityOpen} onclick={() => { toggleActivity(); showMoreMenu = false; }}>
								<span class="more-item-icon">📋</span> Activity Log
								{#if activityOpen}<span class="more-check">✓</span>{/if}
							</button>
							<button class="more-dropdown-item" class:more-active={showStatsPanel} onclick={() => { toggleStatsPanel(); showMoreMenu = false; }}>
								<span class="more-item-icon">📊</span> Statistics
								{#if showStatsPanel}<span class="more-check">✓</span>{/if}
							</button>
							<button class="more-dropdown-item" class:more-active={showArchivePanel} onclick={() => { toggleArchivePanel(); showMoreMenu = false; }}>
								<span class="more-item-icon">🗄️</span> Archived Cards
								{#if showArchivePanel}<span class="more-check">✓</span>{/if}
							</button>
						</div>
					</div>
				{/if}
			</div>
			<a class="btn-ghost export-csv-btn" href={boardFilter !== 'all' && !boardFilter.startsWith('cat:') ? `/api/cards/export/csv?boardId=${boardFilter}` : '/api/cards/export/csv'} download title="Export to CSV">
				<svg width="16" height="16" viewBox="0 0 16 16" fill="none"><path d="M8 2v8M5 7l3 3 3-3" stroke="currentColor" stroke-width="1.5" stroke-linecap="round" stroke-linejoin="round"/><path d="M2 11v2a1 1 0 001 1h10a1 1 0 001-1v-2" stroke="currentColor" stroke-width="1.5" stroke-linecap="round"/></svg>
			</a>
			<ThemePicker />
		</div>
	</header>

	<div class="kanban-scroll">
		<div class="kanban-track">
			{#each data.buckets as bucket}
				{@const filteredCards = getSortedCards(bucket.cards.filter(matchesFilters), bucket.title)}
				<div class="column">
					<div class="column-header">
						<div class="column-title-row">
							<span class="column-color-dot" style="background: {bucketColors[bucket.title] || '#8b5cf6'}"></span>
							<h2 class="column-title">{bucket.title}</h2>
							<span class="column-count">
								{#if bucket.title === 'Complete' && data.hasMoreCompleted}
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
						{#if bucket.contributingBoards && bucket.contributingBoards.length > 0}
							<div class="column-boards">
								{#if bucket.contributingBoards.length === data.boards.length}
									<span class="bucket-board-tag">All Boards</span>
								{:else}
									{#each bucket.contributingBoards as boardName}
										<span class="bucket-board-tag">{boardName}</span>
									{/each}
								{/if}
							</div>
						{/if}
					</div>
					<div class="card-list">
						{#each filteredCards as card (card.id)}
							<div class="card" class:card-pinned={card.pinned} onclick={() => openCard(card)} role="button" tabindex="0">
								{#if card.colorTag}
									<div class="card-color-bar" style="background: {card.colorTag}"></div>
								{/if}
								{#if card.pinned}
									<span class="pin-badge" title="Pinned">📌</span>
								{/if}
								{#if isNew(card.createdAt)}
									<span class="new-badge">New</span>
								{/if}
								<div class="card-header">
									<span class="card-title"><span class="card-id">#{card.id}</span> {card.title}</span>
									<button class="move-btn" title="Move card" onclick={(e) => { e.stopPropagation(); openMoveModal(card); }}>
										<svg width="14" height="14" viewBox="0 0 14 14" fill="none"><path d="M7 2v10M2 7h10" stroke="currentColor" stroke-width="1.5" stroke-linecap="round"/><path d="M4 4L2 7l2 3M10 4l2 3-2 3M4 4L7 2l3 2M4 10l3 2 3-2" stroke="currentColor" stroke-width="1" stroke-linecap="round" stroke-linejoin="round" opacity="0.5"/></svg>
									</button>
								</div>
								<div class="card-board-tag">
									<span class="board-tag">{card.boardEmoji} {card.boardName}</span>
									{#if card.boardCategoryName}
										<span class="board-cat-badge" style="background: {card.boardCategoryColor}20; color: {card.boardCategoryColor}; border: 1px solid {card.boardCategoryColor}40">{card.boardCategoryName}</span>
									{/if}
								</div>
								<div class="card-meta">
									<span class="priority-badge priority-{card.priority}">
										{priorityEmoji[card.priority] || '🟡'} {card.priority.toUpperCase()}
									</span>
									{#if card.categoryId}
										{@const cat = data.categories.find((c: any) => c.id === card.categoryId)}
										{#if cat}
											<span class="category-badge" style="background: {cat.color}20; color: {cat.color}; border: 1px solid {cat.color}40">{cat.name}</span>
										{/if}
									{/if}
									{#if subtaskProgress(card as any)}
										{@const prog = subtaskProgress(card as any)!}
										{@const pct = prog.done / prog.total}
										<span class="subtask-badge" class:all-done={prog.done === prog.total}>
											<svg class="progress-ring" width="14" height="14" viewBox="0 0 14 14">
												<circle cx="7" cy="7" r="5.5" fill="none" stroke="var(--glass-border)" stroke-width="2"/>
												<circle cx="7" cy="7" r="5.5" fill="none"
													stroke={prog.done === prog.total ? '#22c55e' : '#6366f1'}
													stroke-width="2"
													stroke-dasharray={2 * Math.PI * 5.5}
													stroke-dashoffset={2 * Math.PI * 5.5 * (1 - pct)}
													transform="rotate(-90 7 7)"
													stroke-linecap="round"/>
											</svg>
											{prog.done}/{prog.total}
										</span>
									{/if}
									{#if card.dueDate}
										{@const dueStatus = getDueStatus(card.dueDate)}
										<span class="due-badge" class:due-overdue={dueStatus === 'overdue'} class:due-today={dueStatus === 'today'} class:due-soon={dueStatus === 'soon'} title="Due {new Date(card.dueDate).toLocaleDateString('en-GB', { day: 'numeric', month: 'short', year: 'numeric' })}">
											{#if dueStatus === 'overdue'}⚠️{:else if dueStatus === 'today'}🔥{:else if dueStatus === 'soon'}📅{:else}📅{/if}
											Due {getDueRelative(card.dueDate, tick)}
										</span>
									{/if}
									<span class="card-date" title="Created {parseUTC(card.createdAt).toLocaleDateString('en-GB', { day: 'numeric', month: 'short', year: 'numeric' })}">Created {getRelativeAge(card.createdAt, tick)}</span>
								</div>
								{#if card.onHoldNote && bucket.title === 'On Hold'}
									<div class="on-hold-note-badge" title={card.onHoldNote}>
										<svg width="10" height="10" viewBox="0 0 10 10" fill="none"><circle cx="5" cy="5" r="4" stroke="currentColor" stroke-width="1"/><path d="M5 3v2.5h2" stroke="currentColor" stroke-width="1" stroke-linecap="round"/></svg>
										<span>{card.onHoldNote}</span>
									</div>
								{/if}
								{#if card.labelIds && card.labelIds.length > 0}
									<div class="card-labels">
										{#each card.labelIds as labelId}
											{@const label = data.labels.find((l: any) => l.id === labelId)}
											{#if label}
												<span class="label-chip" style="background: {label.color}25; color: {label.color}; border: 1px solid {label.color}40">{label.name}</span>
											{/if}
										{/each}
									</div>
								{/if}
								{#if card.assignees && card.assignees.length > 0}
									<div class="card-assignees">
										{#each card.assignees as assignee}
											<span class="assignee-chip">{assignee.emoji || '👤'} {assignee.username}</span>
										{/each}
									</div>
								{/if}
							</div>
						{:else}
							<div class="column-empty">No tasks</div>
						{/each}
						{#if bucket.title === 'Complete' && data.hasMoreCompleted}
							<button class="load-more-btn" onclick={loadMoreCompleted} disabled={loadingMore} id="load-more-completed">
								{#if loadingMore}
									<span class="spinner"></span> Loading…
								{:else}
									Show More ({data.totalCompletedCount - filteredCards.length} remaining)
								{/if}
							</button>
						{/if}
					</div>
				</div>
			{/each}
		</div>
	</div>
</div> <!-- /.all-page -->
<div class="all-panels-area">
{#if activityOpen}
<div class="activity-panel">
	<div class="activity-panel-header">
		<h3>
			<svg width="14" height="14" viewBox="0 0 14 14" fill="none"><path d="M2 3h10M2 5.5h7M2 8h8M2 10.5h5" stroke="currentColor" stroke-width="1.3" stroke-linecap="round"/></svg>
			Activity
		</h3>
		<div style="display:flex;gap:4px;">
			<button class="activity-refresh-btn" onclick={fetchActivity} title="Refresh">
				<svg width="14" height="14" viewBox="0 0 14 14" fill="none"><path d="M2.5 7a4.5 4.5 0 0 1 8.5-2M11.5 7a4.5 4.5 0 0 1-8.5 2" stroke="currentColor" stroke-width="1.3" stroke-linecap="round"/><path d="M11 2v3h-3" stroke="currentColor" stroke-width="1.3" stroke-linecap="round" stroke-linejoin="round"/><path d="M3 12V9h3" stroke="currentColor" stroke-width="1.3" stroke-linecap="round" stroke-linejoin="round"/></svg>
			</button>
			<button class="activity-refresh-btn" onclick={toggleActivity} title="Close">
				<svg width="14" height="14" viewBox="0 0 14 14" fill="none"><path d="M3 3l8 8M11 3l-8 8" stroke="currentColor" stroke-width="1.5" stroke-linecap="round"/></svg>
			</button>
		</div>
	</div>
	<div class="activity-list">
		{#if activityLoading}
			<div class="activity-loading">Loading activity...</div>
		{:else if activityItems.length === 0}
			<div class="activity-empty">No activity yet</div>
		{:else}
			{#each activityItems as item}
				<div class="activity-item" class:activity-new={newActivityIds.has(item.id)}>
					<div class="activity-avatar">{item.userEmoji || '👤'}</div>
					<div class="activity-body">
						<div class="activity-action-line">
							<span class="activity-action-label">{item.userName || 'System'}</span>
							{getActionLabel(item.action)}
							{#if isApiAction(item.action)}
								<span class="activity-api-badge">API</span>
							{/if}
						</div>
						{#if item.detail}
							<div class="activity-detail">{item.detail}</div>
						{/if}
						<div class="activity-meta">
							<span>{formatActivityTime(item.createdAt)}</span>
							{#if item.boardName}
								<span class="activity-board-tag">{item.boardName}</span>
							{/if}
						</div>
					</div>
				</div>
			{/each}
		{/if}
	</div>
</div>
{/if}
{#if showStatsPanel}
	{@const syntheticColumns = data.buckets.map((b, i) => ({
		id: i + 1,
		boardId: 0,
		title: b.title,
		position: i,
		color: b.title === 'Complete' ? '#10b981' : b.title === 'In Progress' ? '#6366f1' : b.title === 'On Hold' ? '#f59e0b' : '#64748b',
		showAddCard: false,
		wipLimit: 0,
		cards: b.cards as unknown as CardType[]
	} satisfies ColumnType))}
	<StatsPanel
		boardColumns={syntheticColumns}
		boardCategories={data.categories as unknown as CategoryType[]}
		boardId={boardFilter !== 'all' && !boardFilter.startsWith('cat:') ? Number(boardFilter) : 0}
		onClose={() => (showStatsPanel = false)}
	/>
{/if}
{#if showArchivePanel}
<div class="activity-panel">
	<div class="activity-panel-header">
		<h3>🗄️ Archived Cards</h3>
		<div style="display:flex;gap:4px;">
			<button class="activity-refresh-btn" onclick={() => loadAllArchived()} title="Refresh">
				<svg width="14" height="14" viewBox="0 0 14 14" fill="none"><path d="M2.5 7a4.5 4.5 0 0 1 8.5-2M11.5 7a4.5 4.5 0 0 1-8.5 2" stroke="currentColor" stroke-width="1.3" stroke-linecap="round"/><path d="M11 2v3h-3" stroke="currentColor" stroke-width="1.3" stroke-linecap="round" stroke-linejoin="round"/><path d="M3 12V9h3" stroke="currentColor" stroke-width="1.3" stroke-linecap="round" stroke-linejoin="round"/></svg>
			</button>
			<button class="activity-refresh-btn" onclick={() => (showArchivePanel = false)} title="Close">
				<svg width="14" height="14" viewBox="0 0 14 14" fill="none"><path d="M3 3l8 8M11 3l-8 8" stroke="currentColor" stroke-width="1.5" stroke-linecap="round"/></svg>
			</button>
		</div>
	</div>
	<div class="activity-list" style="padding: var(--space-md);">
		{#if loadingArchive}
			<div class="activity-loading">Loading...</div>
		{:else if archivedCards.length === 0}
			<div class="activity-empty">
				<span style="font-size:2rem;">📦</span>
				<p>No archived cards</p>
			</div>
		{:else}
			{#each archivedCards as card (card.id)}
				<div class="archive-card-item">
					<div class="archive-card-info">
						<span class="archive-card-title">{card.title}</span>
						{#if card.boardName}<span class="archive-card-board">{card.boardName}</span>{/if}
					</div>
					<div style="display:flex;gap:4px;">
						<button class="btn-ghost small" onclick={() => restoreArchivedCard(card.id)} title="Restore">↩️ Restore</button>
						<button class="btn-ghost small danger" onclick={() => permanentlyDeleteArchivedCard(card.id, card.title)} title="Delete permanently">🗑️</button>
					</div>
				</div>
			{/each}
		{/if}
	</div>
</div>
{/if}
</div> <!-- /.all-panels-area -->
</div> <!-- /all-page-wrapper -->

<!-- Card Edit Modal -->
{#if showCardModal && editingCard}
	<CardModal
		card={editingCard}
		categories={data.categories.filter((c: any) => c.boardId === editingBoardId) as any}
		labels={data.labels.filter((l: any) => l.boardId === editingBoardId) as any}
		boardId={editingBoardId}
		boardUsers={data.allUsers}
		onSave={saveCard}
		onDelete={deleteCard}
		onClose={() => { showCardModal = false; editingCard = null; }}
	/>
{/if}

<!-- Move Card Modal -->
{#if showMoveModal && moveCard}
	<div class="modal-overlay" role="dialog">
		<div class="move-modal" onclick={(e) => e.stopPropagation()}>
			<h3>Move "{moveCard.title}"</h3>
			<div class="form-group">
				<label for="move-board">Board</label>
				<select id="move-board" bind:value={moveBoardId} onchange={() => { moveColumnId = null; }}>
					{#each data.boards as b}
						<option value={b.id}>{b.emoji} {b.name}</option>
					{/each}
				</select>
			</div>
			{#if moveBoardId}
				<div class="form-group">
					<label for="move-col">Column</label>
					<select id="move-col" bind:value={moveColumnId}>
						<option value={null}>Select column...</option>
						{#each getBoardColumns(moveBoardId) as col}
							<option value={col.id}>{col.title}</option>
						{/each}
					</select>
				</div>
			{/if}
			<div class="move-actions">
				<button class="btn-ghost" onclick={() => { showMoveModal = false; moveCard = null; }}>Cancel</button>
				<button class="btn-primary move-confirm-btn" onclick={doMoveCard} disabled={!moveColumnId}>Move Card</button>
			</div>
		</div>
	</div>
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

{#if liveToasts.length > 0}
	<div class="live-toast-container">
		{#each liveToasts as toast (toast.id)}
			<div class="live-toast" class:live-toast-created={toast.type === 'created'} class:live-toast-moved={toast.type === 'moved'}>
				<div class="live-toast-glow"></div>
				<div class="live-toast-inner">
					<span class="live-toast-emoji">{toast.userEmoji}</span>
					<div class="live-toast-body">
						<span class="live-toast-user">{toast.userName}</span>
						{#if toast.type === 'created'}
							<span class="live-toast-action">created</span>
							<span class="live-toast-card">"{toast.cardTitle}"</span>
						{:else}
							<span class="live-toast-action">moved</span>
							<span class="live-toast-card">"{toast.cardTitle}"</span>
							{#if toast.fromColumn && toast.toColumn}
								<span class="live-toast-cols">{toast.fromColumn} → {toast.toColumn}</span>
							{/if}
						{/if}
					</div>
					<span class="live-toast-icon">{toast.type === 'created' ? '✨' : '➡️'}</span>
				</div>
			</div>
		{/each}
	</div>
{/if}

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

	.all-header {
		display: flex;
		align-items: center;
		justify-content: space-between;
		padding: var(--space-lg) var(--space-xl);
		border-bottom: 1px solid var(--glass-border);
		flex-shrink: 0;
		gap: var(--space-md);
	}

	.all-header-left {
		display: flex;
		align-items: center;
		gap: var(--space-md);
		flex-shrink: 0;
	}

	.all-header-right {
		display: flex;
		align-items: center;
		gap: var(--space-sm);
		flex-shrink: 0;
	}

	.all-icon {
		font-size: 1.75rem;
	}

	.all-title {
		font-size: 1.25rem;
		background: linear-gradient(135deg, var(--text-primary), var(--accent-purple));
		-webkit-background-clip: text;
		-webkit-text-fill-color: transparent;
		background-clip: text;
	}

	.all-subtitle {
		font-size: 0.75rem;
		color: var(--text-secondary);
		margin-top: 1px;
	}

	.board-filter {
		padding: 6px 12px;
		border-radius: var(--radius-md);
		border: 1px solid var(--glass-border);
		background: var(--bg-elevated);
		color: var(--text-primary);
		font-size: 0.8rem;
		font-weight: 500;
		cursor: pointer;
		outline: none;
	}

	.board-filter:focus {
		border-color: var(--accent-purple);
	}

	.search-wrapper {
		position: relative;
		display: flex;
		align-items: center;
	}

	.search-icon {
		position: absolute;
		left: 10px;
		color: var(--text-tertiary);
		pointer-events: none;
	}

	.search-input {
		padding: 6px 10px 6px 30px;
		border-radius: var(--radius-md);
		border: 1px solid var(--glass-border);
		background: var(--bg-elevated);
		color: var(--text-primary);
		font-size: 0.8rem;
		width: 200px;
		outline: none;
		transition: border-color var(--duration-fast) var(--ease-out);
	}

	.search-input:focus {
		border-color: var(--accent-purple);
	}

	.back-btn {
		font-size: 0;
		padding: var(--space-sm);
		color: var(--text-secondary);
	}

	.back-btn:hover {
		color: var(--text-primary);
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

	.column-boards {
		display: flex;
		flex-wrap: wrap;
		gap: 3px;
		margin-top: 6px;
	}

	.bucket-board-tag {
		font-size: 0.6rem;
		font-weight: 500;
		color: var(--text-tertiary);
		background: var(--bg-base);
		padding: 1px 6px;
		border-radius: var(--radius-sm);
		border: 1px solid var(--glass-border);
		white-space: nowrap;
	}

	.card-list {
		flex: 1;
		overflow-y: auto;
		padding: 0 var(--space-md) var(--space-md);
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

	.card {
		display: flex;
		flex-direction: column;
		gap: var(--space-xs);
		padding: var(--space-md);
		border-radius: var(--radius-md);
		text-decoration: none;
		color: var(--text-primary);
		cursor: pointer;
		transition: all var(--duration-normal) var(--ease-out);
		position: relative;
		overflow: hidden;
		flex-shrink: 0;
		background: var(--bg-card);
		border: 1px solid var(--glass-border);
	}

	.card:hover {
		transform: translateY(-1px);
		box-shadow: var(--shadow-md);
		border-color: var(--glass-border);
	}

	.card-pinned {
		border-top: 2px solid var(--accent-indigo);
	}

	.pin-badge {
		position: absolute;
		top: 4px;
		right: 6px;
		font-size: 0.65rem;
	}

	.new-badge {
		position: absolute;
		top: 4px;
		right: 6px;
		font-size: 0.55rem;
		font-weight: 700;
		text-transform: uppercase;
		letter-spacing: 0.06em;
		padding: 1px 6px;
		border-radius: var(--radius-full);
		background: linear-gradient(135deg, #22c55e, #10b981);
		color: #fff;
		box-shadow: 0 0 8px rgba(34, 197, 94, 0.4);
		animation: newPulse 2s ease-in-out infinite;
	}

	.card-pinned .new-badge {
		right: 24px;
	}

	@keyframes newPulse {
		0%, 100% { box-shadow: 0 0 6px rgba(34, 197, 94, 0.3); }
		50% { box-shadow: 0 0 12px rgba(34, 197, 94, 0.6); }
	}

	.card-header {
		display: flex;
		align-items: flex-start;
		gap: var(--space-sm);
	}

	.card-title {
		font-size: 0.82rem;
		font-weight: 600;
		line-height: 1.3;
	}

	.card-board-tag {
		display: flex;
		align-items: center;
		gap: var(--space-xs);
		flex-wrap: wrap;
	}

	.board-tag {
		font-size: 0.65rem;
		font-weight: 600;
		color: var(--accent-purple);
		background: var(--accent-purple-glow, rgba(139, 92, 246, 0.12));
		padding: 1px 6px;
		border-radius: var(--radius-sm);
	}

	.column-tag {
		font-size: 0.6rem;
		color: var(--text-tertiary);
		font-style: italic;
	}

	.card-meta {
		display: flex;
		align-items: center;
		gap: var(--space-xs);
		flex-wrap: wrap;
		font-size: 0.7rem;
	}

	.priority-badge {
		display: inline-flex; align-items: center; gap: 4px;
		font-size: 0.65rem;
		font-weight: 600;
		padding: 2px 8px;
		border-radius: var(--radius-full);
		text-transform: uppercase;
		letter-spacing: 0.04em;
	}

	.priority-critical { background: rgba(239, 68, 68, 0.15); color: #ef4444; border: 1px solid rgba(239, 68, 68, 0.25); }
	.priority-high { background: rgba(249, 115, 22, 0.15); color: #f97316; border: 1px solid rgba(249, 115, 22, 0.25); }
	.priority-medium { background: rgba(234, 179, 8, 0.15); color: #eab308; border: 1px solid rgba(234, 179, 8, 0.25); }
	.priority-low { background: rgba(34, 197, 94, 0.15); color: #22c55e; border: 1px solid rgba(34, 197, 94, 0.25); }

	.subtask-badge {
		font-size: 0.65rem;
		font-weight: 600;
		color: var(--text-secondary);
		display: flex;
		align-items: center;
		gap: 3px;
	}

	.subtask-badge.all-done {
		color: #22c55e;
	}

	.progress-ring { flex-shrink: 0; transition: stroke-dashoffset 0.3s ease-out; }

	.due-badge {
		font-size: 0.6rem;
		font-weight: 600;
		padding: 1px 6px;
		border-radius: var(--radius-sm);
		background: rgba(99, 102, 241, 0.1);
		color: var(--text-secondary);
	}

	.due-overdue { background: rgba(239, 68, 68, 0.15); color: #ef4444; }
	.due-today { background: rgba(245, 158, 11, 0.15); color: #f59e0b; }
	.due-soon { background: rgba(249, 115, 22, 0.12); color: #f97316; }

	.card-date {
		font-size: 0.65rem;
		color: var(--text-secondary);
		margin-left: auto;
		flex-shrink: 0;
	}

	.on-hold-note-badge {
		display: flex;
		align-items: flex-start;
		gap: 4px;
		font-size: 0.65rem;
		color: var(--text-tertiary);
		background: rgba(239, 68, 68, 0.06);
		padding: 4px 6px;
		border-radius: var(--radius-sm);
		border-left: 2px solid var(--accent-rose);
	}

	.on-hold-note-badge svg { flex-shrink: 0; margin-top: 2px; }

	.on-hold-note-badge span {
		overflow: hidden;
		text-overflow: ellipsis;
		display: -webkit-box;
		-webkit-line-clamp: 2;
		line-clamp: 2;
		-webkit-box-orient: vertical;
	}

	.column-empty {
		text-align: center;
		color: var(--text-tertiary);
		font-size: 0.8rem;
		padding: var(--space-xl);
	}

	.theme-toggle { font-size: 0; }

	/* Color tag bar */
	.card-color-bar {
		position: absolute; top: 0; left: 0; right: 0; height: 3px;
		border-radius: var(--radius-md) var(--radius-md) 0 0;
	}

	/* Category badge */
	.category-badge {
		font-size: 0.6rem; font-weight: 600; padding: 1px 6px;
		border-radius: var(--radius-sm);
	}

	/* Board category badge */
	.board-cat-badge {
		font-size: 0.58rem; font-weight: 600; padding: 1px 5px;
		border-radius: var(--radius-sm); white-space: nowrap;
	}

	/* Label chips */
	.card-labels {
		display: flex; flex-wrap: wrap; gap: 3px; margin-top: 2px;
	}
	.label-chip {
		font-size: 0.58rem; font-weight: 600; padding: 1px 5px;
		border-radius: var(--radius-sm); white-space: nowrap;
	}

	/* Assignee chips */
	.card-assignees {
		display: flex; flex-wrap: wrap; gap: 3px; margin-top: 2px;
	}
	.assignee-chip {
		display: inline-flex; align-items: center; gap: 2px;
		font-size: 0.6rem; font-weight: 600;
		padding: 1px 6px; border-radius: var(--radius-full);
		background: rgba(99, 102, 241, 0.1); color: #818cf8;
		border: 1px solid rgba(99, 102, 241, 0.2);
	}

	/* Card interactions */
	.card { cursor: pointer; }
	.card-header { justify-content: space-between; }
	.move-btn {
		flex-shrink: 0; background: none; border: none; cursor: pointer;
		color: var(--text-tertiary); padding: 2px; border-radius: var(--radius-sm);
		opacity: 0; transition: all var(--duration-fast) var(--ease-out);
	}
	.card:hover .move-btn { opacity: 1; }
	.move-btn:hover { color: var(--accent-indigo); background: rgba(99, 102, 241, 0.08); }

	/* Move Modal */
	.modal-overlay {
		position: fixed; inset: 0; z-index: 1000;
		background: rgba(0, 0, 0, 0.5); backdrop-filter: blur(4px);
		display: flex; align-items: center; justify-content: center;
	}
	.move-modal {
		background: var(--bg-card); border: 1px solid var(--glass-border);
		border-radius: var(--radius-lg); padding: var(--space-xl); width: 100%; max-width: 400px;
		box-shadow: var(--shadow-lg);
	}
	.move-modal h3 { font-size: 1rem; font-weight: 700; color: var(--text-primary); margin-bottom: var(--space-lg); }
	.move-modal .form-group { display: flex; flex-direction: column; gap: var(--space-xs); margin-bottom: var(--space-md); }
	.move-modal label { font-size: 0.82rem; font-weight: 600; color: var(--text-secondary); }
	.move-modal select {
		padding: 8px 12px; border-radius: var(--radius-md);
		background: var(--bg-surface); border: 1px solid var(--glass-border);
		color: var(--text-primary); font-family: var(--font-family); font-size: 0.88rem;
		cursor: pointer;
	}
	.move-modal select:focus { outline: none; border-color: var(--accent-indigo); }
	.move-actions { display: flex; justify-content: flex-end; gap: var(--space-sm); margin-top: var(--space-lg); }
	.move-confirm-btn {
		padding: 8px 20px; border-radius: var(--radius-md); border: none;
		background: var(--accent-indigo); color: white; font-weight: 600; font-size: 0.85rem;
		cursor: pointer; font-family: var(--font-family);
		transition: all var(--duration-fast) var(--ease-out);
	}
	.move-confirm-btn:hover:not(:disabled) { background: #5558e6; transform: translateY(-1px); }
	.move-confirm-btn:disabled { opacity: 0.5; cursor: not-allowed; }

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

	/* ── Live Activity Toasts ─────────────────────────── */
	.live-toast-container {
		position: fixed;
		top: var(--space-xl);
		left: 50%;
		transform: translateX(-50%);
		z-index: 9999;
		display: flex;
		flex-direction: column;
		gap: var(--space-sm);
		pointer-events: none;
		max-width: 420px;
		width: 90%;
	}

	.live-toast {
		position: relative;
		border-radius: var(--radius-lg);
		overflow: hidden;
		animation: toastSlideIn 0.5s cubic-bezier(0.34, 1.56, 0.64, 1) both;
		pointer-events: auto;
	}

	.live-toast-glow {
		position: absolute;
		inset: 0;
		border-radius: var(--radius-lg);
		opacity: 0.4;
		animation: toastGlow 2s ease-in-out infinite;
	}

	.live-toast-created .live-toast-glow {
		box-shadow: 0 0 20px rgba(16, 185, 129, 0.3), 0 0 40px rgba(16, 185, 129, 0.15);
	}

	.live-toast-moved .live-toast-glow {
		box-shadow: 0 0 20px rgba(99, 102, 241, 0.3), 0 0 40px rgba(99, 102, 241, 0.15);
	}

	.live-toast-inner {
		position: relative;
		display: flex;
		align-items: center;
		gap: var(--space-md);
		padding: var(--space-md) var(--space-lg);
		background: var(--bg-card);
		border: 1px solid var(--glass-border);
		border-radius: var(--radius-lg);
		backdrop-filter: blur(16px);
		-webkit-backdrop-filter: blur(16px);
	}

	.live-toast-created .live-toast-inner {
		border-left: 3px solid #10b981;
		background: linear-gradient(135deg, var(--bg-card), rgba(16, 185, 129, 0.04));
	}

	.live-toast-moved .live-toast-inner {
		border-left: 3px solid #6366f1;
		background: linear-gradient(135deg, var(--bg-card), rgba(99, 102, 241, 0.04));
	}

	.live-toast-emoji {
		font-size: 1.5rem;
		flex-shrink: 0;
		animation: toastBounce 0.6s ease-out;
	}

	.live-toast-body {
		flex: 1;
		min-width: 0;
		display: flex;
		flex-wrap: wrap;
		align-items: baseline;
		gap: 4px;
		font-size: 0.82rem;
		line-height: 1.4;
	}

	.live-toast-user {
		font-weight: 700;
		color: var(--text-primary);
	}

	.live-toast-action {
		color: var(--text-secondary);
		font-weight: 500;
	}

	.live-toast-card {
		font-weight: 600;
		color: var(--text-primary);
		max-width: 200px;
		overflow: hidden;
		text-overflow: ellipsis;
		white-space: nowrap;
	}

	.live-toast-cols {
		display: inline-flex;
		align-items: center;
		gap: 2px;
		font-size: 0.7rem;
		font-weight: 600;
		padding: 1px 6px;
		border-radius: var(--radius-sm);
		background: rgba(99, 102, 241, 0.1);
		color: var(--accent-indigo);
		white-space: nowrap;
	}

	.live-toast-icon {
		font-size: 1.1rem;
		flex-shrink: 0;
		animation: toastIconPulse 1.5s ease-in-out infinite;
	}

	@keyframes toastSlideIn {
		from {
			opacity: 0;
			transform: translateY(-30px) scale(0.9);
		}
		to {
			opacity: 1;
			transform: translateY(0) scale(1);
		}
	}

	@keyframes toastGlow {
		0%, 100% { opacity: 0.3; }
		50% { opacity: 0.6; }
	}

	@keyframes toastBounce {
		0% { transform: scale(0.5); }
		50% { transform: scale(1.2); }
		100% { transform: scale(1); }
	}

	@keyframes toastIconPulse {
		0%, 100% { transform: scale(1); }
		50% { transform: scale(1.15); }
	}
	/* Activity Panel */
	.activity-toggle-btn {
		position: relative;
	}
	.activity-toggle-btn.active {
		color: var(--accent-indigo);
		background: var(--glass-hover);
	}
	.activity-panel {
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
	.activity-panel-header {
		display: flex;
		align-items: center;
		justify-content: space-between;
		padding: 16px 20px;
		border-bottom: 1px solid var(--glass-border);
		flex-shrink: 0;
	}
	.activity-panel-header h3 {
		margin: 0;
		font-size: 0.9rem;
		color: var(--text-primary);
		display: flex;
		align-items: center;
		gap: 8px;
	}
	.activity-panel-header h3 svg {
		opacity: 0.6;
	}
	.activity-refresh-btn {
		background: none;
		border: none;
		color: var(--text-secondary);
		cursor: pointer;
		padding: 4px;
		border-radius: 4px;
		transition: color 0.15s;
	}
	.activity-refresh-btn:hover { color: var(--text-primary); }
	.activity-list {
		flex: 1;
		overflow-y: auto;
		padding: 8px 0;
	}
	.activity-item {
		display: flex;
		gap: 10px;
		padding: 10px 20px;
		transition: background 0.15s, border-color 0.15s;
		border-left: 3px solid transparent;
	}
	.activity-item:hover {
		background: var(--glass-hover);
	}
	.activity-item.activity-new {
		border-left-color: var(--accent-indigo, #6366f1);
		animation: activityPulse 2s ease-in-out infinite;
	}
	@keyframes activityPulse {
		0%, 100% { background: transparent; }
		50% { background: rgba(99, 102, 241, 0.08); }
	}
	.activity-avatar {
		width: 28px;
		height: 28px;
		border-radius: 50%;
		background: var(--glass-hover);
		display: flex;
		align-items: center;
		justify-content: center;
		font-size: 14px;
		flex-shrink: 0;
		margin-top: 2px;
	}
	.activity-body {
		flex: 1;
		min-width: 0;
	}
	.activity-action-line {
		font-size: 0.78rem;
		color: var(--text-primary);
		line-height: 1.3;
	}
	.activity-action-label {
		font-weight: 600;
	}
	.activity-api-badge {
		display: inline-block;
		padding: 1px 5px;
		background: var(--glass-hover);
		color: var(--accent-indigo);
		border-radius: 3px;
		font-size: 0.6rem;
		font-weight: 700;
		text-transform: uppercase;
		margin-left: 4px;
		vertical-align: middle;
	}
	.activity-detail {
		font-size: 0.72rem;
		color: var(--text-secondary);
		white-space: nowrap;
		overflow: hidden;
		text-overflow: ellipsis;
		margin-top: 2px;
	}
	.activity-meta {
		display: flex;
		align-items: center;
		gap: 8px;
		margin-top: 3px;
		font-size: 0.68rem;
		color: var(--text-secondary);
	}
	.activity-board-tag {
		padding: 1px 5px;
		background: var(--bg-elevated);
		border-radius: 3px;
		font-size: 0.65rem;
		color: var(--text-secondary);
	}
	.activity-empty {
		padding: 40px 20px;
		text-align: center;
		color: var(--text-secondary);
		font-size: 0.82rem;
	}
	.activity-loading {
		padding: 30px 20px;
		text-align: center;
		color: var(--text-secondary);
		font-size: 0.8rem;
	}

	/* More Menu Dropdown */
	.more-menu-container { position: relative; }
	.more-dropdown {
		position: absolute; top: 100%; right: 0;
		min-width: 200px; padding: var(--space-xs);
		background: var(--bg-surface); border: 1px solid var(--glass-border);
		border-radius: var(--radius-md); box-shadow: 0 8px 32px rgba(0,0,0,0.2);
		z-index: 100; animation: fadeIn 0.1s ease-out;
	}
	@keyframes fadeIn { from { opacity: 0; transform: translateY(-4px); } to { opacity: 1; transform: translateY(0); } }
	.more-dropdown-label {
		font-size: 0.65rem; font-weight: 700; text-transform: uppercase;
		letter-spacing: 0.04em; color: var(--text-tertiary);
		padding: var(--space-xs) var(--space-sm);
	}
	.more-dropdown-item {
		display: flex; align-items: center; gap: var(--space-sm);
		width: 100%; padding: var(--space-sm); border: none;
		background: transparent; color: var(--text-primary);
		font-size: 0.82rem; cursor: pointer; border-radius: var(--radius-sm);
		transition: background 0.1s;
	}
	.more-dropdown-item:hover { background: var(--glass-hover); }
	.more-dropdown-item.more-active { color: var(--accent-indigo); }
	.more-item-icon { font-size: 1rem; }
	.more-check { margin-left: auto; font-size: 0.8rem; color: var(--accent-emerald); }

	/* All Tasks Stats Panel */
	.all-stats-grid {
		display: grid; grid-template-columns: 1fr 1fr; gap: var(--space-sm);
		margin-bottom: var(--space-lg);
	}
	.all-stat-card {
		display: flex; flex-direction: column; align-items: center;
		padding: var(--space-md); border-radius: var(--radius-md);
		background: var(--glass-bg); border: 1px solid var(--glass-border);
	}
	.all-stat-value { font-size: 1.5rem; font-weight: 800; color: var(--accent-indigo); }
	.all-stat-label { font-size: 0.68rem; color: var(--text-tertiary); font-weight: 600; text-transform: uppercase; letter-spacing: 0.04em; }
	.all-stats-section-title { font-size: 0.75rem; font-weight: 700; text-transform: uppercase; letter-spacing: 0.04em; color: var(--text-secondary); margin-bottom: var(--space-sm); }
	.all-stats-board-row { display: flex; align-items: center; gap: var(--space-sm); margin-bottom: var(--space-xs); }
	.all-stats-board-name { font-size: 0.72rem; font-weight: 600; width: 120px; white-space: nowrap; overflow: hidden; text-overflow: ellipsis; flex-shrink: 0; }
	.all-stats-bar-track { flex: 1; height: 8px; background: var(--glass-bg); border-radius: 4px; overflow: hidden; }
	.all-stats-bar-fill { height: 100%; border-radius: 4px; transition: width 0.3s ease-out; min-width: 2px; }
	.all-stats-board-count { font-size: 0.68rem; font-weight: 700; color: var(--text-secondary); width: 40px; text-align: right; }

	/* Archive Card Items */
	.archive-card-item {
		display: flex; align-items: center; justify-content: space-between;
		padding: var(--space-sm); border-radius: var(--radius-sm);
		border: 1px solid var(--glass-border); margin-bottom: var(--space-xs);
		transition: border-color 0.15s;
	}
	.archive-card-item:hover { border-color: var(--accent-indigo); }
	.archive-card-info { flex: 1; min-width: 0; }
	.archive-card-title { font-size: 0.82rem; font-weight: 600; display: block; overflow: hidden; text-overflow: ellipsis; white-space: nowrap; }
	.archive-card-board { font-size: 0.68rem; color: var(--text-tertiary); }
</style>
