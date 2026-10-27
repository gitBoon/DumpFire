<!--
  CreateBoardModal.svelte — The dashboard's Create New Board window: the
  name, the icon, its kind (a delivery board, or an ideas board: milestone
  22, card 2463) and the grouping, and Create Board, which opens the new
  board (card 2281, slice C2: moved from src/routes/+page.svelte). A
  sub-board, made from a card, is always a delivery board, and is not made
  here.

  Whether it is open is the page's (`showCreate`, bound here, in the header
  and in the boards table, whose buttons open it). Drawn by the page where
  it was, after the dashboard; what is typed is kept while it is shut.
-->
<script lang="ts">
	import type { PageData } from '../../../routes/$types';
	import { goto } from '$app/navigation';
	import { toasts as failureToasts } from '$lib/stores/toast';
	import { failureMessage } from '$lib/api';
	import EmojiPicker from '$lib/components/EmojiPicker.svelte';

	let {
		data,
		showCreate = $bindable()
	}: {
		/** What the dashboard's load gave it, passed on as it is. */
		data: PageData;
		/** The page's: whether this window is open. */
		showCreate: boolean;
	} = $props();

	let newBoardName = $state('');
	let newBoardEmoji = $state('📋');
	let newBoardCategory = $state<number | null>(null);
	/**
	 * The board's kind (milestone 22, card 2463): a delivery board, as every
	 * board was, or an ideas board, which holds only ideas and sends each on
	 * to a delivery board. Each is made with its own columns.
	 */
	let newBoardKind = $state<'delivery' | 'ideas'>('delivery');

	async function createBoard() {
		if (!newBoardName.trim()) return;
		const started = failureToasts.navigation();
		try {
			const res = await fetch('/api/boards', {
				method: 'POST',
				headers: { 'Content-Type': 'application/json' },
				// The kind only for an ideas board: a delivery board is asked for as it always was, the server's default.
				body: JSON.stringify({ name: newBoardName.trim(), emoji: newBoardEmoji, categoryId: newBoardCategory, ...(newBoardKind === 'ideas' ? { kind: 'ideas' } : {}) })
			});
			if (res.ok) {
				const board = await res.json();
				newBoardName = '';
				newBoardCategory = null;
				newBoardKind = 'delivery';
				showCreate = false;
				goto(`/board/${board.id}`);
			} else {
				failureToasts.add(await failureMessage(res, 'The board was not created.'), 'error', started);
			}
		} catch {
			failureToasts.add('No answer from the server. The board may not have been created.', 'error', started);
		}
	}
</script>

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
			<fieldset class="form-group board-kind">
				<legend>Kind</legend>
				<label class="kind-choice">
					<input type="radio" name="board-kind" value="delivery" bind:group={newBoardKind} />
					Delivery board
				</label>
				<label class="kind-choice">
					<input type="radio" name="board-kind" value="ideas" bind:group={newBoardKind} />
					Ideas board
				</label>
				<p class="kind-hint">
					{newBoardKind === 'ideas'
						? 'An ideas board holds ideas not yet committed to, in New Ideas, Shaping and Ready for Replenishment. Each is sent on to a delivery board when it is chosen.'
						: 'A delivery board holds committed work, in To Do, On Hold, In Progress and Complete, with an Options column at the far left for ideas not yet committed to, folded away until it is opened.'}
				</p>
			</fieldset>
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

<style>
	.category-select {
		width: 100%; padding: var(--space-sm) var(--space-md);
		background: var(--bg-surface); border: 1px solid var(--glass-border);
		border-radius: var(--radius-md); color: var(--text-primary);
		font-family: var(--font-family); font-size: 0.85rem;
	}
	.category-select:focus { outline: none; border-color: var(--accent-indigo); }

	.form-group { margin-top: var(--space-xl); }
	.form-group label, .board-kind legend {
		display: block; font-size: 0.8rem; font-weight: 600; color: var(--text-secondary);
		text-transform: uppercase; letter-spacing: 0.05em; margin-bottom: var(--space-sm);
	}
	.board-kind { border: none; padding: 0; }
	.form-group label.kind-choice {
		display: inline-flex; align-items: center; gap: var(--space-xs); margin-right: var(--space-lg);
		font-size: 0.88rem; font-weight: 500; text-transform: none; letter-spacing: normal; color: var(--text-primary); cursor: pointer;
	}
	.kind-hint { font-size: 0.78rem; color: var(--text-tertiary); margin: var(--space-sm) 0 0; line-height: 1.4; }
	.modal-actions { display: flex; justify-content: flex-end; gap: var(--space-md); margin-top: var(--space-2xl); }
</style>
