<!--
  PlanBurndown.svelte — The plan page's burndown: will the goal land by its
  date, how long the open work would take, and the chart (card 2281, slice
  C3a-3: moved from src/routes/plan/[id]/+page.svelte).

  It reads its own, `/api/burndown`, again only when the work it charts
  changes (`burndownSource`), from the goal and the nodes the page's plan
  gave it; the goal's id is the page's, a number, so a re-read of the plan
  that changes nothing fetches nothing.
-->
<script lang="ts">
	import type { PageData } from '../../../routes/plan/[id]/$types';
	import type { Node } from '$lib/plan-graph';
	import { burndownKey } from '$lib/plan-table';
	import BurndownChart from '$lib/components/board/BurndownChart.svelte';
	import type { BurndownResult } from '$lib/burndown';
	import { chancePercent, deliveryNotes, deliveryText, durationText, paceText, targetVerdict } from '$lib/burndown-text';
	import InfoTip from '$lib/components/InfoTip.svelte';
	import { failureMessage } from '$lib/api';

	let {
		milestone,
		milestoneId,
		nodes
	}: {
		/** The page's: the goal itself. */
		milestone: PageData['summary']['milestone'];
		/** The page's: the goal's id, a number, so what reads it is not run again by every re-read of the plan. */
		milestoneId: number;
		/** The page's: every node of the plan's graph. */
		nodes: Node[];
	} = $props();

	// ─── Burndown ────────────────────────────────────────────────────────────
	//
	// Fetched rather than loaded with the plan: it is a second, independent
	// question ("will this land by its date?") and the plan must not wait on it.

	let burndown = $state<BurndownResult | null>(null);
	let burndownLoading = $state(false);
	let burndownError = $state('');

	/**
	 * A refusal is said in the server's words and no answer as no answer; a
	 * chart already drawn stays, marked as no longer current (card 2322: no
	 * answer left "Loading the burndown…" for good, and a failed re-read left
	 * the earlier chart as if it were the goal's now).
	 */
	async function loadBurndown(id: number) {
		burndownLoading = true;
		try {
			let res: Response;
			try {
				res = await fetch(`/api/burndown?milestoneId=${id}`);
			} catch {
				burndownError = 'No answer from the server. The burndown could not be loaded.';
				return;
			}
			if (!res.ok) {
				burndownError = await failureMessage(res, 'The burndown could not be loaded.');
				return;
			}
			// An answer that is not the burndown (a proxy's page) was an answer, not none.
			try {
				burndown = await res.json();
				burndownError = '';
			} catch {
				burndownError = "The server's answer could not be read. The burndown could not be loaded.";
			}
		} finally {
			burndownLoading = false;
		}
	}

	/** The words of a failed read, ending in a full stop unless they end in one of their own (or ? or !). */
	const burndownErrorSentence = $derived(/[.?!]$/.test(burndownError) ? burndownError : `${burndownError}.`);

	// Re-read when the work it charts changes (burndownSource, below), not on
	// every re-read of the plan.
	$effect(() => {
		void burndownSource;
		loadBurndown(milestoneId);
	});

	function formatDay(day: string): string {
		return new Date(`${day}T00:00:00Z`).toLocaleDateString('en-GB', { day: 'numeric', month: 'short', timeZone: 'UTC' });
	}

	/** How long the open work would take, and the chance of making the date. */
	const burndownEta = $derived(burndown ? deliveryText(burndown.delivery) : null);

	/**
	 * The verdict in one line a reader can act on. With a target it is the same
	 * verdict as the burndown page (targetVerdict), so the two never disagree;
	 * without one, where the open work is heading at the recent pace.
	 */
	const burndownStatus = $derived.by(() => {
		if (!burndown) return null;
		const f = burndown.forecast;
		if (f.status === 'done') return { tone: 'good', icon: '✓', text: 'Done — nothing remaining' };
		if (burndown.target) {
			const v = targetVerdict(burndown.target, burndown.delivery, f);
			return { tone: v.tone, icon: v.icon, text: `${v.value} — ${v.detail}` };
		}
		const p = paceText(f, burndown.delivery);
		const icon = p.tone === 'good' ? '→' : p.tone === 'bad' ? '!' : '?';
		return { tone: p.tone === 'good' ? 'neutral' : p.tone, icon, text: `${p.value} — ${p.sub.charAt(0).toLowerCase()}${p.sub.slice(1)}` };
	});

	/**
	 * What the burndown is drawn from: the goal, its target date, its cards and
	 * which are done. Closing the card window re-reads the plan, saved or not,
	 * which makes a new summary even when nothing changed; a string that is
	 * equal is not a change, so the burndown is fetched again (and dimmed) only
	 * when the work it charts did change (card 2221).
	 */
	const burndownSource = $derived(burndownKey(milestone, nodes));
