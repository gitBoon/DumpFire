<script lang="ts">
	/**
	 * Archived Tasks Page — View, restore, and permanently delete archived cards.
	 *
	 * Accessible from the dashboard nav. Supports search, board filtering,
	 * individual restore/delete, and bulk purge (admin only).
	 */
	import type { PageData } from './$types';
	import { invalidateAll } from '$app/navigation';
	import { theme } from '$lib/stores/theme';
	import ThemePicker from '$lib/components/ThemePicker.svelte';

	let { data }: { data: PageData } = $props();

	let currentTheme = $state('light');
	theme.subscribe((v) => (currentTheme = v));

	let searchQuery = $state('');
	let boardFilter = $state('all');
	let purging = $state(false);

	// Confirmation modal
	let confirmState = $state<{ show: boolean; title: string; message: string; confirmText: string; onConfirm: () => void }>({
		show: false, title: '', message: '', confirmText: '', onConfirm: () => {}
	});

	function showConfirm(title: string, message: string, confirmText: string, onConfirm: () => void) {
		confirmState = { show: true, title, message, confirmText, onConfirm };
	}

	const priorityEmoji: Record<string, string> = { critical: '🔴', high: '🟠', medium: '🟡', low: '🟢' };

	let filteredCards = $derived(
		data.archivedCards.filter(card => {
			if (boardFilter !== 'all' && card.boardId !== Number(boardFilter)) return false;
			if (!searchQuery.trim()) return true;
			const q = searchQuery.toLowerCase();
			return card.title.toLowerCase().includes(q) || card.description?.toLowerCase().includes(q);
		})
	);

	let boardOptions = $derived(() => {
		const seen = new Map<number, { name: string; emoji: string }>();
		for (const card of data.archivedCards) {
			if (!seen.has(card.boardId)) {
				seen.set(card.boardId, { name: card.boardName, emoji: card.boardEmoji });
			}
		}
		return Array.from(seen.entries()).map(([id, info]) => ({ id, ...info })).sort((a, b) => a.name.localeCompare(b.name));
	});

	function formatArchiveDate(dateStr: string | null): string {
		if (!dateStr) return 'Unknown';
		const d = new Date(dateStr.endsWith('Z') ? dateStr : dateStr + 'Z');
		if (isNaN(d.getTime())) return 'Unknown';
		const diff = Math.floor((Date.now() - d.getTime()) / 1000);
		if (diff < 60) return 'just now';
		if (diff < 3600) return `${Math.floor(diff / 60)}m ago`;
		if (diff < 86400) return `${Math.floor(diff / 3600)}h ago`;
		if (diff < 604800) return `${Math.floor(diff / 86400)}d ago`;
		return d.toLocaleDateString('en-GB', { day: 'numeric', month: 'short', year: 'numeric' });
	}

	async function restoreCard(cardId: number) {
		await fetch(`/api/cards/${cardId}/restore`, { method: 'POST' });
		await invalidateAll();
	}

	async function permanentlyDeleteCard(cardId: number, cardTitle: string) {
		showConfirm(
			'Delete Permanently',
			`Permanently delete "${cardTitle}"? This cannot be undone. All subtasks, labels, and assignees will be removed.`,
			'Delete Forever',
			async () => {
				await fetch(`/api/cards/${cardId}?permanent=true`, {
					method: 'DELETE',
					headers: { 'Content-Type': 'application/json' },
					body: JSON.stringify({})
				});
				confirmState.show = false;
				await invalidateAll();
			}
		);
	}

	async function purgeAll() {
		showConfirm(
			'Purge All Archived Cards',
			`Permanently delete ALL ${data.archivedCards.length} archived card${data.archivedCards.length !== 1 ? 's' : ''}? This removes all their subtasks, labels, and assignees. This cannot be undone.`,
			'Purge All',
			async () => {
				purging = true;
				confirmState.show = false;
				try {
					await fetch('/api/admin/purge-archived', { method: 'POST' });
					await invalidateAll();
				} finally {
					purging = false;
				}
			}
		);
	}
</script>

<svelte:head>
	<title>DumpFire — Archived Tasks</title>
</svelte:head>

