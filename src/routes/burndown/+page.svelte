<script lang="ts">
	/**
	 * Burndown — how much work is left, and where it is heading, for any slice
	 * of the workspace: a board, several boards, a board category, a milestone,
	 * or everything, narrowed by card category, label, assignee or priority.
	 *
	 * Every control writes to the query string and the server load re-runs, so
	 * the URL is the view. The chart, the figures, the breakdown and the table
	 * are all the same response, so they always agree with each other.
	 */
	import { onMount } from 'svelte';
	import { goto, invalidateAll, replaceState } from '$app/navigation';
	import { page, navigating } from '$app/stores';
	import { connectLiveRefresh } from '$lib/live-refresh';
	import BurndownChart from '$lib/components/board/BurndownChart.svelte';
	import Sparkline from '$lib/components/Sparkline.svelte';
	import Popover from '$lib/components/Popover.svelte';
	import InfoTip from '$lib/components/InfoTip.svelte';
	import {
		chancePercent,
		deliveryText,
		durationText,
		formatDay,
		paceText,
		perWeek,
		plural,
		targetVerdict,
		deliveryNotes,
		deliveryTags,
		isThin,
		leftOut,
		nameList
	} from '$lib/burndown-text';
	import { finishedSinceStart, workInPlay } from '$lib/burndown';
	import type { BurndownGroup, BurndownGroupBy, BurndownOption } from '$lib/burndown';

	let { data } = $props();

	const r = $derived(data.result);
	const q = $derived($page.url.searchParams);
	/** Hold the previous render, dimmed, while the next one loads. */
	const loading = $derived(!!$navigating && $navigating.to?.url.pathname === '/burndown');

	onMount(() => connectLiveRefresh(() => invalidateAll()));

	// ─── Navigation ──────────────────────────────────────────────────────────

	function nav(changes: Record<string, string | null>) {
		const p = new URLSearchParams($page.url.searchParams);
		for (const [k, v] of Object.entries(changes)) {
			if (v === null || v === '') p.delete(k);
			else p.set(k, v);
		}
		const qs = p.toString();
		goto(`/burndown${qs ? `?${qs}` : ''}`, { keepFocus: true, noScroll: true });
	}

	// ─── Scope ───────────────────────────────────────────────────────────────

	type ScopeMode = 'workspace' | 'boards' | 'boardCategory' | 'milestone';
	const activeMode = $derived<ScopeMode>(
		q.get('milestoneId') ? 'milestone' : q.get('boardCategoryId') ? 'boardCategory' : q.get('boardIds') ? 'boards' : 'workspace'
	);

	const selectedBoardIds = $derived(
		(q.get('boardIds') ?? '').split(',').map(Number).filter((n) => Number.isInteger(n) && n > 0)
	);
	const selectedBoards = $derived(data.boards.filter((b) => selectedBoardIds.includes(b.id)));
	const selectedGroup = $derived(data.boardCategories.find((c) => String(c.id) === q.get('boardCategoryId')) ?? null);
	const selectedMilestone = $derived(data.milestones.find((m) => String(m.id) === q.get('milestoneId')) ?? null);

	/** What the scope pill says: the current choice, never just "Scope". */
	const scopeText = $derived.by(() => {
		if (activeMode === 'milestone') return selectedMilestone?.name ?? 'Milestone';
		if (activeMode === 'boardCategory') return selectedGroup?.name ?? 'Board group';
		if (activeMode === 'boards') {
			return selectedBoards.length <= 2 ? selectedBoards.map((b) => b.name).join(' + ') : `${selectedBoards.length} boards`;
		}
		return 'All boards';
	});

	// Labels and categories belong to boards, so a new scope starts unfiltered on
	// them; the breakdown falls back to the natural one for the new scope.
	const SCOPE_RESET = { labelIds: null, categoryIds: null, groupBy: null };

	/** The kind of scope being browsed in the popover; it opens on the current one. */
	let scopeTab = $state<ScopeMode>('workspace');
	let boardSearch = $state('');
	const scopeTabs = $derived(
		[
			{ value: 'workspace', label: 'All boards' },
			{ value: 'boards', label: 'Boards' },
			...(data.boardCategories.length ? [{ value: 'boardCategory', label: 'Group' }] : []),
			...(data.milestones.length ? [{ value: 'milestone', label: 'Milestone' }] : [])
		] as { value: ScopeMode; label: string }[]
	);
	const boardMatches = $derived(
		data.boards.filter((b) => !boardSearch.trim() || b.name.toLowerCase().includes(boardSearch.trim().toLowerCase()))
	);
	const openMilestones = $derived(data.milestones.filter((m) => m.status === 'open'));
	const closedMilestones = $derived(data.milestones.filter((m) => m.status !== 'open'));

	function showAllBoards() {
		nav({ boardIds: null, boardCategoryId: null, milestoneId: null, target: null, ...SCOPE_RESET });
	}
	function toggleBoard(id: number) {
		// Ticking a board from another kind of scope starts a fresh selection.
		const keep = activeMode === 'boards' ? selectedBoardIds : [];
		const ids = keep.includes(id) ? keep.filter((b) => b !== id) : [...keep, id];
		nav({ boardIds: ids.length ? ids.join(',') : null, boardCategoryId: null, milestoneId: null, target: null, ...SCOPE_RESET });
	}
	function removeBoard(id: number) {
		const ids = selectedBoardIds.filter((b) => b !== id);
		nav({ boardIds: ids.length ? ids.join(',') : null, ...SCOPE_RESET });
	}
	function chooseBoardCategory(id: number) {
		nav({ boardCategoryId: String(id), boardIds: null, milestoneId: null, target: null, ...SCOPE_RESET });
	}
	function chooseMilestone(id: number) {
		// A goal's chart runs from when the goal was set, towards its own date.
		nav({ milestoneId: String(id), boardIds: null, boardCategoryId: null, days: null, from: null, to: null, target: null, ...SCOPE_RESET });
	}

	// ─── Period & target ─────────────────────────────────────────────────────

	const PRESETS = [
		{ value: '14', label: 'Last 14 days' },
		{ value: '30', label: 'Last 30 days' },
		{ value: '90', label: 'Last 90 days' },
		{ value: '182', label: 'Last 6 months' },
		{ value: '365', label: 'Last year' }
	];
	const defaultPreset = $derived(activeMode === 'milestone' ? 'start' : '30');
	const preset = $derived(q.get('from') || q.get('to') ? 'custom' : (q.get('days') ?? defaultPreset));
	const periodOptions = $derived(
		activeMode === 'milestone' ? [{ value: 'start', label: 'Since the milestone began' }, ...PRESETS] : PRESETS
	);
	const periodText = $derived(
		preset === 'custom' && r
			? `${formatDay(r.range.from)} – ${formatDay(r.range.to)}`
			: (periodOptions.find((p) => p.value === preset)?.label ?? `Last ${preset} days`)
	);
	let customOpen = $state(false);
	const showCustom = $derived(customOpen || preset === 'custom');

	function setPreset(v: string) {
		customOpen = false;
		nav({ days: v === 'start' ? null : v, from: null, to: null });
	}
	function setCustom(which: 'from' | 'to', v: string) {
		if (!r) return;
		nav({ from: which === 'from' ? v : r.range.from, to: which === 'to' ? v : r.range.to, days: null });
	}

	const milestoneTarget = $derived(r?.scope.milestone?.targetDate ?? null);
	const targetText = $derived(r?.target ? `Target ${formatDay(r.target.date)}` : 'No target');
	function setTarget(v: string) {
		// Clearing a milestone's own date has to be said explicitly, or the
		// milestone's date would simply come back.
		nav({ target: v ? v : milestoneTarget ? 'none' : null });
	}

	// ─── Filters ─────────────────────────────────────────────────────────────

	type FilterKey = 'categoryIds' | 'labelIds' | 'assigneeIds' | 'priorities';
	const FILTERS: { key: FilterKey; option: 'categories' | 'labels' | 'assignees' | 'priorities'; label: string; any: string }[] = [
		{ key: 'categoryIds', option: 'categories', label: 'Category', any: 'Any category' },
		{ key: 'labelIds', option: 'labels', label: 'Label', any: 'Any label' },
		{ key: 'assigneeIds', option: 'assignees', label: 'Assignee', any: 'Anyone' },
		{ key: 'priorities', option: 'priorities', label: 'Priority', any: 'Any priority' }
	];

	/** A facet's choices, keeping the current value even if nothing in scope carries it now. */
	function choices(f: (typeof FILTERS)[number]): BurndownOption[] {
		const opts = r?.options?.[f.option] ?? [];
		const current = q.get(f.key);
		if (current && !opts.some((o) => String(o.id) === current)) {
			return [...opts, { id: current, name: current === 'none' ? 'None' : `#${current}`, color: null, count: 0 }];
		}
		return opts;
	}
	const activeFilters = $derived(FILTERS.filter((f) => q.get(f.key)).length);
	/** Active filters as removable chips, so they are visible without opening anything. */
	const filterChips = $derived(
		FILTERS.filter((f) => q.get(f.key)).map((f) => {
			const id = q.get(f.key)!;
			return { key: f.key, label: f.label, name: choices(f).find((o) => String(o.id) === id)?.name ?? id };
		})
	);
	function clearFilters() {
		nav({ categoryIds: null, labelIds: null, assigneeIds: null, priorities: null });
	}

	// ─── View ────────────────────────────────────────────────────────────────

	let view = $state<'burndown' | 'burnup'>($page.url.searchParams.get('view') === 'burnup' ? 'burnup' : 'burndown');
	function setView(v: 'burndown' | 'burnup') {
		view = v;
		// Presentation only: no reason to recompute, so the URL changes without a load.
		const url = new URL($page.url);
		if (v === 'burnup') url.searchParams.set('view', 'burnup');
		else url.searchParams.delete('view');
		replaceState(url, {});
	}

	let showTable = $state(false);

	// ─── Breakdown ───────────────────────────────────────────────────────────

	const GROUP_BYS: { value: BurndownGroupBy; label: string }[] = [
		{ value: 'board', label: 'Board' },
		{ value: 'category', label: 'Category' },
		{ value: 'label', label: 'Label' },
		{ value: 'assignee', label: 'Assignee' },
		{ value: 'priority', label: 'Priority' },
		{ value: 'none', label: 'None' }
	];

	/** Drill into a row, then break it down by the next thing worth knowing. */
	function drill(g: BurndownGroup) {
		const id = String(g.id);
		switch (g.kind) {
			case 'board':
				nav({ boardIds: id, boardCategoryId: null, ...SCOPE_RESET });
				break;
			case 'category':
				nav({ categoryIds: id, groupBy: 'assignee' });
				break;
			case 'label':
				nav({ labelIds: id, groupBy: 'assignee' });
				break;
			case 'assignee':
				nav({ assigneeIds: id, groupBy: 'priority' });
				break;
			case 'priority':
				nav({ priorities: id, groupBy: 'assignee' });
				break;
		}
	}

	// ─── Figures ─────────────────────────────────────────────────────────────

	const change = $derived(r ? r.summary.remainingNow - r.summary.remainingStart : 0);
	const pace = $derived(r ? paceText(r.forecast) : null);
	const eta = $derived(r ? deliveryText(r.delivery) : null);
	const etaTags = $derived(r ? deliveryTags(r.delivery) : []);
	/** The pace window's counts, back from its rates, for the worked examples. */
	const basisFinished = $derived(r ? Math.round(r.forecast.completionRate * r.forecast.basisDays) : 0);
	const basisArrived = $derived(r ? Math.round(r.forecast.scopeRate * r.forecast.basisDays) : 0);
	const fmt = (n: number) => n.toLocaleString('en-GB');

	const targetStatus = $derived(r?.target ? targetVerdict(r.target, r.delivery, r.forecast) : null);

	/**
	 * The page's answer in plain sentences: how much is open, which way it is
	 * going and why, and how long the open work would take. Written from the
	 * same figures as the tiles, so the two can never disagree.
	 */
	const story = $derived.by(() => {
		if (!r) return '';
		const sm = r.summary;
		const f = r.forecast;
		const d = r.delivery;
		const where =
			r.scope.kind === 'workspace' ? 'across all boards' : r.scope.kind === 'milestone' ? `in “${r.scope.label}”` : `on ${r.scope.label}`;
		const since = formatDay(r.range.from);
		const out: string[] = [];

		const moved = change > 0 ? `, ${fmt(change)} more than on ${since}` : change < 0 ? `, ${fmt(-change)} fewer than on ${since}` : `, the same as on ${since}`;
		const open = sm.remainingNow === 0 ? 'No cards are' : `${plural(sm.remainingNow, 'card')} ${sm.remainingNow === 1 ? 'is' : 'are'}`;
		out.push(`${open} open ${where}${moved}.`);

		const flow =
			sm.added === 0 && sm.completed === 0 && sm.removed === 0
				? 'Nothing arrived or was finished over the period'
				: `Over the period ${fmt(sm.added)} arrived and ${fmt(sm.completed)} ${sm.completed === 1 ? 'was' : 'were'} finished${sm.removed ? ` (${fmt(sm.removed)} dropped)` : ''}`;
		if (f.status === 'converging' && f.projectedDate) {
			out.push(`${flow}; at the recent pace the pile clears by ${formatDay(f.projectedDate, true)}.`);
		} else if (f.status === 'not-converging' && f.completionRate === 0) {
			out.push(`${flow}. Nothing has been finished in the last ${plural(f.basisDays, 'day')}, so the pile is not moving.`);
		} else if (f.status === 'not-converging' && f.netBurnRate === 0) {
			out.push(`${flow}, and work is arriving as fast as it is finished, so the pile is holding steady.`);
		} else if (f.status === 'not-converging') {
			out.push(
				`${flow}. Work is arriving faster than it is being finished (${perWeek(f.scopeRate)} against ${perWeek(f.completionRate)} a week lately), so the pile is growing.`
			);
		} else if (f.status === 'done') {
			out.push(sm.completed ? `${flow}, and everything is now finished.` : `${flow}.`);
		} else {
			out.push(`${flow}.`);
		}

		const when = (p50: { days: number; date: string }, p85: { date: string } | null) =>
			`${durationText(p50.days)} (around ${formatDay(p50.date)}` + (p85 ? `; 85% likely by ${formatDay(p85.date)})` : '; the cautious end runs past two years)');
		const out2 = leftOut(d);
		if (d.method === 'slowest-board' && d.bottleneck) {
			// Several boards: the whole is done when the slowest board is.
			const b = d.bottleneck;
			const thin = isThin(b.basisFinished) ? `, though that rests on only ${plural(b.basisFinished, 'finished card')}` : '';
			if (d.status === 'estimated' && d.p50) {
				out.push(`If nothing new came in, finishing everything open now would most likely take ${when(d.p50, d.p85)}, because ${b.name} is the slowest board${thin}.`);
				if (d.pooled?.p50 && d.pooled.p50.days < d.p50.days * 0.6) {
					out.push(`Pooled into one pile it would be ${durationText(d.pooled.p50.days)}, but only if people could move freely between boards.`);
				}
			} else if (d.status === 'beyond-horizon') {
				out.push(`At its recent pace ${b.name} alone would take more than two years${thin}, so there is no useful finish date for everything.`);
			}
		} else if (d.status === 'estimated' && d.p50) {
			const thin = isThin(d.basisFinished) ? ` That rests on only ${plural(d.basisFinished, 'finished card')}, so treat it as a rough guide.` : '';
			out.push(`If nothing new came in, the ${fmt(d.remaining)} open now would most likely take ${when(d.p50, d.p85)}.${thin}`);
		}
		// When the pace sentence already said nothing was finished, saying it again adds nothing.
		if (d.status === 'no-pace' && f.completionRate > 0) {
			out.push(
				d.method === 'slowest-board'
					? `None of the boards with open work has had anything finished in the last ${plural(d.basisDays, 'day')}, so there is no pace to estimate a finish date from.`
					: 'With nothing finished recently, there is no pace to estimate a finish date from.'
			);
		} else if (out2.length && (d.status === 'estimated' || d.status === 'beyond-horizon')) {
			out.push(
				`${nameList(out2.map((p) => p.name), 3)} ${out2.length === 1 ? 'has' : 'have'} had nothing finished in the last ${plural(d.basisDays, 'day')}, so ${out2.length === 1 ? 'it is' : 'they are'} left out of that date.`
			);
		}

		// A chance is only a finding when there was a pace to simulate; with none
		// it is zero by construction, and saying "0%" would dress that up as one.
		if (r.target && d.chanceByTarget !== null && d.status === 'estimated') {
			out.push(`There is ${chancePercent(d.chanceByTarget) === 'under 1%' ? 'less than a 1%' : `a ${chancePercent(d.chanceByTarget)}`} chance of finishing by the ${formatDay(r.target.date)} target.`);
		}
		return out.join(' ');
	});

	const multiMember = $derived(r?.groupBy === 'label' || r?.groupBy === 'assignee');

	// ─── Export ──────────────────────────────────────────────────────────────

	function downloadCsv() {
		if (!r) return;
		const inPlay = workInPlay(r.series);
		const finished = finishedSinceStart(r.series);
		const rows = [
			['date', 'remaining', 'in_play', 'finished_since_start', 'added', 'completed', 'dropped', 'all_cards', 'all_done'],
			...r.series.map((p, i) => [p.date, p.remaining, inPlay[i], finished[i], p.added, p.completed, p.removed, p.scope, p.done])
		];
		const blob = new Blob([rows.map((row) => row.join(',')).join('\r\n') + '\r\n'], { type: 'text/csv' });
		const slug = r.scope.label.toLowerCase().replace(/[^a-z0-9]+/g, '-').replace(/^-|-$/g, '') || 'burndown';
		const a = document.createElement('a');
		a.href = URL.createObjectURL(blob);
		a.download = `burndown-${slug}-${r.range.from}-to-${r.range.to}.csv`;
		a.click();
		URL.revokeObjectURL(a.href);
	}
