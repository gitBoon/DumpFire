<!--
  BoardMoreMenu.svelte — The board header's More menu (card 2280, slice B3:
  moved from the board page).

  Where to go from the board (Planning and All To Do, scoped to it), the
  panels (Activity Log, Statistics, Archived Cards), what is done to the
  board as a whole (Add Column, Burndown on a delivery board, Manage Categories,
  Bulk Select, Share Board and the board's kind for someone who manages it
  ("Make this an ideas board…", or "Make this a delivery board…" on an ideas
  board; card 2463), and Delete Sub-board when the board is one), and the
  theme. Card 2466 moved Planning, All To Do, Add Column and
  the theme here from the bar, and made the menu a HeaderMenu: keyboard
  operable, and each item closes it, the focus back on More, before the item
  hands its choice to the page, so a window that gives the focus back as it
  closes (Delete Sub-board's confirm) gives it to More. Whether it is open is
  the page's, which closes it on any click outside.
-->
<script lang="ts">
	import HeaderMenu from '$lib/components/HeaderMenu.svelte';
	import ThemeMenuItems from '$lib/components/ThemeMenuItems.svelte';

	let {
		open = $bindable(),
		showActivityPanel,
		showStatsPanel,
		showArchivePanel,
		selectionMode,
		canManage,
		isSubBoard,
		boardId,
		boardKind = 'delivery',
		onAddColumn,
		onMakeIdeas = () => {},
		onMakeDelivery = () => {},
		onToggleActivity,
		onToggleStats,
		onToggleArchive,
		onManageCategories,
		onToggleSelection,
		onShare,
		onDeleteSubBoard
	}: {
		open: boolean;
		showActivityPanel: boolean;
		showStatsPanel: boolean;
		showArchivePanel: boolean;
		selectionMode: boolean;
		canManage: boolean;
		/** The board is a sub-board: Delete Sub-board is offered. */
		isSubBoard: boolean;
		boardId: number;
		/** The board's kind (milestone 22, card 2463): an ideas board has no burndown, and its owner can make it a delivery board again. */
		boardKind?: string;
		onAddColumn: () => void;
		/** "Make this an ideas board…": the page counts the cards and asks first. */
		onMakeIdeas?: () => void;
		/** "Make this a delivery board…": the page says why not while the board holds cards, and asks first when it holds none. */
		onMakeDelivery?: () => void;
		onToggleActivity: () => void;
		onToggleStats: () => void;
		onToggleArchive: () => void;
		onManageCategories: () => void;
		onToggleSelection: () => void;
		onShare: () => void;
		/** Asks first, in the page's confirmation. */
		onDeleteSubBoard: () => void;
	} = $props();

	/** Each section is a group named by its heading, so a screen reader in the menu says it. */
	const uid = $props.id();
	const goId = `more-go-${uid}`;
	const panelsId = `more-panels-${uid}`;
	const boardSectionId = `more-board-${uid}`;
</script>

<!-- More menu (progressive disclosure). HeaderMenu closes it, the focus on
     More, before each item's own click runs. -->
<HeaderMenu label="More" bind:open triggerClass="hdr-control hdr-action more-menu-trigger" triggerTitle="More actions">
	{#snippet trigger()}
		<svg width="14" height="14" viewBox="0 0 16 16" fill="none" aria-hidden="true">
			<circle cx="3" cy="8" r="1.5" fill="currentColor"/>
			<circle cx="8" cy="8" r="1.5" fill="currentColor"/>
			<circle cx="13" cy="8" r="1.5" fill="currentColor"/>
		</svg>
		More
	{/snippet}
	<div class="hm-label" id={goId}>Go to</div>
	<div role="group" aria-labelledby={goId}>
	<!-- Scoped to this board: arriving from a board, the question is about
	     this board's goals, not every goal in the workspace. -->
	<a class="hm-item" role="menuitem" tabindex="-1" href="/plan?board={boardId}" title="Planning — critical path and what is startable for this board">
		<span class="hm-icon">
			<svg width="14" height="14" viewBox="0 0 16 16" fill="none" aria-hidden="true">
				<circle cx="3.5" cy="8" r="1.8" stroke="currentColor" stroke-width="1.2"/>
				<circle cx="8" cy="4" r="1.8" stroke="currentColor" stroke-width="1.2"/>
				<circle cx="12.5" cy="8" r="1.8" stroke="currentColor" stroke-width="1.2"/>
				<path d="M5.2 7.1L6.4 4.9M9.6 4.9l1.2 2.2" stroke="currentColor" stroke-width="1.1" stroke-linecap="round"/>
				<path d="M5.3 8.9l5.4 2.6" stroke="currentColor" stroke-width="1.1" stroke-linecap="round" stroke-dasharray="1.5 1.5"/>
			</svg>
		</span>
		Planning
	</a>
	<!-- Every board's To Do column as one table, filtered to this board and
	     its sub-boards (card 2240). Shown on every board, one with no To Do
	     column too: its sub-boards may have one. -->
	<a class="hm-item" role="menuitem" tabindex="-1" href="/todo?board={boardId}" title="This board's To Do column, and its sub-boards', with every other board's a filter away">
		<span class="hm-icon">
			<svg width="14" height="14" viewBox="0 0 16 16" fill="none" aria-hidden="true">
				<rect x="2" y="2.5" width="12" height="11" rx="2" stroke="currentColor" stroke-width="1.3"/>
				<path d="M4.8 6.2l1.2 1.2 2-2.2M9.6 6.4h2M4.8 10.2h6.8" stroke="currentColor" stroke-width="1.2" stroke-linecap="round" stroke-linejoin="round"/>
			</svg>
		</span>
		All To Do
	</a>
	</div>

	<div class="hm-divider" role="separator"></div>

	<div class="hm-label" id={panelsId}>Panels</div>
	<div role="group" aria-labelledby={panelsId}>
	<button class="hm-item" role="menuitemcheckbox" data-menu-close tabindex="-1" aria-checked={showActivityPanel} onclick={() => onToggleActivity()}>
		<span class="hm-icon">📋</span> Activity Log
		{#if showActivityPanel}<span class="hm-check">✓</span>{/if}
	</button>
	<button class="hm-item" role="menuitemcheckbox" data-menu-close tabindex="-1" aria-checked={showStatsPanel} onclick={() => onToggleStats()}>
		<span class="hm-icon">📊</span> Statistics
		{#if showStatsPanel}<span class="hm-check">✓</span>{/if}
	</button>
	<button class="hm-item" role="menuitemcheckbox" data-menu-close tabindex="-1" aria-checked={showArchivePanel} onclick={() => onToggleArchive()}>
		<span class="hm-icon">🗄️</span> Archived Cards
		{#if showArchivePanel}<span class="hm-check">✓</span>{/if}
	</button>
	</div>

	<div class="hm-divider" role="separator"></div>

	<div class="hm-label" id={boardSectionId}>Board</div>
	<div role="group" aria-labelledby={boardSectionId}>
	<button class="hm-item" role="menuitem" tabindex="-1" onclick={() => onAddColumn()} title="Add column">
		<span class="hm-icon">
			<svg width="14" height="14" viewBox="0 0 16 16" fill="none" aria-hidden="true">
				<rect x="2" y="2" width="12" height="12" rx="2" stroke="currentColor" stroke-width="1.5"/>
				<path d="M8 5v6M5 8h6" stroke="currentColor" stroke-width="1.5" stroke-linecap="round"/>
			</svg>
		</span>
		Add Column
	</button>
	<!-- An ideas board has no burndown: nothing on it is committed work (milestone 22). -->
	{#if boardKind !== 'ideas'}
		<a class="hm-item" role="menuitem" tabindex="-1" href="/burndown?boardIds={boardId}">
			<span class="hm-icon">📉</span> Burndown
		</a>
	{/if}
	<button class="hm-item" role="menuitem" tabindex="-1" onclick={() => onManageCategories()}>
		<span class="hm-icon">🏷️</span> Manage Categories
	</button>
	<button class="hm-item" role="menuitemcheckbox" data-menu-close tabindex="-1" aria-checked={selectionMode} onclick={() => onToggleSelection()}>
		<span class="hm-icon">☑️</span> Bulk Select
		{#if selectionMode}<span class="hm-check">✓</span>{/if}
	</button>
	{#if canManage}
		<button class="hm-item" role="menuitem" tabindex="-1" onclick={() => onShare()}>
			<span class="hm-icon">🔗</span> Share Board
		</button>
		<!-- The board's kind (milestone 22, card 2463), the owner's or an
		     administrator's to change, as the server asks. A sub-board is a
		     delivery board, so is not offered it. -->
		{#if boardKind === 'ideas'}
			<button class="hm-item" role="menuitem" tabindex="-1" onclick={() => onMakeDelivery()} title="Only an ideas board holding no cards can be made a delivery board">
				<span class="hm-icon">🚚</span> Make this a delivery board…
			</button>
		{:else if !isSubBoard}
			<button class="hm-item" role="menuitem" tabindex="-1" onclick={() => onMakeIdeas()} title="Make every card on it an idea, not yet committed to, sent on to delivery boards when chosen">
				<span class="hm-icon">💡</span> Make this an ideas board…
			</button>
		{/if}
	{/if}
	{#if isSubBoard}
		<button class="hm-item more-danger" role="menuitem" tabindex="-1" onclick={() => onDeleteSubBoard()}>
			<span class="hm-icon">🗑️</span> Delete Sub-board
		</button>
	{/if}
	</div>

	<div class="hm-divider" role="separator"></div>

	<ThemeMenuItems />
</HeaderMenu>

<style>
	/* The panel and its items are HeaderMenu's (the shared hm-* look); only
	   what is this menu's own stays here. */
	:global(.hm-panel) .hm-item.more-danger { color: var(--text-tertiary); }
	:global(.hm-panel) .hm-item.more-danger:hover,
	:global(.hm-panel) .hm-item.more-danger:focus {
		color: var(--accent-rose); background: rgba(244, 63, 94, 0.08);
	}

	/* The button while open, as it was drawn. :global, as HeaderMenu draws it. */
	:global(.more-menu-trigger.hm-open) { background: rgba(99, 102, 241, 0.12) !important; color: var(--accent-indigo) !important; }
</style>
