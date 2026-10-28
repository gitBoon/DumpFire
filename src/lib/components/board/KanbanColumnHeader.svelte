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

  The board's Options column (milestone 22, card 2459) has no WIP limit,
  always offers "Add idea", and can be folded back to its strip. Every
  delivery board has one, called Options, made with the board (card 2527):
  it is not renamed or deleted, so it offers neither, only its colour, its
  sort and the fold. Should it carry another title, until the start-up step
  renames it, a "(Options)" follows the title, which is not part of it.

  Every column of an ideas board (card 2463) is upstream as the Options
  column is: it always offers "Add idea", has no Show Add Task switch, and
  shows its options aging, the oldest idea's age and how many are older than
  30 days, which the page hands it (`aging`). It keeps its WIP limit: on
  "Ready for Replenishment" that is a replenishment queue (decision M22-13).
-->
<script lang="ts">
	import type { ColumnType, SortOption } from '$lib/types';
	import { COLUMN_COLORS } from '$lib/utils/constants';
	import { getSortLabel } from '$lib/utils/card-utils';
	import { drawnColour } from '$lib/colours';
	import { holdFocus } from '$lib/dialog-focus';
	import ColourSwatches from '$lib/components/ColourSwatches.svelte';
	// "To Do" or "Todo", trimmed, any capitals: the board's own To Do role (card 2280, slice B5a).
	import { isOptionsColumn, isTodoColumnTitle, isUpstreamColumn, optionsSuffix } from '$lib/column-role';
	import { OPTION_AGING_DAYS } from '$lib/board/board-view';

	let {
		column,
		canManage,
		boardKind = 'delivery',
		onCollapse = () => {},
		aging = null,
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
		/** The board's kind: an ideas board has no Options column (milestone 22). */
		boardKind?: string;
		/** Fold the Options column back to its strip. */
		onCollapse?: () => void;
		/**
		 * Options aging (ruling g) for a column of an ideas board, which has no
		 * strip to show it (card 2463): the oldest idea's age in days and how
		 * many are older than `OPTION_AGING_DAYS`. Null, the default, shows none.
		 */
		aging?: { oldestDays: number | null; over: number } | null;
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

	const isOptions = $derived(isOptionsColumn(column));
	/** Renamed, given a WIP limit or deleted by someone who manages the board: not the Options column, which keeps its title and stays (card 2527). */
	const canChange = $derived(canManage && !isOptions);
	/** Its cards are options: the Options column, or any column of an ideas board (card 2463), which always offers "Add idea" as the Options column does. */
	const upstream = $derived(isUpstreamColumn(column, boardKind));
	const addsCards = $derived(upstream || isTodoColumnTitle(column.title) || column.showAddCard);
</script>

<div class="column-header">
	<div class="column-top-bar" style="background: {drawnColour(column.color)}"></div>
	<div class="column-title-row">
		{#if editing && canChange}
			<input
				class="column-title-input"
				type="text"
				bind:value={editTitle}
				onblur={() => onFinishRename(column.id)}
				onkeydown={(e) => e.key === 'Enter' && onFinishRename(column.id)}
				autofocus
			/>
		{:else}
			<!-- The Options column's title is fixed: a press does not rename it (card 2527).
			     It is out of the Tab order, but the page can still put the focus on
			     it, as it does on the column a Send left (focusColumn). -->
			{#if isOptions}
			<h3 class="column-title fixed-title" tabindex="-1">
				{column.title}{#if optionsSuffix(column)}<span class="options-suffix">{optionsSuffix(column)}</span>{/if}
			</h3>
			{:else}
			<!-- svelte-ignore a11y_click_events_have_key_events -->
			<h3 class="column-title" onclick={() => canManage && onStartRename(column)} role="button" tabindex="0">
				{column.title}
			</h3>
			{/if}
		{/if}
		<span class="column-count" class:wip-over={!isOptions && column.wipLimit > 0 && column.cards.length >= column.wipLimit}>{#if visibleCount !== null}{visibleCount}<span class="of-total">/{column.cards.length}</span>{:else}{column.cards.length}{/if}{#if !isOptions && column.wipLimit > 0}<span class="wip-limit-label">/{column.wipLimit}</span>{/if}</span>
		{#if sort && sort !== 'none'}
			<button class="sort-badge" onclick={() => onSort(column.id, 'none')} title="Clear sort">
				{getSortLabel(sort)} ✕
			</button>
		{/if}
		{#if aging && aging.over > 0}
			<span class="aging-chip aging-over" title="{aging.over} {aging.over === 1 ? 'idea is' : 'ideas are'} older than {OPTION_AGING_DAYS} days">{aging.over} &gt;{OPTION_AGING_DAYS}d</span>
		{/if}
		{#if aging && aging.oldestDays !== null}
			<span class="aging-chip" title="The oldest idea's age">oldest {aging.oldestDays}d</span>
		{/if}
		{#if addsCards}
			<button class="add-card-badge" onclick={() => onAddCard(column.id)} title={upstream ? 'Add idea' : 'Add task'}>
				<svg width="12" height="12" viewBox="0 0 12 12" fill="none"><path d="M6 2v8M2 6h8" stroke="currentColor" stroke-width="2" stroke-linecap="round"/></svg>
				{upstream ? 'Add idea' : 'Add Task'}
			</button>
		{/if}
		{#if isOptions}
			<button class="btn-ghost column-action-btn options-collapse" title="Collapse the Options column" aria-label="Collapse the Options column" aria-expanded="true" onclick={(e) => { e.stopPropagation(); onCollapse(); }}>
				<svg width="12" height="12" viewBox="0 0 12 12" fill="none" aria-hidden="true"><path d="M7.5 2.5L4 6l3.5 3.5" stroke="currentColor" stroke-width="1.5" stroke-linecap="round" stroke-linejoin="round"/></svg>
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
				<!-- The shared picker, presets only (card 2546): each swatch named and pressed while it is the column's; a pick is the page's, which closes the menu. -->
				<div class="color-picker-dropdown show" onclick={(e) => e.stopPropagation()}>
					<ColourSwatches colours={COLUMN_COLORS} value={column.color} onpick={(color) => onColor(column.id, color)} custom={false} label="Colour for column {column.title}" />
				</div>
			{/if}
		</div>
		<div class="column-menu-wrapper">
			<button class="btn-ghost column-action-btn" title="Column options" aria-label="Column options for {column.title}" aria-haspopup="true" aria-expanded={menuOpen} onclick={(e) => { e.stopPropagation(); onToggleDropdown(`menu-${column.id}`); }}>
				<svg width="14" height="14" viewBox="0 0 14 14" fill="none">
					<circle cx="7" cy="3" r="1.2" fill="currentColor"/>
					<circle cx="7" cy="7" r="1.2" fill="currentColor"/>
					<circle cx="7" cy="11" r="1.2" fill="currentColor"/>
				</svg>
			</button>
			{#if menuOpen}
				<!-- Keyboard: its first item takes the focus as it opens, Tab stays
				     inside it, Escape closes it, and the focus goes back to the
				     button that opened it (holdFocus, milestone 22). -->
				<!-- svelte-ignore a11y_click_events_have_key_events -->
				<!-- svelte-ignore a11y_no_static_element_interactions -->
				<div class="column-menu-dropdown show" onclick={(e) => e.stopPropagation()} use:holdFocus={{ first: '.column-menu-item', onEscape: onCloseDropdowns }}>
					<!-- No Rename on the Options column, which is always called Options (card 2527). -->
					{#if !isOptions}
					<button class="column-menu-item" onclick={() => { onStartRename(column); onCloseDropdowns(); }}>
						<svg width="12" height="12" viewBox="0 0 12 12" fill="none"><path d="M8.5 1.5l2 2L4 10H2v-2l6.5-6.5z" stroke="currentColor" stroke-width="1.2" stroke-linecap="round" stroke-linejoin="round"/></svg>
						Rename
					</button>
					<div class="menu-divider"></div>
					{/if}
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
					<!-- The Options column has nothing here: no Show Add Task (it always
					     offers Add idea), no WIP limit, and no delete (card 2527). -->
					{#if canChange}
					<div class="menu-divider"></div>
					{#if !upstream}
					<button class="column-menu-item" onclick={() => onToggleAddCard(column)}>
						{column.showAddCard || isTodoColumnTitle(column.title) ? '✓' : '○'} Show Add Task
					</button>
					{/if}
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
	/* The Options column's "(Options)": not part of the title, and not renamed with it (ruling k). */
	.options-suffix { font-weight: 500; color: var(--text-tertiary); font-size: 0.8rem; }
	.column-menu-item.danger { color: var(--accent-rose); }
	.column-menu-item.danger:hover { background: rgba(244, 63, 94, 0.1); }
	.menu-divider { height: 1px; background: var(--glass-border); margin: var(--space-xs) 0; }

	.column-header { padding: var(--space-md) var(--space-lg) 0; flex-shrink: 0; display: flex; flex-direction: column; gap: 0; }
	.column-top-bar { height: 3px; margin: 0 calc(-1 * var(--space-lg)); margin-bottom: var(--space-md); opacity: 0.8; border-radius: 0 0 var(--radius-sm) var(--radius-sm); }
	.column-title-row { display: flex; align-items: center; gap: var(--space-xs); }
	.column-title { font-size: 0.9rem; font-weight: 600; cursor: pointer; padding: 2px var(--space-xs); border-radius: var(--radius-sm); transition: background var(--duration-fast) var(--ease-out); white-space: nowrap; flex: 1; min-width: 0; overflow: hidden; text-overflow: ellipsis; }
	.column-title:hover { background: var(--glass-hover); }
	/* The Options column's title, which is not renamed: no pointer and no hover (card 2527). */
	.column-title.fixed-title { cursor: default; }
	.column-title.fixed-title:hover { background: none; }
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
	/* An ideas board's column's options aging (card 2463), as the Options strip shows it. */
	.aging-chip { font-size: 0.6rem; font-weight: 600; color: var(--text-tertiary); white-space: nowrap; flex-shrink: 0; }
	.aging-chip.aging-over { color: #f59e0b; }

	.color-picker-wrapper { position: relative; }
	.color-picker-dropdown {
		display: none; position: absolute; top: 100%; right: 0; z-index: 500;
		background: var(--bg-surface); border: 1px solid var(--glass-border);
		border-radius: var(--radius-md); padding: var(--space-sm);
		width: 168px; box-shadow: var(--shadow-lg);
	}
	/* 168px: five 24px swatches to a row at the shared picker's 6px gap (144px of the 150 inside), as there were five at the old 4px in 160px. */
	.color-picker-wrapper:hover .color-picker-dropdown, .color-picker-dropdown.show { display: flex; }

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
