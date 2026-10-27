<!--
  BoardsTable.svelte — The dashboard's Your Boards: the done-board and
  done-sub toggles, the sortable column headers, the All Tasks row, the
  favourites, and each grouping's boards with their sub-boards, star and
  delete (card 2281, slice C2: moved from src/routes/+page.svelte).

  Which boards are expanded and which groupings collapsed are the page's,
  bound here and in the context menu, which also changes them. A board's
  delete asks first through the page's confirm dialog; a right-click opens
  the page's context menu; Manage Categories and Create Board open windows
  the page draws.

  A board's count and bar are its committed work (milestone 22): an ideas
  board's row reads "N ideas" with no completion bar, and a delivery board
  with options says on its count that they are not counted.

  The Display menu also shows and hides the side pane and each of its panels
  (card 2526). The whole choice, the two switches with it, is the page's,
  bound here (`display`): the page draws the pane from it and remembers it
  for the viewer (`src/lib/dashboard/side-pane.ts`). Each change here hands
  the page a new choice, never a changed one, so the page's binding sees it.
-->
<script lang="ts">
	import type { PageData } from '../../../routes/$types';
	import { completionPercent } from '$lib/progress';
	import { formatTokens } from '$lib/tokens';
	import { formatUsd, BLEND_NOTE, SOURCE_NOTE, NOT_BILLED_NOTE } from '$lib/pricing';
	import { toasts as failureToasts } from '$lib/stores/toast';
	import { failureMessage } from '$lib/api';
	import { drawnColour } from '$lib/colours';
	import { parseStamp } from '$lib/timestamps';
	import { boardRowCount, boardRowSize, boardRowTitle, drawsCompletion, timeAgo } from '$lib/dashboard/format';
	import HeaderMenu from '$lib/components/HeaderMenu.svelte';
	import { SIDE_PANE_PANELS, defaultDisplay, displayChanged as isDisplayChanged, displayTitle, withPanel, type DashboardDisplay, type SidePanePanel } from '$lib/dashboard/side-pane';

	let {
		data,
		deleting,
		confirmDeleteBoard,
		openBoardContextMenu,
		showCreate = $bindable(),
		expandedBoards = $bindable(),
		collapsedCategories = $bindable(),
		showCategoryManager = $bindable(),
		display = $bindable(defaultDisplay())
	}: {
		/** What the dashboard's load gave it, passed on as it is. */
		data: PageData;
		/** The page's: the board whose delete is on its way, which shows a spinner. */
		deleting: number | null;
		/** The page's confirm dialog, which asks before a board is deleted. */
		confirmDeleteBoard: (id: number, name: string) => void;
		/** Opens the page's context menu for a board. */
		openBoardContextMenu: (e: MouseEvent, boardId: number, boardName: string) => void;
		/** The page's: whether the create window is open. */
		showCreate: boolean;
		/** The page's: the boards whose sub-boards are shown. */
		expandedBoards: Set<number>;
		/** The page's: the groupings folded shut. */
		collapsedCategories: Set<string>;
		/** The page's: whether Manage Categories is open. */
		showCategoryManager: boolean;
		/** The page's: the Display choice, the done switches and the side pane (card 2526). */
		display?: DashboardDisplay;
	} = $props();

	let showCompletedSubs = $derived(display.showCompletedSubs);
	let showCompletedBoards = $derived(display.showCompletedBoards);
	/** Any of the choice off its default (a switch, the pane or a panel): the Display button's dot. */
	let displayChanged = $derived(isDisplayChanged(display));
	/** The panels' switches are greyed and skipped while the whole pane is off. */
	let paneHidden = $derived(display.paneHidden);

	/** A new choice for the page, the rest of it as it was. */
	function setDisplay(change: Partial<DashboardDisplay>) {
		display = { ...display, ...change };
	}

	/**
	 * A greyed switch takes no focus from a press of the mouse: the focus stays
	 * where it was, so ↓ goes on from there. HeaderMenu's keys skip it, and
	 * with the focus on an item they do not list, ↓ would start again at the top.
	 */
	function keepFocusOffGreyed(e: MouseEvent) {
		if (display.paneHidden) e.preventDefault();
	}

	/** Switches one panel, unless the pane is off, when its switch is greyed and does nothing. */
	function togglePanel(key: SidePanePanel) {
		if (display.paneHidden) return;
		display = withPanel(display, key, display.hiddenPanels.includes(key));
	}

	// Sort state
	type SortColumn = 'name' | 'activity' | 'cards' | 'progress' | 'tokens' | 'cost';
	let sortBy = $state<SortColumn>('name');
	let sortDir = $state<'asc' | 'desc'>('asc');

	function toggleSort(col: SortColumn) {
		if (sortBy === col) {
			sortDir = sortDir === 'asc' ? 'desc' : 'asc';
		} else {
			sortBy = col;
			sortDir = col === 'name' ? 'asc' : 'desc';
		}
	}

	function sortArrow(col: SortColumn): string {
		if (sortBy !== col) return '';
		return sortDir === 'asc' ? ' ▲' : ' ▼';
	}

	function toggleExpand(boardId: number) {
		const next = new Set(expandedBoards);
		if (next.has(boardId)) next.delete(boardId);
		else next.add(boardId);
		expandedBoards = next;
	}

	// All Tasks row — same walk as the All Boards report (top-level boards plus
	// every sub-board), so the dashboard and the PDF quote the same card count.
	// Tasks = cards + their subtasks. Computed in +page.server.ts.
	let totalCards = $derived(data.allTasksTotals.cards);
	let completedCards = $derived(data.allTasksTotals.completedCards);
	let totalTasks = $derived(data.allTasksTotals.tasks);

	// ─── Board Favourites ────────────────────────────────────────────────────
	let favouriteBoardIds = $state<Set<number>>(new Set(data.favouriteBoardIds || []));

	$effect(() => {
		favouriteBoardIds = new Set(data.favouriteBoardIds || []);
	});

	/** Draw `boardId`'s star on or off, and every other board's as it is. */
	function showStar(boardId: number, on: boolean) {
		const next = new Set(favouriteBoardIds);
		if (on) next.add(boardId);
		else next.delete(boardId);
		favouriteBoardIds = next;
	}

	/**
	 * The star turns over at once. A refusal puts it back and says why; a
	 * success draws it as the server says it now is (`favourited`), since the
	 * route turns over whatever it holds, which another tab may have changed.
	 */
	async function toggleFavourite(boardId: number, e: MouseEvent) {
		e.stopPropagation();
		e.preventDefault();
		const was = favouriteBoardIds.has(boardId);
		showStar(boardId, !was);
		const started = failureToasts.navigation();
		try {
			const res = await fetch(`/api/boards/${boardId}/favourite`, { method: 'POST' });
			if (res.ok) {
				showStar(boardId, (await res.json()).favourited === true);
			} else {
				showStar(boardId, was);
				failureToasts.add(await failureMessage(res, 'The board’s star was not changed.'), 'error', started);
			}
		} catch {
			showStar(boardId, was);
			failureToasts.add('No answer from the server. The board’s star may not have been changed.', 'error', started);
		}
	}

	let favouriteBoards = $derived(data.boards.filter(b => favouriteBoardIds.has(b.id)));

	const a = $derived(data.analytics);

	// Group boards by category for dashboard display
	type BoardGroup = { name: string; color: string | null; boards: typeof data.boards; total: number; done: number };
	let boardGroups = $derived.by(() => {
		const groups: BoardGroup[] = [];
		const catMap = new Map<string, BoardGroup>();

		for (const board of data.boards) {
			// Hide completed boards when toggle is off
			// A board that still holds options is not done (the S4b review's J5).
			if (!showCompletedBoards && board.totalCards > 0 && board.completedCards === board.totalCards && !(board.optionsCount > 0)) continue;
			const key = board.categoryName || '__uncategorised__';
			let group = catMap.get(key);
			if (!group) {
				group = { name: board.categoryName || 'Uncategorised', color: board.categoryColor || null, boards: [], total: 0, done: 0 };
				catMap.set(key, group);
				groups.push(group);
			}
			group.boards.push(board);
			group.total += board.totalCards;
			group.done += board.completedCards;
		}

		// Sort: categorised groups alphabetically first, uncategorised last
		groups.sort((a, b) => {
			if (a.name === 'Uncategorised') return 1;
			if (b.name === 'Uncategorised') return -1;
			return a.name.localeCompare(b.name);
		});

		// Sort boards within each group
		const dir = sortDir === 'asc' ? 1 : -1;
		for (const group of groups) {
			group.boards.sort((a, b) => {
				switch (sortBy) {
					case 'name':
						return dir * a.name.localeCompare(b.name);
					case 'activity': {
						// Read as UTC: the stored form names no zone (card 2095).
						const aTime = parseStamp(a.lastActivity)?.getTime() ?? 0;
						const bTime = parseStamp(b.lastActivity)?.getTime() ?? 0;
						return dir * (aTime - bTime);
					}
					case 'cards':
						// An ideas board by its ideas, the figure its row shows (J5).
						return dir * (boardRowSize(a) - boardRowSize(b));
					case 'progress': {
						const aPct = a.totalCards > 0 ? a.completedCards / a.totalCards : 0;
						const bPct = b.totalCards > 0 ? b.completedCards / b.totalCards : 0;
						return dir * (aPct - bPct);
					}
					case 'cost':
						return dir * ((a.costUsd ?? -1) - (b.costUsd ?? -1));
					case 'tokens':
						// Boards with nothing recorded sort as -1 so they group together
						// at one end rather than mixing in with genuinely cheap boards.
						return dir * ((a.tokenTotal ?? -1) - (b.tokenTotal ?? -1));
					default:
						return 0;
				}
			});
		}

		return groups;
	});

	// Removed onMount category expanding since we default to not collapsed

	/** Names the Display menu's Side pane section for a screen reader. */
	const uid = $props.id();
	const sidePaneLabelId = `display-side-pane-${uid}`;

	function toggleCategory(catName: string) {
		const next = new Set(collapsedCategories);
		if (next.has(catName)) next.delete(catName);
		else next.add(catName);
		collapsedCategories = next;
	}
