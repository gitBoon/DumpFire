<script lang="ts">
	import type { PageData } from './$types';
	import { goto, invalidateAll } from '$app/navigation';
	import { browser } from '$app/environment';
	import { onMount } from 'svelte';
	import { theme } from '$lib/stores/theme';
	import { user, type UserProfile } from '$lib/stores/user';
	import ConfirmModal from '$lib/components/ConfirmModal.svelte';
	import UserSetup from '$lib/components/UserSetup.svelte';
	import EmojiPicker from '$lib/components/EmojiPicker.svelte';

	let { data }: { data: PageData } = $props();
	let showCreate = $state(false);
	let newBoardName = $state('');
	let newBoardEmoji = $state('📋');
	let deleting = $state<number | null>(null);
	let currentTheme = $state('dark');
	theme.subscribe((v) => (currentTheme = v));

	let currentUser = $state<UserProfile>({ name: '', emoji: '👤' });
	let showUserSetup = $state(false);
	user.subscribe((v) => (currentUser = v));

	onMount(() => {
		if (browser && !currentUser.name) {
			showUserSetup = true;
		}
	});

	let confirmState = $state<{
		show: boolean;
		boardId: number;
		boardName: string;
	}>({ show: false, boardId: 0, boardName: '' });


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
	// Computed totals across all boards
	let totalCards = $derived(data.boards.reduce((t, b) => t + b.totalCards, 0));
	let completedCards = $derived(data.boards.reduce((t, b) => t + b.completedCards, 0));
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
			<a href="/admin" class="btn-ghost" title="Admin panel" style="font-size: 0; padding: var(--space-sm);">
				<svg width="18" height="18" viewBox="0 0 18 18" fill="none">
					<path d="M9 1.5l1.3 2.6 2.9.4-2.1 2 .5 2.9L9 7.9l-2.6 1.5.5-2.9-2.1-2 2.9-.4L9 1.5z" stroke="currentColor" stroke-width="1.2" stroke-linecap="round" stroke-linejoin="round"/>
					<path d="M4.5 11v3.5a1 1 0 001 1h7a1 1 0 001-1V11" stroke="currentColor" stroke-width="1.2" stroke-linecap="round"/>
				</svg>
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

	<main class="boards-grid stagger-children">
		{#if data.boards.length > 0}
			<a href="/all" class="board-card glass all-tasks-card" id="all-tasks">
				<div class="board-card-emoji">🌐</div>
				<div class="board-card-info">
					<h3>All Tasks</h3>
					<div class="board-card-stats">
						<span class="board-card-count">
							{totalCards} card{totalCards !== 1 ? 's' : ''} · {data.boards.length} board{data.boards.length !== 1 ? 's' : ''}
						</span>
						{#if totalCards > 0}
							<div class="board-card-progress">
								<div class="board-card-progress-fill all-progress" style="width: {(completedCards / totalCards) * 100}%"></div>
							</div>
							<span class="board-card-pct">{Math.round((completedCards / totalCards) * 100)}%</span>
						{/if}
					</div>
				</div>
				<div class="board-card-glow all-glow"></div>
			</a>
		{/if}
		{#each data.boards as board (board.id)}
			<div class="board-card-wrapper">
				<a href="/board/{board.id}" class="board-card glass" id="board-{board.id}">
					<div class="board-card-emoji">{board.emoji}</div>
					<div class="board-card-info">
						<h3>{board.name}</h3>
						<div class="board-card-stats">
							<span class="board-card-count">
								{board.totalCards} card{board.totalCards !== 1 ? 's' : ''}
							</span>
							{#if board.totalCards > 0}
								<div class="board-card-progress">
									<div class="board-card-progress-fill" style="width: {(board.completedCards / board.totalCards) * 100}%"></div>
								</div>
								<span class="board-card-pct">{Math.round((board.completedCards / board.totalCards) * 100)}%</span>
							{/if}
						</div>
					</div>
					<button
						class="board-delete-btn"
						title="Delete board"
						onclick={(e) => {
							e.preventDefault();
							e.stopPropagation();
							confirmDeleteBoard(board.id, board.name);
						}}
						disabled={deleting === board.id}
					>
						{#if deleting === board.id}
							<span class="spinner"></span>
						{:else}
							<svg width="14" height="14" viewBox="0 0 14 14" fill="none">
								<path d="M2 4h10M5 4V2.5A.5.5 0 015.5 2h3a.5.5 0 01.5.5V4m1.5 0l-.5 8a1 1 0 01-1 1h-5a1 1 0 01-1-1l-.5-8" stroke="currentColor" stroke-width="1.2" stroke-linecap="round" stroke-linejoin="round"/>
							</svg>
						{/if}
					</button>
					<div class="board-card-glow"></div>
				</a>
				{#if board.subBoards && board.subBoards.length > 0}
					<div class="sub-boards-list">
						{#each board.subBoards as sb}
							<a href="/board/{sb.id}" class="sub-board-item" title="{sb.parentCardTitle}">
								<span class="sub-board-connector"></span>
								<span class="sub-board-emoji">{sb.emoji}</span>
								<span class="sub-board-name">{sb.name}</span>
								{#if sb.total > 0}
									<span class="sub-board-progress" class:complete={sb.done === sb.total}>{sb.done}/{sb.total}</span>
								{:else}
									<span class="sub-board-progress empty">empty</span>
								{/if}
								<button class="sub-board-delete" title="Delete sub-board" onclick={(e) => { e.preventDefault(); e.stopPropagation(); confirmDeleteBoard(sb.id, sb.name); }}>
									<svg width="10" height="10" viewBox="0 0 10 10" fill="none"><path d="M2 2l6 6M8 2L2 8" stroke="currentColor" stroke-width="1.5" stroke-linecap="round"/></svg>
								</button>
							</a>
						{/each}
					</div>
				{/if}
			</div>
		{:else}
			<div class="empty-state">
				<span class="empty-icon">🗂️</span>
				<h3>No boards yet</h3>
				<p>Create your first board to get started</p>
			</div>
		{/each}
	</main>
</div>

{#if showCreate}
	<div class="modal-overlay" onclick={() => (showCreate = false)} role="dialog" aria-modal="true">
		<!-- svelte-ignore a11y_click_events_have_key_events -->
		<div class="modal-content" onclick={(e) => e.stopPropagation()} role="document">
			<h2>Create New Board</h2>
			<div class="form-group">
				<label for="board-name">Board name</label>
				<input
					id="board-name"
					type="text"
					placeholder="e.g. Sprint 23, Side Project..."
					bind:value={newBoardName}
					onkeydown={(e) => e.key === 'Enter' && createBoard()}
					autofocus
				/>
			</div>
			<div class="form-group">
				<label>Icon</label>
				<EmojiPicker value={newBoardEmoji} onSelect={(e) => (newBoardEmoji = e)} />
			</div>
			<div class="modal-actions">
				<button class="btn-ghost" onclick={() => (showCreate = false)}>Cancel</button>
				<button class="btn-primary" onclick={createBoard} disabled={!newBoardName.trim()}>
					Create Board
				</button>
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

{#if showUserSetup}
	<UserSetup onComplete={() => (showUserSetup = false)} />
{/if}

<style>
	.dashboard {
		max-width: 1000px;
		margin: 0 auto;
		padding: var(--space-2xl) var(--space-xl);
	}

	.dashboard-header {
		display: flex;
		align-items: center;
		justify-content: space-between;
		margin-bottom: var(--space-3xl);
		padding-bottom: var(--space-xl);
		border-bottom: 1px solid var(--glass-border);
	}

	.header-actions {
		display: flex;
		align-items: center;
		gap: var(--space-sm);
	}

	.theme-toggle {
		font-size: 0;
	}

	.brand {
		display: flex;
		align-items: center;
		gap: var(--space-lg);
	}

	.brand-icon {
		font-size: 2.5rem;
		filter: drop-shadow(0 0 12px rgba(245, 158, 11, 0.4));
	}

	.brand h1 {
		font-size: 1.75rem;
		background: linear-gradient(135deg, var(--text-primary), var(--accent-purple));
		-webkit-background-clip: text;
		-webkit-text-fill-color: transparent;
		background-clip: text;
	}

	.brand-tagline {
		color: var(--text-secondary);
		font-size: 0.85rem;
		font-weight: 400;
	}

	.boards-grid {
		display: grid;
		grid-template-columns: repeat(auto-fill, minmax(280px, 1fr));
		gap: var(--space-lg);
	}

	.board-card {
		position: relative;
		display: flex;
		align-items: center;
		gap: var(--space-lg);
		padding: var(--space-xl);
		border-radius: var(--radius-lg);
		color: var(--text-primary);
		text-decoration: none;
		overflow: hidden;
		transition: all var(--duration-normal) var(--ease-out);
	}

	.board-card:hover {
		transform: translateY(-2px);
		box-shadow: var(--shadow-lg);
	}

	.board-card:hover .board-card-glow {
		opacity: 1;
	}

	.board-card-glow {
		position: absolute;
		top: 0;
		left: 0;
		right: 0;
		height: 2px;
		background: linear-gradient(90deg, var(--accent-purple), var(--accent-cyan));
		opacity: 0;
		transition: opacity var(--duration-normal) var(--ease-out);
	}

	.board-card-emoji {
		font-size: 2rem;
		flex-shrink: 0;
	}

	.board-card-info {
		flex: 1;
		min-width: 0;
	}

	.board-card-info h3 {
		font-size: 1rem;
		font-weight: 600;
		white-space: nowrap;
		overflow: hidden;
		text-overflow: ellipsis;
	}

	.board-card-date {
		font-size: 0.75rem;
		color: var(--text-tertiary);
	}
	.board-card-stats {
		display: flex; align-items: center; gap: 6px; margin-top: 2px;
	}
	.board-card-count {
		font-size: 0.7rem; color: var(--text-tertiary); font-weight: 600; white-space: nowrap;
	}
	.board-card-progress {
		flex: 1; height: 4px; background: var(--glass-bg); border-radius: 2px; overflow: hidden; min-width: 40px;
	}
	.board-card-progress-fill {
		height: 100%; background: var(--accent-indigo); border-radius: 2px; transition: width 0.3s;
	}
	.board-card-pct {
		font-size: 0.6rem; font-weight: 700; color: var(--accent-indigo); white-space: nowrap;
	}

	.all-tasks-card {
		grid-column: 1 / -1;
		background: linear-gradient(135deg, var(--glass-bg), rgba(99, 102, 241, 0.06)) !important;
		border: 1px solid rgba(99, 102, 241, 0.2);
	}

	.all-tasks-card:hover {
		border-color: rgba(99, 102, 241, 0.4);
	}

	.all-glow {
		background: linear-gradient(90deg, #6366f1, #a855f7, #06b6d4) !important;
		opacity: 0.6 !important;
	}

	.all-tasks-card:hover .all-glow {
		opacity: 1 !important;
	}

	.all-progress {
		background: linear-gradient(90deg, #6366f1, #a855f7) !important;
	}

	.board-card-wrapper {
		display: flex;
		flex-direction: column;
	}

	.sub-boards-list {
		display: flex;
		flex-direction: column;
		gap: 1px;
		padding-left: var(--space-xl);
		margin-top: -2px;
	}

	.sub-board-item {
		display: flex;
		align-items: center;
		gap: var(--space-sm);
		padding: 6px var(--space-md);
		border-radius: 0 0 var(--radius-sm) var(--radius-sm);
		text-decoration: none;
		color: var(--text-secondary);
		font-size: 0.75rem;
		transition: all var(--duration-fast) var(--ease-out);
		background: var(--glass-bg);
		border: 1px solid var(--glass-border);
		border-top: none;
	}

	.sub-board-item:first-child {
		border-top: 1px solid var(--glass-border);
		border-radius: 0;
	}

	.sub-board-item:last-child {
		border-radius: 0 0 var(--radius-md) var(--radius-md);
	}

	.sub-board-item:hover {
		background: rgba(99, 102, 241, 0.06);
		color: var(--text-primary);
	}

	.sub-board-connector {
		width: 12px;
		height: 1px;
		background: var(--glass-border);
		flex-shrink: 0;
	}

	.sub-board-emoji {
		font-size: 0.8rem;
		flex-shrink: 0;
	}

	.sub-board-name {
		flex: 1;
		min-width: 0;
		overflow: hidden;
		text-overflow: ellipsis;
		white-space: nowrap;
		font-weight: 500;
	}

	.sub-board-progress {
		font-size: 0.65rem;
		font-weight: 700;
		padding: 1px 6px;
		border-radius: var(--radius-full);
		background: rgba(99, 102, 241, 0.1);
		color: #818cf8;
		white-space: nowrap;
	}

	.sub-board-progress.complete {
		background: rgba(16, 185, 129, 0.1);
		color: #10b981;
	}

	.sub-board-progress.empty {
		background: var(--glass-bg);
		color: var(--text-tertiary);
	}

	.sub-board-delete {
		flex-shrink: 0;
		width: 24px; height: 24px;
		display: flex; align-items: center; justify-content: center;
		border-radius: var(--radius-sm);
		background: transparent; border: none;
		color: var(--text-tertiary); cursor: pointer;
		opacity: 0.4; transition: all 0.15s;
	}
	.sub-board-item:hover .sub-board-delete { opacity: 0.8; }
	.sub-board-delete:hover { opacity: 1 !important; color: var(--accent-rose); background: rgba(244, 63, 94, 0.15); }

	.board-delete-btn {
		position: absolute;
		top: var(--space-sm);
		right: var(--space-sm);
		width: 28px;
		height: 28px;
		display: flex;
		align-items: center;
		justify-content: center;
		border-radius: var(--radius-sm);
		background: transparent;
		color: var(--text-tertiary);
		opacity: 0;
		transition: all var(--duration-fast) var(--ease-out);
	}

	.board-card:hover .board-delete-btn {
		opacity: 1;
	}

	.board-delete-btn:hover {
		background: rgba(244, 63, 94, 0.15);
		color: var(--accent-rose);
	}

	.empty-state {
		grid-column: 1 / -1;
		text-align: center;
		padding: var(--space-3xl);
		color: var(--text-secondary);
	}

	.empty-icon {
		font-size: 3rem;
		display: block;
		margin-bottom: var(--space-lg);
	}

	.empty-state h3 {
		margin-bottom: var(--space-sm);
		color: var(--text-primary);
	}

	/* Modal form */
	.form-group {
		margin-top: var(--space-xl);
	}

	.form-group label {
		display: block;
		font-size: 0.8rem;
		font-weight: 600;
		color: var(--text-secondary);
		text-transform: uppercase;
		letter-spacing: 0.05em;
		margin-bottom: var(--space-sm);
	}

	.emoji-picker {
		display: flex;
		flex-wrap: wrap;
		gap: var(--space-sm);
	}

	.emoji-btn {
		width: 40px;
		height: 40px;
		display: flex;
		align-items: center;
		justify-content: center;
		font-size: 1.25rem;
		border-radius: var(--radius-md);
		background: var(--bg-base);
		border: 1px solid var(--glass-border);
	}

	.emoji-btn:hover {
		border-color: var(--accent-purple);
		background: var(--bg-elevated);
	}

	.emoji-btn.active {
		border-color: var(--accent-purple);
		background: var(--accent-purple-glow);
		box-shadow: var(--shadow-glow-purple);
	}

	.modal-actions {
		display: flex;
		justify-content: flex-end;
		gap: var(--space-md);
		margin-top: var(--space-2xl);
	}

	.spinner {
		width: 12px;
		height: 12px;
		border: 2px solid var(--text-tertiary);
		border-top-color: transparent;
		border-radius: 50%;
		animation: spin 0.6s linear infinite;
	}

	@keyframes spin {
		to { transform: rotate(360deg); }
	}
</style>
