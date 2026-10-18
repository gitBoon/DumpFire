<!--
  BoardFilterSelect.svelte — the board filter as All Tasks draws it (cards 1990 and 2240).

  "All Boards", then a group for each grouping that has a board: "All <grouping>"
  (`cat:N`) and its boards, each sub-board straight after its parent and
  indented (`boardOptions`, `boardOptionLabel`); then "Uncategorized". A board
  is grouped by the grouping it is filtered under (`filterCategoryId`), so a
  sub-board sits under its parent's.

  Every option's value is a string, and so is the bound value: Svelte 5 gives
  a bound select the option's value as it was passed, and a number once made
  the filter's `startsWith` throw (card 1990's review).

  All To Do uses it. All Tasks still draws its own, which its tests read;
  card 2012 can move it onto this.
-->
<script lang="ts">
	import { boardOptionLabel, boardOptions } from '$lib/board-tree';

	type FilterBoard = { id: number; name: string; emoji: string; parentId: number | null; hiddenAbove: boolean; filterCategoryId: number | null };

	let {
		boards,
		groupings,
		value = $bindable('all'),
		onchange,
		id,
		label = 'Board'
	}: {
		boards: readonly FilterBoard[];
		groupings: readonly { id: number; name: string }[];
		value?: string;
		onchange?: (value: string) => void;
		id?: string;
		label?: string;
	} = $props();

	/** One group of the filter, each sub-board indented under its parent. */
	function filterOptions(group: readonly FilterBoard[]) {
		return boardOptions(group).map(({ board, depth }) => ({ id: board.id, label: boardOptionLabel(board, depth) }));
	}

	const grouped = $derived(
		groupings
			.map((grouping) => ({ grouping, options: filterOptions(boards.filter((b) => b.filterCategoryId === grouping.id)) }))
			.filter((group) => group.options.length > 0)
	);
	const ungrouped = $derived(filterOptions(boards.filter((b) => !b.filterCategoryId)));
</script>

<select class="hdr-control board-filter" {id} aria-label={label} bind:value onchange={() => onchange?.(value)}>
	<option value="all">All Boards</option>
	{#each grouped as group (group.grouping.id)}
		<optgroup label={group.grouping.name}>
			<option value="cat:{group.grouping.id}">⬛ All {group.grouping.name}</option>
			{#each group.options as option (option.id)}
				<option value={String(option.id)}>{option.label}</option>
			{/each}
		</optgroup>
	{/each}
	{#if ungrouped.length > 0}
		<optgroup label="Uncategorized">
			{#each ungrouped as option (option.id)}
				<option value={String(option.id)}>{option.label}</option>
			{/each}
		</optgroup>
	{/if}
</select>

<style>
	.board-filter { max-width: 220px; padding-right: 8px; }
	.board-filter:focus { border-color: var(--accent-purple); }
</style>
