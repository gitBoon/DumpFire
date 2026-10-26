<!--
  MoveCardModal.svelte — All Tasks' Move window: a card moved to any column
  of any board the viewer can see, a refusal said in the server's words with
  the window left open (card 2281, slice C3a-2: moved from
  src/routes/all/+page.svelte).

  `openMoveModal` is exported: the page reaches it with `bind:this` for each
  card's Move button. Drawn by the page where it was, after the shared
  toast.
-->
<script lang="ts">
	import type { PageData } from '../../../routes/all/$types';
	import { invalidateAll } from '$app/navigation';
	import { toasts } from '$lib/stores/toast';
	import { isCompleteColumnTitle, isOptionsColumn } from '$lib/column-role';
	import { answerBody, failureMessage, leftMilestoneNotice } from '$lib/api';
	import { commitmentToasts } from '$lib/board/dnd-handlers';
	import { playMoveSound, playCompleteSound } from '$lib/utils/sounds';

	/** What All Tasks' load gave it, passed on as it is. */
	let { data }: { data: PageData } = $props();

	let showMoveModal = $state(false);
	let moveCard = $state<any>(null);
	let moveBoardId = $state<number | null>(null);
	let moveColumnId = $state<number | null>(null);

	export function openMoveModal(card: any) {
		moveCard = card;
		moveBoardId = card.boardId;
		moveColumnId = card.columnId;
		showMoveModal = true;
	}

	async function doMoveCard() {
		if (!moveCard || !moveColumnId) return;

		// Check if moving to a "complete" column for sound effect
		const targetCol = data.columns.find((c: any) => c.id === moveColumnId);
		const isCompletingMove = targetCol && isCompleteColumnTitle(targetCol.title);

		// A refusal, such as a card with open subtasks moved to Complete, is
		// said in the server's words, and the window stays open. It used to
		// close as if the card had moved.
		const started = toasts.navigation();
		let res: Response;
		try {
			res = await fetch(`/api/cards/${moveCard.id}`, {
				method: 'PUT',
				headers: { 'Content-Type': 'application/json' },
				body: JSON.stringify({ columnId: moveColumnId, boardId: moveBoardId })
			});
		} catch {
			toasts.add('No answer from the server. The card may not have been moved.', 'error', started);
			return;
		}
		if (!res.ok) {
			toasts.add(await failureMessage(res, 'The card was not moved.'), 'error', started);
			return;
		}

		// A move to another board takes the card out of a milestone of the board
		// it left, for good: say so (card 2155, the review's O3).
		const answer = await answerBody(res);
		const leftGoal = leftMilestoneNotice(answer);
		if (leftGoal) toasts.add(leftGoal, 'info');
		// And a move across the commitment point, as the board's drag says it
		// (milestone 22, the S2 review's C7).
		for (const message of commitmentToasts(answer, [moveCard])) toasts.add(message);

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

	function getBoardColumns(boardId: number) {
		return data.columns.filter((c: any) => c.boardId === boardId);
	}
</script>

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
							<option value={col.id}>{col.title}{isOptionsColumn(col) ? ' (Options)' : ''}</option>
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
