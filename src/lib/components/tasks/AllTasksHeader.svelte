<!--
  AllTasksHeader.svelte — All Tasks' header: the back link, the title and
  its counts, the spend across every board, the board filter, the search,
  and the Views and More menus (card 2281, slice C3a-2: moved from
  src/routes/all/+page.svelte).

  Card 2472 tidied the bar as card 2466 did the dashboard's and the board's:
  the board filter and the search stay in view; Planning and All To Do are
  in Views; Hide blocked, the three panels, Export to CSV and the theme are
  in More, whose button has a dot while Hide blocked is on.

  The filter, the search and Hide blocked are the page's, bound here, which
  it filters the cards by. The three panels are drawn by the page, which
  opens and closes them. HeaderMenu closes its own menus on a click outside.
-->
<script lang="ts">
	import type { PageData } from '../../../routes/all/$types';
	import { formatTokens } from '$lib/tokens';
	import { formatUsd, BLEND_NOTE, SOURCE_NOTE, NOT_BILLED_NOTE } from '$lib/pricing';
	import HeaderMenu from '$lib/components/HeaderMenu.svelte';
	import ThemeMenuItems from '$lib/components/ThemeMenuItems.svelte';
	import { boardOptionLabel, boardOptions } from '$lib/board-tree';

	let {
		data,
		chosenBoard,
		activityOpen,
		showStatsPanel,
		showArchivePanel,
		toggleActivity,
		toggleStatsPanel,
		toggleArchivePanel,
		boardFilter = $bindable(),
		searchQuery = $bindable(),
		hideBlocked = $bindable()
	}: {
		/** What All Tasks' load gave it, passed on as it is. */
		data: PageData;
		/** The page's: the board chosen in the filter, or 0 (`chosenBoardId`). */
		chosenBoard: number;
		/** The page's: whether the Activity Log is open. */
		activityOpen: boolean;
		/** The page's: whether Statistics is open. */
		showStatsPanel: boolean;
		/** The page's: whether Archived Cards is open. */
		showArchivePanel: boolean;
		/** Opens or closes the Activity Log, which reads its list as it first opens. */
		toggleActivity: () => void;
		/** Opens or closes Statistics. */
		toggleStatsPanel: () => void;
		/** Opens or closes Archived Cards, which reads its list as it first opens. */
		toggleArchivePanel: () => void;
		/** The page's: the board filter's value, a string ('all', 'cat:N' or a board's id). */
		boardFilter: string;
		/** The page's: what is typed in the search. */
		searchQuery: string;
		/** The page's: whether cards still waiting on another card are hidden. */
		hideBlocked: boolean;
	} = $props();

	const ownBoardOnly = ' (the chosen board alone, not its sub-boards)';

	/**
	 * More's dot, as the dashboard's Display has one: lit by Hide blocked
	 * alone, the one switch in Show that is otherwise unseen with the menu
	 * shut. A panel that is open shows itself (the review of card 2472).
	 */
	const moreTitle = $derived(hideBlocked ? 'More: Hide blocked is on' : 'More: Hide blocked, the panels, Export to CSV and the theme');

	/** Each section of More is a group named by its heading, so a screen reader in the menu says it. */
	const uid = $props.id();
	const showId = `all-more-show-${uid}`;
	const exportId = `all-more-export-${uid}`;

	/**
	 * All To Do with this page's board filter, so the two pages hand over the
	 * same scope (card 2240): a board there takes in its sub-boards, as here.
	 */
	const todoHref = $derived(String(boardFilter) === 'all' ? '/todo' : `/todo?${new URLSearchParams({ board: String(boardFilter) })}`);

	/** One group of the board filter, each sub-board indented under its parent. */
	function filterOptions(group: typeof data.boards) {
		return boardOptions(group).map(({ board, depth }) => ({ id: board.id, label: boardOptionLabel(board, depth) }));
	}
</script>

