<!--
  BoardManagementPanel.svelte — The admin page's Board Management: each
  board with its Clear Cards, Clear Cats and Delete (card 2281, slice C1b:
  moved from src/routes/admin/+page.svelte).

  Shown to every administrator. Each action asks first through the page's
  own confirm dialog, for the caller's own password too, which it sends (card
  2701); and the page's data is read again after it.

  Card 3076: a kit card at the page's #boards, the boards as rows divided by
  a line, each action a quiet button; no row slides or fades in.
-->
<script lang="ts">
	import type { PageData } from '../../../routes/admin/$types';
	import { invalidateAll } from '$app/navigation';
	import { boardDeleteWarning, clearCardsWarning } from '$lib/api';
	import { sentAsking, showToast } from '$lib/admin/send';
	import { codeAskedHere } from '$lib/code-asked';
	import { asksForPassword, type StepUpProof } from '$lib/step-up-words';
	import Button from '$lib/components/ui/Button.svelte';
	import Card from '$lib/components/ui/Card.svelte';
	import CardContent from '$lib/components/ui/CardContent.svelte';
	import CardDescription from '$lib/components/ui/CardDescription.svelte';
	import CardHeader from '$lib/components/ui/CardHeader.svelte';
	import CardTitle from '$lib/components/ui/CardTitle.svelte';
	import EmptyState from '$lib/components/ui/EmptyState.svelte';

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
<Card as="section" id="boards" class="admin-section" aria-labelledby="boards-title">
	<CardHeader>
		<CardTitle level={2} id="boards-title">Board Management</CardTitle>
		<CardDescription>Selectively manage or clear data from individual boards.</CardDescription>
	</CardHeader>
	<CardContent>
		{#if data.boards.length === 0}
			<EmptyState level={3} title="No boards in the database." />
		{:else}
			<div class="board-list admin-rows">
				{#each data.boards as board (board.id)}
					<div class="board-row">
						<div class="board-info">
							<span class="board-emoji">{board.emoji}</span>
							<div class="board-text">
								<span class="board-name">{board.name}</span>
								<span class="board-meta">
									ID: {board.id} · {board.columnCount} cols · {board.cardCount} cards · {board.categoryCount} cats
								</span>
							</div>
						</div>
						<div class="board-actions">
							<Button variant="ghost" size="sm" onclick={() => confirm('Clear Cards', clearCardsWarning(board.name, codeAskedHere()), (proof: StepUpProof) => clearBoardCards(board.id, proof), { askPassword: true })}>
								<svg width="12" height="12" viewBox="0 0 12 12" fill="none" aria-hidden="true"><path d="M1 3h10M3 3V2a1 1 0 011-1h4a1 1 0 011 1v1m-6 0v7a1 1 0 001 1h4a1 1 0 001-1V3" stroke="currentColor" stroke-width="1" stroke-linecap="round"/></svg>
								Clear Cards
							</Button>
							<Button variant="ghost" size="sm" onclick={() => confirm('Clear Categories', `Remove all categories from "${board.name}"? ${asksForPassword(codeAskedHere())}`, (proof: StepUpProof) => clearBoardCategories(board.id, proof), { askPassword: true })}>
								Clear Cats
							</Button>
							<Button variant="ghost" size="sm" class="danger" onclick={() => confirm('Delete Board', boardDeleteWarning(board.name, codeAskedHere()), (proof: StepUpProof) => deleteBoard(board.id, proof), { askPassword: true })}>
								Delete
							</Button>
						</div>
					</div>
				{/each}
			</div>
		{/if}
	</CardContent>
</Card>

<style>
	.board-row {
		display: flex;
		align-items: center;
		justify-content: space-between;
		flex-wrap: wrap;
		gap: var(--space-sm) var(--space-md);
		padding: var(--space-sm) 0;
	}
	.board-row:first-child {
		padding-top: 0;
	}
	.board-row:last-child {
		padding-bottom: 0;
	}
	.board-info {
		display: flex;
		align-items: center;
		gap: var(--space-md);
		min-width: 0;
	}
	.board-emoji {
		font-size: 1.25rem;
	}
	.board-text {
		min-width: 0;
	}
	.board-name {
		display: block;
		font-weight: 500;
		overflow-wrap: anywhere;
	}
	.board-meta {
		font-size: 0.75rem;
		color: var(--ui-muted-foreground);
	}
	.board-actions {
		display: flex;
		flex-wrap: wrap;
		gap: var(--space-xs);
	}
</style>