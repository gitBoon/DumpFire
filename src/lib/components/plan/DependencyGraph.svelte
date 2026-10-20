<!--
  DependencyGraph.svelte — The plan page's dependency graph: every card, left
  to right in the order the work has to happen, the critical path in red,
  each card opening to its ordered subtasks on demand, and the cards nobody
  has sequenced listed under it; a node opens in the page's card window
  (card 2281, slice C3a-3: moved from src/routes/plan/[id]/+page.svelte).

  Which cards are open to their subtasks is its own. The geometry, worked
  out on what is drawn, is $lib/plan-graph's.
-->
<script lang="ts">
	import type { PageData } from '../../../routes/plan/[id]/$types';
	import { orderSubtaskNodes } from '$lib/plan-table';
	import { NODE_H, NODE_W, clip, key, type Node, type WorkRef } from '$lib/plan-graph';
	import * as geometry from '$lib/plan-graph';

	let {
		data,
		summary,
		nodes,
		nodeByKey,
		milestone,
		openCard
	}: {
		/** What the plan page's load gave it, passed on as it is: the subtasks of each card, in their order. */
		data: PageData;
		/** The page's: the plan, as its load gave it. */
		summary: PageData['summary'];
		/** The page's: every node of the plan's graph. */
		nodes: Node[];
		/** The page's: each node of the plan's graph by its key. */
		nodeByKey: Map<string, Node>;
		/** The page's: the goal itself. */
		milestone: PageData['summary']['milestone'];
		/** Opens the page's card window on a card, or on the card a subtask belongs to. */
		openCard: (ref: { kind?: string; id: number; parentCardId?: number; withheld?: boolean }) => void;
	} = $props();

	/**
	 * Subtask nodes grouped by the card they belong to, each card's in its own
	 * order, as the table lists them (card 2223): they were sorted by id.
	 */
	const subtasksByCard = $derived.by(() => {
		const m = new Map<number, Node[]>();
		for (const n of nodes) {
			if (n.kind !== 'subtask' || n.parentCardId === undefined) continue;
			if (!m.has(n.parentCardId)) m.set(n.parentCardId, []);
			m.get(n.parentCardId)!.push(n);
		}
		for (const [cardId, list] of m) m.set(cardId, orderSubtaskNodes(list, data.subtasks[cardId]));
		return m;
	});

	/** Cards whose subtask nodes are currently shown rather than rolled up. */
	let expandedCards = $state<Set<number>>(new Set());

	function toggleCardExpanded(cardId: number) {
		const next = new Set(expandedCards);
		if (next.has(cardId)) next.delete(cardId);
		else next.add(cardId);
		expandedCards = next;
	}

	// The geometry (card 2281, slice C3a-3): $lib/plan-graph's, each part
	// worked out here on what is drawn, with the cards opened above.
	function drawnKey(r: WorkRef): string {
		return geometry.drawnKey(r, nodeByKey, expandedCards);
	}
	const drawnNodes = $derived(geometry.drawnNodes(nodes, expandedCards));
	const drawnEdges = $derived(geometry.drawnEdges(summary, drawnKey));
	const layers = $derived(geometry.layers(drawnNodes, drawnEdges));
	function nodeHeight(n: Node): number {
		return geometry.nodeHeight(n, expandedCards, subtasksByCard);
	}
	const positions = $derived(geometry.positions(layers, nodeHeight));
	const graphWidth = $derived(geometry.graphWidth(layers));
	const graphHeight = $derived(geometry.graphHeight(layers, nodeHeight));
	function edgePath(fromKey: string, toKey: string): string {
		return geometry.edgePath(fromKey, toKey, positions);
	}
	const criticalSteps = $derived(geometry.criticalSteps(summary, drawnKey));
	function isCriticalEdge(fromKey: string, toKey: string): boolean {
		return geometry.isCriticalEdge(fromKey, toKey, criticalSteps);
	}

	const unorderedNodes = $derived(
		(summary.graph.unordered as number[])
			.map((id) => nodeByKey.get(`card:${id}`))
			.filter((n): n is Node => !!n)
	);
</script>

