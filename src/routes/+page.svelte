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
	import { onMount } from 'svelte';
	import { theme } from '$lib/stores/theme';
	import ConfirmModal from '$lib/components/ConfirmModal.svelte';
	import EmojiPicker from '$lib/components/EmojiPicker.svelte';

	let { data }: { data: PageData } = $props();

	let showCreate = $state(false);
	let newBoardName = $state('');
	let newBoardEmoji = $state('📋');
	let deleting = $state<number | null>(null);
	let currentTheme = $state('light');
	theme.subscribe((v) => (currentTheme = v));

	let user = $derived($page.data.user);
	let isAdmin = $derived(user?.role === 'admin' || user?.role === 'superadmin');

	let confirmState = $state<{ show: boolean; boardId: number; boardName: string }>({ show: false, boardId: 0, boardName: '' });

	let inboxCount = $state(0);
	let expandedBoards = $state<Set<number>>(new Set());
	let showCompletedSubs = $state(false);

	onMount(async () => {
		const res = await fetch('/api/requests');
		if (res.ok) {
			const requests = await res.json();
			inboxCount = requests.filter((r: any) => r.status === 'pending').length;
		}
	});

	async function createBoard() {
		if (!newBoardName.trim()) return;
		const res = await fetch('/api/boards', {
			method: 'POST',
			headers: { 'Content-Type': 'application/json' },
			body: JSON.stringify({ name: newBoardName.trim(), emoji: newBoardEmoji })
		});
		if (res.ok) {
			const board = await res.json();
			newBoardName = '';
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

	function timeAgo(dateStr: string): string {
		const diff = Math.floor((Date.now() - new Date(dateStr + 'Z').getTime()) / 1000);
		if (diff < 60) return 'just now';
		if (diff < 3600) return `${Math.floor(diff / 60)}m ago`;
		if (diff < 86400) return `${Math.floor(diff / 3600)}h ago`;
		return `${Math.floor(diff / 86400)}d ago`;
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
				<p class="brand-tagline">Blazingly fast local Kanban</p>
			</div>
		</div>
		<div class="header-actions">
			<a href="/teams" class="btn-ghost" title="My Teams" style="font-size: 0; padding: var(--space-sm);">
				<svg width="18" height="18" viewBox="0 0 18 18" fill="none">
					<path d="M6 9a3 3 0 100-6 3 3 0 000 6zM2 16v-1a4 4 0 014-4h0" stroke="currentColor" stroke-width="1.2" stroke-linecap="round" stroke-linejoin="round"/>
					<path d="M12 9a3 3 0 100-6 3 3 0 000 6zM16 16v-1a4 4 0 00-3-3.87" stroke="currentColor" stroke-width="1.2" stroke-linecap="round" stroke-linejoin="round"/>
				</svg>
			</a>
			{#if isAdmin}
			<a href="/admin" class="btn-ghost" title="Admin panel" style="font-size: 0; padding: var(--space-sm);">
				<svg width="18" height="18" viewBox="0 0 18 18" fill="none">
					<path d="M9 1.5l1.3 2.6 2.9.4-2.1 2 .5 2.9L9 7.9l-2.6 1.5.5-2.9-2.1-2 2.9-.4L9 1.5z" stroke="currentColor" stroke-width="1.2" stroke-linecap="round" stroke-linejoin="round"/>
					<path d="M4.5 11v3.5a1 1 0 001 1h7a1 1 0 001-1V11" stroke="currentColor" stroke-width="1.2" stroke-linecap="round"/>
				</svg>
			</a>
			{/if}
			<a href="/inbox" class="btn-ghost nav-btn" title="Inbox">
				📥 Inbox
				{#if inboxCount > 0}
					<span class="inbox-count-badge">{inboxCount}</span>
				{/if}
			</a>
			<a href="/request" class="btn-ghost nav-btn" title="Submit a Request">
				📋 Request
			</a>
			<button class="theme-toggle btn-ghost" onclick={() => theme.toggle()} title="Toggle theme">
				{#if currentTheme === 'dark'}
					<svg width="18" height="18" viewBox="0 0 18 18" fill="none">
						<circle cx="9" cy="9" r="4" stroke="currentColor" stroke-width="1.5"/>
						<path d="M9 1v2M9 15v2M1 9h2M15 9h2M3.3 3.3l1.4 1.4M13.3 13.3l1.4 1.4M3.3 14.7l1.4-1.4M13.3 4.7l1.4-1.4" stroke="currentColor" stroke-width="1.5" stroke-linecap="round"/>
					</svg>
				{:else}
					<svg width="18" height="18" viewBox="0 0 18 18" fill="none">
						<path d="M15.5 10.1A6.5 6.5 0 017.9 2.5 7 7 0 1015.5 10.1z" stroke="currentColor" stroke-width="1.5" stroke-linecap="round" stroke-linejoin="round"/>
					</svg>
				{/if}
			</button>
			<button class="btn-primary" onclick={() => (showCreate = true)} id="create-board-btn">
				<svg width="16" height="16" viewBox="0 0 16 16" fill="none">
					<path d="M8 3v10M3 8h10" stroke="currentColor" stroke-width="2" stroke-linecap="round" />
				</svg>
				New Board
			</button>
		</div>
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

			{#each data.boards as board (board.id)}
				<div class="board-row-group">
					<div class="board-row">
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
			<div class="modal-actions">
				<button class="btn-ghost" onclick={() => (showCreate = false)}>Cancel</button>
				<button class="btn-primary" onclick={createBoard} disabled={!newBoardName.trim()}>Create Board</button>
			</div>
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
		margin-bottom: var(--space-xl); padding-bottom: var(--space-xl);
		border-bottom: 1px solid var(--glass-border);
	}
	.header-actions { display: flex; align-items: center; gap: var(--space-sm); }
	.nav-btn {
		position: relative; display: inline-flex; align-items: center; gap: 5px;
		font-size: 0.82rem !important; font-weight: 600;
		text-decoration: none; color: var(--text-secondary);
	}
	.nav-btn:hover { color: var(--text-primary); }
	.inbox-count-badge {
		display: inline-flex; align-items: center; justify-content: center;
		min-width: 18px; height: 18px; padding: 0 5px;
		border-radius: var(--radius-full);
		background: var(--accent-rose); color: white;
		font-size: 0.65rem; font-weight: 800; line-height: 1;
	}
	.theme-toggle { font-size: 0; }
	.brand { display: flex; align-items: center; gap: var(--space-lg); }
	.brand-icon { font-size: 2.5rem; filter: drop-shadow(0 0 12px rgba(245, 158, 11, 0.4)); }
	.brand h1 {
		font-size: 1.75rem;
		background: linear-gradient(135deg, var(--text-primary), var(--accent-purple));
		-webkit-background-clip: text; -webkit-text-fill-color: transparent; background-clip: text;
	}
	.brand-tagline { color: var(--text-secondary); font-size: 0.85rem; font-weight: 400; }

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
</style>
