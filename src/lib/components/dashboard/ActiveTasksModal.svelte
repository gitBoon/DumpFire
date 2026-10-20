<!--
  ActiveTasksModal.svelte — The dashboard's Active Tasks window: the open
  cards assigned to the viewer, by board, read as it opens (card 2281,
  slice C2: moved from src/routes/+page.svelte).

  `openActiveTasksModal` is exported: the page reaches it with `bind:this`
  for the sidebar's Active Tasks tile. A card's due words are read on the
  page's clock, as the sidebar's due figures are. Drawn by the page where
  it was, after the failure toast.
-->
<script lang="ts">
	import { daysUntilDue } from '$lib/utils/date-utils';

	/** The page's: the viewer's moment once the page is up, null until then (card 2258). */
	let { clock }: { clock: Date | null } = $props();

	// Active Tasks Modal
	type ActiveTaskBoard = {
		boardId: number;
		boardName: string;
		boardEmoji: string;
		cards: {
			id: number;
			title: string;
			priority: string;
			dueDate: string | null;
			columnName: string;
			createdAt: string;
		}[];
	};
	let showActiveTasksModal = $state(false);
	let activeTasksData = $state<ActiveTaskBoard[]>([]);
	let activeTasksLoading = $state(false);

	export async function openActiveTasksModal() {
		showActiveTasksModal = true;
		activeTasksLoading = true;
		try {
			const res = await fetch('/api/my-tasks');
			if (res.ok) {
				activeTasksData = await res.json();
			}
		} catch { /* silent */ }
		activeTasksLoading = false;
	}

	function priorityIcon(p: string): string {
		switch (p) {
			case 'critical': return '🔴';
			case 'high': return '🟠';
			case 'medium': return '🟡';
			case 'low': return '🟢';
			default: return '⚪';
		}
	}

	/**
	 * A card's due date in words, counted in calendar days from the viewer's own
	 * today (card 2241). `clock` is read so that the Active Tasks list's words
	 * move on at midnight, on the due figures' tick (card 2258).
	 */
	function dueText(dateStr: string | null): string | null {
		void clock;
		if (!dateStr) return null;
		const d = daysUntilDue(dateStr);
		if (d === null) return null;
		if (d < 0) return `${Math.abs(d)}d overdue`;
		if (d === 0) return 'Today';
		if (d === 1) return 'Tomorrow';
		return `${d} days`;
	}
</script>

