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

	let { data }: { data: PageData } = $props();

	let showCreate = $state(false);
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
	let showCompletedSubs = $state(false);

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

	const a = $derived(data.analytics);

	// Group boards by category for dashboard display
	type BoardGroup = { name: string; color: string | null; boards: typeof data.boards };
	let boardGroups = $derived.by(() => {
		const groups: BoardGroup[] = [];
		const catMap = new Map<string, BoardGroup>();

		for (const board of data.boards) {
			const key = board.categoryName || '__uncategorised__';
			let group = catMap.get(key);
			if (!group) {
				group = { name: board.categoryName || 'Uncategorised', color: board.categoryColor || null, boards: [] };
				catMap.set(key, group);
				groups.push(group);
			}
			group.boards.push(board);
		}

		// Sort: categorised groups alphabetically first, uncategorised last
		groups.sort((a, b) => {
			if (a.name === 'Uncategorised') return 1;
			if (b.name === 'Uncategorised') return -1;
			return a.name.localeCompare(b.name);
		});

		return groups;
	});

	function timeAgo(dateStr: string): string {
		const diff = Math.floor((Date.now() - new Date(dateStr + 'Z').getTime()) / 1000);
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
			await setBoardCategory(boardCtx.boardId, created.id);
			newBoardCatName = '';
			newBoardCatColor = '#6366f1';
			showNewBoardCat = false;
		}
	}
</script>

<svelte:head>
	<title>DumpFire — Your Boards</title>
