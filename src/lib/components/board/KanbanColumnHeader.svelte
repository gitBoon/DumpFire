<!--
  KanbanColumnHeader.svelte — The head of one Kanban column on the board
  page (card 2280, slice B3: moved from the board page).

  The column's colour bar, its title (renamed in place by someone who
  manages the board), its count (shown/total while a filter is on, and the
  WIP limit), its sort, Add Task, and on hover its colour picker and menu:
  rename, sort, Show Add Task, the WIP limit and delete.

  It holds no state of its own and sends nothing. The column being renamed
  and the WIP limit being typed are the page's, one at a time for the whole
  board, bound here; which dropdown is open is the page's, which closes it
  on any click outside; every change is handed to the page's own functions.
  The page keeps the column element itself, the direct child of its keyed
  `{#each}` that `animate:flip` and the columns' drag zone need, and styles
  this header's hover from it (`.kanban-column:hover`).
-->
<script lang="ts">
	import type { ColumnType, SortOption } from '$lib/types';
	import { COLUMN_COLORS } from '$lib/utils/constants';
	import { getSortLabel } from '$lib/utils/card-utils';
	import { drawnColour } from '$lib/colours';

	let {
		column,
		canManage,
		editing,
		editTitle = $bindable(),
		editingWip,
		wipLimitInput = $bindable(),
		sort,
		visibleCount,
		colorOpen,
		menuOpen,
		onStartRename,
		onFinishRename,
		onSort,
		onAddCard,
		onToggleDropdown,
		onColor,
		onToggleAddCard,
		onStartWip,
		onSaveWip,
		onCancelWip,
		onDelete,
		onCloseDropdowns
	}: {
		column: ColumnType;
		canManage: boolean;
		/** This column's title is being renamed: the box is shown, on `editTitle`. */
		editing: boolean;
		editTitle: string;
		/** This column's WIP limit is being set: the box is shown, on `wipLimitInput`. */
		editingWip: boolean;
		wipLimitInput: number;
		sort: SortOption | undefined;
		/** How many of its cards the header's filters leave, or null while none is on. */
		visibleCount: number | null;
		colorOpen: boolean;
		menuOpen: boolean;
		onStartRename: (column: ColumnType) => void;
		/** The box's blur and Enter: the page sends the title, once. */
		onFinishRename: (columnId: number) => void;
		onSort: (columnId: number, sort: SortOption) => void;
		onAddCard: (columnId: number) => void;
		/** `color-<id>` or `menu-<id>`. */
		onToggleDropdown: (id: string) => void;
		onColor: (columnId: number, color: string) => void;
		onToggleAddCard: (column: ColumnType) => void;
		onStartWip: (column: ColumnType) => void;
		onSaveWip: (columnId: number) => void;
		onCancelWip: () => void;
		/** Asks first, in the page's confirmation. */
		onDelete: (columnId: number, title: string) => void;
		onCloseDropdowns: () => void;
	} = $props();
</script>