<section class="panel">
	<div class="panel-head">
		<h2>Dependency graph</h2>
		<span class="panel-note">Left to right is the order the work has to happen in</span>
	</div>

	{#if layers.length === 0}
		<p class="muted">No cards to draw yet.</p>
	{:else}
		<div class="graph-legend">
			<span class="legend-item"><span class="legend-swatch critical"></span>Critical path</span>
			<span class="legend-item"><span class="legend-swatch complete"></span>Complete</span>
			<span class="legend-item"><span class="legend-swatch blocked"></span>Blocked</span>
			<span class="legend-item"><span class="legend-swatch ready"></span>Startable</span>
			<span class="legend-item"><span class="legend-swatch external"></span>Outside this goal</span>
		</div>

		<!-- Scrolls in its own container: nodes keep a readable size and the
		     page body never scrolls sideways. -->
		<div class="graph-scroll">
			<svg width={graphWidth} height={graphHeight} role="img" aria-label="Dependency graph for {milestone.name}">
				<defs>
					<marker id="arrow" viewBox="0 0 8 8" refX="7" refY="4" markerWidth="6" markerHeight="6" orient="auto-start-reverse">
						<path d="M0 0 L8 4 L0 8 z" fill="var(--text-tertiary)" />
					</marker>
					<marker id="arrow-crit" viewBox="0 0 8 8" refX="7" refY="4" markerWidth="6" markerHeight="6" orient="auto-start-reverse">
						<path d="M0 0 L8 4 L0 8 z" fill="#f43f5e" />
					</marker>
				</defs>

				{#each drawnEdges as e}
					{@const crit = isCriticalEdge(e.from, e.to)}
					<path
						d={edgePath(e.from, e.to)}
						fill="none"
						stroke={crit ? '#f43f5e' : 'var(--text-tertiary)'}
						stroke-width={crit ? 2.2 : 1.2}
						stroke-opacity={crit ? 0.9 : 0.35}
						marker-end={crit ? 'url(#arrow-crit)' : 'url(#arrow)'}
					/>
				{/each}

				{#each drawnNodes as n (key(n))}
					{@const p = positions.get(key(n))}
					{#if p}
						{@const state = n.isComplete
							? 'complete'
							: n.external
								? 'external'
								: n.openBlockers.length > 0
									? 'blocked'
									: 'ready'}
						{@const subs = n.kind === 'card' ? (subtasksByCard.get(n.id) ?? []) : []}
						{@const isOpen = n.kind === 'card' && expandedCards.has(n.id)}
						<g class="node node-{state}" class:node-critical={n.onCriticalPath} class:node-subtask={n.kind === 'subtask'}>
							<rect x={p.x} y={p.y} width={NODE_W} height={p.h} rx={n.kind === 'subtask' ? 5 : 8} />

							{#if n.kind === 'subtask'}
								<!-- svelte-ignore a11y_click_events_have_key_events -->
								<g class="node-link" role="button" tabindex="0" onclick={() => openCard(n)}>
									<text class="node-sub-title" x={p.x + 10} y={p.y + 17}>↳ {clip(n.title, 28)}</text>
								</g>
							{:else}
								<!-- svelte-ignore a11y_click_events_have_key_events -->
								<g class="node-link" role="button" tabindex="0" onclick={() => openCard(n)}>
									<text class="node-id" x={p.x + 11} y={p.y + 19}>#{n.id}</text>
									<text class="node-col" x={p.x + NODE_W - 11} y={p.y + 19} text-anchor="end">
										{n.columnTitle}
									</text>
									<text class="node-title" x={p.x + 11} y={p.y + 37}>{clip(n.title, 26)}</text>
									<text class="node-sub" x={p.x + 11} y={p.y + 50}>
										{#if n.external}
											{n.withheld ? 'outside goal' : `${clip(n.boardName, 20)} · outside goal`}
										{:else if n.downstreamCount > 0}
											unblocks {n.downstreamCount}
										{:else if n.isComplete}
											done
										{:else}
											{n.priority}
										{/if}
									</text>
								</g>

								{#if subs.length > 0}
									<!-- Collapsed by default: drawing every ordered subtask inline
									     would swamp a graph of any size, so the card carries a count
									     and opens on demand. The critical path is computed over the
									     full graph either way, so this is display only. -->
									<!-- svelte-ignore a11y_click_events_have_key_events -->
									<g
										class="sub-toggle"
										role="button"
										tabindex="0"
										aria-label="{isOpen ? 'Hide' : 'Show'} {subs.length} ordered subtask{subs.length === 1 ? '' : 's'}"
										onclick={() => toggleCardExpanded(n.id)}
									>
										<rect x={p.x + NODE_W - 46} y={p.y + NODE_H - 21} width="38" height="16" rx="8" />
										<text x={p.x + NODE_W - 27} y={p.y + NODE_H - 9} text-anchor="middle">
											{isOpen ? '−' : '+'}{subs.length}
										</text>
									</g>
								{/if}
							{/if}
						</g>
					{/if}
				{/each}
			</svg>
		</div>

		{#if unorderedNodes.length > 0}
			<!-- Cards nobody has sequenced must still be visible, or the plan
			     quietly under-reports what is in the goal. -->
			<div class="unordered">
				<h3>Parallel / unordered</h3>
				<p class="muted">
					In this milestone but with no dependencies recorded either way — they
					can happen at any time, or nobody has sequenced them yet.
				</p>
				<div class="card-list">
					{#each unorderedNodes as n}
						<button class="list-card" disabled={n.withheld} onclick={() => openCard(n)}>
							{#if n.priority}<span class="prio-dot prio-{n.priority}" title="Priority: {n.priority}"></span>{/if}
							<span class="card-id">#{n.id}</span>
							<span class="card-title">{n.title}</span>
							{#if !n.withheld}<span class="card-where">{n.boardName} / {n.columnTitle}</span>{/if}
						</button>
					{/each}
				</div>
			</div>
		{/if}
	{/if}
</section>

<style>
	/* These were links until cards started opening in place. They are buttons
	   now — the browser's button defaults have to be undone so nothing shifts.
	   (Card 2281, slice C3a-3: each block resets its own buttons; the critical
	   path and the work table reset theirs.) By its class alone and before the
	   card's own style, which sets its box after it: `button.list-card`
	   outweighed that style and took the box away (card 2321). */
	.list-card {
		appearance: none; background: none; border: none; font: inherit;
		padding: 0; text-align: left; cursor: pointer; color: inherit;
	}
	.node-link { cursor: pointer; }

	/*
	 * The panel's frame, copied into each block of the plan page (card 2281,
	 * slice C3a-3): a rule in the page over every block would outrank the card
	 * picker's own border colour. The same is in PlanCardPicker, PlanProgress,
	 * PlanBurndown, CriticalPathPanel and WorkTable.
	 */
	.panel {
		background: var(--bg-card); border: 1px solid var(--glass-border);
		border-radius: var(--radius-md); padding: var(--space-lg);
	}

	/* ─── Card lists ───────────────────────────────────────────────────── */

	.card-list { display: flex; flex-direction: column; gap: 4px; }

	.list-card {
		display: flex; align-items: baseline; gap: 8px;
		padding: 7px 10px; text-decoration: none;
		background: var(--bg-surface); border: 1px solid var(--glass-border);
		border-radius: var(--radius-sm);
		transition: all var(--duration-fast) var(--ease-out);
	}
	.list-card:hover { border-color: var(--accent-indigo); }

	/* ─── Graph ────────────────────────────────────────────────────────── */

	.graph-legend { display: flex; flex-wrap: wrap; gap: var(--space-md); margin-bottom: var(--space-md); }
	.legend-item {
		display: inline-flex; align-items: center; gap: 5px;
		font-size: 0.68rem; color: var(--text-tertiary); font-weight: 600;
	}
	.legend-swatch { width: 12px; height: 12px; border-radius: 3px; border: 1.5px solid; }
	.legend-swatch.critical { background: rgba(244, 63, 94, 0.15); border-color: #f43f5e; }
	.legend-swatch.complete { background: rgba(16, 185, 129, 0.12); border-color: var(--accent-emerald); }
	.legend-swatch.blocked { background: rgba(245, 158, 11, 0.12); border-color: #f59e0b; }
	.legend-swatch.ready { background: rgba(99, 102, 241, 0.12); border-color: var(--accent-indigo); }
	.legend-swatch.external { background: rgba(136, 136, 170, 0.1); border-color: rgba(136, 136, 170, 0.5); }

	/* Wide graphs scroll here, never on the page body. */
	.graph-scroll {
		overflow-x: auto; overflow-y: hidden; padding-bottom: var(--space-sm);
		border: 1px solid var(--glass-border); border-radius: var(--radius-sm);
		background: var(--bg-surface);
	}

	/* Subtask nodes: smaller, indented visually by their shorter box, and
	   dashed-free so they read as 'inside' rather than 'elsewhere'. */
	.node-subtask rect { stroke-dasharray: none; }
	.node-sub-title { font-size: 10.5px; fill: var(--text-primary); }

	.sub-toggle { cursor: pointer; }
	.sub-toggle rect {
		fill: rgba(139, 92, 246, 0.16); stroke: rgba(139, 92, 246, 0.45); stroke-width: 1;
	}
	.sub-toggle text {
		font-size: 9.5px; font-weight: 700; fill: #a78bfa;
		font-family: var(--font-family); pointer-events: none;
	}
	.sub-toggle:hover rect { fill: rgba(139, 92, 246, 0.3); }

	.node-link { text-decoration: none; }
	.node rect {
		fill: var(--bg-card); stroke: rgba(136, 136, 170, 0.35); stroke-width: 1.5;
		transition: stroke-width 0.12s ease-out;
	}
	.node:hover rect { stroke-width: 2.5; }

	.node-ready rect { stroke: var(--accent-indigo); fill: rgba(99, 102, 241, 0.07); }
	.node-blocked rect { stroke: #f59e0b; fill: rgba(245, 158, 11, 0.07); }
	.node-complete rect { stroke: var(--accent-emerald); fill: rgba(16, 185, 129, 0.07); }
	/* Greyed, as the card asks: done work should recede so the open chain reads. */
	.node-complete text { opacity: 0.55; }
	.node-external rect { stroke: rgba(136, 136, 170, 0.5); stroke-dasharray: 4 3; }
	.node-critical rect { stroke: #f43f5e; stroke-width: 2.5; fill: rgba(244, 63, 94, 0.07); }

	.node text { font-family: var(--font-family); }
	.node-id { font-size: 10px; font-weight: 700; fill: var(--text-tertiary); }
	.node-col { font-size: 9px; font-weight: 600; fill: var(--text-tertiary); }
	.node-title { font-size: 12px; font-weight: 600; fill: var(--text-primary); }
	.node-sub { font-size: 9.5px; fill: var(--text-tertiary); }

	.unordered { margin-top: var(--space-lg); }
	.unordered h3 {
		margin: 0 0 4px; font-size: 0.78rem; font-weight: 700;
		color: var(--text-secondary); text-transform: uppercase; letter-spacing: 0.05em;
	}
	.unordered .muted { margin-bottom: var(--space-sm); }
</style>
