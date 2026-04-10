<script lang="ts">
	/**
	 * Dashboard Page — The home screen of DumpFire.
	 *
	 * Shows personal analytics, boards in a tabular layout with
	 * collapsible sub-boards, and quick navigation.
	 */
	import type { PageData } from './$types';
	import { goto, invalidateAll } from '$app/navigation';
	import { page } from '$app/stores';
	import { onMount, onDestroy } from 'svelte';
	import { theme } from '$lib/stores/theme';
	import { COLUMN_COLORS } from '$lib/utils/constants';
	import ConfirmModal from '$lib/components/ConfirmModal.svelte';
	import EmojiPicker from '$lib/components/EmojiPicker.svelte';
	import ThemePicker from '$lib/components/ThemePicker.svelte';
	import CategoryManager from '$lib/components/CategoryManager.svelte';

	let { data }: { data: PageData } = $props();

	let showCreate = $state(false);
	let showMoreMenu = $state(false);
	let newBoardName = $state('');
	let newBoardEmoji = $state('📋');
	let newBoardCategory = $state<number | null>(null);
	let deleting = $state<number | null>(null);
	let currentTheme = $state('light');
	theme.subscribe((v) => (currentTheme = v));

	let user = $derived($page.data.user);
	let isAdmin = $derived(user?.role === 'admin' || user?.role === 'superadmin');

	let confirmState = $state<{ show: boolean; boardId: number; boardName: string }>({ show: false, boardId: 0, boardName: '' });

	let inboxCount = $state(0);
	let expandedBoards = $state<Set<number>>(new Set());
	let collapsedCategories = $state<Set<string>>(new Set());
	let showCompletedSubs = $state(false);
	let showCompletedBoards = $state(true);
	let showCategoryManager = $state(false);

	// Sort state
	type SortColumn = 'name' | 'activity' | 'cards' | 'progress';
	let sortBy = $state<SortColumn>('name');
	let sortDir = $state<'asc' | 'desc'>('asc');

	function toggleSort(col: SortColumn) {
		if (sortBy === col) {
			sortDir = sortDir === 'asc' ? 'desc' : 'asc';
		} else {
			sortBy = col;
			sortDir = col === 'name' ? 'asc' : 'desc';
		}
	}

	function sortArrow(col: SortColumn): string {
		if (sortBy !== col) return '';
		return sortDir === 'asc' ? ' ▲' : ' ▼';
	}

	// Typewriter straplines
	const straplines = [
		'Blazingly fast local Kanban',
		'No cloud. No latency. Just speed.',
		'Ship faster, stress less.',
		'Your tasks, your rules.',
		'Drag. Drop. Done.',
		'Organise chaos, beautifully.',
		'Built for makers & doers.',
		'Zero distractions, maximum flow.',
		'Where ideas become actions.',
		'Move fast. Break nothing.'
	];
	let typedText = $state('');
	let typewriterTimer: ReturnType<typeof setTimeout> | null = null;

	function runTypewriter() {
		let lineIdx = 0;
		let charIdx = 0;
		let deleting = false;
		const TYPE_SPEED = 55;
		const DELETE_SPEED = 30;
		const PAUSE_AFTER_TYPE = 2500;
		const PAUSE_AFTER_DELETE = 400;

		function tick() {
			const currentLine = straplines[lineIdx];
			if (!deleting) {
				typedText = currentLine.slice(0, charIdx + 1);
				charIdx++;
				if (charIdx >= currentLine.length) {
					deleting = true;
					typewriterTimer = setTimeout(tick, PAUSE_AFTER_TYPE);
				} else {
					typewriterTimer = setTimeout(tick, TYPE_SPEED);
				}
			} else {
				charIdx--;
				typedText = currentLine.slice(0, charIdx);
				if (charIdx <= 0) {
					deleting = false;
					lineIdx = (lineIdx + 1) % straplines.length;
					typewriterTimer = setTimeout(tick, PAUSE_AFTER_DELETE);
				} else {
					typewriterTimer = setTimeout(tick, DELETE_SPEED);
				}
			}
		}
		tick();
	}

	onMount(async () => {
		runTypewriter();
		const res = await fetch('/api/requests');
		if (res.ok) {
			const requests = await res.json();
			inboxCount = requests.filter((r: any) => r.status === 'pending').length;
		}
	});

	onDestroy(() => {
		if (typewriterTimer) clearTimeout(typewriterTimer);
	});

	async function createBoard() {
		if (!newBoardName.trim()) return;
		const res = await fetch('/api/boards', {
			method: 'POST',
			headers: { 'Content-Type': 'application/json' },
			body: JSON.stringify({ name: newBoardName.trim(), emoji: newBoardEmoji, categoryId: newBoardCategory })
		});
		if (res.ok) {
			const board = await res.json();
			newBoardName = '';
			newBoardCategory = null;
			showCreate = false;
			goto(`/board/${board.id}`);
		}
	}

	function confirmDeleteBoard(id: number, name: string) {
		confirmState = { show: true, boardId: id, boardName: name };
	}

	async function deleteBoard(id: number) {
		deleting = id;
		confirmState.show = false;
		await fetch(`/api/boards/${id}`, { method: 'DELETE' });
		await invalidateAll();
		deleting = null;
	}

	function toggleExpand(boardId: number) {
		const next = new Set(expandedBoards);
		if (next.has(boardId)) next.delete(boardId);
		else next.add(boardId);
		expandedBoards = next;
	}

	let totalCards = $derived(data.boards.reduce((t, b) => t + b.totalCards, 0));
	let completedCards = $derived(data.boards.reduce((t, b) => t + b.completedCards, 0));

	// ─── Board Favourites ────────────────────────────────────────────────────
	let favouriteBoardIds = $state<Set<number>>(new Set(data.favouriteBoardIds || []));

	$effect(() => {
		favouriteBoardIds = new Set(data.favouriteBoardIds || []);
	});

	async function toggleFavourite(boardId: number, e: MouseEvent) {
		e.stopPropagation();
		e.preventDefault();
		const next = new Set(favouriteBoardIds);
		if (next.has(boardId)) next.delete(boardId);
		else next.add(boardId);
		favouriteBoardIds = next;
		await fetch(`/api/boards/${boardId}/favourite`, { method: 'POST' });
	}

	let favouriteBoards = $derived(data.boards.filter(b => favouriteBoardIds.has(b.id)));

	const a = $derived(data.analytics);

	// Group boards by category for dashboard display
	type BoardGroup = { name: string; color: string | null; boards: typeof data.boards; total: number; done: number };
	let boardGroups = $derived.by(() => {
		const groups: BoardGroup[] = [];
		const catMap = new Map<string, BoardGroup>();

		for (const board of data.boards) {
			// Hide completed boards when toggle is off
			if (!showCompletedBoards && board.totalCards > 0 && board.completedCards === board.totalCards) continue;
			const key = board.categoryName || '__uncategorised__';
			let group = catMap.get(key);
			if (!group) {
				group = { name: board.categoryName || 'Uncategorised', color: board.categoryColor || null, boards: [], total: 0, done: 0 };
				catMap.set(key, group);
				groups.push(group);
			}
			group.boards.push(board);
			group.total += board.totalCards;
			group.done += board.completedCards;
		}

		// Sort: categorised groups alphabetically first, uncategorised last
		groups.sort((a, b) => {
			if (a.name === 'Uncategorised') return 1;
			if (b.name === 'Uncategorised') return -1;
			return a.name.localeCompare(b.name);
		});

		// Sort boards within each group
		const dir = sortDir === 'asc' ? 1 : -1;
		for (const group of groups) {
			group.boards.sort((a, b) => {
				switch (sortBy) {
					case 'name':
						return dir * a.name.localeCompare(b.name);
					case 'activity': {
						const aTime = new Date(a.lastActivity || '').getTime() || 0;
						const bTime = new Date(b.lastActivity || '').getTime() || 0;
						return dir * (aTime - bTime);
					}
					case 'cards':
						return dir * (a.totalCards - b.totalCards);
					case 'progress': {
						const aPct = a.totalCards > 0 ? a.completedCards / a.totalCards : 0;
						const bPct = b.totalCards > 0 ? b.completedCards / b.totalCards : 0;
						return dir * (aPct - bPct);
					}
					default:
						return 0;
				}
			});
		}

		return groups;
	});

	function timeAgo(dateStr: string | null | undefined): string {
		if (!dateStr) return 'unknown';
		const dateObj = new Date(dateStr.endsWith('Z') ? dateStr : dateStr + 'Z');
		if (isNaN(dateObj.getTime())) return 'unknown';
		const diff = Math.floor((Date.now() - dateObj.getTime()) / 1000);
		if (diff < 60) return 'just now';
		if (diff < 3600) return `${Math.floor(diff / 60)}m ago`;
		if (diff < 86400) return `${Math.floor(diff / 3600)}h ago`;
		return `${Math.floor(diff / 86400)}d ago`;
	}

	// ─── Board Context Menu ─────────────────────────────────────────────────
	let boardCtx = $state<{ show: boolean; x: number; y: number; boardId: number; boardName: string }>(
		{ show: false, x: 0, y: 0, boardId: 0, boardName: '' }
	);
	let showCatPicker = $state(false);
	let newBoardCatName = $state('');
	let newBoardCatColor = $state('#6366f1');
	let showNewBoardCat = $state(false);

	function openBoardContextMenu(e: MouseEvent, boardId: number, boardName: string) {
		e.preventDefault();
		e.stopPropagation();
		boardCtx = { show: true, x: e.clientX, y: e.clientY, boardId, boardName };
		showCatPicker = false;
		showNewBoardCat = false;
	}

	function closeBoardContextMenu() {
		boardCtx.show = false;
		showCatPicker = false;
		showNewBoardCat = false;
	}

	async function setBoardCategory(boardId: number, categoryId: number | null) {
		await fetch(`/api/boards/${boardId}`, {
			method: 'PUT',
			headers: { 'Content-Type': 'application/json' },
			body: JSON.stringify({ categoryId })
		});
		closeBoardContextMenu();
		await invalidateAll();
	}

	async function createBoardCategoryInline() {
		if (!newBoardCatName.trim()) return;
		const res = await fetch('/api/board-categories', {
			method: 'POST',
			headers: { 'Content-Type': 'application/json' },
			body: JSON.stringify({ name: newBoardCatName.trim(), color: newBoardCatColor })
		});
		if (res.ok) {
			const created = await res.json();
			// Auto-expand the new category group
			const next = new Set(collapsedCategories);
			next.delete(created.name);
			collapsedCategories = next;
			await setBoardCategory(boardCtx.boardId, created.id);
			newBoardCatName = '';
			newBoardCatColor = '#6366f1';
			showNewBoardCat = false;
		}
	}

	// Removed onMount category expanding since we default to not collapsed

	function toggleCategory(catName: string) {
		const next = new Set(collapsedCategories);
		if (next.has(catName)) next.delete(catName);
		else next.add(catName);
		collapsedCategories = next;
	}

	function getCircumference(radius: number) {
		return 2 * Math.PI * radius;
	}

	// Computed analytics helpers
	let maxTrend = $derived(Math.max(1, ...a.weeklyTrend.map((w: any) => w.count)));
	let totalCatCards = $derived(a.categoryDistribution.reduce((s: number, c: any) => s + c.count, 0));
	let agingTotal = $derived(a.agingBuckets.fresh + a.agingBuckets.week + a.agingBuckets.fortnight + a.agingBuckets.month + a.agingBuckets.stale);
	let agingItems = $derived([
		{ label: '< 3d', count: a.agingBuckets.fresh, color: 'var(--priority-low)' },
		{ label: '3-7d', count: a.agingBuckets.week, color: 'var(--accent-emerald)' },
		{ label: '1-2w', count: a.agingBuckets.fortnight, color: 'var(--priority-medium)' },
		{ label: '2-4w', count: a.agingBuckets.month, color: 'var(--priority-high)' },
		{ label: '> 1m', count: a.agingBuckets.stale, color: 'var(--priority-critical)' }
	]);

	function daysUntilDue(dateStr: string): number {
		return Math.ceil((new Date(dateStr).getTime() - Date.now()) / 86400000);
	}

	function dueLabel(dateStr: string): string {
		const d = daysUntilDue(dateStr);
		if (d <= 0) return 'Today';
		if (d === 1) return 'Tomorrow';
		return `${d} days`;
	}
