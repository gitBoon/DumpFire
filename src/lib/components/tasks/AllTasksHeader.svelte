<!--
  AllTasksHeader.svelte — All Tasks' header: the back link, the title and
  its counts, the spend across every board, the board filter, the search,
  Hide blocked, Planning, All To Do, the More menu with its three panels,
  Export to CSV and the theme picker (card 2281, slice C3a-2: moved from
  src/routes/all/+page.svelte).

  The filter, the search and Hide blocked are the page's, bound here, which
  it filters the cards by. Whether the More menu is open is the page's too,
  which closes it on a click anywhere on the page. The menu's three panels
  are drawn by the page, which opens and closes them.
-->
<script lang="ts">
	import type { PageData } from '../../../routes/all/$types';
	import { formatTokens } from '$lib/tokens';
	import { formatUsd, BLEND_NOTE, SOURCE_NOTE, NOT_BILLED_NOTE } from '$lib/pricing';
	import ThemePicker from '$lib/components/ThemePicker.svelte';
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
		hideBlocked = $bindable(),
		showMoreMenu = $bindable()
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
		/** The page's: whether the More menu is open. */
		showMoreMenu: boolean;
	} = $props();

	const ownBoardOnly = ' (the chosen board alone, not its sub-boards)';

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
		<button
			class="hdr-control blocked-filter-toggle"
			class:is-on={hideBlocked}
			onclick={() => (hideBlocked = !hideBlocked)}
			title="Hide cards that are still waiting on another card"
		>
			<svg width="13" height="13" viewBox="0 0 10 10" fill="none" aria-hidden="true">
				<circle cx="5" cy="5" r="4" stroke="currentColor" stroke-width="1.4"/>
				<path d="M2.2 7.8L7.8 2.2" stroke="currentColor" stroke-width="1.4" stroke-linecap="round"/>
			</svg>
			Hide blocked
		</button>
		<a
			href={chosenBoard ? `/plan?board=${chosenBoard}` : '/plan'}
			class="hdr-control hdr-action"
			title="Planning — critical path and what is startable{chosenBoard ? ownBoardOnly : ''}"
		>
			<svg width="14" height="14" viewBox="0 0 16 16" fill="none">
				<circle cx="3.5" cy="8" r="1.8" stroke="currentColor" stroke-width="1.2"/>
				<circle cx="8" cy="4" r="1.8" stroke="currentColor" stroke-width="1.2"/>
				<circle cx="12.5" cy="8" r="1.8" stroke="currentColor" stroke-width="1.2"/>
				<path d="M5.2 7.1L6.4 4.9M9.6 4.9l1.2 2.2" stroke="currentColor" stroke-width="1.1" stroke-linecap="round"/>
				<path d="M5.3 8.9l5.4 2.6" stroke="currentColor" stroke-width="1.1" stroke-linecap="round" stroke-dasharray="1.5 1.5"/>
			</svg>
			Planning
		</a>
		<!-- All To Do over the same scope: the chosen board with its sub-boards, or the grouping (card 2240). -->
		<a href={todoHref} class="hdr-control hdr-action" title="All To Do — every To Do column as one table{boardFilter === 'all' ? '' : ', for the boards chosen here'}">
			<svg width="14" height="14" viewBox="0 0 16 16" fill="none">
				<rect x="2" y="2.5" width="12" height="11" rx="2" stroke="currentColor" stroke-width="1.3"/>
				<path d="M4.8 6.2l1.2 1.2 2-2.2M9.6 6.4h2M4.8 10.2h6.8" stroke="currentColor" stroke-width="1.2" stroke-linecap="round" stroke-linejoin="round"/>
			</svg>
			All To Do
		</a>
		<div class="more-menu-container">
			<button class="hdr-control hdr-action" class:is-on={showMoreMenu} onclick={(e) => { e.stopPropagation(); showMoreMenu = !showMoreMenu; }} title="Panels">
				<svg width="14" height="14" viewBox="0 0 16 16" fill="none"><circle cx="8" cy="3" r="1.2" fill="currentColor"/><circle cx="8" cy="8" r="1.2" fill="currentColor"/><circle cx="8" cy="13" r="1.2" fill="currentColor"/></svg>
				More
			</button>
			{#if showMoreMenu}
				<!-- svelte-ignore a11y_click_events_have_key_events -->
				<!-- svelte-ignore a11y_no_static_element_interactions -->
				<div class="more-dropdown" onclick={(e) => e.stopPropagation()}>
					<div class="more-dropdown-section">
						<div class="more-dropdown-label">Panels</div>
						<button class="more-dropdown-item" class:more-active={activityOpen} onclick={() => { toggleActivity(); showMoreMenu = false; }}>
							<span class="more-item-icon">📋</span> Activity Log
							{#if activityOpen}<span class="more-check">✓</span>{/if}
						</button>
						<button class="more-dropdown-item" class:more-active={showStatsPanel} onclick={() => { toggleStatsPanel(); showMoreMenu = false; }} title="Statistics{chosenBoard ? ownBoardOnly : ''}">
							<span class="more-item-icon">📊</span> Statistics
							{#if showStatsPanel}<span class="more-check">✓</span>{/if}
						</button>
						<button class="more-dropdown-item" class:more-active={showArchivePanel} onclick={() => { toggleArchivePanel(); showMoreMenu = false; }}>
							<span class="more-item-icon">🗄️</span> Archived Cards
							{#if showArchivePanel}<span class="more-check">✓</span>{/if}
						</button>
					</div>
				</div>
			{/if}
		</div>
		<a class="hdr-control hdr-action export-csv-btn" href={chosenBoard ? `/api/cards/export/csv?boardId=${chosenBoard}` : '/api/cards/export/csv'} download title="Export to CSV{chosenBoard ? ownBoardOnly : ''}">
			<svg width="14" height="14" viewBox="0 0 16 16" fill="none"><path d="M8 2v8M5 7l3 3 3-3" stroke="currentColor" stroke-width="1.5" stroke-linecap="round" stroke-linejoin="round"/><path d="M2 11v2a1 1 0 001 1h10a1 1 0 001-1v-2" stroke="currentColor" stroke-width="1.5" stroke-linecap="round"/></svg>
		</a>
		<ThemePicker />
	</div>
</header>

<style>
	.all-header {
		display: flex;
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
		flex-shrink: 0;
	}

	.all-header-right {
		display: flex;
		align-items: center;
		gap: var(--space-sm);
		flex-shrink: 0;
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

	/* Amber is specific to "blocked", so this state stays local. */
	.blocked-filter-toggle.is-on {
		background: rgba(245, 158, 11, 0.14); color: #f59e0b;
		border-color: rgba(245, 158, 11, 0.35);
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

	/* Blocked / milestone chips and the filter toggle — deliberately identical to
	   the board so a card reads the same wherever it is seen. */
	.blocked-filter-toggle.is-on {
		background: rgba(245, 158, 11, 0.14); color: #f59e0b;
		border-color: rgba(245, 158, 11, 0.35);
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

	.theme-toggle { font-size: 0; }

	/* More Menu Dropdown */
	.more-menu-container { position: relative; }
	.more-dropdown {
		position: absolute; top: 100%; right: 0;
		min-width: 200px; padding: var(--space-xs);
		background: var(--bg-surface); border: 1px solid var(--glass-border);
		border-radius: var(--radius-md); box-shadow: 0 8px 32px rgba(0,0,0,0.2);
		z-index: 100; animation: fadeIn 0.1s ease-out;
	}
	@keyframes fadeIn { from { opacity: 0; transform: translateY(-4px); } to { opacity: 1; transform: translateY(0); } }
	.more-dropdown-label {
		font-size: 0.65rem; font-weight: 700; text-transform: uppercase;
		letter-spacing: 0.04em; color: var(--text-tertiary);
		padding: var(--space-xs) var(--space-sm);
	}
	.more-dropdown-item {
		display: flex; align-items: center; gap: var(--space-sm);
		width: 100%; padding: var(--space-sm); border: none;
		background: transparent; color: var(--text-primary);
		font-size: 0.82rem; cursor: pointer; border-radius: var(--radius-sm);
		transition: background 0.1s;
	}
	.more-dropdown-item:hover { background: var(--glass-hover); }
	.more-dropdown-item.more-active { color: var(--accent-indigo); }
	.more-item-icon { font-size: 1rem; }
	.more-check { margin-left: auto; font-size: 0.8rem; color: var(--accent-emerald); }
</style>