</script>

<svelte:head>
	<title>Burndown{r ? ` — ${r.scope.label}` : ''} — DumpFire</title>
</svelte:head>

<div class="bd-page">
	<header class="bd-header">
		<div class="bd-header-left">
			<a href="/" class="back-btn" title="Back to Dashboard" aria-label="Back to Dashboard">
				<svg width="16" height="16" viewBox="0 0 16 16" fill="none">
					<path d="M10 3L5 8l5 5" stroke="currentColor" stroke-width="1.5" stroke-linecap="round" stroke-linejoin="round"/>
				</svg>
			</a>
			<span class="bd-title-icon" aria-hidden="true">📉</span>
			<h1>Burndown</h1>
			{#if r}<span class="bd-subtitle">{r.scope.label}</span>{/if}
		</div>
		<div class="bd-header-right">
			<div class="seg" role="group" aria-label="Chart type">
				<button class:active={view === 'burndown'} aria-pressed={view === 'burndown'} onclick={() => setView('burndown')}>Burndown</button>
				<button class:active={view === 'burnup'} aria-pressed={view === 'burnup'} onclick={() => setView('burnup')}>Burn-up</button>
			</div>
			<button class="hdr-btn" onclick={downloadCsv} disabled={!r} title="Download the daily figures as CSV">
				<svg width="13" height="13" viewBox="0 0 16 16" fill="none" aria-hidden="true">
					<path d="M8 2v8m0 0L5 7m3 3l3-3M3 13h10" stroke="currentColor" stroke-width="1.5" stroke-linecap="round" stroke-linejoin="round"/>
				</svg>
				CSV
			</button>
		</div>
	</header>

	<div class="bd-body">
		<!-- One row that states every current choice; the detail opens on demand. -->
		<section class="controls" aria-label="What to chart">
			<Popover label="Choose what to chart" width={340} active={activeMode !== 'workspace'} onopen={() => { scopeTab = activeMode; boardSearch = ''; }}>
				{#snippet trigger()}
					<svg width="14" height="14" viewBox="0 0 16 16" fill="none" aria-hidden="true">
						<rect x="2" y="2" width="5" height="5" rx="1.2" stroke="currentColor" stroke-width="1.4"/>
						<rect x="9" y="2" width="5" height="5" rx="1.2" stroke="currentColor" stroke-width="1.4"/>
						<rect x="2" y="9" width="5" height="5" rx="1.2" stroke="currentColor" stroke-width="1.4"/>
						<rect x="9" y="9" width="5" height="5" rx="1.2" stroke="currentColor" stroke-width="1.4"/>
					</svg>
					<span class="pill-text">{scopeText}</span>
				{/snippet}
				{#snippet children(close)}
					<span class="section-label">Chart</span>
					<div class="seg seg-block" role="group" aria-label="Kind of scope">
						{#each scopeTabs as tab (tab.value)}
							<button class:active={scopeTab === tab.value} aria-pressed={scopeTab === tab.value} onclick={() => (scopeTab = tab.value)}>{tab.label}</button>
						{/each}
					</div>
					{#if scopeTab === 'workspace'}
						<div class="pick-note">Every board you can see — {plural(data.boards.length, 'board')} in all.</div>
						<button class="btn-apply" disabled={activeMode === 'workspace'} onclick={() => { showAllBoards(); close(); }}>
							{activeMode === 'workspace' ? 'Showing all boards' : 'Show all boards'}
						</button>
					{:else if scopeTab === 'boards'}
						{#if data.boards.length > 8}
							<input class="pick-search" type="search" placeholder="Find a board…" aria-label="Find a board" bind:value={boardSearch} />
						{/if}
						<div class="pick-list">
							{#each boardMatches as b (b.id)}
								<label class="pick-row">
									<input type="checkbox" checked={activeMode === 'boards' && selectedBoardIds.includes(b.id)} onchange={() => toggleBoard(b.id)} />
									<span class="pick-name">{b.emoji} {b.name}</span>
								</label>
							{:else}
								<div class="pick-note">No board matches “{boardSearch}”.</div>
							{/each}
						</div>
						<div class="pick-note">Tick more than one to chart them together.</div>
					{:else if scopeTab === 'boardCategory'}
						<div class="pick-list">
							{#each data.boardCategories as c (c.id)}
								{@const on = activeMode === 'boardCategory' && selectedGroup?.id === c.id}
								<button class="pick-row" class:checked={on} onclick={() => { chooseBoardCategory(c.id); close(); }}>
									<span class="check" aria-hidden="true">{on ? '✓' : ''}</span>
									<span class="swatch" style="background: {c.color}"></span>
									<span class="pick-name">{c.name}</span>
								</button>
							{/each}
						</div>
						<div class="pick-note">Every board in the group that you can see.</div>
					{:else}
						<div class="pick-list">
							{#each [...openMilestones, ...closedMilestones] as m, i (m.id)}
								{@const on = selectedMilestone?.id === m.id}
								{#if i === openMilestones.length && closedMilestones.length}<span class="section-label">Closed</span>{/if}
								<button class="pick-row" class:checked={on} onclick={() => { chooseMilestone(m.id); close(); }}>
									<span class="check" aria-hidden="true">{on ? '✓' : ''}</span>
									<span class="pick-name">{m.name}</span>
									{#if m.targetDate}<span class="pick-meta">{formatDay(m.targetDate.slice(0, 10))}</span>{/if}
								</button>
							{/each}
						</div>
						{#if selectedMilestone}
							<a class="ctl-link pick-link" href="/plan/{selectedMilestone.id}">Open this milestone's plan →</a>
						{/if}
					{/if}
				{/snippet}
			</Popover>

			<Popover label="Choose the period" width={260} active={preset !== defaultPreset} onopen={() => (customOpen = preset === 'custom')}>
				{#snippet trigger()}
					<svg width="14" height="14" viewBox="0 0 16 16" fill="none" aria-hidden="true">
						<rect x="2" y="3" width="12" height="11" rx="1.5" stroke="currentColor" stroke-width="1.4"/>
						<path d="M2 6.5h12M5.5 1.5v3M10.5 1.5v3" stroke="currentColor" stroke-width="1.4" stroke-linecap="round"/>
					</svg>
					<span class="pill-text">{periodText}</span>
				{/snippet}
				{#snippet children(close)}
					<div class="pick-list">
						{#each periodOptions as p (p.value)}
							<button class="pick-row" class:checked={preset === p.value} onclick={() => { setPreset(p.value); close(); }}>
								<span class="check" aria-hidden="true">{preset === p.value ? '✓' : ''}</span>{p.label}
							</button>
						{/each}
					</div>
					<hr class="hairline" />
					<button class="pick-row" class:checked={preset === 'custom'} aria-expanded={showCustom} onclick={() => (customOpen = !customOpen)}>
						<span class="check" aria-hidden="true">{preset === 'custom' ? '✓' : ''}</span>Custom range…
					</button>
					{#if showCustom && r}
						<div class="custom-range">
							<label class="field">From <input class="ctl" type="date" value={r.range.from} max={r.range.to} onchange={(e) => setCustom('from', e.currentTarget.value)} /></label>
							<label class="field">To <input class="ctl" type="date" value={r.range.to} min={r.range.from} onchange={(e) => setCustom('to', e.currentTarget.value)} /></label>
						</div>
					{/if}
				{/snippet}
			</Popover>

			{#if r?.options}
				<Popover label="Filter the cards" width={300} active={activeFilters > 0}>
					{#snippet trigger()}
						<svg width="14" height="14" viewBox="0 0 16 16" fill="none" aria-hidden="true">
							<path d="M2 3h12l-4.5 5.5V13l-3 1.5V8.5L2 3z" stroke="currentColor" stroke-width="1.4" stroke-linejoin="round"/>
						</svg>
						<span class="pill-text">Filters</span>
						{#if activeFilters}<span class="badge">{activeFilters}</span>{/if}
					{/snippet}
					{#snippet children(close)}
						{#each FILTERS as f (f.key)}
							{@const opts = choices(f)}
							<label class="filter-field">
								<span>{f.label}</span>
								<select class="ctl" class:is-set={!!q.get(f.key)} value={q.get(f.key) ?? ''} disabled={!opts.length && !q.get(f.key)} onchange={(e) => nav({ [f.key]: e.currentTarget.value || null })}>
									<option value="">{opts.length || q.get(f.key) ? f.any : `No ${f.label.toLowerCase()}s in this scope`}</option>
									{#each opts as o (o.id)}
										<option value={String(o.id)}>{o.name} ({o.count})</option>
									{/each}
								</select>
							</label>
						{/each}
						<div class="pick-note">The number beside each choice is how many cards it would include, given the other filters.</div>
						{#if activeFilters}
							<button class="ctl-link pick-link" onclick={() => { clearFilters(); close(); }}>Clear all filters</button>
						{/if}
					{/snippet}
				</Popover>
			{/if}

			<Popover label="Set a target date" width={290} active={!!r?.target}>
				{#snippet trigger()}
					<svg width="14" height="14" viewBox="0 0 16 16" fill="none" aria-hidden="true">
						<circle cx="8" cy="8" r="6" stroke="currentColor" stroke-width="1.4"/>
						<circle cx="8" cy="8" r="2.5" stroke="currentColor" stroke-width="1.4"/>
					</svg>
					<span class="pill-text">{targetText}</span>
				{/snippet}
				{#snippet children(close)}
					<p>
						Draws a straight <strong>ideal</strong> line from the work open at the start down to zero on
						this date, and says whether the work is on course to get there.
					</p>
					<input class="ctl ctl-date" type="date" aria-label="Target date" value={r?.target?.date ?? ''} onchange={(e) => setTarget(e.currentTarget.value)} />
					{#if q.get('target') === 'none' && milestoneTarget}
						<button class="ctl-link pick-link" onclick={() => { nav({ target: null }); close(); }}>Use the milestone's date ({formatDay(milestoneTarget, true)})</button>
					{:else if r?.target}
						<button class="ctl-link pick-link" onclick={() => { setTarget(''); close(); }}>Clear the target</button>
					{/if}
					{#if r?.target?.source === 'milestone'}<div class="pick-note">This is the milestone's own target date.</div>{/if}
				{/snippet}
			</Popover>

			{#if filterChips.length || (activeMode === 'milestone' && selectedBoards.length)}
				<div class="chips">
					{#if activeMode === 'milestone'}
						{#each selectedBoards as b (b.id)}
							<span class="chip">
								Board: {b.name}
								<button class="chip-x" onclick={() => removeBoard(b.id)} aria-label="Stop narrowing to {b.name}">✕</button>
							</span>
						{/each}
					{/if}
					{#each filterChips as c (c.key)}
						<span class="chip">
							{c.label}: {c.name}
							<button class="chip-x" onclick={() => nav({ [c.key]: null })} aria-label="Remove the {c.label.toLowerCase()} filter">✕</button>
						</span>
					{/each}
				</div>
			{/if}
		</section>

		{#if data.problem}
			<div class="problem" role="alert">
				<strong>{data.problem.status === 403 ? 'No access' : data.problem.status === 404 ? 'Not found' : 'Can’t draw that'}</strong>
				<span>{data.problem.message}</span>
				<a href="/burndown">Start again</a>
			</div>
		{/if}

		{#if r}
			<!-- The answer first, in words; then the figures behind it -->
			<p class="story" class:loading>{story}</p>

			{#snippet infoIcon()}
				<svg class="info-icon" width="12" height="12" viewBox="0 0 12 12" aria-hidden="true">
					<circle cx="6" cy="6" r="5" fill="none" stroke="currentColor" stroke-width="1.1" />
					<path d="M6 5.3v3M6 3.4v.1" stroke="currentColor" stroke-width="1.3" stroke-linecap="round" />
				</svg>
			{/snippet}

			<section class="kpis" class:loading aria-label="Summary">
				<div class="kpi">
					<InfoTip block title="Remaining" width={300}>
						<span class="kpi-label">Remaining {@render infoIcon()}</span>
						<span class="kpi-value">{fmt(r.summary.remainingNow)}</span>
						<span class="kpi-sub">
							{#if change === 0}
								No change since {formatDay(r.range.from)}
							{:else}
								<span class={change < 0 ? 'good' : 'bad'}>{change < 0 ? '▼' : '▲'} {fmt(Math.abs(change))}</span> since {formatDay(r.range.from)}
							{/if}
						</span>
						{#snippet tip()}
							<p>Cards open right now: not in a Complete column, and not archived.</p>
							<div class="calc">
								<b>{fmt(r.summary.remainingStart)}</b> open on {formatDay(r.range.from)}<br />
								+ <b>{fmt(r.summary.added)}</b> added<br />
								− <b>{fmt(r.summary.completed)}</b> finished<br />
								{#if r.summary.removed}− <b>{fmt(r.summary.removed)}</b> dropped<br />{/if}
								= <b>{fmt(r.summary.remainingNow)}</b> open now
							</div>
							<p class="muted">{change > 0 ? 'Up' : change < 0 ? 'Down' : 'Level'} because {r.summary.added > r.summary.completed + r.summary.removed ? 'more arrived than was finished' : r.summary.added < r.summary.completed + r.summary.removed ? 'more was finished than arrived' : 'as much arrived as was finished'} in the period.</p>
						{/snippet}
					</InfoTip>
				</div>

				<div class="kpi">
					<InfoTip block title="Finished" width={300}>
						<span class="kpi-label">Finished {@render infoIcon()}</span>
						<span class="kpi-value">{fmt(r.summary.completed)}</span>
						<span class="kpi-sub">{perWeek(r.forecast.completionRate)} a week over the last {plural(r.forecast.basisDays, 'day')}</span>
						{#snippet tip()}
							<p>Cards that reached a Complete column during the period, each counted on the day it got there.</p>
							<div class="calc">
								<b>{fmt(basisFinished)}</b> finished in the last {plural(r.forecast.basisDays, 'day')}<br />
								÷ {r.forecast.basisDays} × 7 = <b>{perWeek(r.forecast.completionRate)}</b> a week
							</div>
							{#if r.meta.inferredInWindow}
								<p class="muted">{plural(r.meta.inferredInWindow, 'of these has', 'of these have')} no completion stamp, so the date of the card's last update stands in. See the notes under the chart.</p>
							{/if}
						{/snippet}
					</InfoTip>
				</div>

				<div class="kpi">
					<InfoTip block title="Added" width={300}>
						<span class="kpi-label">Added {@render infoIcon()}</span>
						<span class="kpi-value">+{fmt(r.summary.added)}</span>
						<span class="kpi-sub">{r.summary.removed ? `${fmt(r.summary.removed)} dropped` : 'None dropped'}</span>
						{#snippet tip()}
							<p>
								New cards created during the period. <strong>Dropped</strong> means an open card was
								archived without being finished — it leaves the work without counting as done.
							</p>
							<div class="calc">
								<b>{fmt(basisArrived)}</b> net arrivals in the last {plural(r.forecast.basisDays, 'day')}<br />
								= <b>{perWeek(r.forecast.scopeRate)}</b> a week
							</div>
						{/snippet}
					</InfoTip>
				</div>

				{#if pace}
					<div class="kpi">
						<InfoTip block title="At this pace" width={320}>
							<span class="kpi-label">At this pace {@render infoIcon()}</span>
							<span class="kpi-value tone-{pace.tone}">{pace.value}</span>
							<span class="kpi-sub">{pace.sub}</span>
							{#snippet tip()}
								<p>
									Where the open pile is heading if cards keep arriving and being finished as they have over
									the last {plural(r.forecast.basisDays, 'day')}.
								</p>
								{#if r.forecast.status === 'converging' || r.forecast.status === 'not-converging'}
									<div class="calc">
										finishing <b>{perWeek(r.forecast.completionRate)}</b> a week<br />
										− arriving <b>{perWeek(r.forecast.scopeRate)}</b> a week<br />
										= <b>{perWeek(Math.abs(r.forecast.netBurnRate))}</b> a week {r.forecast.netBurnRate > 0 ? 'off' : r.forecast.netBurnRate < 0 ? 'onto' : 'on or off'} the pile
									</div>
								{/if}
								{#if r.forecast.status === 'converging' && r.forecast.projectedDate}
									<p>{fmt(r.summary.remainingNow)} open ÷ {perWeek(r.forecast.netBurnRate)} a week → clear around <strong>{formatDay(r.forecast.projectedDate, true)}</strong>.</p>
								{:else if r.forecast.status === 'not-converging'}
									<p>While at least as much arrives as is finished, the pile never reaches zero. <strong>Time to deliver</strong> answers the other question: how long the work open now would take on its own.</p>
								{/if}
							{/snippet}
						</InfoTip>
					</div>
				{/if}

				{#if eta}
					<div class="kpi">
						<InfoTip block title="Time to deliver" width={340}>
							<span class="kpi-label">Time to deliver {@render infoIcon()}</span>
							<span class="kpi-value">{eta.value}</span>
							<span class="kpi-sub">{eta.sub}</span>
							{#if etaTags.length}
								<span class="kpi-tags">
									{#each etaTags as tag (tag.text)}
										<span class="kpi-tag" class:warn={tag.tone === 'warn'} title={tag.title}>
											{#if tag.tone === 'warn'}
												<svg width="11" height="11" viewBox="0 0 12 12" aria-hidden="true"><path d="M6 1.2L11 10.5H1L6 1.2z" fill="#d97706"/><path d="M6 4.6v3M6 8.9v.1" stroke="#fff" stroke-width="1.3" stroke-linecap="round"/></svg>
											{/if}
											<span class="kpi-tag-text">{tag.text}</span>
										</span>
									{/each}
								</span>
							{/if}
							{#snippet tip()}
								<p>How long the <strong>{fmt(r.delivery.remaining)}</strong> cards open now would take to finish if no new work were added.</p>
								{#if r.delivery.method === 'slowest-board'}
									{@const dated = r.delivery.parts.filter((p) => p.status === 'estimated' || p.status === 'beyond-horizon')}
									<p>
										Each board is simulated at <strong>its own pace</strong>, and everything is done only when the
										slowest board is. The people finishing one board's cards are not clearing another's.
									</p>
									{#if dated.length}
										<div class="calc">
											{#each dated.slice(0, 5) as p (p.key)}
												{p.name}: <b>{p.status === 'beyond-horizon' || !p.p50 ? 'over 2 years' : p.p85 ? `${formatDay(p.p50.date)} – ${formatDay(p.p85.date)}` : formatDay(p.p50.date)}</b>{#if isThin(p.basisFinished)} <span class="thin-mark">({plural(p.basisFinished, 'card')})</span>{/if}<br />
											{/each}
											{#if dated.length > 5}and {dated.length - 5} quicker {dated.length - 5 === 1 ? 'board' : 'boards'}{/if}
										</div>
									{/if}
									{#if leftOut(r.delivery).length}
										<p class="muted">Left out, with no recent pace to go on: {leftOut(r.delivery).map((p) => `${p.name} (${plural(p.remaining, 'card')} open)`).join(', ')}.</p>
									{/if}
									{#if r.delivery.pooled?.p50}
										<p class="muted">Pooled into one pile it would be {durationText(r.delivery.pooled.p50.days)} — but only if effort could move freely between boards.</p>
									{/if}
								{/if}
								{#if r.delivery.status === 'estimated' && r.delivery.p50}
									<div class="calc">
										{fmt(r.delivery.trials)} simulated futures:<br />
										half finish by <b>{formatDay(r.delivery.p50.date, true)}</b><br />
										{#if r.delivery.p85}85% by <b>{formatDay(r.delivery.p85.date, true)}</b><br />{/if}
										{#if r.delivery.p95}95% by <b>{formatDay(r.delivery.p95.date, true)}</b>{:else}95%: beyond two years{/if}
									</div>
									<p>
										Each simulated future replays the real number of cards finished on each of the last
										{plural(r.delivery.basisDays, 'day')}, in random order, until the open work runs out — so slow
										days, weekends and busy spells are all accounted for. The gap between the dates is the uncertainty.
									</p>
									{#if r.delivery.method === 'pooled' && isThin(r.delivery.basisFinished)}
										<p class="muted">This rests on only {plural(r.delivery.basisFinished, 'finished card')}, so treat it as a rough guide.</p>
									{/if}
									{#if r.delivery.arrivalPerWeek > 0}
										<p class="muted">New work has been arriving at about {perWeek(r.delivery.arrivalPerWeek / 7)} a week. Every new card pushes these dates out.</p>
									{/if}
								{:else if r.delivery.status === 'no-pace'}
									<p>Nothing was finished in the last {plural(r.delivery.basisDays, 'day')}, so there is no pace to project from.</p>
								{:else if r.delivery.status === 'beyond-horizon'}
									<p>{r.delivery.method === 'slowest-board' && r.delivery.bottleneck ? `At its recent pace, ${r.delivery.bottleneck.name} alone would take more than two years.` : `At the recent pace of ${perWeek(r.delivery.throughputPerWeek / 7)} a week, finishing would take more than two years.`}</p>
								{:else if r.delivery.status === 'insufficient-data'}
									<p>There is less than a week of history to measure a pace from.</p>
								{/if}
							{/snippet}
						</InfoTip>
					</div>
				{/if}

				{#if targetStatus && r.target}
					<div class="kpi">
						<InfoTip block title="Target" width={320}>
							<span class="kpi-label">Target {@render infoIcon()}</span>
							<span class="kpi-value status {targetStatus.tone}"><span class="status-icon" aria-hidden="true">{targetStatus.icon}</span>{targetStatus.value}</span>
							<span class="kpi-sub">{targetStatus.detail}</span>
							{#snippet tip()}
								<p>
									The dashed <strong>ideal</strong> line runs from the {fmt(r.target!.idealStart.remaining)} cards open on
									{formatDay(r.target!.idealStart.date)} straight down to zero on {formatDay(r.target!.date, true)}.
								</p>
								{#if r.delivery.chanceByTarget !== null && r.delivery.status === 'estimated'}
									<div class="calc">
										<b>{chancePercent(r.delivery.chanceByTarget)}</b> of the {fmt(r.delivery.trials)} simulated futures<br />
										finish by {formatDay(r.target!.date, true)}
									</div>
								{/if}
								{#if r.target!.daysLate !== null && r.forecast.projectedDate}
									<p>At the recent net pace the pile clears on {formatDay(r.forecast.projectedDate, true)}, {plural(Math.abs(r.target!.daysLate), 'day')} {r.target!.daysLate > 0 ? 'after' : 'before'} the target.</p>
								{:else if r.forecast.status === 'not-converging'}
									<p>Counting new work still arriving, the pile is not shrinking at the recent pace, so the more that arrives, the further the date slips.</p>
								{/if}
								{#if r.target!.source === 'milestone'}<p class="muted">This is the milestone's own target date.</p>{/if}
							{/snippet}
						</InfoTip>
					</div>
				{/if}
			</section>

			<section class="panel">
				<div class="panel-head">
					<h2>
						<InfoTip title="Reading the chart" width={340}>
							{view === 'burnup' ? 'Finished against work in play' : 'Remaining work'}
							{#snippet tip()}
								{#if view === 'burnup'}
									<p><strong>Finished</strong> (green) counts up everything finished since the start of the period.</p>
									<p><strong>Work in play</strong> (orange) is what was open at the start plus everything added since. When the green line meets it, everything is done.</p>
								{:else}
									<p><strong>Remaining</strong> (blue) is how many cards were open at the end of each day.</p>
									<p>
										<strong>Work in play</strong> (orange) is what was open at the start plus everything added since. The
										gap between the two lines is what got finished.
									</p>
								{/if}
								<p>The dotted line continues at the recent pace; the dashed line, if there is a target, is the ideal path to it. Hover anywhere on the chart for that day's figures, or use the arrow keys.</p>
								<p class="muted">Every card that has ever existed ({fmt(r.summary.scopeNow)}) is not plotted — years of finished work would flatten the chart — but it is in the hover and the table.</p>
							{/snippet}
						</InfoTip>
					</h2>
					<span class="panel-meta">{formatDay(r.range.from, true)} – {formatDay(r.range.to, true)}</span>
					<button class="ctl-link" onclick={() => (showTable = !showTable)} aria-expanded={showTable}>
						{showTable ? 'Hide table' : 'Show table'}
					</button>
				</div>

				<BurndownChart
					series={r.series}
					forecast={r.forecast}
					target={r.target}
					mode={view}
					{loading}
					label="{view === 'burnup' ? 'Burn-up' : 'Burndown'} for {r.scope.label}"
					--bd-surface="var(--bg-card)"
				/>

				{#if showTable}
					{@const inPlay = workInPlay(r.series)}
					{@const finished = finishedSinceStart(r.series)}
					<div class="table-scroll daily">
						<table class="data-table">
							<caption class="sr-only">Daily figures for {r.scope.label}</caption>
							<thead>
								<tr>
									<th>Date</th>
									<th class="num">Remaining</th>
									<th class="num">Work in play</th>
									<th class="num">Finished so far</th>
									<th class="num">Added</th>
									<th class="num">Finished</th>
									<th class="num">Dropped</th>
									<th class="num">All cards ever</th>
								</tr>
							</thead>
							<tbody>
								{#each [...r.series.keys()].reverse() as i (i)}
									{@const p = r.series[i]}
									<tr>
										<td>{formatDay(p.date, true)}</td>
										<td class="num strong">{fmt(p.remaining)}</td>
										<td class="num">{fmt(inPlay[i])}</td>
										<td class="num">{fmt(finished[i])}</td>
										<td class="num">{p.added || ''}</td>
										<td class="num">{p.completed || ''}</td>
										<td class="num">{p.removed || ''}</td>
										<td class="num muted-cell">{fmt(p.scope)}</td>
									</tr>
								{/each}
							</tbody>
						</table>
					</div>
				{/if}

				<div class="notes">
					<p>
						Rebuilt from each card's created, completed and archived dates, so any filter works over
						any period. Days are UTC. Paces use the last {plural(r.forecast.basisDays, 'day')}.
					</p>
					{#each r.meta.notes as note}<p>{note}</p>{/each}
				</div>
			</section>

			<section class="panel">
				<div class="panel-head">
					<h2>Breakdown</h2>
					<label class="field">
						by
						<select class="ctl" value={data.groupBy ?? 'none'} onchange={(e) => nav({ groupBy: e.currentTarget.value })}>
							{#each GROUP_BYS as g}<option value={g.value}>{g.label}</option>{/each}
						</select>
					</label>
				</div>

				{#if r.groups.length === 0}
					<p class="hint">{r.groupBy === 'none' ? 'Pick something to break the work down by.' : 'Nothing to break down in this period.'}</p>
				{:else}
					<div class="table-scroll">
						<table class="data-table groups">
							<thead>
								<tr>
									<th>{GROUP_BYS.find((g) => g.value === r.groupBy)?.label}</th>
									<th>
										<InfoTip width={260}>Trend{#snippet tip()}<p>Open cards over the period, drawn from zero so the distance to done is visible.</p>{/snippet}</InfoTip>
									</th>
									<th class="num">
										<InfoTip width={240}>Remaining{#snippet tip()}<p>Cards open now in this row.</p>{/snippet}</InfoTip>
									</th>
									<th class="num">
										<InfoTip width={260}>Change{#snippet tip()}<p>Open now minus open at the start of the period. ▲ means the pile grew.</p>{/snippet}</InfoTip>
									</th>
									<th class="num">
										<InfoTip width={240}>Finished{#snippet tip()}<p>Cards in this row that reached Complete during the period.</p>{/snippet}</InfoTip>
									</th>
									<th>
										<InfoTip width={280}>Time to deliver{#snippet tip()}<p>How long this row's open cards would take if nothing new were added, from its own recent pace. Hover a row's figure for the dates.</p>{/snippet}</InfoTip>
									</th>
								</tr>
							</thead>
							<tbody>
								{#each r.groups as g (g.key)}
									{@const delta = g.summary.remainingNow - g.summary.remainingStart}
									{@const gEta = deliveryText(g.delivery)}
									{@const gPace = paceText(g.forecast)}
									<tr>
										<td class="name">
											<button class="row-link" onclick={() => drill(g)} title="Chart just this">
												{#if g.color}<span class="swatch" style="background: {g.color}"></span>{/if}
												{g.name}
											</button>
										</td>
										<td><Sparkline values={g.remaining} /></td>
										<td class="num strong">{fmt(g.summary.remainingNow)}</td>
										<td class="num">
											{#if delta}<span class={delta < 0 ? 'good' : 'bad'}>{delta < 0 ? '▼' : '▲'} {fmt(Math.abs(delta))}</span>{:else}—{/if}
										</td>
										<td class="num">{fmt(g.summary.completed)}</td>
										<td class="forecast">
											<InfoTip title={g.name} width={280}>
												{gEta.value}{#if (g.delivery.status === 'estimated' || g.delivery.status === 'beyond-horizon') && isThin(g.delivery.basisFinished)}<span class="thin-mark"> · from {plural(g.delivery.basisFinished, 'card')}</span>{/if}
												{#snippet tip()}
													<p>{gEta.sub}.</p>
													{#if g.delivery.status === 'estimated' && g.delivery.p50}
														<div class="calc">
															likely <b>{formatDay(g.delivery.p50.date, true)}</b><br />
															{#if g.delivery.p85}85% by <b>{formatDay(g.delivery.p85.date, true)}</b><br />{/if}
															{#if g.delivery.p95}95% by <b>{formatDay(g.delivery.p95.date, true)}</b>{/if}
														</div>
													{/if}
													{#each deliveryNotes(g.delivery) as note}<p class="muted">{note}.</p>{/each}
													<p class="muted">At this pace: {gPace.value.toLowerCase()} — {gPace.sub.charAt(0).toLowerCase() + gPace.sub.slice(1)}.</p>
												{/snippet}
											</InfoTip>
										</td>
									</tr>
								{/each}
							</tbody>
						</table>
					</div>
					{#if multiMember}
						<p class="footnote">
							A card with several {r.groupBy === 'label' ? 'labels' : 'assignees'} counts in each of their rows, so the rows can add up to more than the whole.
						</p>
					{/if}
				{/if}
			</section>
		{/if}
	</div>
</div>

<style>
	.bd-page { display: flex; flex-direction: column; min-height: 100vh; background: var(--bg-deep); }

	.bd-header {
		display: flex; align-items: center; justify-content: space-between; gap: var(--space-md);
		padding: var(--space-md) var(--space-xl);
		background: var(--bg-surface); border-bottom: 1px solid var(--glass-border);
		position: sticky; top: 0; z-index: 10;
	}
	.bd-header-left { display: flex; align-items: center; gap: var(--space-md); min-width: 0; }
	.bd-header-right { display: flex; align-items: center; gap: var(--space-sm); flex-shrink: 0; }
	.back-btn {
		display: flex; align-items: center; justify-content: center;
		width: 32px; height: 32px; border-radius: var(--radius-sm);
		color: var(--text-secondary); transition: all 0.15s; flex-shrink: 0;
	}
	.back-btn:hover { background: var(--glass-hover); color: var(--text-primary); }
	.bd-title-icon { font-size: 1.3rem; }
	.bd-header h1 { font-size: 1.1rem; font-weight: 700; color: var(--text-primary); letter-spacing: -0.02em; white-space: nowrap; }
	.bd-subtitle {
		font-size: 0.8rem; color: var(--text-secondary); font-weight: 600;
		padding-left: var(--space-sm); border-left: 1px solid var(--glass-border);
		white-space: nowrap; overflow: hidden; text-overflow: ellipsis;
	}

	.hdr-btn {
		display: inline-flex; align-items: center; gap: 5px; white-space: nowrap;
		height: 30px; padding: 0 11px;
		background: var(--bg-elevated); border: 1px solid var(--glass-border);
		border-radius: var(--radius-sm); color: var(--text-secondary);
		font-family: var(--font-family); font-size: 0.76rem; font-weight: 600;
		cursor: pointer; transition: all var(--duration-fast) var(--ease-out);
	}
	.hdr-btn:hover:not(:disabled) { color: var(--text-primary); border-color: var(--text-tertiary); }
	.hdr-btn:disabled { opacity: 0.5; cursor: default; }

	.bd-body { padding: var(--space-xl); max-width: 1100px; width: 100%; margin: 0 auto; display: flex; flex-direction: column; gap: var(--space-lg); }

	/* ─── Controls ───────────────────────────────────────────────────── */

	.controls { display: flex; align-items: center; gap: var(--space-sm); flex-wrap: wrap; }
	.pill-text { overflow: hidden; text-overflow: ellipsis; max-width: 220px; }
	.badge {
		display: inline-flex; align-items: center; justify-content: center;
		min-width: 18px; height: 18px; padding: 0 5px; border-radius: 9px;
		background: var(--accent-indigo); color: #fff; font-size: 0.66rem; font-weight: 700;
	}

	/* ─── Popover contents ───────────────────────────────────────────── */

	.seg-block { display: flex; width: 100%; margin-bottom: 10px; }
	.seg-block button { flex: 1; padding: 6px 6px; }
	.pick-list { display: flex; flex-direction: column; gap: 1px; max-height: 280px; overflow-y: auto; margin: 0 -8px; }
	.pick-row {
		display: flex; align-items: center; gap: 8px; width: 100%;
		padding: 7px 8px; border: none; background: none; border-radius: var(--radius-sm);
		color: var(--text-primary); font-family: var(--font-family); font-size: 0.8rem;
		text-align: left; cursor: pointer;
	}
	.pick-row:hover { background: var(--glass-hover); }
	.pick-row:focus-visible { outline: 2px solid var(--accent-indigo); outline-offset: -2px; }
	.pick-row.checked { font-weight: 600; }
	/* app.css gives every input width: 100% and 12px/16px padding. A checkbox
	   inherited that, filled the row and squeezed the board name to nothing. */
	.pick-row input[type='checkbox'] {
		flex: none; width: 15px; height: 15px; padding: 0; margin: 0 2px 0 4px;
		accent-color: var(--accent-indigo); cursor: pointer; box-shadow: none;
	}
	.check { width: 16px; flex-shrink: 0; text-align: center; font-weight: 800; color: var(--accent-indigo); }
	.pick-name { flex: 1; min-width: 0; overflow: hidden; text-overflow: ellipsis; white-space: nowrap; }
	.pick-meta { font-size: 0.7rem; color: var(--text-tertiary); font-variant-numeric: tabular-nums; }
	.pick-note { margin-top: 8px; font-size: 0.72rem; line-height: 1.45; color: var(--text-tertiary); }
	.pick-link { display: inline-block; margin-top: 10px; padding: 0; }
	.pick-search {
		width: 100%; height: 30px; margin-bottom: 6px; padding: 0 10px;
		background: var(--bg-surface); border: 1px solid var(--glass-border);
		border-radius: var(--radius-sm); color: var(--text-primary);
		font-family: var(--font-family); font-size: 0.8rem;
	}
	.pick-search:focus { outline: none; border-color: var(--accent-indigo); }
	.hairline { border: none; border-top: 1px solid var(--glass-border); margin: 8px 0 4px; }
	.custom-range { display: flex; flex-direction: column; gap: 6px; padding: 6px 0 2px 26px; }
	.custom-range .field { display: flex; justify-content: space-between; }
	.custom-range .ctl { flex: none; width: 150px; }
	.filter-field {
		display: flex; flex-direction: column; gap: 4px; margin-bottom: 10px;
		font-size: 0.72rem; font-weight: 600; color: var(--text-secondary);
	}
	.filter-field .ctl { max-width: none; width: 100%; }
	.ctl-date { width: 100%; max-width: none; margin: 2px 0 2px; }
	.btn-apply {
		margin-top: 10px; height: 30px; padding: 0 14px; border: none; border-radius: var(--radius-sm);
		background: var(--accent-indigo); color: #fff; font-family: var(--font-family);
		font-size: 0.78rem; font-weight: 600; cursor: pointer;
	}
	.btn-apply:disabled { background: var(--bg-elevated); color: var(--text-tertiary); cursor: default; }

	.seg {
		display: inline-flex; flex-shrink: 0; border-radius: var(--radius-full);
		border: 1px solid var(--glass-border); overflow: hidden;
	}
	.seg button {
		padding: 6px 12px; background: var(--bg-surface); border: none;
		border-right: 1px solid var(--glass-border);
		color: var(--text-secondary); font-family: var(--font-family);
		font-size: 0.75rem; font-weight: 600; cursor: pointer; white-space: nowrap;
		transition: all var(--duration-fast) var(--ease-out);
	}
	.seg button:last-child { border-right: none; }
	.seg button:hover { background: var(--bg-elevated); color: var(--text-primary); }
	.seg button.active { background: var(--accent-indigo); color: #fff; }

	.ctl {
		height: 30px; padding: 0 10px; max-width: 240px;
		background: var(--bg-surface); border: 1px solid var(--glass-border);
		border-radius: var(--radius-sm); color: var(--text-primary);
		font-family: var(--font-family); font-size: 0.78rem; cursor: pointer;
	}
	.ctl:focus { outline: none; border-color: var(--accent-indigo); }
	.ctl.is-set { border-color: var(--accent-indigo); color: var(--accent-indigo); font-weight: 600; }
	.field { display: inline-flex; align-items: center; gap: 6px; font-size: 0.75rem; font-weight: 600; color: var(--text-secondary); }
	.ctl-link {
		background: none; border: none; padding: 0 4px; cursor: pointer;
		font: inherit; font-size: 0.75rem; font-weight: 600;
		color: var(--accent-indigo); text-decoration: none; white-space: nowrap;
	}
	.ctl-link:hover { text-decoration: underline; }

	.chips { display: inline-flex; align-items: center; gap: 6px; flex-wrap: wrap; }
	.chip {
		display: inline-flex; align-items: center; gap: 6px;
		padding: 3px 5px 3px 11px; border-radius: var(--radius-full);
		font-size: 0.74rem; font-weight: 600; white-space: nowrap;
		background: rgba(99, 102, 241, 0.12); color: var(--text-primary);
		border: 1px solid rgba(99, 102, 241, 0.3);
	}
	.chip-x {
		display: flex; align-items: center; justify-content: center;
		width: 18px; height: 18px; border-radius: 50%; border: none; padding: 0;
		font-size: 0.6rem; cursor: pointer; color: inherit; background: rgba(99, 102, 241, 0.2);
	}
	.chip-x:hover { background: var(--accent-indigo); color: #fff; }

	.problem {
		display: flex; gap: var(--space-sm); align-items: baseline; flex-wrap: wrap;
		padding: 10px 14px; border-radius: var(--radius-md); font-size: 0.82rem;
		background: rgba(244, 63, 94, 0.1); color: var(--text-primary);
		border: 1px solid rgba(244, 63, 94, 0.3);
	}
	.problem a { color: var(--accent-indigo); font-weight: 600; }
	.hint { font-size: 0.82rem; color: var(--text-secondary); margin: 0; }

	/* ─── Figures ────────────────────────────────────────────────────── */

	/* Full width, like the tiles below it: a narrow measure left it bunched to one side. */
	.story {
		margin: 0; font-size: 0.95rem; line-height: 1.6; color: var(--text-primary);
		transition: opacity var(--duration-normal) ease;
	}
	.story.loading { opacity: 0.5; }
	.info-icon { color: var(--text-tertiary); flex-shrink: 0; }
	.kpi:hover .info-icon, .kpi:focus-within .info-icon { color: var(--accent-indigo); }
	.tone-good { color: #059669; }
	.tone-bad { color: #dc2626; }
	.muted-cell { color: var(--text-tertiary); }

	.kpis {
		display: grid; grid-template-columns: repeat(auto-fit, minmax(170px, 1fr)); gap: var(--space-sm);
		transition: opacity var(--duration-normal) ease;
	}
	.kpis.loading { opacity: 0.5; }
	.kpi {
		display: flex; flex-direction: column; gap: 2px; padding: var(--space-md) var(--space-lg);
		background: var(--bg-card); border: 1px solid var(--glass-border); border-radius: var(--radius-md);
	}
	.kpi-label { display: inline-flex; align-items: center; gap: 5px; font-size: 0.72rem; font-weight: 600; color: var(--text-secondary); }
	.kpi-value { font-size: 1.45rem; font-weight: 700; color: var(--text-primary); letter-spacing: -0.02em; line-height: 1.25; }
	.kpi-sub { font-size: 0.72rem; color: var(--text-tertiary); }
	/* Qualifiers under a figure: short tags, the full sentence on hover. */
	.kpi-tags { display: flex; flex-wrap: wrap; gap: 4px; margin-top: 6px; }
	.kpi-tag {
		display: inline-flex; align-items: center; gap: 4px; max-width: 100%;
		padding: 1px 7px; border-radius: var(--radius-full);
		background: var(--bg-surface); border: 1px solid var(--glass-border);
		font-size: 0.66rem; font-weight: 600; line-height: 1.6; color: var(--text-secondary);
	}
	.kpi-tag svg { flex-shrink: 0; }
	.kpi-tag-text { min-width: 0; overflow: hidden; text-overflow: ellipsis; white-space: nowrap; }
	.kpi-tag.warn { border-color: color-mix(in srgb, #d97706 35%, var(--glass-border)); }
	.thin-mark { font-size: 0.7rem; color: var(--text-tertiary); font-weight: 500; }
	.status { display: inline-flex; align-items: center; gap: 6px; }
	.status-icon {
		display: inline-flex; align-items: center; justify-content: center;
		width: 20px; height: 20px; border-radius: 50%; font-size: 0.75rem; font-weight: 800; color: #fff;
	}
	.status.good .status-icon { background: #059669; }
	.status.bad .status-icon { background: #dc2626; }
	.status.neutral .status-icon { background: var(--text-tertiary); }
	.status.warn .status-icon { background: #d97706; }
	.good { color: #059669; font-weight: 700; }
	.bad { color: #dc2626; font-weight: 700; }

	/* ─── Panels ─────────────────────────────────────────────────────── */

	.panel {
		background: var(--bg-card); border: 1px solid var(--glass-border);
		border-radius: var(--radius-md); padding: var(--space-lg);
	}
	.panel-head { display: flex; align-items: center; gap: var(--space-md); flex-wrap: wrap; margin-bottom: var(--space-md); }
	.panel-head h2 { font-size: 0.95rem; font-weight: 700; color: var(--text-primary); margin: 0; }
	.panel-meta { font-size: 0.75rem; color: var(--text-tertiary); flex: 1; }

	.notes { margin-top: var(--space-md); padding-top: var(--space-sm); border-top: 1px solid var(--glass-border); }
	.notes p { margin: 4px 0 0; font-size: 0.72rem; line-height: 1.5; color: var(--text-tertiary); }
	.footnote { margin: var(--space-sm) 0 0; font-size: 0.72rem; color: var(--text-tertiary); }

	.table-scroll { overflow-x: auto; border: 1px solid var(--glass-border); border-radius: var(--radius-sm); }
	.table-scroll.daily { margin-top: var(--space-md); max-height: 360px; overflow-y: auto; }
	.data-table { width: 100%; border-collapse: collapse; font-size: 0.8rem; }
	.data-table th {
		position: sticky; top: 0; background: var(--bg-surface); text-align: left;
		padding: 8px 12px; font-size: 0.68rem; font-weight: 700; color: var(--text-tertiary);
		border-bottom: 1px solid var(--glass-border); white-space: nowrap;
	}
	.data-table td { padding: 7px 12px; border-bottom: 1px solid var(--glass-border); color: var(--text-secondary); white-space: nowrap; }
	.data-table tbody tr:last-child td { border-bottom: none; }
	.data-table tbody tr:hover { background: var(--bg-elevated); }
	.num { text-align: right; font-variant-numeric: tabular-nums; }
	th.num { text-align: right; }
	.strong { color: var(--text-primary); font-weight: 700; }

	.groups .name { max-width: 280px; }
	.row-link {
		display: inline-flex; align-items: center; gap: 8px; max-width: 100%;
		background: none; border: none; padding: 0; cursor: pointer;
		font: inherit; font-weight: 600; color: var(--text-primary); text-align: left;
		overflow: hidden; text-overflow: ellipsis;
	}
	.row-link:hover { color: var(--accent-indigo); text-decoration: underline; }
	.swatch { width: 10px; height: 10px; border-radius: 3px; flex-shrink: 0; }
	.forecast { color: var(--text-secondary); }

	.sr-only {
		position: absolute; width: 1px; height: 1px; padding: 0; margin: -1px;
		overflow: hidden; clip: rect(0 0 0 0); white-space: nowrap; border: 0;
	}

	@media (max-width: 640px) {
		.bd-header { padding: var(--space-sm) var(--space-md); }
		.bd-subtitle { display: none; }
		.bd-body { padding: var(--space-md); }
		.panel { padding: var(--space-md); }
	}
</style>
