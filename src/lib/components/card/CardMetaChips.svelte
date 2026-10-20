<!--
  CardMetaChips.svelte — The card window's Details chips: priority,
  category, due date and who it is assigned to, each opening its own
  dropdown (card 2280, slice B4: moved from CardModal.svelte).

  The fields are the window's, bound here: it fills them from its card once
  and sends them with a save. Which dropdown is open is the window's too,
  which closes them all on any click inside it (`closeAllDropdowns`), and
  `toggleDrop` is its. The categories offered are the window's own list
  (`localCategories`), which its New Category form adds to. Assigning and
  unassigning a saved card's people are sent from here, each answer read:
  a refusal is said in the window's message box (`windowError`, bound), and
  the chip changes only once the server has changed the card. A new card's
  people are queued, and sent by the page once the card is made.
-->
<script lang="ts">
	import { drawnColour } from '$lib/colours';
	import { formatDueDate } from '$lib/utils/date-utils';
	import { deleteFailure, failureMessage } from '$lib/api';
	import type { CardType, CategoryType } from '$lib/types';

	let {
		card,
		boardId,
		boardUsers,
		localCategories,
		priority = $bindable(),
		categoryId = $bindable(),
		dueDate = $bindable(),
		cardAssignees = $bindable(),
		showPriorityDrop = $bindable(),
		showCategoryDrop = $bindable(),
		showDueDateDrop = $bindable(),
		showAssigneeDrop = $bindable(),
		showNewCategory = $bindable(),
		windowError = $bindable(),
		toggleDrop
	}: {
		card: CardType | null;
		boardId: number;
		boardUsers: { id: number; username: string; email?: string; emoji: string }[];
		localCategories: CategoryType[];
		priority: string;
		categoryId: number | null;
		dueDate: string;
		cardAssignees: { id: number; username: string; emoji: string }[];
		showPriorityDrop: boolean;
		showCategoryDrop: boolean;
		showDueDateDrop: boolean;
		showAssigneeDrop: boolean;
		showNewCategory: boolean;
		windowError: string;
		/** The window's: closes every dropdown, then opens this one if it was shut. */
		toggleDrop: (name: string) => void;
	} = $props();

	/** What a change that got no answer says: it may or may not have been made. */
	const NO_ANSWER = 'No answer from the server. It is not known whether that was saved.';

	function getPriorityColor(p: string) {
		const m: Record<string, string> = { critical: '#ef4444', high: '#f97316', medium: '#eab308', low: '#22c55e' };
		return m[p] || '#eab308';
	}

	// What the picker offers: this board's categories and the shared ones, of
	// no board, which are everybody's. The server files a card under nothing
	// else (card 2117, R3); the page passes those of every board the caller can
	// open, and one a card carries from a board they cannot, marked `carried`
	// (card 2128), which this leaves out too. A card already filed under
	// another board's keeps it, and its chip still names it.
	const pickableCategories = $derived(localCategories.filter((c) => c.boardId === boardId || c.boardId === null));

	async function assignUser(userId: number) {
		const user = boardUsers.find(u => u.id === userId);
		if (!user) return;

		if (card) {
			// Existing card — assign via API
			windowError = '';
			let res: Response;
			try {
				res = await fetch(`/api/cards/${card.id}/assignees`, {
					method: 'POST',
					headers: { 'Content-Type': 'application/json' },
					body: JSON.stringify({ userId })
				});
			} catch {
				windowError = NO_ANSWER;
				return;
			}
			if (!res.ok) {
				windowError = await failureMessage(res, `${user.username} was not assigned.`);
				return;
			}
			cardAssignees = [...cardAssignees, { id: user.id, username: user.username, emoji: user.emoji }];
		} else {
			// New card — queue locally
			cardAssignees = [...cardAssignees, { id: user.id, username: user.username, emoji: user.emoji }];
		}
	}

	async function unassignUser(userId: number) {
		if (card) {
			// Taken off the list only once the server has taken them off the card.
			const cardId = card.id;
			windowError = '';
			const failure = await deleteFailure(
				() =>
					fetch(`/api/cards/${cardId}/assignees`, {
						method: 'DELETE',
						headers: { 'Content-Type': 'application/json' },
						body: JSON.stringify({ userId })
					}),
				'assignee',
				'removed'
			);
			if (failure) {
				windowError = failure;
				return;
			}
		}
		cardAssignees = cardAssignees.filter(a => a.id !== userId);
	}

	let availableAssignees = $derived(
		boardUsers.filter(u => !cardAssignees.some(a => a.id === u.id))
	);
