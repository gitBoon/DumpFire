<!--
  CardSubBoards.svelte — The card window's Sub-board section, in More options
  (card 2280, slice B4: moved from CardModal.svelte).

  A saved card's sub-boards, each a link with its progress and, where the
  page allows it, a delete; a name to create one under the card, and the
  boards that can be linked. A new card's sub-boards are names, made by the
  page with the card. It sends nothing itself: creating, linking and
  deleting are the page's callbacks. What is typed, the names queued and
  whether the link picker is open are the window's, bound here, so they are
  kept while More options is shut or another tab is shown.
-->
<script lang="ts">
	import type { CardType } from '$lib/types';

	let {
		card,
		availableBoards,
		onCreateSubBoard,
		onDeleteSubBoard,
		onLinkSubBoard,
		newSubBoardName = $bindable(),
		showLinkPicker = $bindable(),
		pendingSubBoardNames = $bindable(),
		newPendingSubBoardName = $bindable()
	}: {
		card: CardType | null;
		availableBoards: { id: number; name: string; emoji: string }[];
		onCreateSubBoard?: (name: string) => void;
		onDeleteSubBoard?: (boardId: number) => void;
		onLinkSubBoard?: (boardId: number) => void;
		newSubBoardName: string;
		showLinkPicker: boolean;
		pendingSubBoardNames: string[];
		newPendingSubBoardName: string;
	} = $props();
</script>

