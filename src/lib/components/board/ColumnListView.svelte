<!--
  ColumnListView.svelte — The board as a list, one column at a time (card 2079).

  For a portrait monitor: the chosen column fills the width, its cards as rows
  with room for their summary and description. A strip of the board's columns
  above it chooses the column, each with its count ("shown/total" while a
  filter is on, as the board's column headers say it), and a second control
  the order: Priority (pinned first, then critical to low, the board's order
  within each) or Board order. There is no reordering here: the order on
  screen is not the stored one. A card is moved with the board's right-click
  menu.

  Everything it shows is the page's: the columns live updates keep current,
  the header's filters, the selection. It makes no request of its own.
-->
<script lang="ts">
	import type { CardType, CategoryType, ColumnType } from '$lib/types';
	import { isCompleteColumn, isOnHoldColumn } from '$lib/utils/card-utils';
	import {
		isFiltering,
		listCards,
		passesFilter,
		resolveListColumn,
		type BoardViewChoice,
		type ListFilter,
		type ListOrder
	} from '$lib/board/board-view';
	import CardListRow from './CardListRow.svelte';

	let {
		columns,
		categories,
		filter,
		blockerCount,
		blockerTooltip,
		milestoneNameById,
		cardTokens,
		tick,
		selectedCards,
		selectionMode,
		choice,
		onOpen,
		onContextMenu,
		onChange
	}: {
		columns: ColumnType[];
		categories: CategoryType[];
		/** The header's search, assignee filter and Hide blocked. */
		filter: ListFilter;
		/** Open blockers of a card, by its id. */
		blockerCount: (cardId: number) => number;
		blockerTooltip: (cardId: number) => string;
		milestoneNameById: Map<number, string>;
		cardTokens: Record<number, { tokens: number; costUsd: number | null }>;
		tick: number;
		selectedCards: Set<number>;
		selectionMode: boolean;
		choice: BoardViewChoice;
		onOpen: (card: CardType, e: Event) => void;
		onContextMenu: (e: MouseEvent, card: CardType, columnId: number) => void;
		onChange: (choice: BoardViewChoice) => void;
	} = $props();

	const filtering = $derived(isFiltering(filter));
	const keep = $derived((card: CardType) => passesFilter(card, filter, categories, (id) => blockerCount(id) > 0));
	const columnId = $derived(resolveListColumn(columns, choice.columnId));
	const column = $derived(columns.find((c) => c.id === columnId) ?? null);
	const rows = $derived(column ? listCards(column.cards, choice.order, categories, keep) : []);

	// Another column starts at its top, not where the last one was scrolled to.
	let listEl = $state<HTMLDivElement | null>(null);
	$effect(() => {
		void columnId;
		if (listEl) listEl.scrollTop = 0;
	});

	const ORDERS: { order: ListOrder; label: string; title: string }[] = [
		{ order: 'priority', label: 'Priority', title: 'Pinned first, then critical, high, medium and low, in the board’s order within each' },
		{ order: 'board', label: 'Board order', title: 'The column as the board shows it' }
	];
</script>

<div class="list-view" bind:this={listEl}>
	<div class="list-toolbar">
		<div class="column-strip" role="group" aria-label="Column">
			{#each columns as col (col.id)}
				{@const shown = filtering ? col.cards.filter(keep).length : col.cards.length}
				<button
					class="strip-btn"
					class:active={col.id === columnId}
					aria-pressed={col.id === columnId}
					onclick={() => onChange({ ...choice, columnId: col.id })}
				>
					<span class="strip-dot" style="background: {col.color}" aria-hidden="true"></span>
					<span class="strip-title">{col.title}</span>
					<span class="strip-count">{shown}{#if filtering}<span class="of-total">/{col.cards.length}</span>{/if}</span>
				</button>
			{/each}
		</div>
		<div class="seg" role="group" aria-label="Order">
			{#each ORDERS as o (o.order)}
				<button
					class:active={choice.order === o.order}
					aria-pressed={choice.order === o.order}
					title={o.title}
					onclick={() => onChange({ ...choice, order: o.order })}
				>{o.label}</button>
			{/each}
		</div>
	</div>

	<div class="list-rows">
		{#if !column}
			<p class="list-empty">This board has no columns yet.</p>
		{:else if rows.length === 0}
			<p class="list-empty">{filtering && column.cards.length > 0 ? 'No cards match' : `No cards in ${column.title}`}</p>
		{:else}
			{#each rows as card (card.id)}
				<CardListRow
					{card}
					onHold={isOnHoldColumn(column.title)}
					completed={isCompleteColumn(column)}
					{categories}
					blockerCount={blockerCount(card.id)}
					blockerTooltip={blockerTooltip(card.id)}
					milestoneName={card.milestoneId ? (milestoneNameById.get(card.milestoneId) ?? null) : null}
					tokens={cardTokens[card.id]}
					{tick}
					selected={selectedCards.has(card.id)}
					{selectionMode}
					{onOpen}
					onContextMenu={(e, c) => onContextMenu(e, c, column.id)}
				/>
			{/each}
		{/if}
	</div>
</div>

<style>
	/* Full width at any size, scrolling down and never across. */
	.list-view {
		flex: 1; min-height: 0; min-width: 0;
		display: flex; flex-direction: column;
		overflow-y: auto; overflow-x: hidden;
		padding: var(--space-lg);
	}
	.list-toolbar {
		display: flex; align-items: flex-start; justify-content: space-between;
		gap: var(--space-sm); flex-wrap: wrap; margin-bottom: var(--space-md);
	}
	.column-strip { display: flex; flex-wrap: wrap; gap: 6px; min-width: 0; flex: 1; }
	.strip-btn {
		display: inline-flex; align-items: center; gap: 6px; max-width: 100%;
		height: 30px; padding: 0 10px;
		background: var(--bg-surface); color: var(--text-secondary);
		border: 1px solid var(--glass-border); border-radius: var(--radius-full);
		font-family: var(--font-family); font-size: 0.75rem; font-weight: 600;
		cursor: pointer; transition: all var(--duration-fast) var(--ease-out);
	}
	.strip-btn:hover { background: var(--bg-elevated); color: var(--text-primary); }
	.strip-btn.active { background: var(--accent-indigo); border-color: var(--accent-indigo); color: #fff; }
	.strip-btn:focus-visible { outline: 2px solid var(--accent-indigo); outline-offset: 2px; }
	.strip-dot { width: 8px; height: 8px; border-radius: 50%; flex-shrink: 0; }
	.strip-title { min-width: 0; overflow: hidden; text-overflow: ellipsis; white-space: nowrap; }
	.strip-count { font-variant-numeric: tabular-nums; opacity: 0.8; }
	.of-total { opacity: 0.6; font-size: 0.65rem; }

	.seg {
		display: inline-flex; flex-shrink: 0; border-radius: var(--radius-full);
		border: 1px solid var(--glass-border); overflow: hidden;
	}
	.seg button {
		height: 28px; padding: 0 12px; background: var(--bg-surface); border: none;
		border-right: 1px solid var(--glass-border);
		color: var(--text-secondary); font-family: var(--font-family);
		font-size: 0.75rem; font-weight: 600; cursor: pointer; white-space: nowrap;
		transition: all var(--duration-fast) var(--ease-out);
	}
	.seg button:last-child { border-right: none; }
	.seg button:hover { background: var(--bg-elevated); color: var(--text-primary); }
	.seg button.active { background: var(--accent-indigo); color: #fff; }
	/* app.css takes the outline off every button; inset, as the group clips its edges. */
	.seg button:focus-visible { outline: 2px solid var(--accent-indigo); outline-offset: -2px; }

	.list-rows { display: flex; flex-direction: column; gap: var(--space-sm); min-width: 0; }
	.list-empty { color: var(--text-tertiary); font-size: 0.85rem; text-align: center; padding: var(--space-xl) 0; }
</style>
