<!--
  WorkTable.svelte — The plan page's work table: every card in the goal with
  its subtasks, searchable, filtered by state, sortable, each card opening
  to its subtasks (remembered in this browser for the goal) and each row to
  what it waits on; a card or blocker opens in the page's card window, and
  ✕ takes a card out of the goal (card 2281, slice C3a-3: moved from
  src/routes/plan/[id]/+page.svelte).

  Its rows are arranged by $lib/plan-table from the plan's nodes and the
  subtasks the page's load gave it. Taking a card out goes through the
  page's one PATCH path (`mutate`).
-->
<script lang="ts">
	import type { PageData } from '../../../routes/plan/[id]/$types';
	import {
		afterExpandAll,
		afterToggle,
		cardGroups,
		expandAllTargets,
		openCardsKey,
		openCardsToStore,
		readOpenCards,
		stateCounts as countStates,
		tableRows,
		type RowState,
		type SortKey,
		type StateFilter,
		type OpenCards,
		type TableRow
	} from '$lib/plan-table';
	import type { Node } from '$lib/plan-graph';

	let {
		data,
		summary,
		nodes,
		milestone,
		milestoneId,
		openCard,
		mutate
	}: {
		/** What the plan page's load gave it, passed on as it is: the subtasks of each card. */
		data: PageData;
		/** The page's: the plan, as its load gave it. */
		summary: PageData['summary'];
		/** The page's: every node of the plan's graph. */
		nodes: Node[];
		/** The page's: the goal itself. */
		milestone: PageData['summary']['milestone'];
		/** The page's: the goal's id, a number, so what is remembered is read again only for another goal. */
		milestoneId: number;
		/** Opens the page's card window on a card, or on the card a subtask belongs to. */
		openCard: (ref: { kind?: string; id: number; parentCardId?: number; withheld?: boolean }) => void;
		/** The page's one PATCH path for every change to the goal. */
		mutate: (body: Record<string, unknown>) => Promise<void>;
	} = $props();

	// ─── The work table ──────────────────────────────────────────────────────

	/**
	 * Every card in the milestone, each with all of its subtasks: the ordered
	 * ones from the graph, the plain ones from the load's `subtasks`. External
	 * blockers are not rows: they are context for the graph, not scope of the
	 * goal. Arranged by $lib/plan-table, so the tests can call it.
	 */
	const groups = $derived(cardGroups(nodes, summary.blocked, data.subtasks));

	/** Cards and ordered subtasks, as before a card could be opened (card 2221). */
	const stateCounts = $derived(countStates(groups));

	let tableSearch = $state('');
	let stateFilter = $state<StateFilter>('all');
	let sortKey = $state<SortKey>('id');
	let sortDir = $state<'asc' | 'desc'>('asc');
	let expandedRow = $state<string | null>(null);

	// ─── Opening a card to its subtasks (card 2221) ──────────────────────────
	//
	// Collapsed by default. What the viewer opens is remembered in this browser
	// for this milestone, as All Tasks remembers its activity panel; a private
	// window, or site data that is blocked, throws on localStorage itself, and
	// then nothing is remembered and every card starts collapsed.

	/** The cards the viewer opened with nothing filtered: what is remembered. */
	let openCards = $state<Set<number>>(new Set());
	/**
	 * The cards opened and closed by hand, or by Expand all / Collapse all, while
	 * a search or the state filter is in force, kept for that search and filter
	 * only: a new one starts from what is remembered again. None of it is stored.
	 */
	let view = $state<{ filter: string; open: Set<number>; shut: Set<number> }>({ filter: '', open: new Set(), shut: new Set() });
	const filtering = $derived(tableSearch.trim() !== '' || stateFilter !== 'all');
	const filterKey = $derived(`${stateFilter}|${tableSearch.trim().toLowerCase()}`);
	const viewNow = $derived(
		filtering && view.filter === filterKey ? view : { filter: filterKey, open: new Set<number>(), shut: new Set<number>() }
	);

	// Read once the page is in the browser, and again only for another milestone.
	$effect(() => {
		const id = milestoneId;
		try {
			openCards = readOpenCards(localStorage.getItem(openCardsKey(id)));
		} catch {
			openCards = new Set();
		}
	});

	/**
	 * Take what a toggle or Expand all left. What is remembered comes back as the
	 * same set unless nothing was filtered (afterToggle, afterExpandAll), and
	 * only then is it written: a search or filter never changes what is stored.
	 */
	function applyOpen(next: OpenCards) {
		view = { filter: filterKey, open: new Set(next.viewOpen), shut: new Set(next.viewShut) };
		if (next.stored === openCards) return;
		openCards = new Set(next.stored);
		try {
			localStorage.setItem(openCardsKey(milestone.id), openCardsToStore(next.stored, groups));
		} catch {
			// Not remembered; the page works the same.
		}
	}

	const openNow = $derived<OpenCards>({ stored: openCards, viewOpen: viewNow.open, viewShut: viewNow.shut });

	function toggleSubtasks(row: TableRow) {
		applyOpen(afterToggle(openNow, row, filtering));
	}

	/** Acts on the cards drawn (expandAll, below the rows). */
	function expandOrCollapseAll() {
		applyOpen(afterExpandAll(openNow, visibleRows, filtering));
	}

	function toggleSort(key: typeof sortKey) {
		if (sortKey === key) {
			sortDir = sortDir === 'asc' ? 'desc' : 'asc';
		} else {
			sortKey = key;
			// Numbers are most useful biggest-first; everything else reads A–Z.
			sortDir = key === 'downstreamCount' ? 'desc' : 'asc';
		}
	}

	/**
	 * The rows drawn: each card that is listed, with its subtasks under it when
	 * it is open. A search or filter that one of a card's subtasks matches lists
	 * the card and opens it; the sort orders the cards and never parts a subtask
	 * from its card. See tableRows in $lib/plan-table.
	 */
	const visibleRows = $derived(
		tableRows(groups, {
			query: tableSearch,
			stateFilter,
			sortKey,
			sortDir,
			open: new Set([...openCards, ...viewNow.open]),
			shut: viewNow.shut
		})
	);

	/**
	 * Expand all / Collapse all acts on the cards drawn, and its label follows
	 * them: under a search or filter, the cards listed (expandAllTargets).
	 */
	const expandAll = $derived(expandAllTargets(visibleRows));

	const STATE_LABEL: Record<RowState, string> = { done: 'Done', ready: 'Startable', blocked: 'Blocked', open: 'Open' };

	async function detachCard(cardId: number) {
		await mutate({ cardId, attach: false });
	}