<div class="form-group">
	<label>Sub-board</label>
	{#if card}
		{#if card.subBoards && card.subBoards.length > 0}
			<div class="subboard-list">
				{#each card.subBoards as sb}
					<div class="subboard-row">
						<a href="/board/{sb.id}" class="subboard-link">
							<span class="subboard-link-icon">{sb.emoji}</span>
							<div class="subboard-link-info">
								<span class="subboard-link-name">{sb.name}</span>
								<span class="subboard-link-progress">{sb.done}/{sb.total} complete</span>
							</div>
						</a>
						{#if onDeleteSubBoard}
							<button class="subboard-delete-btn" title="Delete" onclick={() => onDeleteSubBoard!(sb.id)}>✕</button>
						{/if}
					</div>
				{/each}
			</div>
		{/if}
		{#if onCreateSubBoard}
			<div class="subboard-create-row">
				<input type="text" class="subboard-name-input" placeholder="Link to a sub-board..." maxlength="200" bind:value={newSubBoardName} onkeydown={(e) => e.key === 'Enter' && newSubBoardName.trim() && onCreateSubBoard!(newSubBoardName.trim())} />
				<button class="btn-ghost subboard-add-btn" onclick={() => { if (newSubBoardName.trim()) onCreateSubBoard!(newSubBoardName.trim()); }} disabled={!newSubBoardName.trim()}>+ Create</button>
			</div>
		{/if}
		{#if onLinkSubBoard && availableBoards.length > 0}
			{#if showLinkPicker}
				<div class="link-picker">
					{#each availableBoards as ab}
						<button class="link-picker-item" onclick={() => { onLinkSubBoard!(ab.id); showLinkPicker = false; }}>{ab.emoji} {ab.name}</button>
					{/each}
				</div>
			{:else}
				<button class="btn-ghost subboard-link-btn" onclick={() => (showLinkPicker = true)}>🔗 Link existing board</button>
			{/if}
		{/if}
	{:else}
		{#if pendingSubBoardNames.length > 0}
			<div class="subboard-list">
				{#each pendingSubBoardNames as name, i}
					<div class="subboard-row">
						<div class="subboard-link" style="cursor: default;">
							<span class="subboard-link-icon">📋</span>
							<span class="subboard-link-name">{name}</span>
						</div>
						<button class="subboard-delete-btn" title="Remove" onclick={() => { pendingSubBoardNames = pendingSubBoardNames.filter((_, idx) => idx !== i); }}>✕</button>
					</div>
				{/each}
			</div>
		{/if}
		<div class="subboard-create-row">
			<input type="text" class="subboard-name-input" placeholder="Link to a sub-board..." maxlength="200" bind:value={newPendingSubBoardName} onkeydown={(e) => { if (e.key === 'Enter' && newPendingSubBoardName.trim()) { pendingSubBoardNames = [...pendingSubBoardNames, newPendingSubBoardName.trim()]; newPendingSubBoardName = ''; } }} />
			<button class="btn-ghost subboard-add-btn" onclick={() => { if (newPendingSubBoardName.trim()) { pendingSubBoardNames = [...pendingSubBoardNames, newPendingSubBoardName.trim()]; newPendingSubBoardName = ''; } }} disabled={!newPendingSubBoardName.trim()}>+ Add</button>
		</div>
	{/if}
</div>

<style>
	/* The window's own field style, on the name boxes here (CardModal.svelte's `.card-modal-content input`). */
	:global(.card-modal-content) input {
		background: var(--bg-base); border: 1px solid var(--glass-border);
	}
	:global(.card-modal-content) input:focus {
		border-color: var(--accent-indigo); box-shadow: 0 0 0 2px var(--accent-purple-glow);
	}

	.form-group { margin-bottom: var(--space-lg); }
	.form-group label {
		display: flex; align-items: center; gap: var(--space-sm);
		font-size: 0.7rem; font-weight: 600; color: var(--text-secondary);
		text-transform: uppercase; letter-spacing: 0.05em; margin-bottom: var(--space-sm);
	}

	.subboard-list {
		display: flex;
		flex-direction: column;
		gap: 4px;
		margin-bottom: var(--space-md);
	}

	.subboard-row {
		display: flex;
		align-items: center;
		gap: 6px;
	}

	.subboard-row .subboard-link { flex: 1; min-width: 0; }

	.subboard-delete-btn {
		flex-shrink: 0;
		width: 28px; height: 28px;
		display: flex; align-items: center; justify-content: center;
		border-radius: var(--radius-sm);
		background: transparent; border: 1px solid transparent;
		color: var(--text-tertiary); cursor: pointer;
		transition: all 0.15s;
	}
	.subboard-delete-btn:hover { color: var(--accent-rose); background: rgba(244, 63, 94, 0.1); border-color: rgba(244, 63, 94, 0.2); }
	.subboard-link {
		display: flex; align-items: center; gap: var(--space-md);
		padding: var(--space-sm) var(--space-md); border-radius: var(--radius-md);
		background: rgba(99, 102, 241, 0.06); border: 1px solid rgba(99, 102, 241, 0.15);
		text-decoration: none; color: var(--text-primary);
		transition: all var(--duration-fast) var(--ease-out);
	}
	.subboard-link:hover {
		background: rgba(99, 102, 241, 0.12);
		border-color: rgba(99, 102, 241, 0.3);
		transform: translateX(2px);
	}
	.subboard-link-icon { font-size: 1rem; flex-shrink: 0; }
	.subboard-link-info { flex: 1; min-width: 0; }
	.subboard-link-name { display: block; font-size: 0.82rem; font-weight: 600; }
	.subboard-link-progress { display: block; font-size: 0.68rem; color: var(--text-secondary); margin-top: 1px; }

	.subboard-create-row {
		display: flex; gap: var(--space-sm); margin-bottom: var(--space-sm);
	}
	.subboard-name-input {
		flex: 1; padding: 6px var(--space-sm);
		border-radius: var(--radius-sm);
		background: var(--bg-base); border: 1px solid var(--glass-border);
		color: var(--text-primary); font-family: var(--font-family);
		font-size: 0.8rem;
	}
	.subboard-name-input:focus { outline: none; border-color: rgba(99, 102, 241, 0.5); }
	.subboard-add-btn {
		display: flex; align-items: center; gap: 4px;
		font-size: 0.75rem !important; white-space: nowrap;
		padding: 4px var(--space-sm) !important;
	}
	.subboard-add-btn:disabled { opacity: 0.3; cursor: not-allowed; }

	.subboard-link-btn {
		font-size: 0.75rem !important;
		color: var(--text-tertiary) !important;
		padding: 4px var(--space-sm) !important;
	}
	.subboard-link-btn:hover { color: #818cf8 !important; }

	.link-picker {
		display: flex; flex-direction: column; gap: 2px;
		max-height: 150px; overflow-y: auto;
		padding: var(--space-xs); border-radius: var(--radius-sm);
		background: var(--bg-base); border: 1px solid var(--glass-border);
	}
	.link-picker-item {
		padding: 6px var(--space-sm);
		border: none; background: transparent;
		color: var(--text-primary); font-size: 0.8rem;
		text-align: left; cursor: pointer;
		border-radius: var(--radius-sm);
		transition: background 0.1s;
	}
	.link-picker-item:hover { background: var(--glass-bg); }
</style>