<header class="all-header">
	<div class="all-header-left">
		<a href="/" class="back-btn btn-ghost" id="back-to-dashboard">
			<svg width="18" height="18" viewBox="0 0 18 18" fill="none"><path d="M11 4L6 9l5 5" stroke="currentColor" stroke-width="2" stroke-linecap="round" stroke-linejoin="round"/></svg>
		</a>
		<span class="all-icon">🌐</span>
		<div>
			<h1 class="all-title">All Tasks</h1>
			<p class="all-subtitle">
				{data.totalCards} total · {data.completedCards} complete · {data.totalCards - data.completedCards} remaining
			</p>
		</div>
		<!-- Spend across every board here. Lifted out of the subtitle line so it
		     can carry the same weight as the board header chip rather than
		     trailing a row of counts at subtitle size. -->
		{#if data.allTokenSummary}
			<span class="hdr-cost" title="{formatTokens(data.allTokenSummary.total)} tokens across every board here · {NOT_BILLED_NOTE}. {SOURCE_NOTE} — {BLEND_NOTE}.">
				{formatTokens(data.allTokenSummary.total)}
				{#if data.allTokenSummary.costUsd !== null}
					<span class="hdr-cost-money">{formatUsd(data.allTokenSummary.costUsd)}</span>
				{/if}
			</span>
		{/if}
	</div>
	<div class="all-header-right">
		<select class="hdr-control board-filter" bind:value={boardFilter}>
			<option value="all">All Boards</option>
			{#each (data.boardCategories || []) as cat}
				{@const catBoards = data.boards.filter((b) => b.filterCategoryId === cat.id)}
				{#if catBoards.length > 0}
					<optgroup label="{cat.name}">
						<option value="cat:{cat.id}">⬛ All {cat.name}</option>
						{#each filterOptions(catBoards) as option}
							<option value={String(option.id)}>{option.label}</option>
						{/each}
					</optgroup>
				{/if}
			{/each}
			{#each [data.boards.filter((b) => !b.filterCategoryId)] as uncategorizedBoards}
				{#if uncategorizedBoards.length > 0}
					<optgroup label="Uncategorized">
						{#each filterOptions(uncategorizedBoards) as option}
							<option value={String(option.id)}>{option.label}</option>
						{/each}
					</optgroup>
				{/if}
			{/each}
		</select>
		<div class="search-wrapper hdr-search">
			<svg class="search-icon" width="14" height="14" viewBox="0 0 14 14" fill="none">
				<circle cx="6" cy="6" r="4.5" stroke="currentColor" stroke-width="1.5"/>
				<path d="M10 10l3 3" stroke="currentColor" stroke-width="1.5" stroke-linecap="round"/>
			</svg>
			<input type="text" class="search-input" placeholder="Search tasks or #id..." bind:value={searchQuery} />
		</div>
		<!-- The other pages, one click deeper (card 2472, as card 2466 did the dashboard's). -->
		<HeaderMenu label="Views" triggerClass="hdr-control hdr-action" triggerId="all-views-btn" triggerTitle="Planning and All To Do">
			{#snippet trigger()}
				<svg width="14" height="14" viewBox="0 0 16 16" fill="none" aria-hidden="true">
					<rect x="2" y="2" width="5" height="5" rx="1" stroke="currentColor" stroke-width="1.2"/>
					<rect x="9" y="2" width="5" height="5" rx="1" stroke="currentColor" stroke-width="1.2"/>
					<rect x="2" y="9" width="5" height="5" rx="1" stroke="currentColor" stroke-width="1.2"/>
					<rect x="9" y="9" width="5" height="5" rx="1" stroke="currentColor" stroke-width="1.2"/>
				</svg>
				Views
			{/snippet}
			<a
				href={chosenBoard ? `/plan?board=${chosenBoard}` : '/plan'}
				class="hm-item"
				role="menuitem"
				tabindex="-1"
				title="Planning — critical path and what is startable{chosenBoard ? ownBoardOnly : ''}"
			>
				<svg width="14" height="14" viewBox="0 0 16 16" fill="none" aria-hidden="true">
					<circle cx="3.5" cy="8" r="1.8" stroke="currentColor" stroke-width="1.2"/>
					<circle cx="8" cy="4" r="1.8" stroke="currentColor" stroke-width="1.2"/>
					<circle cx="12.5" cy="8" r="1.8" stroke="currentColor" stroke-width="1.2"/>
					<path d="M5.2 7.1L6.4 4.9M9.6 4.9l1.2 2.2" stroke="currentColor" stroke-width="1.1" stroke-linecap="round"/>
					<path d="M5.3 8.9l5.4 2.6" stroke="currentColor" stroke-width="1.1" stroke-linecap="round" stroke-dasharray="1.5 1.5"/>
				</svg>
				Planning
			</a>
			<!-- All To Do over the same scope: the chosen board with its sub-boards, or the grouping (card 2240). -->
			<a href={todoHref} class="hm-item" role="menuitem" tabindex="-1" title="All To Do — every To Do column as one table{boardFilter === 'all' ? '' : ', for the boards chosen here'}">
				<svg width="14" height="14" viewBox="0 0 16 16" fill="none" aria-hidden="true">
					<rect x="2" y="2.5" width="12" height="11" rx="2" stroke="currentColor" stroke-width="1.3"/>
					<path d="M4.8 6.2l1.2 1.2 2-2.2M9.6 6.4h2M4.8 10.2h6.8" stroke="currentColor" stroke-width="1.2" stroke-linecap="round" stroke-linejoin="round"/>
				</svg>
				All To Do
			</a>
		</HeaderMenu>
		<!-- Hide blocked and the panels, Export to CSV and the theme (card 2472). Hide
		     blocked leaves the menu open, as the board's Filter does; a panel's switch
		     closes it (data-menu-close), as it did, the focus back on More. The dot
		     says Hide blocked is on, as the dashboard's Display says a setting is changed. -->
		<HeaderMenu label="More" triggerClass="hdr-control hdr-action" triggerId="all-more-btn" triggerTitle={moreTitle} triggerActive={hideBlocked}>
			{#snippet trigger()}
				<svg width="14" height="14" viewBox="0 0 16 16" fill="none" aria-hidden="true"><circle cx="3" cy="8" r="1.5" fill="currentColor"/><circle cx="8" cy="8" r="1.5" fill="currentColor"/><circle cx="13" cy="8" r="1.5" fill="currentColor"/></svg>
				More
				{#if hideBlocked}<span class="more-dot" aria-label="changed"></span>{/if}
			{/snippet}
			<div class="hm-label" id={showId}>Show</div>
			<div role="group" aria-labelledby={showId}>
				<button class="hm-item" role="menuitemcheckbox" tabindex="-1" aria-checked={hideBlocked} onclick={() => (hideBlocked = !hideBlocked)} title="Hide cards that are still waiting on another card">
					<span class="hm-icon" aria-hidden="true">
						<svg width="13" height="13" viewBox="0 0 10 10" fill="none">
							<circle cx="5" cy="5" r="4" stroke="currentColor" stroke-width="1.4"/>
							<path d="M2.2 7.8L7.8 2.2" stroke="currentColor" stroke-width="1.4" stroke-linecap="round"/>
						</svg>
					</span>
					Hide blocked
					{#if hideBlocked}<span class="hm-check" aria-hidden="true">✓</span>{/if}
				</button>
				<button class="hm-item" role="menuitemcheckbox" data-menu-close tabindex="-1" aria-checked={activityOpen} onclick={() => toggleActivity()}>
					<span class="hm-icon" aria-hidden="true">📋</span> Activity Log
					{#if activityOpen}<span class="hm-check" aria-hidden="true">✓</span>{/if}
				</button>
				<button class="hm-item" role="menuitemcheckbox" data-menu-close tabindex="-1" aria-checked={showStatsPanel} onclick={() => toggleStatsPanel()} title="Statistics{chosenBoard ? ownBoardOnly : ''}">
					<span class="hm-icon" aria-hidden="true">📊</span> Statistics
					{#if showStatsPanel}<span class="hm-check" aria-hidden="true">✓</span>{/if}
				</button>
				<button class="hm-item" role="menuitemcheckbox" data-menu-close tabindex="-1" aria-checked={showArchivePanel} onclick={() => toggleArchivePanel()}>
					<span class="hm-icon" aria-hidden="true">🗄️</span> Archived Cards
					{#if showArchivePanel}<span class="hm-check" aria-hidden="true">✓</span>{/if}
				</button>
			</div>
			<div class="hm-divider" role="separator"></div>
			<div class="hm-label" id={exportId}>Export</div>
			<div role="group" aria-labelledby={exportId}>
				<a class="hm-item export-csv-btn" role="menuitem" tabindex="-1" href={chosenBoard ? `/api/cards/export/csv?boardId=${chosenBoard}` : '/api/cards/export/csv'} download title="Export to CSV{chosenBoard ? ownBoardOnly : ''}">
					<span class="hm-icon" aria-hidden="true">
						<svg width="14" height="14" viewBox="0 0 16 16" fill="none"><path d="M8 2v8M5 7l3 3 3-3" stroke="currentColor" stroke-width="1.5" stroke-linecap="round" stroke-linejoin="round"/><path d="M2 11v2a1 1 0 001 1h10a1 1 0 001-1v-2" stroke="currentColor" stroke-width="1.5" stroke-linecap="round"/></svg>
					</span>
					Export to CSV
				</a>
			</div>
			<div class="hm-divider" role="separator"></div>
			<ThemeMenuItems />
		</HeaderMenu>
	</div>
</header>

<style>
	/* The bar wraps at any width where it does not fit (card 2472's review),
	   the controls to a row of their own, kept to the right, rather than
	   running past the window, which .all-page would clip; where it fits it
	   is one row, as before. The menus' panels are kept inside the window by
	   HeaderMenu. */
	.all-header {
		display: flex;
		flex-wrap: wrap;
		align-items: center;
		justify-content: space-between;
		padding: var(--space-lg) var(--space-xl);
		border-bottom: 1px solid var(--glass-border);
		flex-shrink: 0;
		gap: var(--space-md);
	}

	.all-header-left {
		display: flex;
		align-items: center;
		gap: var(--space-md);
		flex-shrink: 1;
		min-width: 0;
	}

	.all-header-right {
		display: flex;
		flex-wrap: wrap;
		align-items: center;
		gap: var(--space-sm);
		flex-shrink: 1;
		min-width: 0;
		margin-left: auto;
	}

	.all-icon {
		font-size: 1.75rem;
	}

	.all-title {
		font-size: 1.25rem;
		background: linear-gradient(135deg, var(--text-primary), var(--accent-purple));
		-webkit-background-clip: text;
		-webkit-text-fill-color: transparent;
		background-clip: text;
	}

	.all-subtitle {
		font-size: 0.75rem;
		color: var(--text-secondary);
		margin-top: 1px;
	}

	.board-filter:focus {
		border-color: var(--accent-purple);
	}

	/* Header controls come from .hdr-control / .hdr-search in app.css so this
	   header and the board's cannot drift apart again. Only what is local to
	   All Tasks stays here. */
	.search-wrapper input { width: 210px; }
	.board-filter { max-width: 190px; padding-right: 8px; }

	/* More while Hide blocked is on, as app.css draws an action that is
	   on. :global, as HeaderMenu draws the button. */
	.all-header-right :global(.hdr-action.hm-on) {
		background: var(--glass-hover);
		border-color: var(--glass-border);
		color: var(--text-primary);
	}
	/* Hide blocked is on: a dot, so it is seen with the menu shut (as the dashboard's Display). */
	.more-dot {
		display: inline-block; width: 7px; height: 7px; border-radius: 50%;
		background: var(--accent-indigo);
	}

	.search-icon {
		position: absolute;
		left: 10px;
		color: var(--text-tertiary);
		pointer-events: none;
	}


	.search-input:focus {
		border-color: var(--accent-purple);
	}

	.back-btn {
		font-size: 0;
		padding: var(--space-sm);
		color: var(--text-secondary);
	}

	.back-btn:hover {
		color: var(--text-primary);
	}

	/* What has been spent, on the header strip. Sized to be read at a glance:
	   this is the figure the whole ledger exists to surface, and inline in the
	   subtitle at 0.8rem it was easy to miss entirely. The money carries the
	   most weight because it is the part people act on. Matches the board. */
	.hdr-cost {
		display: inline-flex; align-items: baseline; gap: 8px;
		padding: 5px 14px; border-radius: var(--radius-full);
		background: var(--bg-surface);
		border: 1px solid var(--accent-purple-glow, var(--glass-border));
		font-size: 1rem; font-weight: 600; line-height: 1.25;
		color: var(--text-primary);
		font-variant-numeric: tabular-nums; white-space: nowrap;
	}
	.hdr-cost-money { font-weight: 800; font-size: 1.1rem; color: var(--accent-purple, #8b5cf6); }

	/* On a phone (card 2472) the title wraps too, and the filter and the
	   search share the width. */
	@media (max-width: 640px) {
		.all-header { padding: var(--space-md); }
		.all-header-left { flex-wrap: wrap; }
		.all-header-right { width: 100%; }
		.board-filter { flex: 1 1 140px; max-width: none; min-width: 0; }
		.search-wrapper { flex: 1 1 160px; min-width: 0; }
		.search-wrapper input { width: 100%; min-width: 0; }
	}
</style>
