<!--
  CriticalPathPanel.svelte — The plan page's critical path: the longest chain
  of work still to do, in order, each step opening its card in the page's
  card window (card 2281, slice C3a-3: moved from
  src/routes/plan/[id]/+page.svelte).
-->
<script lang="ts">
	import type { PageData } from '../../../routes/plan/[id]/$types';
	import { key, type Node } from '$lib/plan-graph';

	let {
		summary,
		nodeByKey,
		openCard
	}: {
		/** The page's: the plan, as its load gave it. */
		summary: PageData['summary'];
		/** The page's: each node of the plan's graph by its key. */
		nodeByKey: Map<string, Node>;
		/** Opens the page's card window on a card, or on the card a subtask belongs to. */
		openCard: (ref: { kind?: string; id: number; parentCardId?: number; withheld?: boolean }) => void;
	} = $props();
</script>

<section class="panel">
	<div class="panel-head">
		<h2>Critical path</h2>
		<span class="panel-note">The longest chain of work still to do — if any of these slips, the goal slips</span>
	</div>

	{#if summary.criticalPathNodes.length === 0}
		<p class="muted">
			No chain yet. Record what blocks what — in a card's or subtask's
			Dependencies section — and the chain that cannot slip shows up here.
		</p>
	{:else}
		<ol class="chain">
			{#each summary.criticalPathNodes as step, i}
				{@const n = nodeByKey.get(key(step))}
				{#if n}
					<li class="chain-step">
						<span class="chain-index">{i + 1}</span>
						<button class="chain-card" disabled={n.withheld} onclick={() => openCard(n)}>
							{#if n.kind === 'subtask'}
								<span class="kind-tag">subtask</span>
							{:else}
								<span class="card-id">#{n.id}</span>
							{/if}
							<span class="card-title">{n.title}</span>
							<span class="card-where">
								{#if n.external}<span class="ext-tag">outside this goal</span>{/if}
								{#if !n.withheld}
									{#if n.kind === 'subtask'}of #{n.parentCardId} · {/if}{n.boardName} / {n.columnTitle}
								{/if}
							</span>
						</button>
					</li>
				{/if}
			{/each}
		</ol>
	{/if}
</section>

<style>
	/* These were links until cards started opening in place. They are buttons
	   now — the browser's button defaults have to be undone so nothing shifts.
	   (Card 2281, slice C3a-3: each block resets its own buttons; the work
	   table and the dependency graph reset theirs.) */
	.chain-card {
		appearance: none; background: none; border: none; font: inherit;
		padding: 0; text-align: left; cursor: pointer; color: inherit;
	}

	/*
	 * The panel's frame, copied into each block of the plan page (card 2281,
	 * slice C3a-3): a rule in the page over every block would outrank the card
	 * picker's own border colour. The same is in PlanCardPicker, PlanProgress,
	 * PlanBurndown, WorkTable and DependencyGraph.
	 */
	.panel {
		background: var(--bg-card); border: 1px solid var(--glass-border);
		border-radius: var(--radius-md); padding: var(--space-lg);
	}

	/* ─── Chain (critical path) ────────────────────────────────────────── */

	.chain { list-style: none; margin: 0; padding: 0; display: flex; flex-direction: column; gap: 4px; }
	.chain-step { display: flex; align-items: stretch; gap: var(--space-sm); position: relative; }
	/* The connector makes the chain read as one run rather than four rows. */
	.chain-step:not(:last-child)::after {
		content: ''; position: absolute; left: 11px; top: 26px; bottom: -6px;
		width: 2px; background: rgba(244, 63, 94, 0.35);
	}
	.chain-index {
		flex-shrink: 0; width: 24px; height: 24px; border-radius: 50%;
		display: flex; align-items: center; justify-content: center;
		font-size: 0.68rem; font-weight: 700; z-index: 1;
		background: rgba(244, 63, 94, 0.14); color: var(--accent-rose);
		border: 1px solid rgba(244, 63, 94, 0.3);
	}
	.chain-card {
		flex: 1; min-width: 0; display: flex; align-items: baseline; gap: 8px;
		padding: 4px 10px; border-radius: var(--radius-sm); text-decoration: none;
		transition: background var(--duration-fast) var(--ease-out);
	}
	.chain-card:hover { background: var(--bg-elevated); }

	.ext-tag { font-style: italic; margin-right: 4px; }
</style>