{#if showActiveTasksModal}
	<div class="modal-overlay" role="dialog" aria-modal="true" onclick={() => showActiveTasksModal = false}>
		<!-- svelte-ignore a11y_click_events_have_key_events -->
		<!-- svelte-ignore a11y_no_static_element_interactions -->
		<div class="modal-content active-tasks-modal" onclick={(e) => e.stopPropagation()}>
			<div class="atm-header">
				<div class="atm-header-left">
					<span class="atm-icon">⚡</span>
					<div>
						<h2>Active Tasks</h2>
						<p class="atm-subtitle">
							{activeTasksData.reduce((t, g) => t + g.cards.length, 0)} tasks across {activeTasksData.length} board{activeTasksData.length !== 1 ? 's' : ''}
						</p>
					</div>
				</div>
				<button class="atm-close" onclick={() => showActiveTasksModal = false}>✕</button>
			</div>

			{#if activeTasksLoading}
				<div class="atm-loading">
					<span class="spinner atm-spinner"></span>
					<span>Loading tasks…</span>
				</div>
			{:else if activeTasksData.length === 0}
				<div class="atm-empty">
					<span class="atm-empty-icon">🎉</span>
					<p>No active tasks assigned to you!</p>
					<p class="atm-empty-sub">You're all caught up.</p>
				</div>
			{:else}
				<div class="atm-board-list">
					{#each activeTasksData as group}
						<div class="atm-board-group">
							<a href="/board/{group.boardId}" class="atm-board-header">
								<span class="atm-board-emoji">{group.boardEmoji}</span>
								<span class="atm-board-name">{group.boardName}</span>
								<span class="atm-board-count">{group.cards.length}</span>
								<svg class="atm-board-arrow" width="12" height="12" viewBox="0 0 12 12" fill="none"><path d="M4 2l4 4-4 4" stroke="currentColor" stroke-width="1.5" stroke-linecap="round" stroke-linejoin="round"/></svg>
							</a>
							<div class="atm-card-list">
								{#each group.cards as card}
									<a href="/board/{group.boardId}?card={card.id}" class="atm-card-row">
										<span class="atm-card-priority" title={card.priority}>{priorityIcon(card.priority)}</span>
										<div class="atm-card-info">
											<span class="atm-card-title">{card.title}</span>
											<div class="atm-card-meta">
												<span class="atm-card-col">{card.columnName}</span>
												{#if card.dueDate}
													{@const dueWords = dueText(card.dueDate)}
													{#if dueWords}
														<span class="atm-card-due" class:overdue={dueWords.includes('overdue')} class:today={dueWords === 'Today'} class:soon={dueWords === 'Tomorrow'}>
															📅 {dueWords}
														</span>
													{/if}
												{/if}
											</div>
										</div>
										<span class="atm-card-id">#{card.id}</span>
									</a>
								{/each}
							</div>
						</div>
					{/each}
				</div>
			{/if}
		</div>
	</div>
{/if}

<style>
	/* Copied from BoardsTable.svelte, with its keyframes: this window is drawn outside .dashboard, where no page rule reaches. */
	.spinner {
		width: 12px; height: 12px;
		border: 2px solid var(--text-tertiary); border-top-color: transparent;
		border-radius: 50%; animation: spin 0.6s linear infinite;
	}
	@keyframes spin { to { transform: rotate(360deg); } }

	/* ─── Active Tasks Modal ────────────────────────────────── */
	.active-tasks-modal {
		max-width: 680px;
		max-height: 80vh;
		padding: 0;
		overflow: hidden;
		display: flex;
		flex-direction: column;
	}
	.atm-header {
		display: flex; align-items: center; justify-content: space-between;
		padding: var(--space-lg) var(--space-xl);
		border-bottom: 1px solid var(--glass-border);
		background: var(--bg-surface);
		flex-shrink: 0;
	}
	.atm-header-left {
		display: flex; align-items: center; gap: var(--space-md);
	}
	.atm-icon { font-size: 1.5rem; }
	.atm-header h2 {
		font-size: 1.1rem; font-weight: 800; color: var(--text-primary);
		margin: 0; letter-spacing: -0.02em;
	}
	.atm-subtitle {
		font-size: 0.7rem; color: var(--text-tertiary); font-weight: 500; margin-top: 2px;
	}
	.atm-close {
		width: 28px; height: 28px; border-radius: var(--radius-sm);
		background: transparent; border: none; color: var(--text-tertiary);
		font-size: 0.9rem; cursor: pointer; display: flex; align-items: center;
		justify-content: center; transition: all var(--duration-fast);
	}
	.atm-close:hover { background: var(--glass-hover); color: var(--text-primary); }

	.atm-loading {
		display: flex; align-items: center; justify-content: center; gap: var(--space-md);
		padding: var(--space-3xl); color: var(--text-tertiary); font-size: 0.85rem;
	}
	.atm-spinner { width: 18px; height: 18px; }

	.atm-empty {
		text-align: center; padding: var(--space-3xl) var(--space-xl);
	}
	.atm-empty-icon { font-size: 2.5rem; display: block; margin-bottom: var(--space-md); }
	.atm-empty p { font-size: 0.9rem; font-weight: 600; color: var(--text-primary); margin: 0; }
	.atm-empty-sub { font-size: 0.75rem; color: var(--text-tertiary); margin-top: 4px !important; font-weight: 400; }

	.atm-board-list {
		flex: 1; overflow-y: auto; padding: var(--space-md) var(--space-xl) var(--space-xl);
		display: flex; flex-direction: column; gap: var(--space-md);
	}

	.atm-board-group {
		background: var(--bg-card); border: 1px solid var(--glass-border);
		border-radius: var(--radius-lg); overflow: hidden;
	}
	.atm-board-header {
		display: flex; align-items: center; gap: var(--space-sm);
		padding: var(--space-sm) var(--space-md);
		background: var(--glass-bg); border-bottom: 1px solid var(--glass-border);
		text-decoration: none; color: inherit;
		transition: all var(--duration-fast) var(--ease-out);
	}
	.atm-board-header:hover {
		background: rgba(99, 102, 241, 0.06);
	}
	.atm-board-emoji { font-size: 0.95rem; flex-shrink: 0; }
	.atm-board-name {
		flex: 1; font-size: 0.78rem; font-weight: 700; color: var(--text-primary);
		text-transform: uppercase; letter-spacing: 0.04em;
		white-space: nowrap; overflow: hidden; text-overflow: ellipsis;
	}
	.atm-board-count {
		min-width: 20px; height: 20px; display: flex; align-items: center;
		justify-content: center; border-radius: var(--radius-full);
		background: rgba(99, 102, 241, 0.12); color: var(--accent-indigo);
		font-size: 0.65rem; font-weight: 800; flex-shrink: 0; padding: 0 6px;
	}
	.atm-board-arrow {
		color: var(--text-tertiary); flex-shrink: 0;
		transition: transform var(--duration-fast); opacity: 0;
	}
	.atm-board-header:hover .atm-board-arrow {
		opacity: 1; transform: translateX(2px);
	}

	.atm-card-list {
		display: flex; flex-direction: column;
	}
	.atm-card-row {
		display: flex; align-items: center; gap: var(--space-sm);
		padding: 8px var(--space-md);
		border-bottom: 1px solid var(--glass-border);
		text-decoration: none; color: inherit;
		transition: background var(--duration-fast) var(--ease-out);
	}
	.atm-card-row:last-child { border-bottom: none; }
	.atm-card-row:hover { background: rgba(99, 102, 241, 0.04); }

	.atm-card-priority { font-size: 0.7rem; flex-shrink: 0; }
	.atm-card-info { flex: 1; min-width: 0; display: flex; flex-direction: column; gap: 2px; }
	.atm-card-title {
		font-size: 0.82rem; font-weight: 600; color: var(--text-primary);
		white-space: nowrap; overflow: hidden; text-overflow: ellipsis;
	}
	.atm-card-meta {
		display: flex; align-items: center; gap: 8px;
	}
	.atm-card-col {
		font-size: 0.62rem; font-weight: 600; color: var(--text-tertiary);
		background: var(--glass-bg); padding: 1px 6px; border-radius: var(--radius-sm);
		border: 1px solid var(--glass-border); text-transform: uppercase;
		letter-spacing: 0.03em;
	}
	.atm-card-due {
		font-size: 0.62rem; font-weight: 600; color: var(--text-secondary);
	}
	.atm-card-due.overdue { color: var(--accent-rose, #f43f5e); font-weight: 700; }
	.atm-card-due.today { color: var(--priority-high, #ea580c); font-weight: 700; }
	.atm-card-due.soon { color: var(--accent-amber, #f59e0b); }
	.atm-card-id {
		font-family: var(--font-mono); font-size: 0.62rem; font-weight: 600;
		color: var(--text-tertiary); opacity: 0.6; flex-shrink: 0;
	}
</style>