<div class="column-header">
	<div class="column-top-bar" style="background: {drawnColour(column.color)}"></div>
	<div class="column-title-row">
		{#if editing && canManage}
			<input
				class="column-title-input"
				type="text"
				bind:value={editTitle}
				onblur={() => onFinishRename(column.id)}
				onkeydown={(e) => e.key === 'Enter' && onFinishRename(column.id)}
				autofocus
			/>
		{:else}
			<!-- svelte-ignore a11y_click_events_have_key_events -->
			<h3 class="column-title" onclick={() => canManage && onStartRename(column)} role="button" tabindex="0">
				{column.title}
			</h3>
		{/if}
		<span class="column-count" class:wip-over={column.wipLimit > 0 && column.cards.length >= column.wipLimit}>{#if visibleCount !== null}{visibleCount}<span class="of-total">/{column.cards.length}</span>{:else}{column.cards.length}{/if}{#if column.wipLimit > 0}<span class="wip-limit-label">/{column.wipLimit}</span>{/if}</span>
		{#if sort && sort !== 'none'}
			<button class="sort-badge" onclick={() => onSort(column.id, 'none')} title="Clear sort">
				{getSortLabel(sort)} ✕
			</button>
		{/if}
		{#if column.title.toLowerCase() === 'to do' || column.showAddCard}
			<button class="add-card-badge" onclick={() => onAddCard(column.id)} title="Add task">
				<svg width="12" height="12" viewBox="0 0 12 12" fill="none"><path d="M6 2v8M2 6h8" stroke="currentColor" stroke-width="2" stroke-linecap="round"/></svg>
				Add Task
			</button>
		{/if}
		<div class="column-actions">
		<div class="color-picker-wrapper">
			<button class="btn-ghost column-action-btn" title="Change color" onclick={(e) => { e.stopPropagation(); onToggleDropdown(`color-${column.id}`); }}>
				<span class="color-dot" style="background: {drawnColour(column.color)}"></span>
			</button>
			{#if colorOpen}
				<!-- svelte-ignore a11y_click_events_have_key_events -->
				<!-- svelte-ignore a11y_no_static_element_interactions -->
				<div class="color-picker-dropdown show" onclick={(e) => e.stopPropagation()}>
					{#each COLUMN_COLORS as color}
						<button
							class="color-swatch"
							class:active={column.color === color}
							style="background: {drawnColour(color)}"
							onclick={() => onColor(column.id, color)}
						></button>
					{/each}
				</div>
			{/if}
		</div>
		<div class="column-menu-wrapper">
			<button class="btn-ghost column-action-btn" title="Column options" onclick={(e) => { e.stopPropagation(); onToggleDropdown(`menu-${column.id}`); }}>
				<svg width="14" height="14" viewBox="0 0 14 14" fill="none">
					<circle cx="7" cy="3" r="1.2" fill="currentColor"/>
					<circle cx="7" cy="7" r="1.2" fill="currentColor"/>
					<circle cx="7" cy="11" r="1.2" fill="currentColor"/>
				</svg>
			</button>
			{#if menuOpen}
				<!-- svelte-ignore a11y_click_events_have_key_events -->
				<!-- svelte-ignore a11y_no_static_element_interactions -->
				<div class="column-menu-dropdown show" onclick={(e) => e.stopPropagation()}>
					<button class="column-menu-item" onclick={() => { onStartRename(column); onCloseDropdowns(); }}>
						<svg width="12" height="12" viewBox="0 0 12 12" fill="none"><path d="M8.5 1.5l2 2L4 10H2v-2l6.5-6.5z" stroke="currentColor" stroke-width="1.2" stroke-linecap="round" stroke-linejoin="round"/></svg>
						Rename
					</button>
					<div class="menu-divider"></div>
					<div class="menu-label">Sort by</div>
					<button class="column-menu-item" class:active-sort={sort === 'date-asc'} onclick={() => onSort(column.id, 'date-asc')}>
						↑ Oldest first
					</button>
					<button class="column-menu-item" class:active-sort={sort === 'date-desc'} onclick={() => onSort(column.id, 'date-desc')}>
						↓ Newest first
					</button>
					<button class="column-menu-item" class:active-sort={sort === 'priority'} onclick={() => onSort(column.id, 'priority')}>
						⚡ Priority
					</button>
					<button class="column-menu-item" class:active-sort={sort === 'category'} onclick={() => onSort(column.id, 'category')}>
						🏷 Category
					</button>
					<button class="column-menu-item" class:active-sort={sort === 'assignee'} onclick={() => onSort(column.id, 'assignee')}>
						👤 Assignee
					</button>
					{#if sort && sort !== 'none'}
						<button class="column-menu-item" onclick={() => onSort(column.id, 'none')}>
							✕ Clear sort
						</button>
					{/if}
					{#if canManage}
					<div class="menu-divider"></div>
					<button class="column-menu-item" onclick={() => onToggleAddCard(column)}>
						{column.showAddCard || column.title.toLowerCase() === 'to do' ? '✓' : '○'} Show Add Task
					</button>
					{#if editingWip}
						<!-- svelte-ignore a11y_click_events_have_key_events -->
						<!-- svelte-ignore a11y_no_static_element_interactions -->
						<div class="wip-limit-edit" onclick={(e) => e.stopPropagation()}>
							<label class="wip-label">WIP Limit (0 = none)</label>
							<div class="wip-input-row">
								<input type="number" class="wip-input" min="0" max="99" bind:value={wipLimitInput} onkeydown={(e) => e.key === 'Enter' && onSaveWip(column.id)} autofocus />
								<button class="btn-primary small" onclick={() => onSaveWip(column.id)}>Set</button>
								<button class="btn-ghost small" onclick={() => onCancelWip()}>✕</button>
							</div>
						</div>
					{:else}
						<button class="column-menu-item" onclick={() => onStartWip(column)}>
							📊 WIP Limit {column.wipLimit > 0 ? `(${column.wipLimit})` : ''}
						</button>
					{/if}
					<div class="menu-divider"></div>
					<button class="column-menu-item danger" onclick={() => { onDelete(column.id, column.title); onCloseDropdowns(); }}>
						<svg width="12" height="12" viewBox="0 0 12 12" fill="none"><path d="M2 3.5h8M4.5 3.5V2.5a.5.5 0 01.5-.5h2a.5.5 0 01.5.5v1m1 0l-.4 6a1 1 0 01-1 .9H4.9a1 1 0 01-1-.9l-.4-6" stroke="currentColor" stroke-width="1" stroke-linecap="round" stroke-linejoin="round"/></svg>
						Delete column
					</button>
					{/if}
				</div>
			{/if}
		</div>
		</div>
	</div>
</div>

<style>
	/* Sort badge */
	.sort-badge {
		display: inline-flex; align-items: center; gap: 3px;
		padding: 1px 8px; border-radius: var(--radius-full);
		font-size: 0.6rem; font-weight: 600; white-space: nowrap;
		background: rgba(99, 102, 241, 0.12); color: var(--accent-indigo);
		border: 1px solid rgba(99, 102, 241, 0.2);
		cursor: pointer; font-family: var(--font-family);
		transition: all var(--duration-fast) var(--ease-out);
	}
	.sort-badge:hover { background: rgba(99, 102, 241, 0.2); }

	/* Menu label */
	.menu-label {
		font-size: 0.6rem; font-weight: 700; text-transform: uppercase;
		letter-spacing: 0.05em; color: var(--text-tertiary);
		padding: var(--space-xs) var(--space-md);
	}
	.column-menu-item.active-sort {
		color: var(--accent-indigo); font-weight: 600;
	}

	/* Column menu */
	.column-menu-wrapper { position: relative; display: inline-flex; }
	.column-menu-dropdown {
		display: none; position: absolute; top: calc(100% + 4px); right: 0; z-index: 500;
		background: var(--bg-surface); border: 1px solid var(--glass-border);
		border-radius: var(--radius-md); padding: var(--space-xs);
		min-width: 150px; box-shadow: var(--shadow-lg);
	}
	.column-menu-wrapper:hover .column-menu-dropdown, .column-menu-dropdown.show { display: block; }
	.column-menu-item {
		display: flex; align-items: center; gap: var(--space-sm); width: 100%;
		padding: var(--space-sm) var(--space-md); border-radius: var(--radius-sm);
		background: transparent; color: var(--text-secondary); font-size: 0.8rem;
		font-weight: 500; text-align: left; font-family: var(--font-family); cursor: pointer;
		border: none; transition: all var(--duration-fast) var(--ease-out);
	}
	.column-menu-item:hover { background: var(--glass-hover); color: var(--text-primary); }
	.column-menu-item.danger { color: var(--accent-rose); }
	.column-menu-item.danger:hover { background: rgba(244, 63, 94, 0.1); }
	.menu-divider { height: 1px; background: var(--glass-border); margin: var(--space-xs) 0; }

	.column-header { padding: var(--space-md) var(--space-lg) 0; flex-shrink: 0; display: flex; flex-direction: column; gap: 0; }
	.column-top-bar { height: 3px; margin: 0 calc(-1 * var(--space-lg)); margin-bottom: var(--space-md); opacity: 0.8; border-radius: 0 0 var(--radius-sm) var(--radius-sm); }
	.column-title-row { display: flex; align-items: center; gap: var(--space-xs); }
	.column-title { font-size: 0.9rem; font-weight: 600; cursor: pointer; padding: 2px var(--space-xs); border-radius: var(--radius-sm); transition: background var(--duration-fast) var(--ease-out); white-space: nowrap; flex: 1; min-width: 0; overflow: hidden; text-overflow: ellipsis; }
	.column-title:hover { background: var(--glass-hover); }
	.column-title-input { font-size: 0.9rem; font-weight: 600; padding: 2px var(--space-xs); width: 100%; }
	.column-count {
		font-size: 0.78rem; font-weight: 700; color: var(--text-secondary);
		background: var(--bg-base); padding: 2px 8px;
		border-radius: var(--radius-full); flex-shrink: 0;
		border: 1px solid var(--glass-border);
		min-width: 22px; text-align: center;
	}
	/* Shown on the column's hover: `.kanban-column:hover :global(.column-actions)`, in the page. */
	.column-actions { display: flex; align-items: center; gap: 0; opacity: 0; transition: opacity var(--duration-fast) var(--ease-out); flex-shrink: 0; margin-left: auto; margin-bottom: var(--space-xs); }
	.column-action-btn { padding: 2px !important; }
	.add-card-badge {
		display: flex; align-items: center; gap: 4px;
		padding: 3px 10px 3px 7px; border-radius: var(--radius-full);
		background: var(--accent-indigo); color: white;
		border: none; cursor: pointer; flex-shrink: 0;
		font-size: 0.68rem; font-weight: 600; font-family: var(--font-family);
		transition: all var(--duration-fast) var(--ease-out);
		box-shadow: 0 1px 4px rgba(99, 102, 241, 0.3);
		white-space: nowrap;
	}
	.add-card-badge:hover { transform: scale(1.05); background: var(--accent-purple); box-shadow: 0 2px 8px rgba(99, 102, 241, 0.5); }
	.add-card-badge:active { transform: scale(0.95); }

	.color-picker-wrapper { position: relative; }
	.color-picker-dropdown {
		display: none; position: absolute; top: 100%; right: 0; z-index: 500;
		background: var(--bg-surface); border: 1px solid var(--glass-border);
		border-radius: var(--radius-md); padding: var(--space-sm);
		gap: 4px; flex-wrap: wrap; width: 160px; box-shadow: var(--shadow-lg);
	}
	.color-picker-wrapper:hover .color-picker-dropdown, .color-picker-dropdown.show { display: flex; }
	.color-swatch { width: 24px; height: 24px; border-radius: var(--radius-sm); border: 2px solid transparent; cursor: pointer; transition: all var(--duration-fast) var(--ease-out); }
	.color-swatch:hover { transform: scale(1.15); }
	.color-swatch.active { border-color: var(--text-primary); box-shadow: 0 0 8px rgba(255, 255, 255, 0.2); }

	/* Search count */
	.of-total { opacity: 0.5; font-size: 0.6rem; }

	/* ─── WIP Limit Styles ──────────────────────────────────────────────── */
	.wip-over { color: #f59e0b !important; font-weight: 700; }
	.wip-limit-label { color: var(--text-tertiary); font-weight: 400; }

	.wip-limit-edit { padding: 8px 12px; }
	.wip-label { font-size: 0.72rem; font-weight: 600; color: var(--text-secondary); display: block; margin-bottom: 6px; }
	.wip-input-row { display: flex; align-items: center; gap: 6px; }
	.wip-input {
		width: 60px; padding: 4px 8px; border-radius: var(--radius-sm);
		border: 1px solid var(--glass-border); background: var(--bg-surface);
		color: var(--text-primary); font-size: 0.82rem; text-align: center;
		font-family: var(--font-family);
	}
	.wip-input:focus { outline: none; border-color: var(--accent-indigo); }

	/* ─── Mobile Responsive ──────────────────────────────────────────────── */

	@media (max-width: 768px) {
		/* Touch-friendly buttons */
		.btn-ghost, .column-action-btn {
			min-height: 36px;
			min-width: 36px;
		}
		.column-menu-item {
			padding: var(--space-md) var(--space-lg) !important;
			min-height: 40px;
		}
	}
</style>