</svelte:head>

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
			<a href="/teams" class="nav-pill">
				<svg width="16" height="16" viewBox="0 0 16 16" fill="none">
					<path d="M5.5 8a2.5 2.5 0 100-5 2.5 2.5 0 000 5zM1.5 14v-1a3.5 3.5 0 013.5-3.5h1" stroke="currentColor" stroke-width="1.2" stroke-linecap="round" stroke-linejoin="round"/>
					<path d="M10.5 8a2.5 2.5 0 100-5 2.5 2.5 0 000 5zM14.5 14v-1a3.5 3.5 0 00-2.5-3.37" stroke="currentColor" stroke-width="1.2" stroke-linecap="round" stroke-linejoin="round"/>
				</svg>
				Teams
			</a>
			{#if isAdmin}
			<a href="/admin" class="nav-pill">
				<svg width="16" height="16" viewBox="0 0 16 16" fill="none">
					<path d="M8 1l1.1 2.2 2.4.35-1.75 1.7.4 2.4L8 6.6l-2.15 1.05.4-2.4-1.75-1.7 2.4-.35L8 1z" stroke="currentColor" stroke-width="1.2" stroke-linecap="round" stroke-linejoin="round"/>
					<path d="M3.5 9.5v3a1 1 0 001 1h7a1 1 0 001-1v-3" stroke="currentColor" stroke-width="1.2" stroke-linecap="round"/>
				</svg>
				Admin
			</a>
			{/if}
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
			<a href="/request" class="nav-pill">
				<svg width="16" height="16" viewBox="0 0 16 16" fill="none">
					<path d="M4 2h8a1 1 0 011 1v10a1 1 0 01-1 1H4a1 1 0 01-1-1V3a1 1 0 011-1z" stroke="currentColor" stroke-width="1.2" stroke-linecap="round"/>
					<path d="M6 5h4M6 8h4M6 11h2" stroke="currentColor" stroke-width="1.2" stroke-linecap="round"/>
				</svg>
				Request
			</a>
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
	<section class="analytics">
		<div class="stat-cards">
			<div class="stat-card">
				<div class="stat-value">{a.active}</div>
				<div class="stat-label">Active Tasks</div>
				<div class="stat-sub">{a.totalAssigned} total assigned</div>
			</div>
			<div class="stat-card accent-green">
				<div class="stat-value">{a.completionRate}<span class="stat-unit">%</span></div>
				<div class="stat-label">Completion Rate</div>
				<div class="stat-sub">{a.completed} completed</div>
				<div class="stat-ring">
					<svg viewBox="0 0 36 36">
						<path class="ring-bg" d="M18 2.0845 a 15.9155 15.9155 0 0 1 0 31.831 a 15.9155 15.9155 0 0 1 0 -31.831" />
						<path class="ring-fill" stroke-dasharray="{a.completionRate}, 100" d="M18 2.0845 a 15.9155 15.9155 0 0 1 0 31.831 a 15.9155 15.9155 0 0 1 0 -31.831" />
					</svg>
				</div>
			</div>
			<div class="stat-card accent-cyan">
				<div class="stat-value">{a.completedThisWeek}</div>
				<div class="stat-label">Done This Week</div>
				<div class="stat-sub">{a.completedThisMonth} this month</div>
			</div>
			<div class="stat-card" class:accent-rose={a.overdue > 0}>
				<div class="stat-value">{a.overdue}</div>
				<div class="stat-label">Overdue</div>
				<div class="stat-sub">{a.pendingRequests} inbox pending</div>
			</div>
		</div>

		<!-- Priority breakdown -->
		{#if a.active > 0}
		<div class="priority-bar-container">
			<span class="priority-bar-label">Priority Spread</span>
			<div class="priority-bar">
				{#if a.priorityCounts.critical > 0}
					<div class="priority-seg seg-critical" style="flex: {a.priorityCounts.critical}" title="{a.priorityCounts.critical} critical"></div>
				{/if}
				{#if a.priorityCounts.high > 0}
					<div class="priority-seg seg-high" style="flex: {a.priorityCounts.high}" title="{a.priorityCounts.high} high"></div>
				{/if}
				{#if a.priorityCounts.medium > 0}
					<div class="priority-seg seg-medium" style="flex: {a.priorityCounts.medium}" title="{a.priorityCounts.medium} medium"></div>
				{/if}
				{#if a.priorityCounts.low > 0}
					<div class="priority-seg seg-low" style="flex: {a.priorityCounts.low}" title="{a.priorityCounts.low} low"></div>
				{/if}
			</div>
			<div class="priority-legend">
				{#if a.priorityCounts.critical > 0}<span class="legend-item"><span class="legend-dot dot-critical"></span> {a.priorityCounts.critical} Critical</span>{/if}
				{#if a.priorityCounts.high > 0}<span class="legend-item"><span class="legend-dot dot-high"></span> {a.priorityCounts.high} High</span>{/if}
				{#if a.priorityCounts.medium > 0}<span class="legend-item"><span class="legend-dot dot-medium"></span> {a.priorityCounts.medium} Medium</span>{/if}
				{#if a.priorityCounts.low > 0}<span class="legend-item"><span class="legend-dot dot-low"></span> {a.priorityCounts.low} Low</span>{/if}
			</div>
		</div>
		{/if}
	</section>

	<!-- ─── Boards Table ─────────────────────────────────────────────── -->
	<section class="boards-section">
		<div class="section-header">
			<h2>Boards</h2>
			<span class="section-count">{data.boards.length} board{data.boards.length !== 1 ? 's' : ''} · {totalCards} cards</span>
			<button class="toggle-completed-btn" class:active={showCompletedSubs} onclick={() => showCompletedSubs = !showCompletedSubs}>
				{showCompletedSubs ? '✅ Showing completed' : '👁️ Show completed subs'}
			</button>
		</div>

		{#if data.boards.length > 0}
			<!-- All Tasks row -->
			<a href="/all" class="board-row board-row-all" id="all-tasks">
				<span class="board-row-emoji">🌐</span>
				<span class="board-row-name">All Tasks</span>
				<span class="board-row-count">{totalCards} cards</span>
				<div class="board-row-progress">
					{#if totalCards > 0}
						<div class="progress-track"><div class="progress-fill fill-all" style="width: {(completedCards / totalCards) * 100}%"></div></div>
						<span class="progress-pct">{Math.round((completedCards / totalCards) * 100)}%</span>
					{/if}
				</div>
				<span class="board-row-action"></span>
			</a>

			{#each boardGroups as group}
				<!-- Category group header -->
				<div class="category-group">
					<div class="category-group-header">
						{#if group.color}
							<span class="category-dot" style="background: {group.color}"></span>
						{/if}
						<span class="category-group-name" style={group.color ? `color: ${group.color}` : ''}>{group.name}</span>
						<span class="category-group-count">{group.boards.length} board{group.boards.length !== 1 ? 's' : ''}</span>
					</div>

					{#each group.boards as board (board.id)}
						<div class="board-row-group">
							<!-- svelte-ignore a11y_no_static_element_interactions -->
							<div class="board-row" style={group.color ? `border-left: 3px solid ${group.color}` : ''} oncontextmenu={(e) => openBoardContextMenu(e, board.id, board.name)}>
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
									<span class="board-row-emoji">{board.emoji}</span>
									<span class="board-row-name">{board.name}</span>
								</a>
								<span class="board-row-count">{board.totalCards} card{board.totalCards !== 1 ? 's' : ''}</span>
								<div class="board-row-progress">
									{#if board.totalCards > 0}
										<div class="progress-track"><div class="progress-fill" style="width: {(board.completedCards / board.totalCards) * 100}%"></div></div>
										<span class="progress-pct">{Math.round((board.completedCards / board.totalCards) * 100)}%</span>
									{:else}
										<span class="progress-pct empty">—</span>
									{/if}
								</div>
								{#if board.subBoards && board.subBoards.length > 0}
									{@const activeSubs = board.subBoards.filter((s: any) => showCompletedSubs || !(s.total > 0 && s.done === s.total))}
									<span class="sub-count-badge">{activeSubs.length}/{board.subBoards.length} sub</span>
								{/if}
								<button
									class="row-delete-btn"
									title="Delete board"
									onclick={(e) => { e.preventDefault(); e.stopPropagation(); confirmDeleteBoard(board.id, board.name); }}
									disabled={deleting === board.id}
								>
									{#if deleting === board.id}
										<span class="spinner"></span>
									{:else}
										<svg width="12" height="12" viewBox="0 0 14 14" fill="none">
											<path d="M2 4h10M5 4V2.5A.5.5 0 015.5 2h3a.5.5 0 01.5.5V4m1.5 0l-.5 8a1 1 0 01-1 1h-5a1 1 0 01-1-1l-.5-8" stroke="currentColor" stroke-width="1.2" stroke-linecap="round" stroke-linejoin="round"/>
										</svg>
									{/if}
								</button>
							</div>

							<!-- Sub-boards (expanded) -->
							{#if expandedBoards.has(board.id) && board.subBoards && board.subBoards.length > 0}
								{#each board.subBoards.filter((s) => showCompletedSubs || !(s.total > 0 && s.done === s.total)) as sb}
									<a href="/board/{sb.id}" class="board-row sub-row" title="Parent: {sb.parentCardTitle}">
										<span class="sub-connector">└</span>
										<span class="board-row-emoji">{sb.emoji}</span>
										<span class="board-row-name">{sb.name}</span>
										<span class="board-row-count">{sb.total} card{sb.total !== 1 ? 's' : ''}</span>
										<div class="board-row-progress">
											{#if sb.total > 0}
												<div class="progress-track"><div class="progress-fill" style="width: {(sb.done / sb.total) * 100}%"></div></div>
												<span class="progress-pct" class:complete={sb.done === sb.total}>{Math.round((sb.done / sb.total) * 100)}%</span>
											{:else}
												<span class="progress-pct empty">empty</span>
											{/if}
										</div>
										<button class="row-delete-btn" title="Delete sub-board" onclick={(e) => { e.preventDefault(); e.stopPropagation(); confirmDeleteBoard(sb.id, sb.name); }}>
											<svg width="10" height="10" viewBox="0 0 10 10" fill="none"><path d="M2 2l6 6M8 2L2 8" stroke="currentColor" stroke-width="1.5" stroke-linecap="round"/></svg>
										</button>
									</a>
								{/each}
							{/if}
						</div>
					{/each}
				</div>
			{/each}
		{:else}
			<div class="empty-state">
				<span class="empty-icon">🗂️</span>
				<h3>No boards yet</h3>
				<p>Create your first board to get started</p>
			</div>
		{/if}
	</section>

	<!-- ─── Recent Activity ──────────────────────────────────────────── -->
	{#if a.recentActivity.length > 0}
	<section class="activity-section">
		<h2>Recent Activity</h2>
		<div class="activity-list">
			{#each a.recentActivity as entry}
				<div class="activity-item">
					<span class="activity-emoji">{entry.userEmoji}</span>
					<span class="activity-detail">{entry.detail || entry.action}</span>
					<span class="activity-time">{timeAgo(entry.createdAt)}</span>
				</div>
			{/each}
		</div>
	</section>
	{/if}
</div>

<!-- Create board modal -->
{#if showCreate}
	<div class="modal-overlay" onclick={() => (showCreate = false)} role="dialog" aria-modal="true">
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
	.dashboard { max-width: 1000px; margin: 0 auto; padding: var(--space-2xl) var(--space-xl); }

	/* ─── Header ─────────────────────────────────────────────────── */
	.dashboard-header {
		display: flex; align-items: center; justify-content: space-between;
		margin-bottom: var(--space-xl); padding-bottom: calc(var(--space-xl) + 18px);
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

	/* ─── Analytics ──────────────────────────────────────────────── */
	.analytics { margin-bottom: var(--space-2xl); }

	.stat-cards {
		display: grid; grid-template-columns: repeat(4, 1fr); gap: var(--space-md);
		margin-bottom: var(--space-lg);
	}
	.stat-card {
		position: relative; overflow: hidden;
		background: var(--bg-card); border: 1px solid var(--glass-border);
		border-radius: var(--radius-md); padding: var(--space-lg);
		transition: all var(--duration-fast) var(--ease-out);
	}
	.stat-card:hover { border-color: rgba(99, 102, 241, 0.3); transform: translateY(-1px); }
	.stat-value {
		font-size: 2rem; font-weight: 800; color: var(--text-primary);
		line-height: 1; margin-bottom: 4px;
	}
	.stat-unit { font-size: 1rem; font-weight: 600; opacity: 0.5; }
	.stat-label { font-size: 0.75rem; font-weight: 600; color: var(--text-secondary); text-transform: uppercase; letter-spacing: 0.04em; }
	.stat-sub { font-size: 0.68rem; color: var(--text-tertiary); margin-top: 4px; }

	/* Accent variants */
	.accent-green { border-left: 3px solid #22c55e; }
	.accent-green .stat-value { color: #22c55e; }
	.accent-cyan { border-left: 3px solid #06b6d4; }
	.accent-cyan .stat-value { color: #06b6d4; }
	.accent-rose { border-left: 3px solid var(--accent-rose); }
	.accent-rose .stat-value { color: var(--accent-rose); }

	/* Completion ring */
	.stat-ring {
		position: absolute; top: 10px; right: 10px;
		width: 48px; height: 48px; opacity: 0.4;
	}
	.stat-ring svg { width: 100%; height: 100%; }
	.ring-bg {
		fill: none; stroke: var(--glass-border); stroke-width: 3;
	}
	.ring-fill {
		fill: none; stroke: #22c55e; stroke-width: 3;
		stroke-linecap: round;
		transition: stroke-dasharray 0.6s ease;
	}

	/* Priority bar */
	.priority-bar-container { margin-bottom: var(--space-md); }
	.priority-bar-label { font-size: 0.7rem; font-weight: 600; color: var(--text-tertiary); text-transform: uppercase; letter-spacing: 0.04em; margin-bottom: 6px; display: block; }
	.priority-bar {
		display: flex; height: 8px; border-radius: 4px; overflow: hidden; gap: 2px;
	}
	.priority-seg { border-radius: 2px; transition: flex 0.3s; }
	.seg-critical { background: #ef4444; }
	.seg-high { background: #f97316; }
	.seg-medium { background: #eab308; }
	.seg-low { background: #22c55e; }

	.priority-legend { display: flex; gap: var(--space-md); margin-top: 6px; }
	.legend-item { display: flex; align-items: center; gap: 4px; font-size: 0.68rem; color: var(--text-secondary); font-weight: 500; }
	.legend-dot { width: 8px; height: 8px; border-radius: 50%; flex-shrink: 0; }
	.dot-critical { background: #ef4444; }
	.dot-high { background: #f97316; }
	.dot-medium { background: #eab308; }
	.dot-low { background: #22c55e; }

	/* ─── Category Groups ────────────────────────────────────────── */
	.category-group {
		margin-bottom: var(--space-xs);
	}
	.category-group-header {
		display: flex; align-items: center; gap: var(--space-sm);
		padding: var(--space-sm) var(--space-md);
		margin-top: var(--space-md);
	}
	.category-dot {
		width: 10px; height: 10px; border-radius: 50%; flex-shrink: 0;
		box-shadow: 0 0 6px currentColor;
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

	/* ─── Boards Table ────────────────────────────────────────────── */
	.boards-section { margin-bottom: var(--space-2xl); }
	.section-header {
		display: flex; align-items: baseline; gap: var(--space-sm);
		margin-bottom: var(--space-md);
	}
	.section-header h2 { font-size: 1.1rem; font-weight: 700; color: var(--text-primary); }
	.section-count { font-size: 0.75rem; color: var(--text-tertiary); font-weight: 500; }

	.toggle-completed-btn {
		margin-left: auto; padding: 4px 10px;
		font-size: 0.68rem; font-weight: 600; font-family: var(--font-family);
		background: var(--bg-surface); border: 1px solid var(--glass-border);
		border-radius: var(--radius-full); color: var(--text-secondary); cursor: pointer;
		transition: all var(--duration-fast) var(--ease-out);
	}
	.toggle-completed-btn:hover { border-color: var(--accent-indigo); color: var(--text-primary); }
	.toggle-completed-btn.active { background: rgba(99, 102, 241, 0.1); border-color: rgba(99, 102, 241, 0.3); color: var(--accent-indigo); }


	.board-row {
		display: flex; align-items: center; gap: var(--space-sm);
		padding: 10px var(--space-md);
		border: 1px solid var(--glass-border);
		border-bottom: none;
		background: var(--bg-card);
		transition: all var(--duration-fast) var(--ease-out);
		text-decoration: none; color: inherit;
	}
	.board-row:first-child, .board-row-all { border-radius: var(--radius-md) var(--radius-md) 0 0; }
	.board-row-group:last-child .board-row:last-child,
	.board-row-group:last-child .sub-row:last-child { border-bottom: 1px solid var(--glass-border); border-radius: 0 0 var(--radius-md) var(--radius-md); }
	.board-row:hover { background: rgba(99, 102, 241, 0.04); }

	.board-row-all {
		border-bottom: 1px solid rgba(99, 102, 241, 0.2);
		background: linear-gradient(135deg, var(--bg-card), rgba(99, 102, 241, 0.04));
		border-radius: var(--radius-md);
		margin-bottom: var(--space-xs);
	}
	.board-row-all:hover { background: linear-gradient(135deg, var(--bg-card), rgba(99, 102, 241, 0.08)); }

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
	.board-row-count { font-size: 0.72rem; color: var(--text-tertiary); font-weight: 500; white-space: nowrap; min-width: 55px; }
	.board-row-progress {
		display: flex; align-items: center; gap: 6px; min-width: 100px;
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
	.board-row-action { width: 24px; flex-shrink: 0; }

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
	@media (max-width: 768px) {
		.stat-cards { grid-template-columns: repeat(2, 1fr); }
		.dashboard-header { flex-direction: column; gap: var(--space-md); align-items: flex-start; }
		.header-actions { flex-wrap: wrap; }
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
</style>
