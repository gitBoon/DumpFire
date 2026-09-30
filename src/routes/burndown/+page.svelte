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
	import type { BurndownForecast, BurndownGroup, BurndownGroupBy, BurndownOption, Day } from '$lib/burndown';

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
	/** A scope picked but not yet given its board / category / milestone. */
	let pendingMode = $state<ScopeMode | null>(null);
	const shownMode = $derived(pendingMode ?? activeMode);

	const selectedBoardIds = $derived(
		(q.get('boardIds') ?? '').split(',').map(Number).filter((n) => Number.isInteger(n) && n > 0)
	);
	const selectedBoards = $derived(data.boards.filter((b) => selectedBoardIds.includes(b.id)));
	const selectedMilestone = $derived(data.milestones.find((m) => String(m.id) === q.get('milestoneId')) ?? null);

	// Labels and categories belong to boards, so a new scope starts unfiltered on
	// them; the breakdown falls back to the natural one for the new scope.
	const SCOPE_RESET = { labelIds: null, categoryIds: null, groupBy: null };

	function setMode(m: ScopeMode) {
		if (m === activeMode) { pendingMode = null; return; }
		if (m === 'workspace') {
			pendingMode = null;
			nav({ boardIds: null, boardCategoryId: null, milestoneId: null, target: null, ...SCOPE_RESET });
		} else {
			pendingMode = m;
		}
	}
	function addBoard(id: string) {
		if (!id) return;
		// Only reachable from the Boards scope, so it always leaves a milestone.
		const keep = activeMode === 'boards' ? selectedBoardIds : [];
		pendingMode = null;
		nav({
			boardIds: [...new Set([...keep, Number(id)])].join(','),
			boardCategoryId: null,
			milestoneId: null,
			target: null,
			...SCOPE_RESET
		});
	}
	function removeBoard(id: number) {
		const ids = selectedBoardIds.filter((b) => b !== id);
		nav({ boardIds: ids.length ? ids.join(',') : null, ...SCOPE_RESET });
	}
	function chooseBoardCategory(id: string) {
		if (!id) return;
		pendingMode = null;
		nav({ boardCategoryId: id, boardIds: null, milestoneId: null, target: null, ...SCOPE_RESET });
	}
	function chooseMilestone(id: string) {
		if (!id) return;
		pendingMode = null;
		// A goal's chart runs from when the goal was set, towards its own date.
		nav({ milestoneId: id, boardIds: null, boardCategoryId: null, days: null, from: null, to: null, target: null, ...SCOPE_RESET });
	}

	// ─── Range & target ──────────────────────────────────────────────────────

	const PRESETS = [
		{ value: '14', label: '14d' },
		{ value: '30', label: '30d' },
		{ value: '90', label: '90d' },
		{ value: '182', label: '6m' },
		{ value: '365', label: '1y' }
	];
	const preset = $derived(
		q.get('from') || q.get('to') ? 'custom' : (q.get('days') ?? (activeMode === 'milestone' ? 'start' : '30'))
	);
	let customOpen = $state(false);
	const showCustom = $derived(customOpen || preset === 'custom');

	function setPreset(v: string) {
		customOpen = v === 'custom';
		if (v === 'custom') return;
		nav({ days: v === 'start' ? null : v, from: null, to: null });
	}
	function setCustom(which: 'from' | 'to', v: string) {
		if (!r) return;
		nav({ from: which === 'from' ? v : r.range.from, to: which === 'to' ? v : r.range.to, days: null });
	}

	const milestoneTarget = $derived(r?.scope.milestone?.targetDate ?? null);
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

	function formatDay(day: Day, year = false): string {
		return new Date(`${day}T00:00:00Z`).toLocaleDateString('en-GB', {
			day: 'numeric', month: 'short', ...(year ? { year: 'numeric' } : {}), timeZone: 'UTC'
		});
	}
	const perWeek = (rate: number) => {
		const w = rate * 7;
		return w >= 10 ? Math.round(w).toString() : w.toFixed(1).replace(/\.0$/, '');
	};
	const plural = (n: number, one: string, many = `${one}s`) => `${n.toLocaleString('en-GB')} ${n === 1 ? one : many}`;

	function forecastText(f: BurndownForecast): { value: string; sub: string } {
		switch (f.status) {
			case 'done':
				return { value: 'Done', sub: 'Nothing remaining' };
			case 'insufficient-data':
				return { value: 'Too early', sub: `Needs a week of history — has ${plural(f.basisDays, 'day')}` };
			case 'converging':
				return {
					value: formatDay(f.projectedDate!, true),
					sub:
						f.projectedDateNoNewScope && f.projectedDateNoNewScope !== f.projectedDate
							? `${formatDay(f.projectedDateNoNewScope)} if nothing more is added`
							: `At the pace of the last ${plural(f.basisDays, 'day')}`
				};
			case 'not-converging':
				return {
					value: 'Not converging',
					sub:
						f.completionRate === 0
							? `Nothing completed in the last ${plural(f.basisDays, 'day')}`
							: `${perWeek(f.scopeRate)} added vs ${perWeek(f.completionRate)} done a week`
				};
		}
	}

	function groupForecast(f: BurndownForecast): string {
		if (f.status === 'converging' && f.projectedDate) return formatDay(f.projectedDate, true);
		if (f.status === 'done') return 'Done';
		if (f.status === 'not-converging') return 'Not converging';
		return '—';
	}

	const fc = $derived(r ? forecastText(r.forecast) : null);
	const change = $derived(r ? r.summary.remainingNow - r.summary.remainingStart : 0);

	const targetStatus = $derived.by(() => {
		const t = r?.target;
		if (!t) return null;
		const when = `Target ${formatDay(t.date, true)}`;
		if (t.onTrack === true) {
			return { tone: 'good', icon: '✓', value: 'On track', sub: t.daysLate ? `${when} · ${plural(-t.daysLate, 'day')} early` : when };
		}
		if (t.onTrack === false && t.daysLate !== null) {
			return { tone: 'bad', icon: '!', value: `${plural(t.daysLate, 'day')} late`, sub: when };
		}
		if (t.onTrack === false) return { tone: 'bad', icon: '!', value: 'At risk', sub: `Not converging towards ${formatDay(t.date)}` };
		return { tone: 'neutral', icon: '?', value: 'No forecast yet', sub: when };
	});

	const multiMember = $derived(r?.groupBy === 'label' || r?.groupBy === 'assignee');

	// ─── Export ──────────────────────────────────────────────────────────────

	function downloadCsv() {
		if (!r) return;
		const rows = [
			['date', 'scope', 'done', 'remaining', 'added', 'completed', 'dropped'],
			...r.series.map((p) => [p.date, p.scope, p.done, p.remaining, p.added, p.completed, p.removed])
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
		<!-- One row of controls above everything they scope -->
		<section class="controls" aria-label="What to chart">
			<div class="control-row">
				<div class="seg" role="group" aria-label="Scope">
					<button class:active={shownMode === 'workspace'} aria-pressed={shownMode === 'workspace'} onclick={() => setMode('workspace')}>All boards</button>
					<button class:active={shownMode === 'boards'} aria-pressed={shownMode === 'boards'} onclick={() => setMode('boards')}>Boards</button>
					{#if data.boardCategories.length}
						<button class:active={shownMode === 'boardCategory'} aria-pressed={shownMode === 'boardCategory'} onclick={() => setMode('boardCategory')}>Board group</button>
					{/if}
					{#if data.milestones.length}
						<button class:active={shownMode === 'milestone'} aria-pressed={shownMode === 'milestone'} onclick={() => setMode('milestone')}>Milestone</button>
					{/if}
				</div>

				{#if shownMode === 'boards' || (shownMode === 'milestone' && selectedBoards.length)}
					<div class="chips">
						{#each selectedBoards as b (b.id)}
							<span class="chip">
								{b.emoji} {b.name}
								<button class="chip-x" onclick={() => removeBoard(b.id)} aria-label="Remove {b.name}">✕</button>
							</span>
						{/each}
						{#if shownMode === 'boards'}
							<select class="ctl" aria-label="Add a board" value="" onchange={(e) => addBoard(e.currentTarget.value)}>
								<option value="">{selectedBoards.length ? '+ Add board' : 'Choose a board…'}</option>
								{#each data.boards.filter((b) => !selectedBoardIds.includes(b.id)) as b (b.id)}
									<option value={b.id}>{b.emoji} {b.name}</option>
								{/each}
							</select>
						{/if}
					</div>
				{/if}
				{#if shownMode === 'boardCategory'}
					<select class="ctl" aria-label="Board group" value={q.get('boardCategoryId') ?? ''} onchange={(e) => chooseBoardCategory(e.currentTarget.value)}>
						<option value="" disabled>Choose a board group…</option>
						{#each data.boardCategories as c (c.id)}
							<option value={String(c.id)}>{c.name}</option>
						{/each}
					</select>
				{/if}
				{#if shownMode === 'milestone'}
					<select class="ctl ctl-wide" aria-label="Milestone" value={q.get('milestoneId') ?? ''} onchange={(e) => chooseMilestone(e.currentTarget.value)}>
						<option value="" disabled>Choose a milestone…</option>
						{#each data.milestones as m (m.id)}
							<option value={String(m.id)}>{m.status === 'open' ? '' : '(closed) '}{m.name}</option>
						{/each}
					</select>
					{#if selectedMilestone}
						<a class="ctl-link" href="/plan/{selectedMilestone.id}">Open plan →</a>
					{/if}
				{/if}
			</div>

			<div class="control-row">
				<div class="seg" role="group" aria-label="Date range">
					{#each PRESETS as p}
						<button class:active={preset === p.value && !showCustom} aria-pressed={preset === p.value && !showCustom} onclick={() => setPreset(p.value)}>{p.label}</button>
					{/each}
					{#if activeMode === 'milestone'}
						<button class:active={preset === 'start' && !showCustom} aria-pressed={preset === 'start' && !showCustom} onclick={() => setPreset('start')}>Since start</button>
					{/if}
					<button class:active={showCustom} aria-pressed={showCustom} onclick={() => setPreset('custom')}>Custom</button>
				</div>
				{#if showCustom && r}
					<label class="field">From <input class="ctl" type="date" value={r.range.from} max={r.range.to} onchange={(e) => setCustom('from', e.currentTarget.value)} /></label>
					<label class="field">To <input class="ctl" type="date" value={r.range.to} min={r.range.from} onchange={(e) => setCustom('to', e.currentTarget.value)} /></label>
				{/if}

				<label class="field">
					Target
					<input class="ctl" type="date" value={r?.target?.date ?? ''} onchange={(e) => setTarget(e.currentTarget.value)} />
				</label>
				{#if q.get('target') === 'none' && milestoneTarget}
					<button class="ctl-link" onclick={() => nav({ target: null })}>Use the milestone's {formatDay(milestoneTarget)}</button>
				{:else if r?.target}
					<button class="ctl-link" onclick={() => setTarget('')}>Clear</button>
				{/if}
			</div>

			{#if r?.options}
				<div class="control-row">
					{#each FILTERS as f (f.key)}
						{@const opts = choices(f)}
						{#if opts.length || q.get(f.key)}
							<select class="ctl" aria-label={f.label} class:is-set={!!q.get(f.key)} value={q.get(f.key) ?? ''} onchange={(e) => nav({ [f.key]: e.currentTarget.value || null })}>
								<option value="">{f.any}</option>
								{#each opts as o (o.id)}
									<option value={String(o.id)}>{o.name} ({o.count})</option>
								{/each}
							</select>
						{/if}
					{/each}
					{#if activeFilters}
						<button class="ctl-link" onclick={() => nav({ categoryIds: null, labelIds: null, assigneeIds: null, priorities: null })}>Clear filters</button>
					{/if}
				</div>
			{/if}
		</section>

		{#if data.problem}
			<div class="problem" role="alert">
				<strong>{data.problem.status === 403 ? 'No access' : data.problem.status === 404 ? 'Not found' : 'Can’t draw that'}</strong>
				<span>{data.problem.message}</span>
				<a href="/burndown">Start again</a>
			</div>
		{:else if pendingMode && pendingMode !== activeMode}
			<p class="hint">Choose {pendingMode === 'boards' ? 'a board' : pendingMode === 'boardCategory' ? 'a board group' : 'a milestone'} above to chart it.</p>
		{/if}

		{#if r}
			<!-- The figures a reader wants before the chart -->
			<section class="kpis" class:loading aria-label="Summary">
				<div class="kpi">
					<span class="kpi-label">Remaining</span>
					<span class="kpi-value">{r.summary.remainingNow.toLocaleString('en-GB')}</span>
					<span class="kpi-sub">
						{#if change === 0}
							No change since {formatDay(r.range.from)}
						{:else}
							<span class={change < 0 ? 'good' : 'bad'}>{change < 0 ? '▼' : '▲'} {Math.abs(change)}</span> since {formatDay(r.range.from)}
						{/if}
					</span>
				</div>
				<div class="kpi">
					<span class="kpi-label">Completed</span>
					<span class="kpi-value">{r.summary.completed.toLocaleString('en-GB')}</span>
					<span class="kpi-sub">{perWeek(r.forecast.completionRate)} a week lately</span>
				</div>
				<div class="kpi">
					<span class="kpi-label">Scope change</span>
					<span class="kpi-value">+{r.summary.added}{#if r.summary.removed}<span class="kpi-minor"> / −{r.summary.removed}</span>{/if}</span>
					<span class="kpi-sub">{plural(r.summary.scopeNow, 'card')} in scope now</span>
				</div>
				{#if fc}
					<div class="kpi">
						<span class="kpi-label">Forecast</span>
						<span class="kpi-value">{fc.value}</span>
						<span class="kpi-sub">{fc.sub}</span>
					</div>
				{/if}
				{#if targetStatus}
					<div class="kpi">
						<span class="kpi-label">Target</span>
						<span class="kpi-value status {targetStatus.tone}"><span class="status-icon" aria-hidden="true">{targetStatus.icon}</span>{targetStatus.value}</span>
						<span class="kpi-sub">{targetStatus.sub}</span>
					</div>
				{/if}
			</section>

			<section class="panel">
				<div class="panel-head">
					<h2>{view === 'burnup' ? 'Done against scope' : 'Remaining work'}</h2>
					<span class="panel-meta">
						{formatDay(r.range.from, true)} – {formatDay(r.range.to, true)} · {plural(r.meta.cardCount, 'card')}
					</span>
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
					<div class="table-scroll daily">
						<table class="data-table">
							<caption class="sr-only">Daily figures for {r.scope.label}</caption>
							<thead>
								<tr><th>Date</th><th class="num">Remaining</th><th class="num">Scope</th><th class="num">Done</th><th class="num">Added</th><th class="num">Completed</th><th class="num">Dropped</th></tr>
							</thead>
							<tbody>
								{#each [...r.series].reverse() as p (p.date)}
									<tr>
										<td>{formatDay(p.date, true)}</td>
										<td class="num strong">{p.remaining}</td>
										<td class="num">{p.scope}</td>
										<td class="num">{p.done}</td>
										<td class="num">{p.added || ''}</td>
										<td class="num">{p.completed || ''}</td>
										<td class="num">{p.removed || ''}</td>
									</tr>
								{/each}
							</tbody>
						</table>
					</div>
				{/if}

				<div class="notes">
					<p>
						Rebuilt from each card's created, completed and archived dates, so any filter works over
						any window. Days are UTC. The forecast uses the pace of the last
						{plural(r.forecast.basisDays, 'day')}.
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
									<th>Trend</th>
									<th class="num">Remaining</th>
									<th class="num">Change</th>
									<th class="num">Completed</th>
									<th class="num">Scope</th>
									<th>Forecast</th>
								</tr>
							</thead>
							<tbody>
								{#each r.groups as g (g.key)}
									{@const delta = g.summary.remainingNow - g.summary.remainingStart}
									<tr>
										<td class="name">
											<button class="row-link" onclick={() => drill(g)} title="Chart just this">
												{#if g.color}<span class="swatch" style="background: {g.color}"></span>{/if}
												{g.name}
											</button>
										</td>
										<td><Sparkline values={g.remaining} /></td>
										<td class="num strong">{g.summary.remainingNow}</td>
										<td class="num">
											{#if delta}<span class={delta < 0 ? 'good' : 'bad'}>{delta < 0 ? '▼' : '▲'} {Math.abs(delta)}</span>{:else}—{/if}
										</td>
										<td class="num">{g.summary.completed}</td>
										<td class="num">{g.summary.scopeNow}</td>
										<td class="forecast">{groupForecast(g.forecast)}</td>
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

	.controls { display: flex; flex-direction: column; gap: var(--space-sm); }
	.control-row { display: flex; align-items: center; gap: var(--space-sm); flex-wrap: wrap; }

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
	.ctl-wide { max-width: 340px; }
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

	.kpis {
		display: grid; grid-template-columns: repeat(auto-fit, minmax(170px, 1fr)); gap: var(--space-sm);
		transition: opacity var(--duration-normal) ease;
	}
	.kpis.loading { opacity: 0.5; }
	.kpi {
		display: flex; flex-direction: column; gap: 2px; padding: var(--space-md) var(--space-lg);
		background: var(--bg-card); border: 1px solid var(--glass-border); border-radius: var(--radius-md);
	}
	.kpi-label { font-size: 0.72rem; font-weight: 600; color: var(--text-secondary); }
	.kpi-value { font-size: 1.45rem; font-weight: 700; color: var(--text-primary); letter-spacing: -0.02em; line-height: 1.25; }
	.kpi-minor { font-size: 1rem; color: var(--text-secondary); font-weight: 600; }
	.kpi-sub { font-size: 0.72rem; color: var(--text-tertiary); }
	.status { display: inline-flex; align-items: center; gap: 6px; }
	.status-icon {
		display: inline-flex; align-items: center; justify-content: center;
		width: 20px; height: 20px; border-radius: 50%; font-size: 0.75rem; font-weight: 800; color: #fff;
	}
	.status.good .status-icon { background: #059669; }
	.status.bad .status-icon { background: #dc2626; }
	.status.neutral .status-icon { background: var(--text-tertiary); }
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