</script>

<section class="panel">
	<div class="panel-head">
		<h2>The work</h2>
		<span class="panel-note">Every card in this goal — search it, sort it, open it to its subtasks, see what each one is waiting on</span>
	</div>

	<div class="table-controls">
		<div class="table-search">
			<svg width="14" height="14" viewBox="0 0 14 14" fill="none" aria-hidden="true">
				<circle cx="6" cy="6" r="4.5" stroke="currentColor" stroke-width="1.5"/>
				<path d="M9.5 9.5L13 13" stroke="currentColor" stroke-width="1.5" stroke-linecap="round"/>
			</svg>
			<input type="text" placeholder="Search by #id, title or board…" bind:value={tableSearch} />
			{#if tableSearch}
				<button class="search-clear" onclick={() => (tableSearch = '')} title="Clear search">✕</button>
			{/if}
		</div>

		<!-- The three lists this table replaced, preserved as counts: the
		     partition is still readable at a glance, without scrolling
		     three sections to find out how much is blocked. -->
		<div class="state-filter">
			<button class:active={stateFilter === 'all'} onclick={() => (stateFilter = 'all')}>
				All <span class="fc">{stateCounts.all}</span>
			</button>
			<button class:active={stateFilter === 'ready'} onclick={() => (stateFilter = 'ready')}>
				Startable <span class="fc">{stateCounts.ready}</span>
			</button>
			<button class:active={stateFilter === 'blocked'} onclick={() => (stateFilter = 'blocked')}>
				Blocked <span class="fc">{stateCounts.blocked}</span>
			</button>
			<button class:active={stateFilter === 'done'} onclick={() => (stateFilter = 'done')}>
				Done <span class="fc">{stateCounts.done}</span>
			</button>
		</div>

		{#if expandAll.ids.length > 0}
			<button class="expand-all" onclick={expandOrCollapseAll}>
				{expandAll.allOpen ? 'Collapse all' : 'Expand all'}
			</button>
		{/if}
	</div>

	{#if groups.length === 0}
		<p class="muted">No cards in this milestone yet — use “+ Add cards” above.</p>
	{:else if visibleRows.length === 0}
		<p class="muted">
			{#if tableSearch.trim()}
				Nothing matches “{tableSearch.trim()}”{#if stateFilter !== 'all'} among {stateFilter === 'ready' ? 'startable' : stateFilter} cards{/if}.
			{:else if stateFilter === 'ready'}
				Nothing is startable — every remaining card is waiting on something.
			{:else if stateFilter === 'blocked'}
				Nothing is blocked.
			{:else}
				Nothing is complete yet.
			{/if}
		</p>
	{:else}
		<div class="table-scroll">
			<table class="work-table">
				<thead>
					<tr>
						<th class="col-expand"><span class="sr-only">Blockers</span></th>
						<th class="col-id">
							<button class="sort-btn" class:sorted={sortKey === 'id'} onclick={() => toggleSort('id')}>
								ID{#if sortKey === 'id'}<span class="sort-arrow">{sortDir === 'asc' ? '▲' : '▼'}</span>{/if}
							</button>
						</th>
						<th class="col-title">
							<button class="sort-btn" class:sorted={sortKey === 'title'} onclick={() => toggleSort('title')}>
								Title{#if sortKey === 'title'}<span class="sort-arrow">{sortDir === 'asc' ? '▲' : '▼'}</span>{/if}
							</button>
						</th>
						<th class="col-board">
							<button class="sort-btn" class:sorted={sortKey === 'boardName'} onclick={() => toggleSort('boardName')}>
								Board{#if sortKey === 'boardName'}<span class="sort-arrow">{sortDir === 'asc' ? '▲' : '▼'}</span>{/if}
							</button>
						</th>
						<th class="col-col">
							<button class="sort-btn" class:sorted={sortKey === 'columnTitle'} onclick={() => toggleSort('columnTitle')}>
								Column{#if sortKey === 'columnTitle'}<span class="sort-arrow">{sortDir === 'asc' ? '▲' : '▼'}</span>{/if}
							</button>
						</th>
						<th class="col-num">
							<button class="sort-btn" class:sorted={sortKey === 'downstreamCount'} onclick={() => toggleSort('downstreamCount')}>
								Unblocks{#if sortKey === 'downstreamCount'}<span class="sort-arrow">{sortDir === 'asc' ? '▲' : '▼'}</span>{/if}
							</button>
						</th>
						<th class="col-state">
							<button class="sort-btn" class:sorted={sortKey === 'state'} onclick={() => toggleSort('state')}>
								State{#if sortKey === 'state'}<span class="sort-arrow">{sortDir === 'asc' ? '▲' : '▼'}</span>{/if}
							</button>
						</th>
						<th class="col-actions"><span class="sr-only">Actions</span></th>
					</tr>
				</thead>
				<tbody>
					{#each visibleRows as r (r.kind + ':' + r.id)}
						<tr class="row-{r.state}" class:on-critical={r.onCriticalPath} class:is-subtask={r.kind === 'subtask'}>
							<td class="col-expand">
								{#if r.blockers.length > 0}
									<button
										class="expander"
										class:open={expandedRow === r.kind + ':' + r.id}
										aria-expanded={expandedRow === r.kind + ':' + r.id}
										title={expandedRow === r.kind + ':' + r.id ? 'Hide blockers' : `Show the ${r.blockers.length} thing${r.blockers.length === 1 ? '' : 's'} this is waiting on`}
										onclick={() => (expandedRow = expandedRow === r.kind + ':' + r.id ? null : r.kind + ':' + r.id)}
									>▸</button>
								{/if}
							</td>
							<td class="col-id">
								{#if r.kind === 'card'}
									<button class="id-link" disabled={r.withheld} onclick={() => openCard(r)}>#{r.id}</button>
								{:else}
									<span class="sub-id" title="Subtask of #{r.parentCardId}">↳</span>
								{/if}
							</td>
							<td class="col-title" class:indented={r.depth > 0}>
								<div class="title-cell">
									<button class="title-link" disabled={r.withheld} onclick={() => openCard(r)} title={r.title}>
										{#if r.priority}<span class="prio-dot prio-{r.priority}" title="Priority: {r.priority}"></span>{/if}
										<span class="title-text">{r.title}</span>
									</button>
									<!-- A withheld card has no subtasks in the page data, so no button (card 2129). -->
									{#if r.kind === 'card' && r.subtaskTotal > 0 && !r.withheld}
										<button
											class="sub-btn"
											class:open={r.expanded}
											aria-expanded={r.expanded}
											onclick={() => toggleSubtasks(r)}
										>
											<!-- Its name is its text, "1/4 subtasks of #12", the same open
											     or closed: aria-expanded says which (card 2221). -->
											<span class="sub-caret" aria-hidden="true">▸</span>
											{r.subtaskDone}/{r.subtaskTotal} subtask{r.subtaskTotal === 1 ? '' : 's'}<span class="sr-only"> of #{r.id}</span>
										</button>
									{/if}
									{#if r.onCriticalPath}<span class="crit-chip">critical path</span>{/if}
								</div>
							</td>
							<td class="col-board">
								{#if r.withheld}
									<!-- On a board the viewer cannot open: no board to name or link (card 2129). -->
								{:else if r.kind === 'card'}
									<a class="board-link" href="/board/{r.boardId}">{r.boardName}</a>
								{:else}
									<span class="kind-tag">subtask</span>
								{/if}
							</td>
							<td class="col-col">{r.kind === 'card' ? r.columnTitle : ''}</td>
							<td class="col-num">
								{#if r.downstreamCount > 0}
									<span class="unblock-chip" title="Finishing this frees up {r.downstreamCount} thing{r.downstreamCount === 1 ? '' : 's'} downstream">
										{r.downstreamCount}
									</span>
								{:else}
									<span class="dash">—</span>
								{/if}
							</td>
							<td class="col-state"><span class="state-chip state-{r.state}">{STATE_LABEL[r.state]}</span></td>
							<td class="col-actions">
								{#if r.kind === 'card'}
									<button class="detach" title="Remove from this milestone" onclick={() => detachCard(r.id)}>✕</button>
								{/if}
							</td>
						</tr>
						{#if expandedRow === r.kind + ':' + r.id && r.blockers.length > 0}
							<tr class="blocker-row">
								<td></td>
								<td colspan="7">
									<div class="blocker-list">
										{#each r.blockers as blocker}
											<button class="blocker" disabled={blocker.withheld} onclick={() => openCard(blocker)}>
												waiting on
												{#if blocker.kind === 'subtask'}
													<span class="kind-tag">subtask</span>
													<span class="blocker-title">{blocker.title}</span>
												{:else}
													<span class="card-id">#{blocker.id}</span>
													<span class="blocker-title">{blocker.title}</span>
												{/if}
												{#if !blocker.withheld}
													<span class="card-where">{blocker.boardName} / {blocker.columnTitle}</span>
												{/if}
											</button>
										{/each}
									</div>
								</td>
							</tr>
						{/if}
					{/each}
				</tbody>
			</table>
		</div>
	{/if}
</section>

<style>
	/* These were links until cards started opening in place. They are buttons
	   now — the browser's button defaults have to be undone so nothing shifts.
	   (Card 2281, slice C3a-3: each block resets its own buttons; the critical
	   path and the dependency graph reset theirs.) */
	.title-link,
	.id-link,
	.blocker {
		appearance: none; background: none; border: none; font: inherit;
		padding: 0; text-align: left; cursor: pointer; color: inherit;
	}
	.id-link {
		padding: 0; font-size: 0.7rem; font-weight: 700; color: var(--text-tertiary);
		font-variant-numeric: tabular-nums;
	}
	.id-link:hover { color: var(--accent-indigo); }
	.blocker:hover { background: var(--bg-elevated); }

	/*
	 * The panel's frame, copied into each block of the plan page (card 2281,
	 * slice C3a-3): a rule in the page over every block would outrank the card
	 * picker's own border colour. The same is in PlanCardPicker, PlanProgress,
	 * PlanBurndown, CriticalPathPanel and DependencyGraph.
	 */
	.panel {
		background: var(--bg-card); border: 1px solid var(--glass-border);
		border-radius: var(--radius-md); padding: var(--space-lg);
	}

	/* ─── The work table ───────────────────────────────────────────────── */

	.sr-only {
		position: absolute; width: 1px; height: 1px; padding: 0; margin: -1px;
		overflow: hidden; clip: rect(0 0 0 0); white-space: nowrap; border: 0;
	}

	.table-controls {
		display: flex; align-items: center; gap: var(--space-md);
		flex-wrap: wrap; margin-bottom: var(--space-md);
	}

	.table-search {
		position: relative; display: flex; align-items: center;
		flex: 1 1 260px; min-width: 0;
	}
	.table-search svg {
		position: absolute; left: 10px; color: var(--text-tertiary); pointer-events: none;
	}
	.table-search input {
		width: 100%; padding: 7px 30px 7px 32px;
		background: var(--bg-surface); border: 1px solid var(--glass-border);
		border-radius: var(--radius-full); color: var(--text-primary);
		font-family: var(--font-family); font-size: 0.82rem;
	}
	.table-search input:focus { outline: none; border-color: var(--accent-indigo); }
	.search-clear {
		position: absolute; right: 8px; width: 18px; height: 18px; padding: 0;
		display: flex; align-items: center; justify-content: center;
		background: none; border: none; cursor: pointer; font: inherit;
		font-size: 0.66rem; color: var(--text-tertiary); border-radius: 50%;
	}
	.search-clear:hover { background: var(--bg-elevated); color: var(--text-primary); }

	.state-filter {
		display: flex; flex-shrink: 0; border-radius: var(--radius-full);
		border: 1px solid var(--glass-border); overflow: hidden;
	}
	.state-filter button {
		display: inline-flex; align-items: center; gap: 5px;
		padding: 6px 12px; background: var(--bg-surface); border: none;
		border-right: 1px solid var(--glass-border);
		color: var(--text-secondary); font-family: var(--font-family);
		font-size: 0.75rem; font-weight: 600; cursor: pointer; white-space: nowrap;
		transition: all var(--duration-fast) var(--ease-out);
	}
	.state-filter button:last-child { border-right: none; }
	.state-filter button:hover { background: var(--bg-elevated); color: var(--text-primary); }
	.state-filter button.active { background: var(--accent-indigo); color: #fff; }
	.fc {
		font-variant-numeric: tabular-nums; font-size: 0.68rem;
		opacity: 0.75; font-weight: 700;
	}

	/* The table scrolls here, never the page body. */
	.table-scroll {
		overflow-x: auto;
		border: 1px solid var(--glass-border); border-radius: var(--radius-sm);
	}

	.work-table { width: 100%; border-collapse: collapse; font-size: 0.8rem; }

	.work-table thead th {
		position: sticky; top: 0; z-index: 1;
		background: var(--bg-surface); text-align: left;
		border-bottom: 1px solid var(--glass-border);
		padding: 0; white-space: nowrap;
	}

	.sort-btn {
		display: inline-flex; align-items: center; gap: 4px;
		width: 100%; padding: 8px 10px;
		background: none; border: none; cursor: pointer; font: inherit;
		font-size: 0.68rem; font-weight: 700; text-transform: uppercase;
		letter-spacing: 0.04em; color: var(--text-tertiary); text-align: left;
		transition: color var(--duration-fast) var(--ease-out);
	}
	.sort-btn:hover { color: var(--text-primary); }
	.sort-btn.sorted { color: var(--accent-indigo); }
	.sort-arrow { font-size: 0.55rem; }

	.work-table tbody tr { border-bottom: 1px solid var(--glass-border); }
	.work-table tbody tr:last-child { border-bottom: none; }
	.work-table tbody tr:hover { background: var(--bg-elevated); }
	.work-table td { padding: 7px 10px; vertical-align: middle; }

	/* Done rows step back so open work reads first; the critical path keeps the
	   same red marker it has in the chain and the graph. */
	.work-table tbody tr.row-done { opacity: 0.55; }
	.work-table tbody tr.on-critical td:first-child { box-shadow: inset 3px 0 0 var(--accent-rose); }

	.col-expand { width: 26px; }
	.col-id { width: 64px; }
	.col-id a {
		font-size: 0.72rem; font-weight: 700; color: var(--text-tertiary);
		font-variant-numeric: tabular-nums; text-decoration: none;
	}
	.col-id a:hover { color: var(--accent-indigo); }

	.col-title { max-width: 0; width: 45%; }
	/* The title gives way first: the subtask button and the critical-path chip
	   keep their size beside it, at every width (card 2221). */
	.title-cell { display: flex; align-items: center; gap: 7px; min-width: 0; }
	.title-link {
		display: inline-flex; align-items: center; gap: 7px; max-width: 100%;
		text-decoration: none; color: var(--text-primary); vertical-align: middle;
		flex: 0 1 auto; min-width: 0;
	}
	.sub-btn {
		flex-shrink: 0; display: inline-flex; align-items: center; gap: 4px;
		padding: 1px 7px; border-radius: var(--radius-full); cursor: pointer;
		font: inherit; font-size: 0.64rem; font-weight: 700; white-space: nowrap;
		font-variant-numeric: tabular-nums;
		background: rgba(139, 92, 246, 0.1); color: #a78bfa;
		border: 1px solid rgba(139, 92, 246, 0.25);
		transition: background var(--duration-fast) var(--ease-out);
	}
	.sub-btn:hover, .sub-btn.open { background: rgba(139, 92, 246, 0.2); }
	.sub-caret { display: inline-block; transition: transform var(--duration-fast) var(--ease-out); }
	.sub-btn.open .sub-caret { transform: rotate(90deg); }

	.expand-all {
		flex-shrink: 0; padding: 6px 12px; cursor: pointer; white-space: nowrap;
		background: var(--bg-surface); border: 1px solid var(--glass-border);
		border-radius: var(--radius-full); color: var(--text-secondary);
		font-family: var(--font-family); font-size: 0.75rem; font-weight: 600;
		transition: all var(--duration-fast) var(--ease-out);
	}
	.expand-all:hover { background: var(--bg-elevated); color: var(--text-primary); }
	.title-text { overflow: hidden; text-overflow: ellipsis; white-space: nowrap; }
	.title-link:hover .title-text { color: var(--accent-indigo); }

	.col-board { width: 130px; }
	.board-link {
		font-size: 0.74rem; color: var(--text-secondary); text-decoration: none;
		overflow: hidden; text-overflow: ellipsis; white-space: nowrap; display: block;
	}
	.board-link:hover { color: var(--accent-indigo); }

	.col-col { width: 96px; font-size: 0.74rem; color: var(--text-tertiary); white-space: nowrap; }
	.col-num { width: 82px; text-align: center; font-variant-numeric: tabular-nums; }
	.dash { color: var(--text-tertiary); opacity: 0.5; }
	.col-state { width: 96px; }
	.col-actions { width: 34px; }

	.state-chip {
		display: inline-block; padding: 1px 8px; border-radius: var(--radius-full);
		font-size: 0.64rem; font-weight: 700; white-space: nowrap;
	}
	.state-ready {
		background: rgba(99, 102, 241, 0.12); color: #818cf8;
		border: 1px solid rgba(99, 102, 241, 0.28);
	}
	.state-blocked {
		background: rgba(245, 158, 11, 0.14); color: #f59e0b;
		border: 1px solid rgba(245, 158, 11, 0.3);
	}
	.state-done {
		background: rgba(16, 185, 129, 0.12); color: var(--accent-emerald);
		border: 1px solid rgba(16, 185, 129, 0.25);
	}
	/* A plain subtask not yet ticked: in no plan, so neither startable nor blocked. */
	.state-open {
		background: rgba(136, 136, 170, 0.1); color: var(--text-secondary);
		border: 1px solid rgba(136, 136, 170, 0.25);
	}

	.expander {
		width: 20px; height: 20px; padding: 0;
		display: flex; align-items: center; justify-content: center;
		background: none; border: none; cursor: pointer; font: inherit;
		font-size: 0.7rem; color: #f59e0b; border-radius: var(--radius-sm);
		transition: transform var(--duration-fast) var(--ease-out);
	}
	.expander:hover { background: rgba(245, 158, 11, 0.15); }
	.expander.open { transform: rotate(90deg); }

	/* Subtask rows sit under their card, indented, and slightly recessed so a
	   card row still reads as the top-level thing. */
	.work-table tbody tr.is-subtask { background: rgba(139, 92, 246, 0.035); }
	.work-table tbody tr.is-subtask:hover { background: rgba(139, 92, 246, 0.08); }
	.col-title.indented { padding-left: 26px; }
	.sub-id { color: #a78bfa; font-size: 0.8rem; }

	.blocker-row { background: rgba(245, 158, 11, 0.04); }
	.blocker-row td { padding: 4px 10px 8px; }

	@media (max-width: 900px) {
		/* Board and column are the first things worth losing on a narrow screen —
		   id, title and state are what the table is actually for. */
		.col-board, .col-col { display: none; }
	}

	.unblock-chip {
		flex-shrink: 0; padding: 1px 7px; border-radius: var(--radius-full);
		font-size: 0.64rem; font-weight: 700;
		background: rgba(16, 185, 129, 0.12); color: var(--accent-emerald);
		border: 1px solid rgba(16, 185, 129, 0.25);
	}
	.crit-chip {
		flex-shrink: 0; padding: 1px 7px; border-radius: var(--radius-full);
		font-size: 0.64rem; font-weight: 700;
		background: rgba(244, 63, 94, 0.12); color: var(--accent-rose);
		border: 1px solid rgba(244, 63, 94, 0.25);
	}

	.detach {
		flex-shrink: 0; width: 20px; height: 20px; padding: 0; align-self: center;
		display: flex; align-items: center; justify-content: center;
		background: none; border: none; cursor: pointer; font: inherit;
		font-size: 0.68rem; color: var(--text-tertiary); border-radius: var(--radius-sm);
		opacity: 0; transition: all var(--duration-fast) var(--ease-out);
	}
	/* Shown on the row the pointer is over or the keyboard is in, and on its own
	   keyboard focus; a screen with no hover shows it always, or the tap that
	   found it would be the one that removed the card (card 2320: the reveal
	   was left on the lists the ✕ moved out of, so it never showed). The row's
	   keyboard focus, not any focus: a click on the row's ▸ leaves no ✕ shown.
	   app.css takes every button's outline away, so its focus ring is its own. */
	.work-table tbody tr:hover .detach,
	.work-table tbody tr:has(:focus-visible) .detach,
	.detach:focus-visible { opacity: 1; }
	.detach:focus-visible { outline: 2px solid var(--accent-rose); outline-offset: 1px; }
	@media (hover: none) {
		.detach { opacity: 1; }
	}
	.detach:hover { background: rgba(244, 63, 94, 0.15); color: var(--accent-rose); }

	/* ─── Blocked groups ───────────────────────────────────────────────── */

	.blocked-group { display: flex; flex-direction: column; gap: 3px; margin-bottom: 6px; }
	.blocker-list { display: flex; flex-direction: column; gap: 2px; padding-left: var(--space-lg); }
	.blocker {
		display: flex; align-items: baseline; gap: 6px;
		padding: 3px 10px; text-decoration: none; border-radius: var(--radius-sm);
		font-size: 0.72rem; color: var(--text-tertiary);
		border-left: 2px solid rgba(245, 158, 11, 0.35);
		transition: background var(--duration-fast) var(--ease-out);
	}
	.blocker:hover { background: var(--bg-elevated); }
	.blocker-title {
		color: var(--text-secondary); min-width: 0;
		overflow: hidden; text-overflow: ellipsis; white-space: nowrap;
	}
</style>