</script>

<!-- The window's own: its content's ignore, which covered these dropdowns where they were. -->
<!-- svelte-ignore a11y_click_events_have_key_events -->
<div class="metadata-section">
	<div class="metadata-label">Details</div>
	<div class="metadata-row">
		<!-- Priority chip -->
		<div class="dropdown-wrapper">
			<button class="chip" onclick={(e) => { e.stopPropagation(); toggleDrop('priority'); }}>
				<span class="chip-dot" style="background: {drawnColour(getPriorityColor(priority))}"></span>
				<span>{priority.charAt(0).toUpperCase() + priority.slice(1)}</span>
				<svg class="chip-chevron" width="10" height="10" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2" stroke-linecap="round" stroke-linejoin="round"><polyline points="6 9 12 15 18 9"></polyline></svg>
			</button>
			{#if showPriorityDrop}
			<div class="chip-dropdown" onclick={(e) => e.stopPropagation()}>
				{#each ['critical', 'high', 'medium', 'low'] as p}
					<button class="chip-dropdown-item" class:selected={priority === p} onclick={() => { priority = p; showPriorityDrop = false; }}>
						<span class="chip-dot" style="background: {drawnColour(getPriorityColor(p))}"></span>
						{p.charAt(0).toUpperCase() + p.slice(1)}
					</button>
				{/each}
			</div>
			{/if}
		</div>

		<!-- Category chip -->
		<div class="dropdown-wrapper">
			<button class="chip" class:is-set={categoryId} onclick={(e) => { e.stopPropagation(); toggleDrop('category'); }}>
				<svg class="chip-icon" width="14" height="14" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2" stroke-linecap="round" stroke-linejoin="round"><path d="M4 4h6v6H4z"/><path d="M14 4h6v6h-6z"/><path d="M4 14h6v6H4z"/><path d="M14 14h6v6h-6z"/></svg>
				<span>{categoryId ? localCategories.find(c => c.id === categoryId)?.name || 'Category' : 'Category'}</span>
				<svg class="chip-chevron" width="10" height="10" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2" stroke-linecap="round" stroke-linejoin="round"><polyline points="6 9 12 15 18 9"></polyline></svg>
			</button>
			{#if showCategoryDrop}
			<div class="chip-dropdown" onclick={(e) => e.stopPropagation()}>
				<button class="chip-dropdown-item" class:selected={!categoryId} onclick={() => { categoryId = null; showCategoryDrop = false; }}>None</button>
				{#each pickableCategories as cat}
					<button class="chip-dropdown-item" class:selected={categoryId === cat.id} onclick={() => { categoryId = cat.id; showCategoryDrop = false; }}>
						<span class="chip-dot" style="background: {drawnColour(cat.color)}"></span>
						{cat.name}
					</button>
				{/each}
				<div class="chip-dropdown-divider"></div>
				<button class="chip-dropdown-item" onclick={() => { showNewCategory = true; showCategoryDrop = false; }}>+ New Category</button>
			</div>
			{/if}
		</div>

		<!-- Due date chip -->
		<div class="dropdown-wrapper">
			<button class="chip" class:is-set={dueDate} onclick={(e) => { e.stopPropagation(); toggleDrop('due'); }}>
				<svg class="chip-icon" width="14" height="14" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2" stroke-linecap="round" stroke-linejoin="round"><rect x="3" y="4" width="18" height="18" rx="2" ry="2"/><line x1="16" y1="2" x2="16" y2="6"/><line x1="8" y1="2" x2="8" y2="6"/><line x1="3" y1="10" x2="21" y2="10"/></svg>
				<span>{dueDate ? formatDueDate(dueDate, {day:'numeric',month:'short'}) : 'Due date'}</span>
				<svg class="chip-chevron" width="10" height="10" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2" stroke-linecap="round" stroke-linejoin="round"><polyline points="6 9 12 15 18 9"></polyline></svg>
			</button>
			{#if showDueDateDrop}
			<div class="chip-dropdown" onclick={(e) => e.stopPropagation()}>
				<button class="chip-dropdown-item" class:selected={!dueDate} onclick={() => { dueDate = ''; showDueDateDrop = false; }}>No date</button>
				<div class="chip-dropdown-divider"></div>
				<div style="padding: 4px 8px;">
					<input type="date" bind:value={dueDate} onchange={() => { showDueDateDrop = false; }} style="width: 100%; font-size: 0.82rem;" />
				</div>
			</div>
			{/if}
		</div>

		<!-- Assignee chip -->
		<div class="dropdown-wrapper">
			<button class="chip" class:is-set={cardAssignees.length > 0} onclick={(e) => { e.stopPropagation(); toggleDrop('assignee'); }}>
				<svg class="chip-icon" width="14" height="14" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2" stroke-linecap="round" stroke-linejoin="round"><path d="M20 21v-2a4 4 0 0 0-4-4H8a4 4 0 0 0-4 4v2"/><circle cx="12" cy="7" r="4"/></svg>
				<span>{cardAssignees.length > 0 ? cardAssignees.map(a => a.username).join(', ') : 'Assign'}</span>
				<svg class="chip-chevron" width="10" height="10" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2" stroke-linecap="round" stroke-linejoin="round"><polyline points="6 9 12 15 18 9"></polyline></svg>
			</button>
			{#if showAssigneeDrop}
			<div class="chip-dropdown" onclick={(e) => e.stopPropagation()}>
				{#each cardAssignees as a}
					<button class="chip-dropdown-item selected" onclick={() => unassignUser(a.id)}>
						{a.emoji} {a.username} ✕
					</button>
				{/each}
				{#if cardAssignees.length > 0 && availableAssignees.length > 0}
					<div class="chip-dropdown-divider"></div>
				{/if}
				{#each availableAssignees as u}
					<button class="chip-dropdown-item" onclick={() => assignUser(u.id)}>
						{u.emoji} {u.username}
					</button>
				{/each}
			</div>
			{/if}
		</div>
	</div>
</div>

<style>
	/* The window's own field style, on the date box here (CardModal.svelte's `.card-modal-content input`). */
	:global(.card-modal-content) input {
		background: var(--bg-base); border: 1px solid var(--glass-border);
	}
	:global(.card-modal-content) input:focus {
		border-color: var(--accent-indigo); box-shadow: 0 0 0 2px var(--accent-purple-glow);
	}

	/* The dropdowns' fade, as the window's own (each component's keyframes are its own). */
	@keyframes fadeIn { from { opacity: 0; } to { opacity: 1; } }

	/* Metadata chips */
	.metadata-section { margin-top: var(--space-xl); }
	.metadata-label {
		font-size: 0.68rem; font-weight: 700; text-transform: uppercase;
		letter-spacing: 0.06em; color: var(--text-tertiary); margin-bottom: var(--space-md);
	}
	.metadata-row { display: flex; flex-wrap: wrap; gap: var(--space-sm); }

	.chip {
		display: inline-flex; align-items: center; gap: var(--space-sm);
		padding: 5px 10px; font-family: var(--font-family); font-size: 0.78rem; font-weight: 500;
		color: var(--text-secondary); background: var(--bg-elevated);
		border: 1px solid var(--glass-border); border-radius: 100px;
		cursor: pointer; transition: all 0.15s; white-space: nowrap; user-select: none;
	}
	.chip:hover { border-color: var(--text-tertiary); color: var(--text-primary); background: var(--bg-hover); }
	.chip.is-set { border-color: var(--accent-indigo); background: rgba(99, 102, 241, 0.1); color: var(--text-accent); }
	.chip-dot { width: 8px; height: 8px; border-radius: 50%; flex-shrink: 0; }
	.chip-icon { display: flex; align-items: center; flex-shrink: 0; }
	.chip-chevron { margin-left: 2px; }

	/* Chip dropdowns */
	.dropdown-wrapper { position: relative; }
	.chip-dropdown {
		position: absolute; top: calc(100% + 6px); left: 0; z-index: 200;
		background: var(--bg-surface); border: 1px solid var(--glass-border);
		border-radius: var(--radius-md); padding: var(--space-xs); min-width: 180px;
		box-shadow: var(--shadow-lg); animation: fadeIn 0.15s ease;
	}
	.chip-dropdown-item {
		display: flex; align-items: center; gap: var(--space-md);
		padding: var(--space-sm) var(--space-md); font-size: 0.78rem;
		color: var(--text-secondary); border-radius: var(--radius-sm);
		cursor: pointer; border: none; background: transparent; width: 100%;
		text-align: left; transition: all 0.1s; font-family: var(--font-family);
	}
	.chip-dropdown-item:hover { background: var(--bg-hover); color: var(--text-primary); }
	.chip-dropdown-item.selected { color: var(--text-primary); font-weight: 600; }
	.chip-dropdown-divider { height: 1px; background: var(--glass-border); margin: 4px 0; }
</style>
