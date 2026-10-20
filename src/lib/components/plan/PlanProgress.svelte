<!--
  PlanProgress.svelte — The plan page's first block: how far along the goal
  is, its cards complete, startable and blocked, its open subtasks, and its
  cards by column and by board (card 2281, slice C3a-3: moved from
  src/routes/plan/[id]/+page.svelte). Drawn from the plan the page's load
  gave it.
-->
<script lang="ts">
	import type { PageData } from '../../../routes/plan/[id]/$types';
	import { formatDueDate } from '$lib/utils/date-utils';

	let {
		summary,
		milestone
	}: {
		/** The page's: the plan, as its load gave it. */
		summary: PageData['summary'];
		/** The page's: the goal itself. */
		milestone: PageData['summary']['milestone'];
	} = $props();
</script>

<section class="panel">
	<div class="panel-head">
		<h2>Progress</h2>
		{#if milestone.targetDate}
			<span class="panel-note">Target {formatDueDate(milestone.targetDate)}</span>
		{/if}
	</div>

	<div class="progress-row">
		<div class="progress-track">
			<div class="progress-fill" style="width: {summary.progress.percent}%"></div>
		</div>
		<span class="progress-big">{summary.progress.percent}%</span>
	</div>

	<div class="stat-row">
		<div class="stat">
			<span class="stat-value">{summary.progress.done}/{summary.progress.total}</span>
			<span class="stat-label">cards complete</span>
		</div>
		<div class="stat">
			<span class="stat-value">{summary.nextActionable.length}</span>
			<span class="stat-label">startable now</span>
		</div>
		<div class="stat">
			<span class="stat-value">{summary.blocked.length}</span>
			<span class="stat-label">blocked</span>
		</div>
		<div class="stat">
			<!-- Open against all, in the cards tile's form; no subtasks reads 0/0 (card 2225). -->
			<span class="stat-value">{summary.progress.openSubtasks}/{summary.progress.totalSubtasks}</span>
			<span class="stat-label">open subtasks / all</span>
		</div>
	</div>

	<div class="chip-row">
		{#each summary.progress.byColumn as c}
			<span class="chip">{c.columnTitle} · {c.count}</span>
		{/each}
		{#each summary.progress.boards as b}
			<!-- The cards on boards the viewer cannot open are one entry with no id, and no link (card 2129). -->
			{#if b.id === null}
				<span class="chip">{b.name} · {b.cardCount}</span>
			{:else}
				<a class="chip board-chip" href="/board/{b.id}">{b.name} · {b.cardCount}</a>
			{/if}
		{/each}
	</div>
</section>

<style>
	/*
	 * The panel's frame, copied into each block of the plan page (card 2281,
	 * slice C3a-3): a rule in the page over every block would outrank the card
	 * picker's own border colour. The same is in PlanCardPicker, PlanBurndown,
	 * CriticalPathPanel, WorkTable and DependencyGraph.
	 */
	.panel {
		background: var(--bg-card); border: 1px solid var(--glass-border);
		border-radius: var(--radius-md); padding: var(--space-lg);
	}

	/* ─── Progress ─────────────────────────────────────────────────────── */

	.progress-row { display: flex; align-items: center; gap: var(--space-md); margin-bottom: var(--space-md); }
	.progress-track {
		flex: 1; height: 10px; border-radius: var(--radius-full);
		background: rgba(136, 136, 170, 0.15); overflow: hidden;
	}
	.progress-fill {
		height: 100%; border-radius: var(--radius-full); background: var(--accent-emerald);
		transition: width var(--duration-normal) var(--ease-out);
	}
	.progress-big {
		font-size: 1.1rem; font-weight: 700; color: var(--text-primary);
		font-variant-numeric: tabular-nums; flex-shrink: 0;
	}

	.stat-row { display: flex; flex-wrap: wrap; gap: var(--space-xl); margin-bottom: var(--space-md); }
	.stat { display: flex; flex-direction: column; gap: 2px; }
	.stat-value {
		font-size: 1.25rem; font-weight: 700; color: var(--text-primary);
		font-variant-numeric: tabular-nums; line-height: 1.1;
	}
	.stat-label {
		font-size: 0.68rem; color: var(--text-tertiary);
		text-transform: uppercase; letter-spacing: 0.04em; font-weight: 600;
	}

	.chip-row { display: flex; flex-wrap: wrap; gap: 5px; }
	.chip {
		padding: 2px 9px; border-radius: var(--radius-full);
		font-size: 0.68rem; font-weight: 600; text-decoration: none;
		background: rgba(136, 136, 170, 0.1); color: var(--text-secondary);
		border: 1px solid rgba(136, 136, 170, 0.2);
	}
	.board-chip {
		background: rgba(99, 102, 241, 0.1); color: #818cf8;
		border-color: rgba(99, 102, 241, 0.22);
		transition: all var(--duration-fast) var(--ease-out);
	}
	.board-chip:hover { background: rgba(99, 102, 241, 0.2); border-color: rgba(99, 102, 241, 0.45); }

	@media (max-width: 720px) {
		.stat-row { gap: var(--space-lg); }
	}
</style>
