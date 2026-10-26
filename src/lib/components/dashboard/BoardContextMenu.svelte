<!--
  BoardContextMenu.svelte — The menu a board's row opens on a right-click:
  Set Category (with a new grouping made in place), Open Board, New
  Sub-board and Delete Board (card 2281, slice C2: moved from
  src/routes/+page.svelte).

  `openBoardContextMenu` is exported: the page reaches it with `bind:this`
  for the boards table's rows. Which boards are expanded and which
  groupings collapsed are the page's, bound here and in the boards table.
  Delete Board asks through the page's confirm dialog.
-->
<script lang="ts">
	import type { PageData } from '../../../routes/$types';
	import { invalidateAll } from '$app/navigation';
	import { COLUMN_COLORS } from '$lib/utils/constants';
	import { firstOpenColumn } from '$lib/column-role';
	import { toasts as failureToasts } from '$lib/stores/toast';
	import { failureMessage } from '$lib/api';
	import { drawnColour } from '$lib/colours';

	let {
		data,
		confirmDeleteBoard,
		expandedBoards = $bindable(),
		collapsedCategories = $bindable()
	}: {
		/** What the dashboard's load gave it, passed on as it is. */
		data: PageData;
		/** The page's confirm dialog, which asks before a board is deleted. */
		confirmDeleteBoard: (id: number, name: string) => void;
		/** The page's: the boards whose sub-boards are shown. */
		expandedBoards: Set<number>;
		/** The page's: the groupings folded shut. */
		collapsedCategories: Set<string>;
	} = $props();

	// ─── Board Context Menu ─────────────────────────────────────────────────
	let boardCtx = $state<{ show: boolean; x: number; y: number; boardId: number; boardName: string }>(
		{ show: false, x: 0, y: 0, boardId: 0, boardName: '' }
	);
	let showCatPicker = $state(false);
	let newBoardCatName = $state('');
	let newBoardCatColor = $state('#6366f1');
	let showNewBoardCat = $state(false);

	export function openBoardContextMenu(e: MouseEvent, boardId: number, boardName: string) {
		e.preventDefault();
		e.stopPropagation();
		boardCtx = { show: true, x: e.clientX, y: e.clientY, boardId, boardName };
		showCatPicker = false;
		showNewBoardCat = false;
		showSubBoardForm = false;
	}

	function closeBoardContextMenu() {
		boardCtx.show = false;
		showCatPicker = false;
		showNewBoardCat = false;
		showSubBoardForm = false;
	}

	// ─── Sub-board creation (from context menu) ─────────────────────────────
	// A sub-board hangs off a parent card, so the form offers the board's cards
	// as parents and defaults to creating a fresh card named after the sub-board.
	type PickerCard = { id: number; title: string; columnId: number; columnTitle: string };
	type PickerColumn = { id: number; title: string; position: number; role: string | null };
	let showSubBoardForm = $state(false);
	let subBoardName = $state('');
	let subBoardParent = $state<'new' | number>('new');
	let subBoardCards = $state<PickerCard[]>([]);
	let subBoardColumns = $state<PickerColumn[]>([]);
	let subBoardLoading = $state(false);
	let subBoardCreating = $state(false);
	let subBoardError = $state('');

	async function openSubBoardForm() {
		showSubBoardForm = true;
		subBoardName = '';
		subBoardParent = 'new';
		subBoardError = '';
		subBoardLoading = true;
		try {
			const res = await fetch(`/api/boards/${boardCtx.boardId}/cards`);
			if (res.ok) {
				const body = await res.json();
				subBoardCards = body.cards;
				subBoardColumns = body.columns;
			}
		} catch { /* picker just shows the new-card option */ }
		subBoardLoading = false;
	}

	async function createSubBoardInline() {
		const name = subBoardName.trim();
		if (!name || subBoardCreating) return;
		subBoardCreating = true;
		subBoardError = '';
		try {
			let parentCardId: number | null = subBoardParent === 'new' ? null : subBoardParent;

			// Default path: create a card named after the sub-board in the first
			// column that is not a Complete column, or the first of all when every
			// one is. A card created in a Complete column is completed (card 2134).
			if (parentCardId === null) {
				const firstCol = firstOpenColumn(subBoardColumns) ?? subBoardColumns[0];
				if (!firstCol) {
					subBoardError = 'This board has no columns to hold a parent card';
					return;
				}
				const res = await fetch('/api/cards', {
					method: 'POST',
					headers: { 'Content-Type': 'application/json' },
					body: JSON.stringify({ columnId: firstCol.id, boardId: boardCtx.boardId, title: name })
				});
				if (!res.ok) {
					// The server's reason (card 2148), and these words where it gives none.
					subBoardError = await failureMessage(res, 'Could not create the parent card');
					return;
				}
				parentCardId = (await res.json()).id;
			}

			const res = await fetch('/api/boards', {
				method: 'POST',
				headers: { 'Content-Type': 'application/json' },
				body: JSON.stringify({ name, emoji: '🗂️', parentCardId })
			});
			if (!res.ok) {
				subBoardError = await failureMessage(res, 'Could not create the sub-board');
				return;
			}

			// Reveal the new sub-board under its parent board
			const next = new Set(expandedBoards);
			next.add(boardCtx.boardId);
			expandedBoards = next;

			closeBoardContextMenu();
			await invalidateAll();
		} catch {
			subBoardError = 'No answer from the server. Reload the page to see whether the sub-board was made.';
		} finally {
			subBoardCreating = false;
		}
	}

	/** File a board under a category, or under none. A refusal is said in the toast; the menu closes either way. */
	async function setBoardCategory(boardId: number, categoryId: number | null) {
		const started = failureToasts.navigation();
		let res: Response;
		try {
			res = await fetch(`/api/boards/${boardId}`, {
				method: 'PUT',
				headers: { 'Content-Type': 'application/json' },
				body: JSON.stringify({ categoryId })
			});
		} catch {
			closeBoardContextMenu();
			failureToasts.add('No answer from the server. The board’s category may not have been changed.', 'error', started);
			return;
		}
		closeBoardContextMenu();
		if (!res.ok) {
			failureToasts.add(await failureMessage(res, 'The board’s category was not changed.'), 'error', started);
			return;
		}
		await invalidateAll();
	}

	async function createBoardCategoryInline() {
		if (!newBoardCatName.trim()) return;
		const started = failureToasts.navigation();
		try {
			const res = await fetch('/api/board-categories', {
				method: 'POST',
				headers: { 'Content-Type': 'application/json' },
				body: JSON.stringify({ name: newBoardCatName.trim(), color: newBoardCatColor })
			});
			if (res.ok) {
				const created = await res.json();
				// Auto-expand the new category group
				const next = new Set(collapsedCategories);
				next.delete(created.name);
				collapsedCategories = next;
				await setBoardCategory(boardCtx.boardId, created.id);
				newBoardCatName = '';
				newBoardCatColor = '#6366f1';
				showNewBoardCat = false;
			} else {
				failureToasts.add(await failureMessage(res, 'The category was not created.'), 'error', started);
			}
		} catch {
			failureToasts.add('No answer from the server. The category may not have been created.', 'error', started);
		}
	}