</script>

<svelte:head>
	<title>DumpFire — Your Boards</title>
</svelte:head>

<svelte:window onclick={() => { showMoreMenu = false; }} />

<div class="dashboard">
	<header class="dashboard-header">
		<div class="brand">
			<span class="brand-icon">🔥</span>
			<div>
				<h1>DumpFire</h1>
				<p class="brand-tagline"><span class="typewriter-text">{typedText}</span><span class="typewriter-cursor">|</span></p>
			</div>
		</div>
		<nav class="header-nav">
			<a href="/all" class="nav-pill">
				<svg width="16" height="16" viewBox="0 0 16 16" fill="none"><path d="M2 4h12M2 8h12M2 12h8" stroke="currentColor" stroke-width="1.5" stroke-linecap="round"/></svg>
				All Tasks
			</a>
			<a href="/inbox" class="nav-pill">
				<svg width="16" height="16" viewBox="0 0 16 16" fill="none">
					<path d="M2 4l6 5 6-5" stroke="currentColor" stroke-width="1.2" stroke-linecap="round" stroke-linejoin="round"/>
					<rect x="1.5" y="3" width="13" height="10" rx="1.5" stroke="currentColor" stroke-width="1.2"/>
				</svg>
				Inbox
				{#if inboxCount > 0}
					<span class="inbox-count-badge">{inboxCount}</span>
				{/if}
			</a>
			<a href="/reports" class="nav-pill" id="reports-link">
				<svg width="16" height="16" viewBox="0 0 16 16" fill="none">
					<rect x="2" y="3" width="3" height="10" rx="0.5" stroke="currentColor" stroke-width="1.2"/>
					<rect x="6.5" y="6" width="3" height="7" rx="0.5" stroke="currentColor" stroke-width="1.2"/>
					<rect x="11" y="1" width="3" height="12" rx="0.5" stroke="currentColor" stroke-width="1.2"/>
				</svg>
				Reports
			</a>
			<!-- More dropdown -->
			<div class="nav-more-wrapper">
				<button class="nav-pill nav-more-btn" onclick={(e) => { e.stopPropagation(); showMoreMenu = !showMoreMenu; }} id="nav-more-btn">
					<svg width="16" height="16" viewBox="0 0 16 16" fill="none"><circle cx="4" cy="8" r="1.2" fill="currentColor"/><circle cx="8" cy="8" r="1.2" fill="currentColor"/><circle cx="12" cy="8" r="1.2" fill="currentColor"/></svg>
					More
				</button>
				{#if showMoreMenu}
				<div class="nav-more-menu" onclick={(e) => e.stopPropagation()}>
					<a href="/teams" class="nav-more-item" onclick={() => showMoreMenu = false}>
						<svg width="16" height="16" viewBox="0 0 16 16" fill="none">
							<path d="M5.5 8a2.5 2.5 0 100-5 2.5 2.5 0 000 5zM1.5 14v-1a3.5 3.5 0 013.5-3.5h1" stroke="currentColor" stroke-width="1.2" stroke-linecap="round" stroke-linejoin="round"/>
							<path d="M10.5 8a2.5 2.5 0 100-5 2.5 2.5 0 000 5zM14.5 14v-1a3.5 3.5 0 00-2.5-3.37" stroke="currentColor" stroke-width="1.2" stroke-linecap="round" stroke-linejoin="round"/>
						</svg>
						Teams
					</a>
					{#if isAdmin}
					<a href="/admin" class="nav-more-item" onclick={() => showMoreMenu = false}>
						<svg width="16" height="16" viewBox="0 0 16 16" fill="none">
							<path d="M8 1l1.1 2.2 2.4.35-1.75 1.7.4 2.4L8 6.6l-2.15 1.05.4-2.4-1.75-1.7 2.4-.35L8 1z" stroke="currentColor" stroke-width="1.2" stroke-linecap="round" stroke-linejoin="round"/>
							<path d="M3.5 9.5v3a1 1 0 001 1h7a1 1 0 001-1v-3" stroke="currentColor" stroke-width="1.2" stroke-linecap="round"/>
						</svg>
						Admin
					</a>
					{/if}
					<a href="/request" class="nav-more-item" onclick={() => showMoreMenu = false}>
						<svg width="16" height="16" viewBox="0 0 16 16" fill="none">
							<path d="M4 2h8a1 1 0 011 1v10a1 1 0 01-1 1H4a1 1 0 01-1-1V3a1 1 0 011-1z" stroke="currentColor" stroke-width="1.2" stroke-linecap="round"/>
							<path d="M6 5h4M6 8h4M6 11h2" stroke="currentColor" stroke-width="1.2" stroke-linecap="round"/>
						</svg>
						Request
					</a>
					<a href="/docs" class="nav-more-item" onclick={() => showMoreMenu = false}>
						<svg width="16" height="16" viewBox="0 0 16 16" fill="none">
							<path d="M2.5 2h4l1.5 2H13.5a1 1 0 011 1v8a1 1 0 01-1 1h-11a1 1 0 01-1-1V3a1 1 0 011-1z" stroke="currentColor" stroke-width="1.2" stroke-linecap="round" stroke-linejoin="round"/>
							<path d="M6 8h4M6 10.5h2.5" stroke="currentColor" stroke-width="1.2" stroke-linecap="round"/>
						</svg>
						API Docs
					</a>
				</div>
				{/if}
			</div>
			<ThemePicker />
			<button class="btn-primary create-btn" onclick={() => (showCreate = true)} id="create-board-btn">
				<svg width="14" height="14" viewBox="0 0 14 14" fill="none">
					<path d="M7 2v10M2 7h10" stroke="currentColor" stroke-width="2" stroke-linecap="round" />
				</svg>
				New Board
			</button>
		</nav>
	</header>

	<!-- ─── Analytics Section ────────────────────────────────────────────── -->
	<div class="dashboard-grid">
		<div class="main-column stagger-children">
			<!-- ─── Boards List ─────────────────────────────────────────────── -->
			<section class="boards-section">
				<div class="section-header">
					<div class="header-titles">
						<h2>Your Boards</h2>
						<span class="section-count">{a.totalBoards} boards · {a.totalSubBoards} sub-boards</span>
					</div>
					<div class="header-actions">
						<button class="toggle-completed-btn" title="Manage Categories" onclick={() => showCategoryManager = true}>
							🏷️ Manage Categories
						</button>
						<button class="toggle-completed-btn" class:active={showCompletedBoards} onclick={() => showCompletedBoards = !showCompletedBoards}>
							{showCompletedBoards ? '✅ Showing done boards' : '👁️ Show done boards'}
						</button>
						<button class="toggle-completed-btn" class:active={showCompletedSubs} onclick={() => showCompletedSubs = !showCompletedSubs}>
							{showCompletedSubs ? '✅ Showing done subs' : '👁️ Show done subs'}
						</button>
					</div>
				</div>

				{#if data.boards.length > 0}
					<!-- Column headers -->
					<div class="board-col-header">
						<span class="bch-spacer"></span>
						<button class="bch-name bch-sort" class:active={sortBy === 'name'} onclick={() => toggleSort('name')}>Name{sortArrow('name')}</button>
						<button class="bch-activity bch-sort" class:active={sortBy === 'activity'} onclick={() => toggleSort('activity')}>Activity{sortArrow('activity')}</button>
						<button class="bch-cards bch-sort" class:active={sortBy === 'cards'} onclick={() => toggleSort('cards')}>Cards{sortArrow('cards')}</button>
						<button class="bch-progress bch-sort" class:active={sortBy === 'progress'} onclick={() => toggleSort('progress')}>Progress{sortArrow('progress')}</button>
						<span class="bch-actions"></span>
					</div>

					<!-- All Tasks row -->
					<a href="/all" class="board-row board-row-all" id="all-tasks">
						<span class="expand-toggle placeholder"></span>
						<span class="board-row-emoji glass">🌐</span>
						<span class="board-row-name">All Tasks</span>
						<span class="board-row-activity"></span>
						<span class="board-row-count">{totalCards} cards</span>
						<div class="board-row-progress">
							{#if totalCards > 0}
								<div class="progress-track"><div class="progress-fill fill-all" style="width: {(completedCards / totalCards) * 100}%"></div></div>
								<span class="progress-pct">{Math.round((completedCards / totalCards) * 100)}%</span>
							{/if}
						</div>
						<div class="board-row-actions"></div>
					</a>

					<!-- Favourites Section -->
					{#if favouriteBoards.length > 0}
						<div class="category-group favourites-group">
							<div class="category-group-header fav-header">
								<span class="fav-star">⭐</span>
								<span class="category-group-name fav-name">Favourites</span>
								<span class="category-group-count">{favouriteBoards.length}</span>
							</div>
							<div class="cat-boards-wrapper animate-slide-up">
								{#each favouriteBoards as board (board.id)}
									<a href="/board/{board.id}" class="board-row fav-row">
										<span class="expand-toggle placeholder"></span>
										<span class="board-row-emoji glass">{board.emoji}</span>
										<span class="board-row-name">{board.name}</span>
										<span class="board-row-activity">{timeAgo(board.lastActivity)}</span>
										<span class="board-row-count">{board.totalCards} card{board.totalCards !== 1 ? 's' : ''}</span>
										<div class="board-row-progress">
											{#if board.totalCards > 0}
												{@const pct = Math.round((board.completedCards / board.totalCards) * 100)}
												<div class="progress-track"><div class="progress-fill" class:complete={pct === 100} style="width: {pct}%"></div></div>
												<span class="progress-pct" class:complete={pct === 100}>{pct}%</span>
											{:else}
												<span class="progress-pct empty">—</span>
											{/if}
										</div>
										<div class="board-row-actions">
											<button class="row-fav-btn favourited" title="Remove from favourites" onclick={(e) => toggleFavourite(board.id, e)}>⭐</button>
										</div>
									</a>
								{/each}
							</div>
						</div>
					{/if}

					{#each boardGroups as group}
						<!-- Category group header -->
						<div class="category-group">
							<button class="category-group-header" onclick={() => toggleCategory(group.name)}>
								<span class="cat-expand-icon" class:rotated={!collapsedCategories.has(group.name)}>
									<svg width="12" height="12" viewBox="0 0 12 12" fill="none"><path d="M4 2l4 4-4 4" stroke="currentColor" stroke-width="1.5" stroke-linecap="round" stroke-linejoin="round"/></svg>
								</span>
								{#if group.color}
									<span class="category-dot" style="background: {group.color}"></span>
								{/if}
								<span class="category-group-name" style={group.color ? `color: ${group.color}` : ''}>{group.name}</span>
								<span class="category-group-count">{group.boards.length} board{group.boards.length !== 1 ? 's' : ''}</span>
								<div class="group-mini-progress">
									<div class="progress-track"><div class="progress-fill" style="background: {group.color || 'var(--text-tertiary)'}; width: {group.total > 0 ? (group.done / group.total) * 100 : 0}%"></div></div>
								</div>
							</button>

							{#if !collapsedCategories.has(group.name)}
								<div class="cat-boards-wrapper animate-slide-up">
									{#each group.boards as board (board.id)}
										<div class="board-row-group">
											<!-- svelte-ignore a11y_no_static_element_interactions -->
											<div class="board-row" style={group.color ? `border-left-color: ${group.color}` : ''} oncontextmenu={(e) => openBoardContextMenu(e, board.id, board.name)}>
												<div class="board-color-strip" style={group.color ? `background: ${group.color}` : ''}></div>
												{#if board.subBoards && board.subBoards.length > 0}
													<button class="expand-toggle" onclick={() => toggleExpand(board.id)} title={expandedBoards.has(board.id) ? 'Collapse' : 'Expand'}>
														<svg width="12" height="12" viewBox="0 0 12 12" fill="none" class:rotated={expandedBoards.has(board.id)}>
															<path d="M4 2l4 4-4 4" stroke="currentColor" stroke-width="1.5" stroke-linecap="round" stroke-linejoin="round"/>
														</svg>
													</button>
												{:else}
													<span class="expand-toggle placeholder"></span>
												{/if}
												<a href="/board/{board.id}" class="board-row-link">
													<span class="board-row-emoji glass">{board.emoji}</span>
													<span class="board-row-name">{board.name}</span>
												</a>
												<span class="board-row-activity">{timeAgo(board.lastActivity)}</span>
												<span class="board-row-count">{board.totalCards} card{board.totalCards !== 1 ? 's' : ''}</span>
												<div class="board-row-progress">
													{#if board.totalCards > 0}
														{@const pct = Math.round((board.completedCards / board.totalCards) * 100)}
														<div class="progress-track"><div class="progress-fill" class:complete={pct === 100} style="width: {pct}%"></div></div>
														<span class="progress-pct" class:complete={pct === 100}>{pct}%</span>
													{:else}
														<span class="progress-pct empty">—</span>
													{/if}
												</div>
												<div class="board-row-actions">
									{#if board.subBoards && board.subBoards.length > 0}
										{@const activeSubs = board.subBoards.filter((s: any) => showCompletedSubs || !(s.total > 0 && s.done === s.total))}
										<span class="sub-count-badge" class:all-done={activeSubs.length === 0}>{activeSubs.length}/{board.subBoards.length} sub</span>
									{/if}
									<button class="row-fav-btn" class:favourited={favouriteBoardIds.has(board.id)} title={favouriteBoardIds.has(board.id) ? 'Remove from favourites' : 'Add to favourites'} onclick={(e) => toggleFavourite(board.id, e)}>
										{favouriteBoardIds.has(board.id) ? '⭐' : '☆'}
									</button>
									<button class="row-delete-btn" title="Delete board" onclick={(e) => { e.preventDefault(); e.stopPropagation(); confirmDeleteBoard(board.id, board.name); }} disabled={deleting === board.id}>
										{#if deleting === board.id}
											<span class="spinner"></span>
										{:else}
											<svg width="12" height="12" viewBox="0 0 14 14" fill="none"><path d="M2 4h10M5 4V2.5A.5.5 0 015.5 2h3a.5.5 0 01.5.5V4m1.5 0l-.5 8a1 1 0 01-1 1h-5a1 1 0 01-1-1l-.5-8" stroke="currentColor" stroke-width="1.2" stroke-linecap="round" stroke-linejoin="round"/></svg>
										{/if}
									</button>
								</div>
											</div>

											<!-- Sub-boards (expanded) -->
											{#if expandedBoards.has(board.id) && board.subBoards && board.subBoards.length > 0}
												{#each board.subBoards.filter((s) => showCompletedSubs || !(s.total > 0 && s.done === s.total)) as sb}
													<a href="/board/{sb.id}" class="board-row sub-row animate-fade-in" title="Parent: {sb.parentCardTitle}">
														<span class="sub-connector">└</span>
														<span class="board-row-emoji glass-sm">{sb.emoji}</span>
														<span class="board-row-name">{sb.name}</span>
														<span class="board-row-activity">{sb.parentCardTitle}</span>
														<span class="board-row-count">{sb.total} card{sb.total !== 1 ? 's' : ''}</span>
														<div class="board-row-progress">
															{#if sb.total > 0}
																{@const sbPct = Math.round((sb.done / sb.total) * 100)}
																<div class="progress-track"><div class="progress-fill" class:complete={sbPct === 100} style="width: {sbPct}%"></div></div>
																<span class="progress-pct" class:complete={sbPct === 100}>{sbPct}%</span>
															{:else}
																<span class="progress-pct empty">empty</span>
															{/if}
														</div>
														<div class="board-row-actions">
															<button class="row-delete-btn" title="Delete sub-board" onclick={(e) => { e.preventDefault(); e.stopPropagation(); confirmDeleteBoard(sb.id, sb.name); }}>
																<svg width="10" height="10" viewBox="0 0 10 10" fill="none"><path d="M2 2l6 6M8 2L2 8" stroke="currentColor" stroke-width="1.5" stroke-linecap="round"/></svg>
															</button>
														</div>
													</a>
												{/each}
											{/if}
										</div>
									{/each}
								</div>
							{/if}
						</div>
					{/each}
				{:else}
					<div class="empty-state glass">
						<span class="empty-icon">🗂️</span>
						<h3>No boards yet</h3>
						<p>Create your first board to get started</p>
						<button class="btn-primary mt-4" onclick={() => (showCreate = true)}>Create Board</button>
					</div>
				{/if}
			</section>
		</div>

		<!-- ─── Sidebar (Analytics) ──────────────────────────────────────── -->
		<div class="sidebar-column stagger-children">
			
			<!-- Primary Metrics -->
			<div class="metrics-grid">
				<div class="stat-card glass-glow">
					<div class="stat-header">
						<span class="stat-label">Active Tasks</span>
						{#if a.dueSoon > 0}
							<span class="stat-badge warn" title="Due in next 3 days">{a.dueSoon} due soon</span>
						{/if}
					</div>
					<div class="stat-value">{a.active}</div>
					<div class="stat-sub">{a.totalAssigned} assigned to {user?.username}</div>
				</div>

				<div class="stat-card glass-glow accent-green">
					<div class="stat-header">
						<span class="stat-label">Progress</span>
					</div>
					<div class="progress-donut">
						<div class="donut-text">
							<span class="donut-val">{a.completionRate}%</span>
						</div>
						<svg viewBox="0 0 36 36">
							<path class="ring-bg" d="M18 2.0845 a 15.9155 15.9155 0 0 1 0 31.831 a 15.9155 15.9155 0 0 1 0 -31.831" />
							<path class="ring-fill" stroke-dasharray="{a.completionRate}, 100" d="M18 2.0845 a 15.9155 15.9155 0 0 1 0 31.831 a 15.9155 15.9155 0 0 1 0 -31.831" />
						</svg>
					</div>
					<div class="stat-sub">{a.completed} completed</div>
				</div>

				<div class="stat-card glass-glow accent-cyan">
					<div class="stat-header">
						<span class="stat-label">Velocity</span>
						<div class="trend-arrow" class:up={a.completedThisWeek > 0}>
							{a.completedThisWeek > 0 ? '↑' : '—'}
						</div>
					</div>
					<div class="stat-value">{a.completedThisWeek}</div>
					<div class="stat-sub">done this week • {a.completedThisMonth} this month</div>
					
					<!-- CSS Sparkline -->
					<div class="sparkline">
						{#each a.weeklyActivity as dayObj}
							<!-- scale sparkline relative to max in week, or just raw if small -->
							{@const hPct = Math.max(10, Math.min(100, (dayObj.count / Math.max(1, ...a.weeklyActivity.map(w => w.count))) * 100))}
							<div class="spark-bar" style="height: {hPct}%" title="{dayObj.day}: {dayObj.count}"></div>
						{/each}
					</div>
				</div>

				<div class="stat-card glass-glow" class:accent-rose={a.overdue > 0 || a.pendingRequests > 0}>
					<div class="stat-header">
						<span class="stat-label">Attention</span>
					</div>
					<div class="stat-value {a.overdue > 0 ? 'pulse-text' : ''}">{a.overdue} <span class="text-sm">overdue</span></div>
					<div class="stat-sub">{a.pendingRequests} inbox pending</div>
				</div>
			</div>

			<!-- Priority breakdown -->
			{#if a.active > 0}
				<div class="sidebar-panel glass">
					<h3 class="panel-title">Priority Spread</h3>
					<div class="priority-bar">
						{#if a.priorityCounts.critical > 0}<div class="priority-seg seg-critical" style="flex: {a.priorityCounts.critical}" title="{a.priorityCounts.critical} critical"></div>{/if}
						{#if a.priorityCounts.high > 0}<div class="priority-seg seg-high" style="flex: {a.priorityCounts.high}" title="{a.priorityCounts.high} high"></div>{/if}
						{#if a.priorityCounts.medium > 0}<div class="priority-seg seg-medium" style="flex: {a.priorityCounts.medium}" title="{a.priorityCounts.medium} medium"></div>{/if}
						{#if a.priorityCounts.low > 0}<div class="priority-seg seg-low" style="flex: {a.priorityCounts.low}" title="{a.priorityCounts.low} low"></div>{/if}
					</div>
					<div class="priority-legend">
						{#if a.priorityCounts.critical > 0}<span class="legend-item"><span class="legend-dot dot-critical"></span> {a.priorityCounts.critical} Cri</span>{/if}
						{#if a.priorityCounts.high > 0}<span class="legend-item"><span class="legend-dot dot-high"></span> {a.priorityCounts.high} Hi</span>{/if}
						{#if a.priorityCounts.medium > 0}<span class="legend-item"><span class="legend-dot dot-medium"></span> {a.priorityCounts.medium} Med</span>{/if}
						{#if a.priorityCounts.low > 0}<span class="legend-item"><span class="legend-dot dot-low"></span> {a.priorityCounts.low} Low</span>{/if}
					</div>
				</div>
			{/if}

			<!-- Board Health -->
			{#if a.boardHealth.length > 0}
				<div class="sidebar-panel glass">
					<h3 class="panel-title">Board Health Overview</h3>
					<div class="health-list">
						{#each a.boardHealth as hb}
							<div class="health-item">
								<span class="hl-emoji">{hb.emoji}</span>
								<div class="hl-content">
									<div class="hl-header">
										<span class="hl-name">{hb.name}</span>
										<span class="hl-pct" class:hot={hb.pct === 100}>{hb.pct}%</span>
									</div>
									<div class="progress-track"><div class="progress-fill" class:complete={hb.pct === 100} style="width: {hb.pct}%"></div></div>
								</div>
							</div>
						{/each}
					</div>
				</div>
			{/if}

			<!-- 4-Week Completion Trend -->
			{#if a.weeklyTrend.some((w: any) => w.count > 0)}
				<div class="sidebar-panel glass">
					<h3 class="panel-title">4-Week Trend</h3>
					<div class="trend-chart">
						{#each a.weeklyTrend as week}
							<div class="trend-col">
								<div class="trend-bar-track">
									<div class="trend-bar-fill" style="height: {(week.count / maxTrend) * 100}%"></div>
								</div>
								<span class="trend-count">{week.count}</span>
								<span class="trend-label">{week.label}</span>
							</div>
						{/each}
					</div>
				</div>
			{/if}

			<!-- Category Distribution -->
			{#if a.categoryDistribution.length > 0 && totalCatCards > 0}
					<div class="sidebar-panel glass">
						<h3 class="panel-title">Category Distribution</h3>
						<div class="cat-dist-bar">
							{#each a.categoryDistribution as cat}
								{#if cat.count > 0}
									<div class="cat-dist-seg" style="flex: {cat.count}; background: {cat.color}" title="{cat.name}: {cat.count} cards"></div>
								{/if}
							{/each}
						</div>
						<div class="cat-dist-legend">
							{#each a.categoryDistribution as cat}
								{#if cat.count > 0}
									<span class="cat-dist-item">
										<span class="cat-dist-dot" style="background: {cat.color}"></span>
										<span class="cat-dist-name">{cat.name}</span>
										<span class="cat-dist-count">{cat.count}</span>
									</span>
								{/if}
							{/each}
						</div>
					</div>
			{/if}

			<!-- Task Aging -->
			{#if a.active > 0}
				<div class="sidebar-panel glass">
					<h3 class="panel-title">Task Aging</h3>
					<div class="aging-grid">
						{#each agingItems as item}
							<div class="aging-cell" class:aging-empty={item.count === 0}>
								<div class="aging-bar-wrap">
									<div class="aging-bar" style="height: {agingTotal > 0 ? (item.count / agingTotal) * 100 : 0}%; background: {item.color}"></div>
								</div>
								<span class="aging-count" style="color: {item.count > 0 ? item.color : 'var(--text-tertiary)'}">{item.count}</span>
								<span class="aging-label">{item.label}</span>
							</div>
						{/each}
					</div>
				</div>
			{/if}

			<!-- Team Leaderboard -->
			{#if a.teamLeaderboard.length > 0}
				<div class="sidebar-panel glass">
					<h3 class="panel-title">Team Leaderboard</h3>
					<div class="leaderboard-list">
						{#each a.teamLeaderboard as member, i}
							<div class="leader-row">
								<span class="leader-rank">{i === 0 ? '🥇' : i === 1 ? '🥈' : i === 2 ? '🥉' : `${i + 1}.`}</span>
								<span class="leader-emoji">{member.emoji}</span>
								<div class="leader-info">
									<span class="leader-name">{member.username}</span>
									<div class="leader-bar-wrap">
										<div class="leader-bar-track">
											{#if (member.completed + member.active) > 0}
												<div class="leader-bar-done" style="width: {(member.completed / (member.completed + member.active)) * 100}%"></div>
											{/if}
										</div>
									</div>
								</div>
								<div class="leader-stats">
									<span class="leader-done">{member.completed}✓</span>
									<span class="leader-active">{member.active}⚡</span>
								</div>
							</div>
						{/each}
					</div>
				</div>
			{/if}

			<!-- Upcoming Deadlines -->
			{#if a.upcomingDeadlines.length > 0}
				<div class="sidebar-panel glass">
					<h3 class="panel-title">Upcoming Deadlines</h3>
					<div class="deadlines-list">
						{#each a.upcomingDeadlines as dl}
							<div class="deadline-item" class:deadline-urgent={daysUntilDue(dl.dueDate) <= 1} class:deadline-soon={daysUntilDue(dl.dueDate) > 1 && daysUntilDue(dl.dueDate) <= 3}>
								<div class="deadline-priority">
									{dl.priority === 'critical' ? '🔴' : dl.priority === 'high' ? '🟠' : dl.priority === 'medium' ? '🟡' : '🟢'}
								</div>
								<div class="deadline-info">
									<span class="deadline-title">{dl.title}</span>
									<span class="deadline-when">{dueLabel(dl.dueDate)}</span>
								</div>
								<span class="deadline-date">{new Date(dl.dueDate).toLocaleDateString('en-GB', { day: 'numeric', month: 'short' })}</span>
							</div>
						{/each}
					</div>
				</div>
			{/if}

			<!-- Quick Stats Summary -->
			<div class="sidebar-panel glass quick-stats">
				<div class="qs-row">
					<span class="qs-label">On Hold</span>
					<span class="qs-value" class:qs-warn={a.onHoldCount > 0}>{a.onHoldCount}</span>
				</div>
				<div class="qs-row">
					<span class="qs-label">Due Soon (3d)</span>
					<span class="qs-value" class:qs-warn={a.dueSoon > 0}>{a.dueSoon}</span>
				</div>
				<div class="qs-row">
					<span class="qs-label">Monthly Rate</span>
					<span class="qs-value">{a.completedThisMonth}/mo</span>
				</div>
			</div>

			<!-- Recent Activity -->
			{#if a.recentActivity.length > 0}
				<div class="sidebar-panel glass activity-section">
					<h3 class="panel-title">Recent Activity</h3>
					<div class="activity-list">
						{#each a.recentActivity as entry}
							<div class="activity-item">
								<span class="activity-emoji">{entry.userEmoji}</span>
								<div class="activity-text">
									<span class="activity-detail">{entry.detail || entry.action}</span>
									<span class="activity-time">{timeAgo(entry.createdAt)}</span>
								</div>
							</div>
						{/each}
					</div>
				</div>
			{/if}
		</div>
	</div>

	<!-- Support modals -->
	{#if showCategoryManager}
		<CategoryManager categories={data.allCategories} onClose={() => showCategoryManager = false} />
	{/if}
</div>

<!-- Create board modal -->
{#if showCreate}
	<div class="modal-overlay" role="dialog" aria-modal="true">
		<!-- svelte-ignore a11y_click_events_have_key_events -->
		<div class="modal-content" onclick={(e) => e.stopPropagation()} role="document">
			<h2>Create New Board</h2>
			<div class="form-group">
				<label for="board-name">Board name</label>
				<input id="board-name" type="text" placeholder="e.g. Sprint 23, Side Project..." bind:value={newBoardName} onkeydown={(e) => e.key === 'Enter' && createBoard()} autofocus />
			</div>
			<div class="form-group">
				<label>Icon</label>
				<EmojiPicker value={newBoardEmoji} onSelect={(e) => (newBoardEmoji = e)} />
			</div>
			<div class="form-group">
				<label for="board-category">Category</label>
				<select id="board-category" bind:value={newBoardCategory} class="category-select">
					<option value={null}>None</option>
					{#each data.allCategories as cat}
						<option value={cat.id}>🏷 {cat.name}</option>
					{/each}
				</select>
			</div>
			<div class="modal-actions">
				<button class="btn-ghost" onclick={() => (showCreate = false)}>Cancel</button>
				<button class="btn-primary" onclick={createBoard} disabled={!newBoardName.trim()}>Create Board</button>
			</div>
		</div>
	</div>
{/if}

<!-- Board Context Menu -->
{#if boardCtx.show}
	<!-- svelte-ignore a11y_click_events_have_key_events -->
	<!-- svelte-ignore a11y_no_static_element_interactions -->
	<div class="ctx-overlay" onclick={closeBoardContextMenu}>
		<div class="ctx-menu" style="left: {boardCtx.x}px; top: {boardCtx.y}px" onclick={(e) => e.stopPropagation()}>
			<div class="ctx-header">{boardCtx.boardName}</div>
			<div class="ctx-divider"></div>

			{#if showCatPicker}
				<div class="ctx-cat-picker">
					<button class="ctx-item" onclick={() => setBoardCategory(boardCtx.boardId, null)}>
						<span class="ctx-icon">∅</span> No Category
					</button>
					{#each data.allCategories as cat}
						<button class="ctx-item" onclick={() => setBoardCategory(boardCtx.boardId, cat.id)}>
							<span class="ctx-dot" style="background: {cat.color}"></span> {cat.name}
						</button>
					{/each}
					<div class="ctx-divider"></div>
					{#if showNewBoardCat}
						<div class="ctx-new-cat">
							<input type="text" class="ctx-cat-input" placeholder="Category name..." bind:value={newBoardCatName} onkeydown={(e) => e.key === 'Enter' && createBoardCategoryInline()} autofocus />
							<div class="ctx-cat-colors">
								{#each COLUMN_COLORS.slice(0, 8) as color}
									<button class="ctx-color-swatch" class:active={newBoardCatColor === color} style="background: {color}" onclick={() => (newBoardCatColor = color)} type="button"></button>
								{/each}
								<label class="color-custom-wrapper">
									<input type="color" bind:value={newBoardCatColor} class="color-native-input" />
									<span class="ctx-color-swatch custom" style="background: {newBoardCatColor}">✎</span>
								</label>
							</div>
							<div class="ctx-cat-actions">
								<button class="btn-primary small" onclick={createBoardCategoryInline} disabled={!newBoardCatName.trim()}>Create</button>
								<button class="btn-ghost small" onclick={() => (showNewBoardCat = false)}>Cancel</button>
							</div>
						</div>
					{:else}
						<button class="ctx-item ctx-new" onclick={() => (showNewBoardCat = true)}>
							<span class="ctx-icon">+</span> New Category
						</button>
					{/if}
				</div>
			{:else}
				<button class="ctx-item" onclick={() => (showCatPicker = true)}>
					<span class="ctx-icon">🏷️</span> Set Category
				</button>
				<a href="/board/{boardCtx.boardId}" class="ctx-item">
					<span class="ctx-icon">📝</span> Open Board
				</a>
				<div class="ctx-divider"></div>
				<button class="ctx-item ctx-danger" onclick={() => { closeBoardContextMenu(); confirmDeleteBoard(boardCtx.boardId, boardCtx.boardName); }}>
					<span class="ctx-icon">🗑️</span> Delete Board
				</button>
			{/if}
		</div>
	</div>
{/if}

{#if confirmState.show}
	<ConfirmModal
		title="Delete Board"
		message={`Are you sure you want to delete "${confirmState.boardName}"? All columns, cards and subtasks will be permanently deleted.`}
		confirmText="Delete Board"
		onConfirm={() => deleteBoard(confirmState.boardId)}
		onCancel={() => (confirmState.show = false)}
	/>
{/if}

<style>
	.dashboard { max-width: 1400px; margin: 0 auto; padding: var(--space-xl) var(--space-xl); }

	/* ─── Grid Layout ────────────────────────────────────────────── */
	.dashboard-grid {
		display: grid; grid-template-columns: minmax(0, 1fr) 340px; gap: var(--space-xl);
		align-items: start;
	}
	.main-column { min-width: 0; }
	.sidebar-column { display: flex; flex-direction: column; gap: var(--space-lg); position: sticky; top: var(--space-xl); }

	/* ─── Header ─────────────────────────────────────────────────── */
	.dashboard-header {
		display: flex; align-items: center; justify-content: space-between;
		margin-bottom: var(--space-lg); padding-bottom: var(--space-md);
		border-bottom: 1px solid var(--glass-border);
	}
	.header-nav {
		display: flex; align-items: center; gap: 6px; flex-wrap: wrap;
	}
	.nav-pill {
		display: inline-flex; align-items: center; gap: 6px;
		padding: 6px 14px; border-radius: var(--radius-full);
		font-size: 0.78rem; font-weight: 600; font-family: var(--font-family);
		color: var(--text-secondary); text-decoration: none;
		background: var(--bg-surface); border: 1px solid var(--glass-border);
		cursor: pointer; transition: all var(--duration-fast) var(--ease-out);
		white-space: nowrap; position: relative;
	}
	.nav-pill:hover {
		color: var(--text-primary); border-color: var(--accent-indigo);
		background: rgba(99, 102, 241, 0.06); transform: translateY(-1px);
		box-shadow: 0 2px 8px rgba(99, 102, 241, 0.1);
	}
	.nav-pill svg { flex-shrink: 0; opacity: 0.7; }
	.nav-pill:hover svg { opacity: 1; }
	.nav-more-wrapper { position: relative; }
	.nav-more-menu {
		position: absolute;
		top: calc(100% + 6px);
		right: 0;
		min-width: 170px;
		background: var(--bg-surface);
		border: 1px solid var(--glass-border);
		border-radius: var(--radius-md);
		box-shadow: var(--shadow-lg);
		padding: 4px;
		z-index: 100;
		animation: navMenuSlideDown 0.15s ease-out;
	}
	@keyframes navMenuSlideDown {
		from { opacity: 0; transform: translateY(-6px); }
		to { opacity: 1; transform: translateY(0); }
	}
	.nav-more-item {
		display: flex;
		align-items: center;
		gap: 8px;
		padding: 8px 12px;
		border-radius: var(--radius-sm);
		font-size: 0.78rem;
		font-weight: 500;
		color: var(--text-secondary);
		text-decoration: none;
		transition: all var(--duration-fast) var(--ease-out);
	}
	.nav-more-item:hover {
		color: var(--text-primary);
		background: var(--glass-hover);
	}
	.nav-more-item svg { flex-shrink: 0; opacity: 0.65; }
	.nav-more-item:hover svg { opacity: 1; }
	.theme-pill { padding: 7px 10px; }
	.create-btn { border-radius: var(--radius-full); padding: 6px 16px; font-size: 0.78rem; }
	.inbox-count-badge {
		display: inline-flex; align-items: center; justify-content: center;
		min-width: 18px; height: 18px; padding: 0 5px;
		border-radius: var(--radius-full);
		background: var(--accent-rose); color: white;
		font-size: 0.65rem; font-weight: 800; line-height: 1;
	}
	.brand { display: flex; align-items: center; gap: var(--space-lg); flex-shrink: 0; }
	.brand > div { position: relative; }
	.brand-icon { font-size: 2.5rem; filter: drop-shadow(0 0 12px rgba(245, 158, 11, 0.4)); }
	.brand h1 {
		font-size: 1.75rem;
		background: linear-gradient(135deg, var(--text-primary), var(--accent-purple));
		-webkit-background-clip: text; -webkit-text-fill-color: transparent; background-clip: text;
	}
	.brand-tagline {
		color: var(--text-secondary); font-size: 0.85rem; font-weight: 400;
		position: absolute; left: 0; top: 100%; white-space: nowrap;
	}
	.typewriter-cursor {
		display: inline-block; margin-left: 1px;
		color: var(--accent-indigo); font-weight: 300;
		animation: blink-cursor 0.75s step-end infinite;
	}
	@keyframes blink-cursor { 0%, 100% { opacity: 1; } 50% { opacity: 0; } }

	/* ─── Sidebar Metrics ────────────────────────────────────────── */
	.metrics-grid {
		display: grid; grid-template-columns: 1fr 1fr; gap: var(--space-sm);
	}
	.stat-card {
		position: relative; overflow: hidden;
		background: var(--bg-card); border: 1px solid var(--glass-border);
		border-radius: var(--radius-lg); padding: var(--space-md);
		transition: all var(--duration-fast) var(--ease-out);
		display: flex; flex-direction: column; min-height: 100px;
	}
	.glass-glow:hover { box-shadow: 0 8px 30px rgba(99, 102, 241, 0.08); border-color: rgba(99, 102, 241, 0.2); transform: translateY(-2px); }
	
	.stat-header { display: flex; align-items: flex-start; justify-content: space-between; margin-bottom: auto; }
	.stat-label { font-size: 0.68rem; font-weight: 700; color: var(--text-tertiary); text-transform: uppercase; letter-spacing: 0.05em; }
	.stat-badge.warn { background: rgba(245, 158, 11, 0.15); color: #d97706; padding: 2px 6px; border-radius: var(--radius-sm); font-size: 0.6rem; font-weight: 700; white-space: nowrap; }
	
	.stat-value {
		font-size: 1.8rem; font-weight: 800; color: var(--text-primary);
		line-height: 1.1; margin-top: 8px; letter-spacing: -0.03em;
	}
	.text-sm { font-size: 0.8rem; font-weight: 600; opacity: 0.5; }
	.stat-sub { font-size: 0.65rem; color: var(--text-secondary); margin-top: 4px; font-weight: 500; }

	/* Accents */
	.accent-green { border-top-color: rgba(34, 197, 94, 0.5); }
	.accent-green .stat-label { color: #22c55e; }
	.accent-cyan { border-top-color: rgba(6, 182, 212, 0.5); }
	.accent-cyan .stat-label { color: #06b6d4; }
	.accent-rose { border-top-color: rgba(244, 63, 94, 0.5); border-left-color: rgba(244, 63, 94, 0.5); }
	.accent-rose .stat-value { color: var(--accent-rose); }
	.pulse-text { animation: pulse-red 2s infinite; }
	@keyframes pulse-red { 0%, 100% { opacity: 1; } 50% { opacity: 0.6; } }

	/* Donut Progress */
	.progress-donut {
		position: relative; width: 44px; height: 44px; align-self: flex-end; margin-top: -10px; margin-bottom: 2px;
	}
	.progress-donut svg { width: 100%; height: 100%; transform: rotate(-90deg); }
	.donut-text {
		position: absolute; inset: 0; display: flex; align-items: center; justify-content: center;
	}
	.donut-val { font-size: 0.65rem; font-weight: 800; color: #22c55e; }
	.ring-bg { fill: none; stroke: var(--glass-bg); stroke-width: 4; }
	.ring-fill { fill: none; stroke: #22c55e; stroke-width: 4; stroke-linecap: round; transition: stroke-dasharray 1s cubic-bezier(0.4, 0, 0.2, 1); }

	/* Trend & Sparkline */
	.trend-arrow { font-size: 0.8rem; font-weight: 800; color: var(--text-tertiary); }
	.trend-arrow.up { color: #06b6d4; }
	.sparkline {
		position: absolute; bottom: 0; left: 0; right: 0; height: 30px;
		display: flex; align-items: flex-end; gap: 2px; padding: 0 var(--space-md); opacity: 0.3;
	}
	.spark-bar {
		flex: 1; background: #06b6d4; border-radius: 2px 2px 0 0;
		min-height: 2px; transition: height 0.5s ease-out;
	}

	/* Sidebar Panels */
	.sidebar-panel {
		background: var(--bg-card); border: 1px solid var(--glass-border);
		border-radius: var(--radius-lg); padding: var(--space-md);
	}
	.panel-title { font-size: 0.72rem; font-weight: 700; color: var(--text-primary); text-transform: uppercase; letter-spacing: 0.05em; margin-bottom: var(--space-sm); border-bottom: 1px solid var(--glass-border); padding-bottom: 6px; }

	/* Priority Bar */
	.priority-bar { display: flex; height: 6px; border-radius: 3px; overflow: hidden; gap: 1px; margin-bottom: 8px; }
	.priority-seg { transition: flex 0.5s cubic-bezier(0.4, 0, 0.2, 1); }
	.seg-critical { background: #ef4444; } .seg-high { background: #f97316; } .seg-medium { background: #eab308; } .seg-low { background: #22c55e; }
	.priority-legend { display: flex; gap: 8px; flex-wrap: wrap; }
	.legend-item { display: flex; align-items: center; gap: 4px; font-size: 0.6rem; color: var(--text-secondary); font-weight: 600; }
	.legend-dot { width: 6px; height: 6px; border-radius: 50%; }

	/* Health List */
	.health-list { display: flex; flex-direction: column; gap: 8px; }
	.health-item { display: flex; align-items: center; gap: 8px; }
	.hl-emoji { font-size: 1rem; flex-shrink: 0; }
	.hl-content { flex: 1; min-width: 0; }
	.hl-header { display: flex; justify-content: space-between; margin-bottom: 3px; font-size: 0.68rem; font-weight: 600; color: var(--text-secondary); }
	.hl-name { white-space: nowrap; overflow: hidden; text-overflow: ellipsis; }
	.hl-pct { font-weight: 800; color: var(--text-primary); }
	.hl-pct.hot { color: #22c55e; }

	/* ─── Category Groups ────────────────────────────────────────── */
	.category-group {
		margin-bottom: var(--space-xs);
	}
	.category-group-header {
		display: flex; align-items: center; gap: var(--space-sm);
		padding: var(--space-sm) var(--space-md);
		margin-top: var(--space-md);
	}
	.cat-expand-icon svg { transition: transform 0.2s; }
	.cat-expand-icon.rotated svg { transform: rotate(90deg); }
	.category-dot {
		width: 10px; height: 10px; border-radius: 50%; flex-shrink: 0;
	}
	.category-group-name {
		font-size: 0.78rem; font-weight: 700; text-transform: uppercase;
		letter-spacing: 0.05em; color: var(--text-secondary);
	}
	.category-group-count {
		font-size: 0.65rem; font-weight: 500; color: var(--text-tertiary);
		margin-left: auto;
	}
	.category-select {
		width: 100%; padding: var(--space-sm) var(--space-md);
		background: var(--bg-surface); border: 1px solid var(--glass-border);
		border-radius: var(--radius-md); color: var(--text-primary);
		font-family: var(--font-family); font-size: 0.85rem;
	}
	.category-select:focus { outline: none; border-color: var(--accent-indigo); }

	/* ─── Boards List ────────────────────────────────────────────── */
	.boards-section { margin-bottom: var(--space-2xl); }
	.section-header {
		display: flex; align-items: center; justify-content: space-between;
		margin-bottom: var(--space-md);
	}
	.header-titles h2 { font-size: 1.25rem; font-weight: 800; color: var(--text-primary); letter-spacing: -0.02em; margin: 0 0 2px 0; }
	.section-count { font-size: 0.7rem; color: var(--text-tertiary); font-weight: 600; text-transform: uppercase; letter-spacing: 0.05em; }

	.header-actions { display: flex; align-items: center; gap: 8px; }
	
	.icon-action-btn {
		width: 32px; height: 32px; border-radius: var(--radius-md);
		background: var(--bg-surface); border: 1px solid var(--glass-border);
		color: var(--text-secondary); display: flex; align-items: center; justify-content: center;
		cursor: pointer; transition: all var(--duration-fast);
	}
	.icon-action-btn:hover { background: rgba(99, 102, 241, 0.1); border-color: rgba(99, 102, 241, 0.3); color: var(--accent-indigo); transform: translateY(-1px); }

	.toggle-completed-btn {
		padding: 6px 12px; height: 32px;
		font-size: 0.72rem; font-weight: 600; font-family: var(--font-family);
		background: var(--bg-surface); border: 1px solid var(--glass-border);
		border-radius: var(--radius-md); color: var(--text-secondary); cursor: pointer;
		transition: all var(--duration-fast) var(--ease-out);
	}
	.toggle-completed-btn:hover { border-color: var(--accent-indigo); color: var(--text-primary); }
	.toggle-completed-btn.active { background: rgba(99, 102, 241, 0.1); border-color: rgba(99, 102, 241, 0.3); color: var(--accent-indigo); box-shadow: inset 0 1px 3px rgba(0,0,0,0.05); }


	.board-row {
		display: flex; align-items: center; gap: var(--space-sm);
		padding: 10px var(--space-md);
		border: 1px solid var(--glass-border);
		border-bottom: none;
		background: var(--bg-card);
		transition: all var(--duration-fast) var(--ease-out);
		text-decoration: none; color: inherit;
		position: relative; overflow: hidden;
	}
	.board-color-strip {
		position: absolute; left: 0; top: 0; bottom: 0; width: 3px;
	}
	.board-row:first-child, .board-row-all { border-radius: var(--radius-md) var(--radius-md) 0 0; }
	.board-row-group:last-child .board-row:last-child,
	.board-row-group:last-child .sub-row:last-child { border-bottom: 1px solid var(--glass-border); border-radius: 0 0 var(--radius-md) var(--radius-md); }
	.board-row:hover { background: rgba(99, 102, 241, 0.04); }

	.board-row-all {
		border-bottom: 1px solid var(--glass-border);
		background: var(--bg-card);
		border-radius: var(--radius-md);
		margin-bottom: var(--space-xs);
	}
	.board-row-all:hover { background: rgba(99, 102, 241, 0.04); }

	/* Column header */
	.board-col-header {
		display: flex; align-items: center; gap: var(--space-sm);
		padding: 6px var(--space-md); margin-bottom: 2px;
	}
	.board-col-header span, .board-col-header button {
		font-size: 0.6rem; font-weight: 700; text-transform: uppercase;
		letter-spacing: 0.06em; color: var(--text-tertiary);
	}
	.bch-sort {
		background: none; border: none; cursor: pointer; padding: 2px 0;
		font-family: var(--font-family); transition: color 0.15s; text-align: left;
	}
	.bch-sort:hover { color: var(--text-primary); }
	.bch-sort.active { color: var(--accent-indigo); }
	.bch-spacer { width: 20px; flex-shrink: 0; }
	.bch-name { flex: 1; min-width: 0; }
	.bch-activity { width: 80px; text-align: right; }
	.bch-cards { width: 60px; text-align: right; }
	.bch-progress { width: 100px; text-align: right; }
	.bch-actions { width: 80px; }

	.board-row-link {
		display: flex; align-items: center; gap: var(--space-sm);
		flex: 1; min-width: 0; text-decoration: none; color: inherit;
	}
	.board-row-emoji { font-size: 1.15rem; flex-shrink: 0; }
	.board-row-name {
		font-size: 0.88rem; font-weight: 600; color: var(--text-primary);
		white-space: nowrap; overflow: hidden; text-overflow: ellipsis;
		flex: 1; min-width: 0;
	}
	.board-row-activity { width: 80px; font-size: 0.7rem; color: var(--text-tertiary); font-weight: 500; white-space: nowrap; text-align: right; flex-shrink: 0; overflow: hidden; text-overflow: ellipsis; }
	.board-row-count { width: 60px; font-size: 0.72rem; color: var(--text-tertiary); font-weight: 500; white-space: nowrap; text-align: right; flex-shrink: 0; }
	.board-row-progress {
		width: 100px; flex-shrink: 0; display: flex; align-items: center; gap: 6px;
	}
	.progress-track { flex: 1; height: 5px; background: var(--glass-bg); border-radius: 3px; overflow: hidden; }
	.progress-fill { height: 100%; background: var(--accent-indigo); border-radius: 3px; transition: width 0.3s; }
	.fill-all { background: linear-gradient(90deg, #6366f1, #a855f7); }
	.progress-pct { font-size: 0.65rem; font-weight: 700; color: var(--accent-indigo); min-width: 28px; text-align: right; }
	.progress-pct.empty { color: var(--text-tertiary); }
	.progress-pct.complete { color: #22c55e; }

	.sub-count-badge {
		font-size: 0.6rem; font-weight: 700; padding: 1px 6px;
		border-radius: var(--radius-full);
		background: rgba(99, 102, 241, 0.1); color: #818cf8;
		white-space: nowrap;
	}

	.expand-toggle {
		width: 20px; height: 20px; flex-shrink: 0;
		display: flex; align-items: center; justify-content: center;
		background: transparent; border: none; color: var(--text-tertiary);
		cursor: pointer; border-radius: var(--radius-sm);
		transition: all 0.15s;
	}
	.expand-toggle:hover { background: var(--bg-surface); color: var(--text-primary); }
	.expand-toggle.placeholder { visibility: hidden; }
	.expand-toggle svg { transition: transform 0.2s; }
	.expand-toggle svg.rotated { transform: rotate(90deg); }

	.row-delete-btn {
		width: 24px; height: 24px; flex-shrink: 0;
		display: flex; align-items: center; justify-content: center;
		border-radius: var(--radius-sm); background: transparent;
		border: none; color: var(--text-tertiary);
		opacity: 0; cursor: pointer; transition: all 0.15s;
	}
	.board-row:hover .row-delete-btn { opacity: 0.6; }
	.row-delete-btn:hover { opacity: 1 !important; background: rgba(244, 63, 94, 0.15); color: var(--accent-rose); }

	/* Sub-board rows */
	.sub-row {
		padding-left: calc(var(--space-md) + 24px);
		background: var(--bg-surface);
	}
	.sub-row:hover { background: rgba(99, 102, 241, 0.04); }
	.sub-connector {
		font-size: 0.7rem; color: var(--text-tertiary); font-weight: 400;
		width: 14px; flex-shrink: 0; text-align: center;
	}
	.board-row-action { width: 80px; flex-shrink: 0; }
	.board-row-actions { width: 80px; flex-shrink: 0; display: flex; align-items: center; gap: 4px; justify-content: flex-end; margin-left: var(--space-sm); }

	/* ─── Activity ────────────────────────────────────────────────── */
	.activity-section { margin-bottom: var(--space-2xl); }
	.activity-section h2 { font-size: 1.1rem; font-weight: 700; color: var(--text-primary); margin-bottom: var(--space-md); }
	.activity-list {
		display: flex; flex-direction: column;
		background: var(--bg-card); border: 1px solid var(--glass-border);
		border-radius: var(--radius-md); overflow: hidden;
	}
	.activity-item {
		display: flex; align-items: center; gap: var(--space-sm);
		padding: 8px var(--space-md);
		border-bottom: 1px solid var(--glass-border);
		font-size: 0.78rem;
	}
	.activity-item:last-child { border-bottom: none; }
	.activity-emoji { flex-shrink: 0; }
	.activity-detail { flex: 1; color: var(--text-secondary); min-width: 0; overflow: hidden; text-overflow: ellipsis; white-space: nowrap; }
	.activity-time { font-size: 0.65rem; color: var(--text-tertiary); white-space: nowrap; }

	/* ─── Misc ────────────────────────────────────────────────────── */
	.empty-state { text-align: center; padding: var(--space-3xl); color: var(--text-secondary); }
	.empty-icon { font-size: 3rem; display: block; margin-bottom: var(--space-lg); }
	.empty-state h3 { margin-bottom: var(--space-sm); color: var(--text-primary); }

	.form-group { margin-top: var(--space-xl); }
	.form-group label {
		display: block; font-size: 0.8rem; font-weight: 600; color: var(--text-secondary);
		text-transform: uppercase; letter-spacing: 0.05em; margin-bottom: var(--space-sm);
	}
	.modal-actions { display: flex; justify-content: flex-end; gap: var(--space-md); margin-top: var(--space-2xl); }

	.spinner {
		width: 12px; height: 12px;
		border: 2px solid var(--text-tertiary); border-top-color: transparent;
		border-radius: 50%; animation: spin 0.6s linear infinite;
	}
	@keyframes spin { to { transform: rotate(360deg); } }

	/* Responsive */
	@media (max-width: 1024px) {
		.dashboard-grid { grid-template-columns: 1fr; }
		.sidebar-column { position: static; }
		.metrics-grid { grid-template-columns: repeat(4, 1fr); }
	}
	@media (max-width: 768px) {
		.metrics-grid { grid-template-columns: repeat(2, 1fr); }
		.dashboard-header { flex-direction: column; gap: var(--space-md); align-items: flex-start; }
		.header-actions { flex-wrap: wrap; }
		.board-row-progress { display: none; }
	}

	/* ─── Board Context Menu ─────────────────────────────────────── */
	.ctx-overlay {
		position: fixed; inset: 0; z-index: 1000;
	}
	.ctx-menu {
		position: fixed; z-index: 1001;
		min-width: 200px; max-width: 280px;
		background: var(--bg-surface); border: 1px solid var(--glass-border);
		border-radius: var(--radius-lg); box-shadow: 0 8px 32px rgba(0,0,0,0.3);
		padding: var(--space-xs) 0; backdrop-filter: blur(20px);
	}
	.ctx-header {
		padding: var(--space-sm) var(--space-md);
		font-size: 0.72rem; font-weight: 700; color: var(--text-tertiary);
		text-transform: uppercase; letter-spacing: 0.04em;
		white-space: nowrap; overflow: hidden; text-overflow: ellipsis;
	}
	.ctx-divider { height: 1px; background: var(--glass-border); margin: var(--space-xs) 0; }
	.ctx-item {
		display: flex; align-items: center; gap: var(--space-sm);
		width: 100%; padding: var(--space-sm) var(--space-md);
		background: none; border: none; color: var(--text-primary);
		font: inherit; font-size: 0.82rem; cursor: pointer; text-decoration: none;
		transition: background var(--duration-fast) var(--ease-out);
	}
	.ctx-item:hover { background: var(--bg-base); }
	.ctx-danger { color: #ef4444 !important; }
	.ctx-danger:hover { background: rgba(239,68,68,0.1); }
	.ctx-new { color: var(--accent-indigo) !important; }
	.ctx-icon { width: 18px; text-align: center; flex-shrink: 0; }
	.ctx-dot {
		width: 10px; height: 10px; border-radius: 50%; flex-shrink: 0;
		display: inline-block;
	}
	.ctx-new-cat {
		padding: var(--space-sm) var(--space-md);
		display: flex; flex-direction: column; gap: var(--space-sm);
	}
	.ctx-cat-input {
		padding: var(--space-xs) var(--space-sm); font-size: 0.82rem;
		background: var(--bg-base); border: 1px solid var(--glass-border);
		border-radius: var(--radius-sm); color: var(--text-primary); font-family: var(--font-family);
	}
	.ctx-cat-input:focus { outline: none; border-color: var(--accent-indigo); }
	.ctx-cat-colors { display: flex; gap: 3px; flex-wrap: wrap; }
	.ctx-color-swatch {
		width: 16px; height: 16px; border-radius: 3px; border: 2px solid transparent;
		cursor: pointer; transition: transform var(--duration-fast) var(--ease-out);
	}
	.ctx-color-swatch:hover { transform: scale(1.2); }
	.ctx-color-swatch.active { border-color: var(--text-primary); }
	.ctx-color-swatch.custom {
		display: flex; align-items: center; justify-content: center;
		font-size: 0.5rem; color: white; text-shadow: 0 1px 2px rgba(0,0,0,0.5);
	}
	.ctx-cat-actions { display: flex; gap: var(--space-sm); }
	.ctx-cat-actions .small { padding: 2px var(--space-sm); font-size: 0.72rem; }
	.color-custom-wrapper { position: relative; cursor: pointer; display: inline-flex; }
	.color-native-input { position: absolute; width: 0; height: 0; opacity: 0; pointer-events: none; }

	/* ─── 4-Week Trend Chart ──────────────────────────────────── */
	.trend-chart {
		display: flex; gap: 4px; align-items: flex-end; height: 80px; padding-top: var(--space-sm);
	}
	.trend-col {
		flex: 1; display: flex; flex-direction: column; align-items: center; gap: 2px;
	}
	.trend-bar-track {
		width: 100%; height: 50px; display: flex; align-items: flex-end;
		background: var(--glass-bg); border-radius: 3px 3px 0 0; overflow: hidden;
	}
	.trend-bar-fill {
		width: 100%; border-radius: 3px 3px 0 0; min-height: 2px;
		background: linear-gradient(180deg, var(--accent-indigo), var(--accent-purple));
		transition: height 0.6s cubic-bezier(0.4, 0, 0.2, 1);
	}
	.trend-count { font-size: 0.7rem; font-weight: 800; color: var(--text-primary); }
	.trend-label { font-size: 0.55rem; color: var(--text-tertiary); font-weight: 600; white-space: nowrap; }

	/* ─── Category Distribution ──────────────────────────────── */
	.cat-dist-bar {
		display: flex; height: 8px; border-radius: 4px; overflow: hidden; gap: 1px; margin-bottom: var(--space-sm);
	}
	.cat-dist-seg { transition: flex 0.5s cubic-bezier(0.4, 0, 0.2, 1); min-width: 4px; }
	.cat-dist-legend { display: flex; flex-direction: column; gap: 4px; }
	.cat-dist-item {
		display: flex; align-items: center; gap: 6px; font-size: 0.65rem; font-weight: 500;
	}
	.cat-dist-dot { width: 8px; height: 8px; border-radius: 3px; flex-shrink: 0; }
	.cat-dist-name { color: var(--text-secondary); flex: 1; white-space: nowrap; overflow: hidden; text-overflow: ellipsis; }
	.cat-dist-count { font-weight: 700; color: var(--text-primary); min-width: 20px; text-align: right; }

	/* ─── Task Aging ─────────────────────────────────────────── */
	.aging-grid {
		display: flex; gap: 4px; align-items: flex-end; padding-top: var(--space-sm);
	}
	.aging-cell {
		flex: 1; display: flex; flex-direction: column; align-items: center; gap: 2px;
	}
	.aging-cell.aging-empty { opacity: 0.35; }
	.aging-bar-wrap {
		width: 100%; height: 40px; display: flex; align-items: flex-end;
		background: var(--glass-bg); border-radius: 3px 3px 0 0; overflow: hidden;
	}
	.aging-bar {
		width: 100%; min-height: 2px; border-radius: 3px 3px 0 0;
		transition: height 0.6s cubic-bezier(0.4, 0, 0.2, 1);
	}
	.aging-count { font-size: 0.72rem; font-weight: 800; }
	.aging-label { font-size: 0.55rem; color: var(--text-tertiary); font-weight: 600; }

	/* ─── Team Leaderboard ───────────────────────────────────── */
	.leaderboard-list { display: flex; flex-direction: column; gap: 8px; }
	.leader-row {
		display: flex; align-items: center; gap: 6px;
		padding: 4px 0; border-bottom: 1px solid var(--glass-border);
	}
	.leader-row:last-child { border-bottom: none; }
	.leader-rank { font-size: 0.8rem; min-width: 20px; text-align: center; }
	.leader-emoji { font-size: 0.9rem; flex-shrink: 0; }
	.leader-info { flex: 1; min-width: 0; display: flex; flex-direction: column; gap: 2px; }
	.leader-name { font-size: 0.72rem; font-weight: 600; color: var(--text-primary); white-space: nowrap; overflow: hidden; text-overflow: ellipsis; }
	.leader-bar-wrap { width: 100%; }
	.leader-bar-track { height: 4px; background: var(--glass-bg); border-radius: 2px; overflow: hidden; }
	.leader-bar-done { height: 100%; background: linear-gradient(90deg, var(--accent-emerald), var(--priority-low)); border-radius: 2px; transition: width 0.5s ease; }
	.leader-stats { display: flex; gap: 4px; flex-shrink: 0; }
	.leader-done { font-size: 0.6rem; font-weight: 700; color: var(--accent-emerald); }
	.leader-active { font-size: 0.6rem; font-weight: 700; color: var(--accent-amber); }

	/* ─── Upcoming Deadlines ─────────────────────────────────── */
	.deadlines-list { display: flex; flex-direction: column; gap: 6px; }
	.deadline-item {
		display: flex; align-items: center; gap: 8px; padding: 6px 8px;
		border-radius: var(--radius-sm); background: var(--glass-bg);
		border: 1px solid transparent; transition: all var(--duration-fast) var(--ease-out);
	}
	.deadline-item:hover { background: var(--bg-base); }
	.deadline-urgent {
		border-color: rgba(239, 68, 68, 0.3) !important;
		background: rgba(239, 68, 68, 0.06) !important;
	}
	.deadline-soon {
		border-color: rgba(245, 158, 11, 0.25) !important;
		background: rgba(245, 158, 11, 0.04) !important;
	}
	.deadline-priority { font-size: 0.7rem; flex-shrink: 0; }
	.deadline-info { flex: 1; min-width: 0; display: flex; flex-direction: column; }
	.deadline-title { font-size: 0.72rem; font-weight: 600; color: var(--text-primary); white-space: nowrap; overflow: hidden; text-overflow: ellipsis; }
	.deadline-when { font-size: 0.6rem; color: var(--text-tertiary); font-weight: 500; }
	.deadline-urgent .deadline-when { color: var(--accent-rose); font-weight: 700; }
	.deadline-soon .deadline-when { color: var(--accent-amber); }
	.deadline-date { font-size: 0.6rem; color: var(--text-secondary); font-weight: 600; flex-shrink: 0; }

	/* ─── Quick Stats ────────────────────────────────────────── */
	.quick-stats { padding: var(--space-md); }
	.qs-row {
		display: flex; justify-content: space-between; align-items: center;
		padding: 4px 0; border-bottom: 1px solid var(--glass-border);
	}
	.qs-row:last-child { border-bottom: none; }
	.qs-label { font-size: 0.68rem; font-weight: 600; color: var(--text-tertiary); text-transform: uppercase; letter-spacing: 0.03em; }
	.qs-value { font-size: 0.78rem; font-weight: 800; color: var(--text-primary); }
	.qs-value.qs-warn { color: var(--accent-rose); }

	/* ─── Favourites ──────────────────────────────────────────── */
	.row-fav-btn {
		background: none; border: none; cursor: pointer;
		font-size: 0.85rem; padding: 2px 4px; border-radius: var(--radius-sm);
		opacity: 0; transition: all var(--duration-fast) var(--ease-out);
		flex-shrink: 0; line-height: 1;
	}
	.board-row:hover .row-fav-btn,
	.row-fav-btn.favourited { opacity: 1; }
	.row-fav-btn:hover { transform: scale(1.2); }

	.favourites-group { border-left: 3px solid #f59e0b; }
	.fav-header {
		display: flex; align-items: center; gap: var(--space-sm);
		padding: 8px var(--space-md); cursor: default;
	}
	.fav-star { font-size: 0.85rem; }
	.fav-name { font-weight: 700; color: #f59e0b; font-size: 0.78rem; }
	.fav-row { border-left: 2px solid rgba(245, 158, 11, 0.25); }
</style>