</script>

<section class="boards-section">
	<div class="section-header">
		<div class="header-titles">
			<h2>Your Boards</h2>
			<span class="section-count">{a.totalBoards} boards · {a.totalSubBoards} sub-boards</span>
		</div>
		<!-- The done-board and done-sub switches, the side pane and its panels
		     (card 2526), and Manage Categories, in one menu (card 2466). Its dot
		     says something is off its default. -->
		<div class="header-actions">
			<HeaderMenu
				label="Display"
				triggerClass="toggle-completed-btn display-btn"
				triggerId="display-menu-btn"
				triggerTitle={displayTitle(display)}
				triggerActive={displayChanged}
			>
				{#snippet trigger()}
					Display
					{#if displayChanged}<span class="display-dot" aria-label="changed"></span>{/if}
				{/snippet}
				<button class="hm-item" role="menuitemcheckbox" tabindex="-1" aria-checked={showCompletedBoards} onclick={() => setDisplay({ showCompletedBoards: !showCompletedBoards })}>
					{showCompletedBoards ? '✅ Showing done boards' : '👁️ Show done boards'}
				</button>
				<button class="hm-item" role="menuitemcheckbox" tabindex="-1" aria-checked={showCompletedSubs} onclick={() => setDisplay({ showCompletedSubs: !showCompletedSubs })}>
					{showCompletedSubs ? '✅ Showing done subs' : '👁️ Show done subs'}
				</button>
				<div class="hm-divider" role="separator"></div>
				<div class="hm-label" id={sidePaneLabelId}>Side pane</div>
				<div role="group" aria-labelledby={sidePaneLabelId}>
					<button class="hm-item" role="menuitemcheckbox" tabindex="-1" aria-checked={!paneHidden} onclick={() => setDisplay({ paneHidden: !paneHidden })}>
						{paneHidden ? '👁️ Show the side pane' : '✅ Showing the side pane'}
					</button>
					{#each SIDE_PANE_PANELS as panel (panel.key)}
						{@const shown = !display.hiddenPanels.includes(panel.key)}
						<button class="hm-item" role="menuitemcheckbox" tabindex="-1" aria-checked={shown} aria-disabled={paneHidden ? 'true' : undefined} data-panel={panel.key} title={paneHidden ? 'The side pane is hidden' : undefined} onmousedown={keepFocusOffGreyed} onclick={() => togglePanel(panel.key)}>
							{shown ? '✅' : '👁️'} {panel.label}
						</button>
					{/each}
				</div>
				<div class="hm-divider" role="separator"></div>
				<button class="hm-item" role="menuitem" tabindex="-1" title="Manage Categories" onclick={() => showCategoryManager = true}>
					🏷️ Manage Categories
				</button>
			</HeaderMenu>
		</div>
	</div>

	{#if data.boards.length > 0}
		<!-- Column headers -->
		<div class="board-col-header">
			<span class="bch-spacer"></span>
			<button class="bch-name bch-sort" class:active={sortBy === 'name'} onclick={() => toggleSort('name')}>Name{sortArrow('name')}</button>
			<button class="bch-activity bch-sort" class:active={sortBy === 'activity'} onclick={() => toggleSort('activity')}>Activity{sortArrow('activity')}</button>
			<button class="bch-cards bch-sort" class:active={sortBy === 'cards'} onclick={() => toggleSort('cards')}>Cards{sortArrow('cards')}</button>
			<button class="bch-progress bch-sort" class:active={sortBy === 'progress'} onclick={() => toggleSort('progress')}>Progress{sortArrow('progress')}</button>
			<button class="bch-tokens bch-sort" class:active={sortBy === 'tokens'} onclick={() => toggleSort('tokens')} title="Tokens spent on this board. Blank means nothing has been recorded — not that it was free.">Tokens{sortArrow('tokens')}</button>
			<button class="bch-cost bch-sort" class:active={sortBy === 'cost'} onclick={() => toggleSort('cost')} title="{NOT_BILLED_NOTE}. {SOURCE_NOTE} — {BLEND_NOTE}.">Cost{sortArrow('cost')}</button>
			<span class="bch-actions"></span>
		</div>

		<!-- All Tasks row -->
		<a href="/all" class="board-row board-row-all" id="all-tasks">
			<span class="expand-toggle placeholder"></span>
			<span class="board-row-emoji glass">🌐</span>
			<span class="board-row-name">All Tasks</span>
			<span class="board-row-activity"></span>
			<span class="board-row-count" title="Cards: every committed, non-archived card across all boards and sub-boards; options are not counted. Tasks: those cards plus their {data.allTasksTotals.subtasks} subtasks.">{totalCards} cards · {totalTasks} tasks</span>
			<div class="board-row-progress">
				{#if totalCards > 0}
					{@const allPct = completionPercent(completedCards, totalCards)}
					<div class="progress-track"><div class="progress-fill fill-all" style="width: {allPct}%"></div></div>
					<span class="progress-pct">{allPct}%</span>
				{/if}
			</div>
			<span class="board-row-tokens">
				{#if data.allTasksTotals.tokenTotal != null}{formatTokens(data.allTasksTotals.tokenTotal)}
				{:else}<span class="tok-empty">—</span>{/if}
			</span>
			<span class="board-row-cost">
				{#if data.allTasksTotals.costUsd != null}{formatUsd(data.allTasksTotals.costUsd)}
				{:else}<span class="tok-empty">—</span>{/if}
			</span>
			<div class="board-row-actions"></div>
		</a>

		<!-- Favourites Section -->
		{#if favouriteBoards.length > 0}
			<div class="category-group favourites-group">
				<div class="category-group-header fav-header">
					<span class="fav-star">⭐</span>
					<span class="category-group-name fav-name">Favourites</span>
					<span class="category-group-count">{favouriteBoards.length}</span>
				</div>
				<div class="cat-boards-wrapper animate-slide-up">
					{#each favouriteBoards as board (board.id)}
						<a href="/board/{board.id}" class="board-row fav-row">
							<span class="expand-toggle placeholder"></span>
							<span class="board-row-emoji glass">{board.emoji}</span>
							<span class="board-row-name">{board.name} <span class="board-id">#{board.id}</span></span>
							<span class="board-row-activity">{timeAgo(board.lastActivity)}</span>
							<span class="board-row-count" title={boardRowTitle(board)}>{boardRowCount(board)}</span>
							<div class="board-row-progress">
								{#if !drawsCompletion(board)}
									<!-- An ideas board completes nothing: no bar (milestone 22). -->
								{:else if board.totalCards > 0}
									{@const pct = completionPercent(board.completedCards, board.totalCards)}
									<div class="progress-track"><div class="progress-fill" class:complete={pct === 100} style="width: {pct}%"></div></div>
									<span class="progress-pct" class:complete={pct === 100}>{pct}%</span>
								{:else}
									<span class="progress-pct empty">—</span>
								{/if}
							</div>
								<span class="board-row-tokens">{#if board.tokenTotal !== null}{formatTokens(board.tokenTotal)}{:else}<span class="tok-empty" title="Nothing recorded — not the same as zero">—</span>{/if}</span>
								<span class="board-row-cost">{#if board.costUsd !== null}{formatUsd(board.costUsd)}{:else}<span class="tok-empty">—</span>{/if}</span>
							<div class="board-row-actions">
								<button class="row-fav-btn favourited" title="Remove from favourites" onclick={(e) => toggleFavourite(board.id, e)}>⭐</button>
							</div>
						</a>
					{/each}
				</div>
			</div>
		{/if}

		{#each boardGroups as group}
			<!-- Category group header -->
			<div class="category-group">
				<button class="category-group-header" onclick={() => toggleCategory(group.name)}>
					<span class="cat-expand-icon" class:rotated={!collapsedCategories.has(group.name)}>
						<svg width="12" height="12" viewBox="0 0 12 12" fill="none"><path d="M4 2l4 4-4 4" stroke="currentColor" stroke-width="1.5" stroke-linecap="round" stroke-linejoin="round"/></svg>
					</span>
					{#if group.color}
						<span class="category-dot" style="background: {drawnColour(group.color)}"></span>
					{/if}
					<span class="category-group-name" style={group.color ? `color: ${drawnColour(group.color)}` : ''}>{group.name}</span>
					<span class="category-group-count">{group.boards.length} board{group.boards.length !== 1 ? 's' : ''}</span>
					<div class="group-mini-progress">
						<div class="progress-track"><div class="progress-fill" style="background: {drawnColour(group.color || 'var(--text-tertiary)')}; width: {completionPercent(group.done, group.total)}%"></div></div>
					</div>
				</button>

				{#if !collapsedCategories.has(group.name)}
					<div class="cat-boards-wrapper animate-slide-up">
						{#each group.boards as board (board.id)}
							<div class="board-row-group">
								<!-- svelte-ignore a11y_no_static_element_interactions -->
								<div class="board-row" style={group.color ? `border-left-color: ${drawnColour(group.color)}` : ''} oncontextmenu={(e) => openBoardContextMenu(e, board.id, board.name)}>
									<div class="board-color-strip" style={group.color ? `background: ${drawnColour(group.color)}` : ''}></div>
									{#if board.subBoards && board.subBoards.length > 0}
										<button class="expand-toggle" onclick={() => toggleExpand(board.id)} title={expandedBoards.has(board.id) ? 'Collapse' : 'Expand'}>
											<svg width="12" height="12" viewBox="0 0 12 12" fill="none" class:rotated={expandedBoards.has(board.id)}>
												<path d="M4 2l4 4-4 4" stroke="currentColor" stroke-width="1.5" stroke-linecap="round" stroke-linejoin="round"/>
											</svg>
										</button>
									{:else}
										<span class="expand-toggle placeholder"></span>
									{/if}
									<a href="/board/{board.id}" class="board-row-link">
										<span class="board-row-emoji glass">{board.emoji}</span>
										<span class="board-row-name">{board.name} <span class="board-id">#{board.id}</span></span>
									</a>
									<span class="board-row-activity">{timeAgo(board.lastActivity)}</span>
									<span class="board-row-count" title={boardRowTitle(board)}>{boardRowCount(board)}</span>
									<div class="board-row-progress">
										{#if !drawsCompletion(board)}
											<!-- An ideas board completes nothing: no bar (milestone 22). -->
										{:else if board.totalCards > 0}
											{@const pct = completionPercent(board.completedCards, board.totalCards)}
											<div class="progress-track"><div class="progress-fill" class:complete={pct === 100} style="width: {pct}%"></div></div>
											<span class="progress-pct" class:complete={pct === 100}>{pct}%</span>
										{:else}
											<span class="progress-pct empty">—</span>
										{/if}
									</div>
								<span class="board-row-tokens">{#if board.tokenTotal !== null}{formatTokens(board.tokenTotal)}{:else}<span class="tok-empty" title="Nothing recorded — not the same as zero">—</span>{/if}</span>
								<span class="board-row-cost">{#if board.costUsd !== null}{formatUsd(board.costUsd)}{:else}<span class="tok-empty">—</span>{/if}</span>
									<div class="board-row-actions">
						{#if board.subBoards && board.subBoards.length > 0}
							{@const activeSubs = board.subBoards.filter((s: any) => showCompletedSubs || !(s.total > 0 && s.done === s.total))}
							<span class="sub-count-badge">{activeSubs.length}/{board.subBoards.length} sub</span>
						{/if}
						<button class="row-fav-btn" class:favourited={favouriteBoardIds.has(board.id)} title={favouriteBoardIds.has(board.id) ? 'Remove from favourites' : 'Add to favourites'} onclick={(e) => toggleFavourite(board.id, e)}>
							{favouriteBoardIds.has(board.id) ? '⭐' : '☆'}
						</button>
						<button class="row-delete-btn" title="Delete board" onclick={(e) => { e.preventDefault(); e.stopPropagation(); confirmDeleteBoard(board.id, board.name); }} disabled={deleting === board.id}>
							{#if deleting === board.id}
								<span class="spinner"></span>
							{:else}
								<svg width="12" height="12" viewBox="0 0 14 14" fill="none"><path d="M2 4h10M5 4V2.5A.5.5 0 015.5 2h3a.5.5 0 01.5.5V4m1.5 0l-.5 8a1 1 0 01-1 1h-5a1 1 0 01-1-1l-.5-8" stroke="currentColor" stroke-width="1.2" stroke-linecap="round" stroke-linejoin="round"/></svg>
							{/if}
						</button>
					</div>
								</div>

								<!-- Sub-boards (expanded) -->
								{#if expandedBoards.has(board.id) && board.subBoards && board.subBoards.length > 0}
									{#each board.subBoards.filter((s) => showCompletedSubs || !(s.total > 0 && s.done === s.total)) as sb}
										<a href="/board/{sb.id}" class="board-row sub-row animate-fade-in" title="Parent: {sb.parentCardTitle}">
											<span class="sub-connector">└</span>
											<span class="board-row-emoji glass-sm">{sb.emoji}</span>
											<span class="board-row-name">{sb.name} <span class="board-id">#{sb.id}</span></span>
											<span class="board-row-activity">{sb.parentCardTitle}</span>
											<span class="board-row-count">{sb.total} card{sb.total !== 1 ? 's' : ''}</span>
											<div class="board-row-progress">
												{#if sb.total > 0}
													{@const sbPct = completionPercent(sb.done, sb.total)}
													<div class="progress-track"><div class="progress-fill" class:complete={sbPct === 100} style="width: {sbPct}%"></div></div>
													<span class="progress-pct" class:complete={sbPct === 100}>{sbPct}%</span>
												{:else}
													<span class="progress-pct empty">empty</span>
												{/if}
											</div>
											<span class="board-row-tokens">{#if sb.tokenTotal !== null}{formatTokens(sb.tokenTotal)}{:else}<span class="tok-empty">—</span>{/if}</span>
											<span class="board-row-cost">{#if sb.costUsd !== null}{formatUsd(sb.costUsd)}{:else}<span class="tok-empty">—</span>{/if}</span>
											<div class="board-row-actions">
												<button class="row-delete-btn" title="Delete sub-board" onclick={(e) => { e.preventDefault(); e.stopPropagation(); confirmDeleteBoard(sb.id, sb.name); }}>
													<svg width="10" height="10" viewBox="0 0 10 10" fill="none"><path d="M2 2l6 6M8 2L2 8" stroke="currentColor" stroke-width="1.5" stroke-linecap="round"/></svg>
												</button>
											</div>
										</a>
									{/each}
								{/if}
							</div>
						{/each}
					</div>
				{/if}
			</div>
		{/each}
	{:else}
		<div class="empty-state glass">
			<span class="empty-icon">🗂️</span>
			<h3>No boards yet</h3>
			<p>Create your first board to get started</p>
			<button class="btn-primary mt-4" onclick={() => (showCreate = true)}>Create Board</button>
		</div>
	{/if}
</section>

<style>
	/* ─── Category Groups ────────────────────────────────────────── */
	.category-group {
		margin-bottom: var(--space-xs);
	}
	.category-group-header {
		display: flex; align-items: center; gap: var(--space-sm);
		padding: var(--space-sm) var(--space-md);
		margin-top: var(--space-md);
	}
	.cat-expand-icon svg { transition: transform 0.2s; }
	.cat-expand-icon.rotated svg { transform: rotate(90deg); }
	.category-dot {
		width: 10px; height: 10px; border-radius: 50%; flex-shrink: 0;
	}
	.category-group-name {
		font-size: 0.78rem; font-weight: 700; text-transform: uppercase;
		letter-spacing: 0.05em; color: var(--text-secondary);
	}
	.category-group-count {
		font-size: 0.65rem; font-weight: 500; color: var(--text-tertiary);
		margin-left: auto;
	}

	/* ─── Boards List ────────────────────────────────────────────── */
	.boards-section { margin-bottom: var(--space-2xl); }
	.section-header {
		display: flex; align-items: center; justify-content: space-between;
		margin-bottom: var(--space-md);
	}
	.header-titles h2 { font-size: 1.25rem; font-weight: 800; color: var(--text-primary); letter-spacing: -0.02em; margin: 0 0 2px 0; }
	.section-count { font-size: 0.7rem; color: var(--text-tertiary); font-weight: 600; text-transform: uppercase; letter-spacing: 0.05em; }

	.header-actions { display: flex; align-items: center; gap: 8px; }

	/* :global, as the Display button is drawn by HeaderMenu with this class (card 2466). */
	.header-actions :global(.toggle-completed-btn) {
		padding: 6px 12px; height: 32px;
		font-size: 0.72rem; font-weight: 600; font-family: var(--font-family);
		background: var(--bg-surface); border: 1px solid var(--glass-border);
		border-radius: var(--radius-md); color: var(--text-secondary); cursor: pointer;
		transition: all var(--duration-fast) var(--ease-out);
	}
	.header-actions :global(.toggle-completed-btn:hover) { border-color: var(--accent-indigo); color: var(--text-primary); }
	.header-actions :global(.toggle-completed-btn.hm-on) { background: rgba(99, 102, 241, 0.1); border-color: rgba(99, 102, 241, 0.3); color: var(--accent-indigo); box-shadow: inset 0 1px 3px rgba(0,0,0,0.05); }
	/* A setting off its default: a dot, so the change is seen with the menu shut. */
	.display-dot {
		display: inline-block; width: 7px; height: 7px; border-radius: 50%;
		background: var(--accent-indigo);
	}
	/* A panel's switch while the whole pane is off: greyed, with no hover or
	   focus highlight, and HeaderMenu's keys skip it (card 2526). */
	.header-actions :global(.hm-item[aria-disabled='true']) { opacity: 0.45; cursor: default; }
	.header-actions :global(.hm-item[aria-disabled='true']:hover),
	.header-actions :global(.hm-item[aria-disabled='true']:focus) {
		background: transparent; color: var(--text-secondary); box-shadow: none;
	}
	.header-actions :global(.hm-item[aria-disabled='true'][aria-checked='true']:hover),
	.header-actions :global(.hm-item[aria-disabled='true'][aria-checked='true']:focus) { color: var(--accent-indigo); }


	.board-row {
		display: flex; align-items: center; gap: var(--space-sm);
		padding: 10px var(--space-md);
		border: 1px solid var(--glass-border);
		border-bottom: none;
		background: var(--bg-card);
		transition: all var(--duration-fast) var(--ease-out);
		text-decoration: none; color: inherit;
		position: relative; overflow: hidden;
	}
	.board-color-strip {
		position: absolute; left: 0; top: 0; bottom: 0; width: 3px;
	}
	.board-row:first-child, .board-row-all { border-radius: var(--radius-md) var(--radius-md) 0 0; }
	.board-row-group:last-child .board-row:last-child,
	.board-row-group:last-child .sub-row:last-child { border-bottom: 1px solid var(--glass-border); border-radius: 0 0 var(--radius-md) var(--radius-md); }
	.board-row:hover { background: rgba(99, 102, 241, 0.04); }

	.board-row-all {
		border-bottom: 1px solid var(--glass-border);
		background: var(--bg-card);
		border-radius: var(--radius-md);
		margin-bottom: var(--space-xs);
	}
	.board-row-all:hover { background: rgba(99, 102, 241, 0.04); }

	/* Column header */
	.board-col-header {
		display: flex; align-items: center; gap: var(--space-sm);
		padding: 6px var(--space-md); margin-bottom: 2px;
	}
	.board-col-header span, .board-col-header button {
		font-size: 0.6rem; font-weight: 700; text-transform: uppercase;
		letter-spacing: 0.06em; color: var(--text-tertiary);
	}
	.bch-sort {
		background: none; border: none; cursor: pointer; padding: 2px 0;
		font-family: var(--font-family); transition: color 0.15s; text-align: left;
	}
	.bch-sort:hover { color: var(--text-primary); }
	.bch-sort.active { color: var(--accent-indigo); }
	.bch-spacer { width: 20px; flex-shrink: 0; }
	.bch-name { flex: 1; min-width: 0; }
	.bch-activity { width: 80px; text-align: right; }
	.bch-cards { width: 60px; text-align: right; }
	.bch-progress { width: 100px; text-align: right; }
	.bch-tokens { width: 74px; text-align: right; }
	.bch-cost { width: 66px; text-align: right; }
	/* Cost is context, not the headline — it sits quieter than the card count
	   so it informs without competing with name and progress. */
	.board-row-tokens {
		width: 74px; text-align: right; flex-shrink: 0;
		font-size: 0.74rem; font-variant-numeric: tabular-nums;
		color: var(--text-secondary); white-space: nowrap;
	}
	/* Nothing recorded. Deliberately fainter than a real figure: it is an
	   absence of data, not a measurement of zero. */
	.tok-empty { color: var(--text-tertiary); opacity: 0.55; }
	/* Money reads a touch stronger than the raw count — it is the figure people
	   actually act on — but still below name and progress in the hierarchy. */
	.board-row-cost {
		width: 66px; text-align: right; flex-shrink: 0;
		font-size: 0.74rem; font-variant-numeric: tabular-nums;
		color: var(--text-primary); white-space: nowrap;
	}
	.bch-actions { width: 80px; }

	.board-row-link {
		display: flex; align-items: center; gap: var(--space-sm);
		flex: 1; min-width: 0; text-decoration: none; color: inherit;
	}
	.board-row-emoji { font-size: 1.15rem; flex-shrink: 0; }
	.board-row-name {
		font-size: 0.88rem; font-weight: 600; color: var(--text-primary);
		white-space: nowrap; overflow: hidden; text-overflow: ellipsis;
		flex: 1; min-width: 0;
	}
	.board-row-activity { width: 80px; font-size: 0.7rem; color: var(--text-tertiary); font-weight: 500; white-space: nowrap; text-align: right; flex-shrink: 0; overflow: hidden; text-overflow: ellipsis; }
	.board-row-count { width: 60px; font-size: 0.72rem; color: var(--text-tertiary); font-weight: 500; white-space: nowrap; text-align: right; flex-shrink: 0; }
	/* The All Tasks row carries "N cards · M tasks" — let it take the width it needs */
	.board-row-all .board-row-count { width: auto; }
	.board-row-progress {
		width: 100px; flex-shrink: 0; display: flex; align-items: center; gap: 6px;
	}
	/* Copied in AnalyticsSidebar.svelte: as .dashboard :global() in the page they would outrank .fill-all below. */
	.progress-track { flex: 1; height: 5px; background: var(--glass-bg); border-radius: 3px; overflow: hidden; }
	.progress-fill { height: 100%; background: var(--accent-indigo); border-radius: 3px; transition: width 0.3s; }
	.fill-all { background: linear-gradient(90deg, #6366f1, #a855f7); }
	.progress-pct { font-size: 0.65rem; font-weight: 700; color: var(--accent-indigo); min-width: 28px; text-align: right; }
	.progress-pct.empty { color: var(--text-tertiary); }
	.progress-pct.complete { color: #22c55e; }

	.sub-count-badge {
		font-size: 0.6rem; font-weight: 700; padding: 1px 6px;
		border-radius: var(--radius-full);
		background: rgba(99, 102, 241, 0.1); color: #818cf8;
		white-space: nowrap;
	}

	.expand-toggle {
		width: 20px; height: 20px; flex-shrink: 0;
		display: flex; align-items: center; justify-content: center;
		background: transparent; border: none; color: var(--text-tertiary);
		cursor: pointer; border-radius: var(--radius-sm);
		transition: all 0.15s;
	}
	.expand-toggle:hover { background: var(--bg-surface); color: var(--text-primary); }
	.expand-toggle.placeholder { visibility: hidden; }
	.expand-toggle svg { transition: transform 0.2s; }
	.expand-toggle svg.rotated { transform: rotate(90deg); }

	.row-delete-btn {
		width: 24px; height: 24px; flex-shrink: 0;
		display: flex; align-items: center; justify-content: center;
		border-radius: var(--radius-sm); background: transparent;
		border: none; color: var(--text-tertiary);
		opacity: 0; cursor: pointer; transition: all 0.15s;
	}
	.board-row:hover .row-delete-btn { opacity: 0.6; }
	.row-delete-btn:hover { opacity: 1 !important; background: rgba(244, 63, 94, 0.15); color: var(--accent-rose); }

	/* Sub-board rows */
	.sub-row {
		padding-left: calc(var(--space-md) + 24px);
		background: var(--bg-surface);
	}
	.sub-row:hover { background: rgba(99, 102, 241, 0.04); }
	.sub-connector {
		font-size: 0.7rem; color: var(--text-tertiary); font-weight: 400;
		width: 14px; flex-shrink: 0; text-align: center;
	}
	.board-row-actions { width: 80px; flex-shrink: 0; display: flex; align-items: center; gap: 4px; justify-content: flex-end; margin-left: var(--space-sm); }

	/* ─── Misc ────────────────────────────────────────────────────── */
	.empty-state { text-align: center; padding: var(--space-3xl); color: var(--text-secondary); }
	.empty-icon { font-size: 3rem; display: block; margin-bottom: var(--space-lg); }
	.empty-state h3 { margin-bottom: var(--space-sm); color: var(--text-primary); }

	/* Copied in ActiveTasksModal.svelte, with its keyframes: that window is drawn outside .dashboard, where no page rule reaches. */
	.spinner {
		width: 12px; height: 12px;
		border: 2px solid var(--text-tertiary); border-top-color: transparent;
		border-radius: 50%; animation: spin 0.6s linear infinite;
	}
	@keyframes spin { to { transform: rotate(360deg); } }

	@media (max-width: 768px) {
		.header-actions { flex-wrap: wrap; }
		.board-row-progress { display: none; }
	}

	/* ─── Favourites ──────────────────────────────────────────── */
	.row-fav-btn {
		background: none; border: none; cursor: pointer;
		font-size: 0.85rem; padding: 2px 4px; border-radius: var(--radius-sm);
		opacity: 0; transition: all var(--duration-fast) var(--ease-out);
		flex-shrink: 0; line-height: 1;
	}
	.board-row:hover .row-fav-btn,
	.row-fav-btn.favourited { opacity: 1; }
	.row-fav-btn:hover { transform: scale(1.2); }

	.favourites-group { border-left: 3px solid #f59e0b; }
	.fav-header {
		display: flex; align-items: center; gap: var(--space-sm);
		padding: 8px var(--space-md); cursor: default;
	}
	.fav-star { font-size: 0.85rem; }
	.fav-name { font-weight: 700; color: #f59e0b; font-size: 0.78rem; }
	.fav-row { border-left: 2px solid rgba(245, 158, 11, 0.25); }
</style>