</script>

<section class="panel">
	<div class="panel-head">
		<h2>Burndown</h2>
		{#if burndownStatus}
			<InfoTip title="Against the target" width={320}>
				<span class="bd-status {burndownStatus.tone}">
					<span class="bd-status-icon" aria-hidden="true">{burndownStatus.icon}</span>{burndownStatus.text}
				</span>
				{#snippet tip()}
					<p>
						The chance of finishing the work open now by the target date, from futures simulated at the pace
						of the last {burndown?.forecast.basisDays} days: <strong>on track</strong> at 85% or more,
						<strong>tight</strong> from 50%, <strong>behind</strong> below that. A goal whose cards sit on
						several boards is dated by its slowest board, because one board's pace does not clear another's.
					</p>
					<p>
						With no chance to quote, a goal on one board is judged by the date its pile clears at the recent
						pace: <strong>on track</strong> when that is by the target, <strong>so many days late</strong> when
						it is after. Across several boards, a board that would need over two years makes the goal
						<strong>behind</strong> when the target is inside two years, and <strong>too early to say</strong>
						when it is further out. <strong>At risk</strong> means work is arriving at least as fast as it is
						finished, or nothing has been finished lately. Without a target date this shows where the open work
						is heading at the recent pace.
					</p>
					<p class="muted">The dashed line on the chart is the ideal: a steady path from the start down to zero on the target date.</p>
				{/snippet}
			</InfoTip>
		{/if}
		<a class="panel-link" href="/burndown?milestoneId={milestone.id}">Full chart →</a>
	</div>
	{#if burndown && burndownError}
		<!-- The latest read failed: what is drawn below is the one before it. -->
		<p class="muted bd-stale" role="status">{burndownErrorSentence} What is shown is from an earlier read and may no longer be current.</p>
	{/if}
	{#if burndown && burndownEta}
		<div class="bd-eta">
			<InfoTip title="Time to deliver" width={320}>
				<span class="bd-eta-label">Time to deliver</span>
				<strong>{burndownEta.value}</strong>
				{#snippet tip()}
					<p>How long the <strong>{burndown?.delivery.remaining}</strong> cards open in this goal would take to finish if nothing new were added.</p>
					{#if burndown?.delivery.method === 'slowest-board'}
						<p>This goal spans several boards. Each is simulated at its own pace, and the goal is done only when the slowest board is{burndown.delivery.bottleneck ? ` — currently ${burndown.delivery.bottleneck.name}` : ''}.</p>
						{#if burndown.delivery.pooled?.p50}
							<p class="muted">Pooled into one pile it would be {durationText(burndown.delivery.pooled.p50.days)}, but only if effort could move freely between boards.</p>
						{/if}
					{/if}
					{#if burndown?.delivery.status === 'estimated' && burndown.delivery.p50}
						<div class="calc">
							half of {burndown.delivery.trials.toLocaleString('en-GB')} simulated futures finish by <b>{formatDay(burndown.delivery.p50.date)}</b><br />
							{#if burndown.delivery.p85}85% by <b>{formatDay(burndown.delivery.p85.date)}</b><br />{/if}
							{#if burndown.delivery.p95}95% by <b>{formatDay(burndown.delivery.p95.date)}</b>{/if}
						</div>
						<p>Each future replays the goal's real daily completions from the last {burndown.delivery.basisDays} days in random order, so quiet days and busy spells are both allowed for.</p>
					{:else}
						<p>{burndownEta.sub}.</p>
					{/if}
					{#if burndown?.delivery.chanceByTarget != null && burndown.target}
						<p class="muted">{chancePercent(burndown.delivery.chanceByTarget)} of those futures finish by the {formatDay(burndown.target.date)} target.</p>
					{/if}
				{/snippet}
			</InfoTip>
			<span class="bd-eta-sub">
				{burndownEta.sub}{#if burndown.delivery.chanceByTarget != null && burndown.target && burndown.delivery.status === 'estimated'} · {chancePercent(burndown.delivery.chanceByTarget)} chance by the {formatDay(burndown.target.date)} target{/if}{#each deliveryNotes(burndown.delivery) as note} · {note}{/each}
			</span>
		</div>
	{/if}
	{#if burndown}
		<BurndownChart
			series={burndown.series}
			forecast={burndown.forecast}
			target={burndown.target}
			height={240}
			loading={burndownLoading}
			label="Burndown for {milestone.name}"
			--bd-surface="var(--bg-card)"
		/>
	{:else if burndownError && !burndownLoading}
		<p class="muted">{burndownError}</p>
	{:else}
		<p class="muted">Loading the burndown…</p>
	{/if}
</section>

<style>
	/*
	 * The panel's frame, copied into each block of the plan page (card 2281,
	 * slice C3a-3): a rule in the page over every block would outrank the card
	 * picker's own border colour. The same is in PlanCardPicker, PlanProgress,
	 * CriticalPathPanel, WorkTable and DependencyGraph.
	 */
	.panel {
		background: var(--bg-card); border: 1px solid var(--glass-border);
		border-radius: var(--radius-md); padding: var(--space-lg);
	}

	.panel-link {
		margin-left: auto; font-size: 0.75rem; font-weight: 600;
		color: var(--accent-indigo); text-decoration: none; white-space: nowrap;
	}
	.panel-link:hover { text-decoration: underline; }

	/* Status carries an icon and words, never colour alone. */
	.bd-status { display: inline-flex; align-items: center; gap: 6px; font-size: 0.78rem; font-weight: 600; color: var(--text-primary); }
	.bd-status-icon {
		display: inline-flex; align-items: center; justify-content: center;
		width: 17px; height: 17px; border-radius: 50%;
		font-size: 0.68rem; font-weight: 800; color: #fff; background: var(--text-tertiary);
	}
	.bd-status.good .bd-status-icon { background: #059669; }
	.bd-status.bad .bd-status-icon { background: #dc2626; }
	.bd-status.warn .bd-status-icon { background: #d97706; }

	.bd-eta { display: flex; align-items: baseline; gap: 10px; flex-wrap: wrap; margin: -4px 0 12px; font-size: 0.8rem; }
	.bd-eta-label { font-size: 0.72rem; font-weight: 600; color: var(--text-secondary); margin-right: 4px; }
	.bd-eta strong { font-size: 0.95rem; color: var(--text-primary); }
	.bd-eta-sub { font-size: 0.74rem; color: var(--text-tertiary); }

	/*
	 * Kept here as well as in the page's rule over every block (card 2281,
	 * slice C3a-3): the explanations open in a panel at the end of the page,
	 * outside the page's frame.
	 */
	.muted { margin: 0; font-size: 0.8rem; line-height: 1.55; color: var(--text-secondary); }

	/* A chart no longer current says so above it, in words in the page's main text colour (legible on
	   either theme), marked by a bar in the "tight" verdict's amber (card 2322). */
	.bd-stale {
		margin: -4px 0 12px; padding-left: 8px; color: var(--text-primary);
		border-left: 3px solid var(--accent-amber);
	}
</style>