</script>

{#if boardCtx.show}
	<!-- svelte-ignore a11y_click_events_have_key_events -->
	<!-- svelte-ignore a11y_no_static_element_interactions -->
	<div class="ctx-overlay" onclick={closeBoardContextMenu}>
		<div class="ctx-menu" style="left: {boardCtx.x}px; top: {boardCtx.y}px" onclick={(e) => e.stopPropagation()}>
			<div class="ctx-header">{boardCtx.boardName}</div>
			<div class="ctx-divider"></div>

			{#if showCatPicker}
				<div class="ctx-cat-picker">
					<button class="ctx-item" onclick={() => setBoardCategory(boardCtx.boardId, null)}>
						<span class="ctx-icon">∅</span> No Category
					</button>
					{#each data.allCategories as cat}
						<button class="ctx-item" onclick={() => setBoardCategory(boardCtx.boardId, cat.id)}>
							<span class="ctx-dot" style="background: {drawnColour(cat.color)}"></span> {cat.name}
						</button>
					{/each}
					<div class="ctx-divider"></div>
					{#if showNewBoardCat}
						<div class="ctx-new-cat">
							<input type="text" class="ctx-cat-input" placeholder="Category name..." bind:value={newBoardCatName} onkeydown={(e) => e.key === 'Enter' && createBoardCategoryInline()} autofocus />
							<div class="ctx-cat-colors">
								{#each COLUMN_COLORS.slice(0, 8) as color}
									<button class="ctx-color-swatch" class:active={newBoardCatColor === color} style="background: {drawnColour(color)}" onclick={() => (newBoardCatColor = color)} type="button"></button>
								{/each}
								<label class="color-custom-wrapper">
									<input type="color" bind:value={newBoardCatColor} class="color-native-input" />
									<span class="ctx-color-swatch custom" style="background: {drawnColour(newBoardCatColor)}">✎</span>
								</label>
							</div>
							<div class="ctx-cat-actions">
								<button class="btn-primary small" onclick={createBoardCategoryInline} disabled={!newBoardCatName.trim()}>Create</button>
								<button class="btn-ghost small" onclick={() => (showNewBoardCat = false)}>Cancel</button>
							</div>
						</div>
					{:else}
						<button class="ctx-item ctx-new" onclick={() => (showNewBoardCat = true)}>
							<span class="ctx-icon">+</span> New Category
						</button>
					{/if}
				</div>
			{:else if showSubBoardForm}
				<div class="ctx-new-cat">
					<input type="text" class="ctx-cat-input" placeholder="Sub-board name..." maxlength="200" bind:value={subBoardName} onkeydown={(e) => e.key === 'Enter' && createSubBoardInline()} autofocus />
					<label class="ctx-field-label" for="sub-board-parent">Attach to card</label>
					<select id="sub-board-parent" class="ctx-cat-input" bind:value={subBoardParent} disabled={subBoardLoading}>
						<option value="new">＋ New card{subBoardName.trim() ? ` "${subBoardName.trim()}"` : ''}</option>
						{#each subBoardColumns as col}
							{@const colCards = subBoardCards.filter(c => c.columnId === col.id)}
							{#if colCards.length > 0}
								<optgroup label={col.title}>
									{#each colCards as card}
										<option value={card.id}>{card.title}</option>
									{/each}
								</optgroup>
							{/if}
						{/each}
					</select>
					{#if subBoardError}
						<span class="ctx-error">{subBoardError}</span>
					{/if}
					<div class="ctx-cat-actions">
						<button class="btn-primary small" onclick={createSubBoardInline} disabled={!subBoardName.trim() || subBoardCreating}>
							{subBoardCreating ? 'Creating…' : 'Create'}
						</button>
						<button class="btn-ghost small" onclick={() => (showSubBoardForm = false)}>Cancel</button>
					</div>
				</div>
			{:else}
				<button class="ctx-item" onclick={() => (showCatPicker = true)}>
					<span class="ctx-icon">🏷️</span> Set Category
				</button>
				<a href="/board/{boardCtx.boardId}" class="ctx-item">
					<span class="ctx-icon">📝</span> Open Board
				</a>
				<button class="ctx-item ctx-new" onclick={openSubBoardForm}>
					<span class="ctx-icon">🗂️</span> New Sub-board
				</button>
				<div class="ctx-divider"></div>
				<button class="ctx-item ctx-danger" onclick={() => { closeBoardContextMenu(); confirmDeleteBoard(boardCtx.boardId, boardCtx.boardName); }}>
					<span class="ctx-icon">🗑️</span> Delete Board
				</button>
			{/if}
		</div>
	</div>
{/if}

<style>
	/* ─── Board Context Menu ─────────────────────────────────────── */
	.ctx-overlay {
		position: fixed; inset: 0; z-index: 1000;
	}
	.ctx-menu {
		position: fixed; z-index: 1001;
		min-width: 200px; max-width: 280px;
		background: var(--bg-surface); border: 1px solid var(--glass-border);
		border-radius: var(--radius-lg); box-shadow: 0 8px 32px rgba(0,0,0,0.3);
		padding: var(--space-xs) 0; backdrop-filter: blur(20px);
	}
	.ctx-header {
		padding: var(--space-sm) var(--space-md);
		font-size: 0.72rem; font-weight: 700; color: var(--text-tertiary);
		text-transform: uppercase; letter-spacing: 0.04em;
		white-space: nowrap; overflow: hidden; text-overflow: ellipsis;
	}
	.ctx-divider { height: 1px; background: var(--glass-border); margin: var(--space-xs) 0; }
	.ctx-item {
		display: flex; align-items: center; gap: var(--space-sm);
		width: 100%; padding: var(--space-sm) var(--space-md);
		background: none; border: none; color: var(--text-primary);
		font: inherit; font-size: 0.82rem; cursor: pointer; text-decoration: none;
		transition: background var(--duration-fast) var(--ease-out);
	}
	.ctx-item:hover { background: var(--bg-base); }
	.ctx-danger { color: #ef4444 !important; }
	.ctx-danger:hover { background: rgba(239,68,68,0.1); }
	.ctx-new { color: var(--accent-indigo) !important; }
	.ctx-icon { width: 18px; text-align: center; flex-shrink: 0; }
	.ctx-dot {
		width: 10px; height: 10px; border-radius: 50%; flex-shrink: 0;
		display: inline-block;
	}
	.ctx-new-cat {
		padding: var(--space-sm) var(--space-md);
		display: flex; flex-direction: column; gap: var(--space-sm);
	}
	.ctx-cat-input {
		padding: var(--space-xs) var(--space-sm); font-size: 0.82rem;
		background: var(--bg-base); border: 1px solid var(--glass-border);
		border-radius: var(--radius-sm); color: var(--text-primary); font-family: var(--font-family);
	}
	.ctx-cat-input:focus { outline: none; border-color: var(--accent-indigo); }
	.ctx-cat-colors { display: flex; gap: 3px; flex-wrap: wrap; }
	.ctx-color-swatch {
		width: 16px; height: 16px; border-radius: 3px; border: 2px solid transparent;
		cursor: pointer; transition: transform var(--duration-fast) var(--ease-out);
	}
	.ctx-color-swatch:hover { transform: scale(1.2); }
	.ctx-color-swatch.active { border-color: var(--text-primary); }
	.ctx-color-swatch.custom {
		display: flex; align-items: center; justify-content: center;
		font-size: 0.5rem; color: white; text-shadow: 0 1px 2px rgba(0,0,0,0.5);
	}
	.ctx-field-label {
		font-size: 0.65rem; font-weight: 700; text-transform: uppercase;
		letter-spacing: 0.04em; color: var(--text-tertiary);
	}
	.ctx-error { font-size: 0.72rem; color: #ef4444; }
	.ctx-cat-actions { display: flex; gap: var(--space-sm); }
	.ctx-cat-actions .small { padding: 2px var(--space-sm); font-size: 0.72rem; }
	.color-custom-wrapper { position: relative; cursor: pointer; display: inline-flex; }
	.color-native-input { position: absolute; width: 0; height: 0; opacity: 0; pointer-events: none; }
</style>
