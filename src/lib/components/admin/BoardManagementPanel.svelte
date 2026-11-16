<!--
  BoardManagementPanel.svelte — The admin page's Board Management: each
  board with its Clear Cards, Clear Cats and Delete (card 2281, slice C1b:
  moved from src/routes/admin/+page.svelte).

  Shown to every administrator. Each action asks first through the page's
  own confirm dialog, for the caller's own password too, which it sends (card
  2701); and the page's data is read again after it.
-->
<script lang="ts">
	import type { PageData } from '../../../routes/admin/$types';
	import { invalidateAll } from '$app/navigation';
	import { boardDeleteWarning, clearCardsWarning } from '$lib/api';
	import { sentAsking, showToast } from '$lib/admin/send';
	import { ASKS_FOR_PASSWORD, type StepUpProof } from '$lib/step-up-words';

	let {
		data,
		confirm
	}: {
		/** What the admin page's load gave it, passed on as it is. */
		data: PageData;
		/**
		 * The page's confirm dialog, which asks before each action, and with
		 * `askPassword` for the caller's own password, handed to the action. Text
		 * the action gives back is a refusal of the password, shown in the dialog.
		 */
		confirm: (
			title: string,
			message: string,
			action: (proof: StepUpProof) => Promise<string | null | void>,
			options?: { askPassword?: boolean }
		) => void;
	} = $props();

	// ─── Board Management ─────────────────────────────────────────────────

	async function deleteBoard(id: number, proof: StepUpProof): Promise<string | void> {
		const res = await sentAsking(
			() => fetch(`/api/boards/${id}`, { method: 'DELETE', headers: { 'Content-Type': 'application/json' }, body: JSON.stringify({ currentPassword: proof.currentPassword, currentCode: proof.currentCode }) }),
			'Failed to delete board'
		);
		if (typeof res === 'string') return res;
		if (!res) return;
		await invalidateAll();
		showToast('Board deleted');
	}

	async function clearBoardCards(id: number, proof: StepUpProof): Promise<string | void> {
		const res = await sentAsking(
			() => fetch(`/api/admin/boards/${id}/clear-cards`, { method: 'POST', headers: { 'Content-Type': 'application/json' }, body: JSON.stringify({ currentPassword: proof.currentPassword, currentCode: proof.currentCode }) }),
			'Failed to clear cards'
		);
		if (typeof res === 'string') return res;
		if (!res) return;
		await invalidateAll();
		showToast('All cards cleared from board');
	}

	async function clearBoardCategories(id: number, proof: StepUpProof): Promise<string | void> {
		const res = await sentAsking(
			() => fetch(`/api/admin/boards/${id}/clear-categories`, { method: 'POST', headers: { 'Content-Type': 'application/json' }, body: JSON.stringify({ currentPassword: proof.currentPassword, currentCode: proof.currentCode }) }),
			'Failed to clear categories'
		);
		if (typeof res === 'string') return res;
		if (!res) return;
		await invalidateAll();
		showToast('All categories cleared from board');
	}
</script>

<!-- Board management -->
<section class="admin-card glass fade-in-up" style="animation-delay: 160ms">
	<h2>📋 Board Management</h2>
	<p class="section-desc">Selectively manage or clear data from individual boards.</p>

	{#if data.boards.length === 0}
		<p class="empty-msg">No boards in the database.</p>
	{:else}
		<div class="board-list">
			{#each data.boards as board, i (board.id)}
				<div class="board-row fade-in-up" style="animation-delay: {200 + i * 60}ms">
					<div class="board-info">
						<span class="board-emoji">{board.emoji}</span>
						<div>
							<span class="board-name">{board.name}</span>
							<span class="board-meta">
								ID: {board.id} · {board.columnCount} cols · {board.cardCount} cards · {board.categoryCount} cats
							</span>
						</div>
					</div>
					<div class="board-actions">
						<button class="btn-ghost action-btn" onclick={() => confirm('Clear Cards', clearCardsWarning(board.name), (proof: StepUpProof) => clearBoardCards(board.id, proof), { askPassword: true })}>
							<svg width="12" height="12" viewBox="0 0 12 12" fill="none"><path d="M1 3h10M3 3V2a1 1 0 011-1h4a1 1 0 011 1v1m-6 0v7a1 1 0 001 1h4a1 1 0 001-1V3" stroke="currentColor" stroke-width="1" stroke-linecap="round"/></svg>
							Clear Cards
						</button>
						<button class="btn-ghost action-btn" onclick={() => confirm('Clear Categories', `Remove all categories from "${board.name}"? ${ASKS_FOR_PASSWORD}`, (proof: StepUpProof) => clearBoardCategories(board.id, proof), { askPassword: true })}>
							Clear Cats
						</button>
						<button class="btn-ghost action-btn danger" onclick={() => confirm('Delete Board', boardDeleteWarning(board.name), (proof: StepUpProof) => deleteBoard(board.id, proof), { askPassword: true })}>
							Delete
						</button>
					</div>
				</div>
			{/each}
		</div>
	{/if}
</section>

<style>
	/* Board management */
	.board-list { display: flex; flex-direction: column; gap: var(--space-sm); }
	.board-row {
		display: flex; align-items: center; justify-content: space-between;
		padding: var(--space-md) var(--space-lg); background: var(--bg-base);
		border: 1px solid var(--glass-border); border-radius: var(--radius-md);
		gap: var(--space-md); flex-wrap: wrap;
		transition: border-color 0.2s ease, transform 0.2s ease;
	}
	.board-row:hover { border-color: var(--accent-indigo); transform: translateX(2px); }
	.board-info { display: flex; align-items: center; gap: var(--space-md); }
	.board-emoji { font-size: 1.3rem; }
	.board-name { font-weight: 600; font-size: 0.9rem; display: block; }
	.board-meta { font-size: 0.72rem; color: var(--text-tertiary); }
	.board-actions { display: flex; gap: var(--space-xs); flex-wrap: wrap; }
	.action-btn {
		font-size: 0.72rem !important; padding: var(--space-xs) var(--space-sm) !important;
		display: flex; align-items: center; gap: 4px;
		transition: transform 0.15s ease;
	}
	.action-btn:hover { transform: scale(1.05); }
	.action-btn.danger { color: var(--accent-rose) !important; }
</style>