<div class="archived-page">
	<header class="archived-header">
		<div class="archived-header-left">
			<a href="/" class="back-btn btn-ghost" id="back-to-dashboard">
				<svg width="18" height="18" viewBox="0 0 18 18" fill="none"><path d="M11 4L6 9l5 5" stroke="currentColor" stroke-width="2" stroke-linecap="round" stroke-linejoin="round"/></svg>
			</a>
			<span class="archived-icon">🗄️</span>
			<div>
				<h1 class="archived-title">Archived Tasks</h1>
				<p class="archived-subtitle">{data.archivedCards.length} archived card{data.archivedCards.length !== 1 ? 's' : ''}{filteredCards.length !== data.archivedCards.length ? ` · ${filteredCards.length} shown` : ''}</p>
			</div>
		</div>
		<div class="archived-header-right">
			<select class="board-filter" bind:value={boardFilter}>
				<option value="all">All Boards</option>
				{#each boardOptions() as board}
					<option value={board.id}>{board.emoji} {board.name}</option>
				{/each}
			</select>
			<div class="search-wrapper">
				<svg class="search-icon" width="14" height="14" viewBox="0 0 14 14" fill="none">
					<circle cx="6" cy="6" r="4.5" stroke="currentColor" stroke-width="1.5"/>
					<path d="M10 10l3 3" stroke="currentColor" stroke-width="1.5" stroke-linecap="round"/>
				</svg>
				<input type="text" class="search-input" placeholder="Search archived..." bind:value={searchQuery} />
			</div>
			{#if data.isAdmin && data.archivedCards.length > 0}
				<button class="btn-danger purge-btn" onclick={purgeAll} disabled={purging}>
					{purging ? '⏳ Purging...' : '🗑️ Purge All'}
				</button>
			{/if}
			<ThemePicker />
		</div>
	</header>

	<div class="archived-content">
		{#if data.archivedCards.length === 0}
			<div class="empty-state glass">
				<span class="empty-icon">📦</span>
				<h3>No archived cards</h3>
				<p>Deleted cards will appear here for recovery</p>
			</div>
		{:else if filteredCards.length === 0}
			<div class="empty-state glass">
				<span class="empty-icon">🔍</span>
				<h3>No matches</h3>
				<p>No archived cards match your search or filter</p>
			</div>
		{:else}
			<div class="archived-list">
				{#each filteredCards as card (card.id)}
					<div class="archived-card glass animate-fade-in">
						<div class="archived-card-main">
							<div class="archived-card-priority">
								<span class="priority-dot priority-{card.priority}" title={card.priority}>{priorityEmoji[card.priority] || '🟡'}</span>
							</div>
							<div class="archived-card-info">
								<span class="archived-card-title">{card.title}</span>
								<div class="archived-card-meta">
									<span class="archived-card-board">{card.boardEmoji} {card.boardName}</span>
									<span class="archived-card-date">Archived {formatArchiveDate(card.archivedAt)}</span>
								</div>
							</div>
						</div>
						<div class="archived-card-actions">
							<button class="btn-ghost action-btn restore-btn" onclick={() => restoreCard(card.id)} title="Restore to board">
								↩️ Restore
							</button>
							<button class="btn-ghost action-btn delete-btn" onclick={() => permanentlyDeleteCard(card.id, card.title)} title="Delete permanently">
								🗑️ Delete
							</button>
						</div>
					</div>
				{/each}
			</div>
		{/if}
	</div>
</div>

<!-- Confirm Modal -->
{#if confirmState.show}
	<!-- svelte-ignore a11y_click_events_have_key_events -->
	<div class="modal-overlay" role="dialog" aria-modal="true" onclick={() => confirmState.show = false}>
		<!-- svelte-ignore a11y_click_events_have_key_events -->
		<div class="confirm-modal glass" onclick={(e) => e.stopPropagation()} role="document">
			<h2>{confirmState.title}</h2>
			<p>{confirmState.message}</p>
			<div class="modal-actions">
				<button class="btn-ghost" onclick={() => confirmState.show = false}>Cancel</button>
				<button class="btn-danger" onclick={confirmState.onConfirm}>{confirmState.confirmText}</button>
			</div>
		</div>
	</div>
{/if}

<style>
	.archived-page {
		min-height: 100vh;
		padding: 0 var(--space-xl) var(--space-2xl);
	}

	.archived-header {
		display: flex;
		align-items: center;
		justify-content: space-between;
		padding: var(--space-lg) 0;
		gap: var(--space-lg);
		flex-wrap: wrap;
		position: sticky;
		top: 0;
		z-index: 100;
		backdrop-filter: blur(24px);
		-webkit-backdrop-filter: blur(24px);
		margin: 0 calc(-1 * var(--space-xl));
		padding-left: var(--space-xl);
		padding-right: var(--space-xl);
	}

	.archived-header-left {
		display: flex;
		align-items: center;
		gap: var(--space-sm);
	}

	.archived-header-right {
		display: flex;
		align-items: center;
		gap: var(--space-sm);
		flex-wrap: wrap;
	}

	.archived-icon { font-size: 1.75rem; }

	.archived-title {
		font-size: 1.3rem;
		font-weight: 800;
		letter-spacing: -0.02em;
		color: var(--text-primary);
		margin: 0;
	}

	.archived-subtitle {
		font-size: 0.78rem;
		color: var(--text-tertiary);
		margin: 0;
	}

	.board-filter {
		padding: var(--space-xs) var(--space-md);
		border: 1px solid var(--glass-border);
		border-radius: var(--radius-sm);
		background: var(--bg-elevated);
		color: var(--text-primary);
		font-size: 0.82rem;
		font-family: var(--font-family);
		cursor: pointer;
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
		padding: var(--space-xs) var(--space-md) var(--space-xs) 30px;
		border: 1px solid var(--glass-border);
		border-radius: var(--radius-sm);
		background: var(--bg-elevated);
		color: var(--text-primary);
		font-size: 0.82rem;
		font-family: var(--font-family);
		width: 200px;
		transition: border-color 0.2s ease;
	}

	.search-input:focus {
		border-color: var(--accent-indigo);
		outline: none;
	}

	.btn-danger {
		padding: var(--space-xs) var(--space-md);
		border: none;
		border-radius: var(--radius-sm);
		background: var(--accent-rose);
		color: white;
		font-size: 0.82rem;
		font-weight: 600;
		font-family: var(--font-family);
		cursor: pointer;
		white-space: nowrap;
		transition: all 0.2s ease;
	}

	.btn-danger:hover { background: #e11d48; transform: scale(1.02); }
	.btn-danger:disabled { opacity: 0.6; cursor: not-allowed; transform: none; }

	.archived-content {
		max-width: 900px;
		margin: 0 auto;
	}

	.empty-state {
		text-align: center;
		padding: var(--space-2xl);
		border-radius: var(--radius-lg);
		margin-top: var(--space-xl);
	}

	.empty-icon { font-size: 3rem; display: block; margin-bottom: var(--space-md); }
	.empty-state h3 { font-size: 1.1rem; color: var(--text-primary); margin: 0 0 var(--space-xs); }
	.empty-state p { font-size: 0.85rem; color: var(--text-tertiary); margin: 0; }

	.archived-list {
		display: flex;
		flex-direction: column;
		gap: var(--space-sm);
		margin-top: var(--space-md);
	}

	.archived-card {
		display: flex;
		align-items: center;
		justify-content: space-between;
		padding: var(--space-md) var(--space-lg);
		border-radius: var(--radius-md);
		transition: transform 0.15s ease, border-color 0.15s ease;
		gap: var(--space-md);
	}

	.archived-card:hover {
		transform: translateX(2px);
		border-color: var(--accent-indigo);
	}

	.archived-card-main {
		display: flex;
		align-items: center;
		gap: var(--space-md);
		flex: 1;
		min-width: 0;
	}

	.archived-card-priority {
		flex-shrink: 0;
	}

	.priority-dot {
		font-size: 0.9rem;
	}

	.archived-card-info {
		display: flex;
		flex-direction: column;
		min-width: 0;
	}

	.archived-card-title {
		font-weight: 600;
		font-size: 0.9rem;
		color: var(--text-primary);
		white-space: nowrap;
		overflow: hidden;
		text-overflow: ellipsis;
	}

	.archived-card-meta {
		display: flex;
		align-items: center;
		gap: var(--space-md);
		margin-top: 2px;
	}

	.archived-card-board {
		font-size: 0.72rem;
		color: var(--text-secondary);
		white-space: nowrap;
	}

	.archived-card-date {
		font-size: 0.72rem;
		color: var(--text-tertiary);
		white-space: nowrap;
	}

	.archived-card-actions {
		display: flex;
		gap: var(--space-xs);
		flex-shrink: 0;
	}

	.action-btn {
		font-size: 0.78rem !important;
		padding: var(--space-xs) var(--space-sm) !important;
		white-space: nowrap;
		transition: transform 0.15s ease;
	}

	.action-btn:hover { transform: scale(1.05); }

	.restore-btn { color: var(--accent-emerald) !important; }
	.delete-btn { color: var(--accent-rose) !important; }

	/* Confirm Modal */
	.modal-overlay {
		position: fixed;
		top: 0; left: 0; right: 0; bottom: 0;
		background: rgba(0, 0, 0, 0.5);
		display: flex;
		align-items: center;
		justify-content: center;
		z-index: 9999;
		backdrop-filter: blur(4px);
	}

	.confirm-modal {
		max-width: 420px;
		padding: var(--space-xl);
		border-radius: var(--radius-lg);
	}

	.confirm-modal h2 { font-size: 1.1rem; margin: 0 0 var(--space-sm); color: var(--text-primary); }
	.confirm-modal p { font-size: 0.85rem; color: var(--text-secondary); margin: 0 0 var(--space-xl); line-height: 1.5; }

	.modal-actions {
		display: flex;
		justify-content: flex-end;
		gap: var(--space-md);
	}

	/* Fade in animation */
	.animate-fade-in {
		animation: fadeIn 0.3s ease-out both;
	}

	@keyframes fadeIn {
		from { opacity: 0; transform: translateY(8px); }
		to { opacity: 1; transform: translateY(0); }
	}

	/* Responsive */
	@media (max-width: 768px) {
		.archived-header { flex-direction: column; align-items: flex-start; }
		.archived-header-right { width: 100%; }
		.search-input { width: 100%; }
		.archived-card { flex-direction: column; align-items: flex-start; }
		.archived-card-actions { width: 100%; justify-content: flex-end; }
	}
</style>
