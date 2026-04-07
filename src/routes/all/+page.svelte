<script lang="ts">
	/**
	 * All Tasks Page — A cross-board view of every card in the system.
	 *
	 * Groups cards into swim-lane "buckets" (To Do, On Hold, In Progress, Complete)
	 * and provides search and board-level filtering. Supports editing and moving cards.
	 */
	import type { PageData } from './$types';
	import { theme } from '$lib/stores/theme';
	import { onMount } from 'svelte';
	import { invalidateAll } from '$app/navigation';
	import CardModal from '$lib/components/CardModal.svelte';
	import ThemePicker from '$lib/components/ThemePicker.svelte';
	import type { CardType } from '$lib/types';
	import { getRelativeAge, getDueRelative, getDueStatus, parseUTC } from '$lib/utils/date-utils';
	import { subtaskProgress } from '$lib/utils/card-utils';

	let { data }: { data: PageData } = $props();
	let currentTheme = $state('light');
	theme.subscribe((v) => (currentTheme = v));

	let tick = $state(0);
	let tickInterval: ReturnType<typeof setInterval> | null = null;
	onMount(() => {
		tickInterval = setInterval(() => { tick++; }, 15000);
		return () => { if (tickInterval) clearInterval(tickInterval); };
	});

	let searchQuery = $state('');
	let boardFilter = $state('all');

	const priorityEmoji: Record<string, string> = { critical: '🔴', high: '🟠', medium: '🟡', low: '🟢' };
	const bucketColors: Record<string, string> = { 'To Do': '#6366f1', 'On Hold': '#ef4444', 'In Progress': '#f59e0b', 'Complete': '#10b981' };

	function matchesFilters(card: any): boolean {
		if (boardFilter !== 'all' && card.boardId !== Number(boardFilter)) return false;
		if (!searchQuery.trim()) return true;
		const q = searchQuery.toLowerCase();
		return card.title.toLowerCase().includes(q) || card.description?.toLowerCase().includes(q);
	}

	function getFilteredCount(bucket: any): number {
		return bucket.cards.filter(matchesFilters).length;
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
			subBoards: card.subBoards || [], assignees: card.assignees || []
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
		await fetch(`/api/cards/${moveCard.id}`, {
			method: 'PUT',
			headers: { 'Content-Type': 'application/json' },
			body: JSON.stringify({ columnId: moveColumnId, boardId: moveBoardId })
		});
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
</script>

<svelte:head>
	<title>DumpFire — All Tasks</title>
</svelte:head>

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
				{#each data.boards as board}
					<option value={board.id}>{board.emoji} {board.name}</option>
				{/each}
			</select>
			<div class="search-wrapper">
				<svg class="search-icon" width="14" height="14" viewBox="0 0 14 14" fill="none">
					<circle cx="6" cy="6" r="4.5" stroke="currentColor" stroke-width="1.5"/>
					<path d="M10 10l3 3" stroke="currentColor" stroke-width="1.5" stroke-linecap="round"/>
				</svg>
				<input type="text" class="search-input" placeholder="Search tasks..." bind:value={searchQuery} />
			</div>
			<ThemePicker />
		</div>
	</header>

	<div class="kanban-scroll">
		<div class="kanban-track">
			{#each data.buckets as bucket}
				{@const filteredCards = bucket.cards.filter(matchesFilters)}
				<div class="column">
					<div class="column-header">
						<div class="column-title-row">
							<span class="column-color-dot" style="background: {bucketColors[bucket.title] || '#8b5cf6'}"></span>
							<h2 class="column-title">{bucket.title}</h2>
							<span class="column-count">{filteredCards.length}</span>
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
								<div class="card-header">
									<span class="card-title">{card.title}</span>
									<button class="move-btn" title="Move card" onclick={(e) => { e.stopPropagation(); openMoveModal(card); }}>
										<svg width="14" height="14" viewBox="0 0 14 14" fill="none"><path d="M7 2v10M2 7h10" stroke="currentColor" stroke-width="1.5" stroke-linecap="round"/><path d="M4 4L2 7l2 3M10 4l2 3-2 3M4 4L7 2l3 2M4 10l3 2 3-2" stroke="currentColor" stroke-width="1" stroke-linecap="round" stroke-linejoin="round" opacity="0.5"/></svg>
									</button>
								</div>
								<div class="card-board-tag">
									<span class="board-tag">{card.boardEmoji} {card.boardName}</span>
									<span class="column-tag">{card.columnTitle}</span>
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
					</div>
				</div>
			{/each}
		</div>
	</div>
</div>

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
	<div class="modal-overlay" onclick={() => { showMoveModal = false; moveCard = null; }} role="dialog">
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

<style>
	.all-page {
		display: flex;
		flex-direction: column;
		height: 100vh;
		overflow: hidden;
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
</style>
