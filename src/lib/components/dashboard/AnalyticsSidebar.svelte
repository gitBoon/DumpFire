<!--
  AnalyticsSidebar.svelte — The dashboard's sidebar: the four figure tiles
  and Notional spend, Priority Spread, Board Health, the 4-week trend,
  Category Distribution, Task Aging, the leaderboard, Upcoming Deadlines,
  the quick figures and Recent Activity (card 2281, slice C2: moved from
  src/routes/+page.svelte).

  Drawn by the page inside its grid's sidebar column. The clock its due
  figures are counted on is the page's, which Active Tasks reads too. The
  Active Tasks, Velocity and Spend tiles open windows the page draws.
-->
<script lang="ts">
	import type { PageData } from '../../../routes/$types';
	import { formatTokens } from '$lib/tokens';
	import { formatUsd, BLEND_NOTE, SOURCE_NOTE, NOT_BILLED_NOTE, UNPRICED_SUM_NOTE } from '$lib/pricing';
	import { drawnColour } from '$lib/colours';
	import { daysUntilDue, dueFigures, formatDueDate } from '$lib/utils/date-utils';
	import { timeAgo } from '$lib/dashboard/format';

	let {
		data,
		clock,
		openActiveTasksModal,
		showVelocityModal = $bindable(),
		showSpendModal = $bindable()
	}: {
		/** What the dashboard's load gave it, passed on as it is. */
		data: PageData;
		/** The page's: the viewer's moment once the page is up, null until then (card 2258). */
		clock: Date | null;
		/** Opens the page's Active Tasks window, which reads its list as it opens. */
		openActiveTasksModal: () => void;
		/** The page's: whether the velocity window is open. */
		showVelocityModal: boolean;
		/** The page's: whether the spend window is open. */
		showSpendModal: boolean;
	} = $props();

	const a = $derived(data.analytics);

	// ─── Due figures (card 2258) ─────────────────────────────────────────────
	// Overdue, due soon and Upcoming Deadlines are counted here, from the due
	// cards the load sends, in the viewer's own day, as the badges are. The
	// server runs in UTC and knows no viewer's zone, so until the page has
	// loaded (`clock` is null, on the server and while the page hydrates) they
	// are the UTC day's at the moment the load ran; the two renders agree, and
	// the figures move to the viewer's day once the page is up. Set again on
	// each live refresh, and on a tick, so a page left open across midnight
	// moves on. The cards overdue in every zone come counted, as `longOverdue`,
	// and are not sent.
	const due = $derived(clock ? dueFigures(a.dueCards, clock, undefined, a.longOverdue) : dueFigures(a.dueCards, new Date(a.asOf), 'UTC', a.longOverdue));

	// Computed analytics helpers
	let maxTrend = $derived(Math.max(1, ...a.weeklyTrend.map((w: any) => w.count)));
	let totalCatCards = $derived(a.categoryDistribution.reduce((s: number, c: any) => s + c.count, 0));
	let agingTotal = $derived(a.agingBuckets.fresh + a.agingBuckets.week + a.agingBuckets.fortnight + a.agingBuckets.month + a.agingBuckets.stale);
	let agingItems = $derived([
		{ label: '< 3d', count: a.agingBuckets.fresh, color: 'var(--priority-low)' },
		{ label: '3-7d', count: a.agingBuckets.week, color: 'var(--accent-emerald)' },
		{ label: '1-2w', count: a.agingBuckets.fortnight, color: 'var(--priority-medium)' },
		{ label: '2-4w', count: a.agingBuckets.month, color: 'var(--priority-high)' },
		{ label: '> 1m', count: a.agingBuckets.stale, color: 'var(--priority-critical)' }
	]);

	/**
	 * Calendar days to a deadline, from the viewer's own today (card 2241).
	 * `clock` is read so that a deadline's words move on with the list, at
	 * midnight, as a badge's do on its tick (card 2258).
	 */
	function deadlineDays(dateStr: string): number {
		void clock;
		return daysUntilDue(dateStr) ?? 0;
	}

	/**
	 * A deadline in words. The list is chosen by the viewer's own day once the
	 * page has loaded (card 2258); until then by the UTC day, so one it calls
	 * today can be yesterday for the viewer: that reads as overdue.
	 */
	function dueLabel(dateStr: string): string {
		const d = deadlineDays(dateStr);
		if (d < 0) return `${-d}d overdue`;
		if (d === 0) return 'Today';
		if (d === 1) return 'Tomorrow';
		return `${d} days`;
	}
</script>

<!-- Primary Metrics -->
<div class="metrics-grid">
	<!-- svelte-ignore a11y_click_events_have_key_events -->
	<!-- svelte-ignore a11y_no_static_element_interactions -->
	<div class="stat-card glass-glow stat-card-clickable" onclick={openActiveTasksModal} id="active-tasks-card">
		<div class="stat-header">
			<span class="stat-label">Active Tasks</span>
			{#if due.dueSoon > 0}
				<span class="stat-badge warn" title="Due in next 3 days">{due.dueSoon} due soon</span>
			{/if}
		</div>
		<div class="stat-value">{a.active}</div>
		<div class="stat-sub">{a.totalAssigned} total · {a.completed} completed</div>

</div>

	<div class="stat-card glass-glow accent-green">
		<div class="stat-header">
			<span class="stat-label">Progress</span>
		</div>
		<div class="progress-donut">
			<div class="donut-text">
				<span class="donut-val">{a.completionRate}%</span>
			</div>
			<svg viewBox="0 0 36 36">
				<path class="ring-bg" d="M18 2.0845 a 15.9155 15.9155 0 0 1 0 31.831 a 15.9155 15.9155 0 0 1 0 -31.831" />
				<path class="ring-fill" stroke-dasharray="{a.completionRate}, 100" d="M18 2.0845 a 15.9155 15.9155 0 0 1 0 31.831 a 15.9155 15.9155 0 0 1 0 -31.831" />
			</svg>
		</div>
		<div class="stat-sub">{a.completed} completed</div>
	</div>

	<!-- svelte-ignore a11y_click_events_have_key_events -->
	<!-- svelte-ignore a11y_no_static_element_interactions -->
	<div class="stat-card glass-glow accent-cyan stat-card-clickable" onclick={() => (showVelocityModal = true)} id="velocity-card">
		<div class="stat-header">
			<span class="stat-label">Velocity</span>
			<div class="trend-arrow" class:up={a.completedThisWeek > 0}>
				{a.completedThisWeek > 0 ? '↑' : '—'}
			</div>
		</div>
		<div class="stat-value">{a.completedThisWeek}</div>
		<div class="stat-sub">done this week • {a.completedThisMonth} this month</div>

		<!-- CSS Sparkline -->
		<div class="sparkline">
			{#each a.weeklyActivity as dayObj}
				<!-- scale sparkline relative to max in week, or just raw if small -->
				{@const hPct = Math.max(10, Math.min(100, (dayObj.count / Math.max(1, ...a.weeklyActivity.map(w => w.count))) * 100))}
				<div class="spark-bar" style="height: {hPct}%" title="{dayObj.day}: {dayObj.count}"></div>
			{/each}
		</div>
	</div>

	<div class="stat-card glass-glow" class:accent-rose={due.overdue > 0 || a.pendingRequests > 0}>
		<div class="stat-header">
			<span class="stat-label">Attention</span>
		</div>
		<div class="stat-value {due.overdue > 0 ? 'pulse-text' : ''}">{due.overdue} <span class="text-sm">overdue</span></div>
		<div class="stat-sub">{a.pendingRequests} inbox pending</div>
	</div>

	<!-- Total cost across every board this user can see.
	     Always rendered, including when nothing has been recorded: a hidden
	     tile is indistinguishable from a feature that did not ship, and the
	     empty state is the only thing that explains why the columns are
	     blank. "Nothing recorded yet" is a statement about the data, not a
	     claim that the work was free. -->
	<!-- svelte-ignore a11y_click_events_have_key_events -->
	<!-- svelte-ignore a11y_no_static_element_interactions -->
	<div
		class="stat-card glass-glow accent-violet"
		class:stat-card-clickable={data.allTasksTotals.tokenTotal != null}
		onclick={() => { if (data.allTasksTotals.tokenTotal != null) showSpendModal = true; }}
		id="spend-card"
	>
		<div class="stat-header">
			<span class="stat-label" title="{NOT_BILLED_NOTE}.">Notional spend</span>
			{#if data.allTasksTotals.tokenTotal != null}
				<span class="stat-card-hint">by person →</span>
			{/if}
		</div>
		{#if data.allTasksTotals.tokenTotal != null}
			<div class="stat-value">{formatUsd(data.allTasksTotals.costUsd)}</div>
			<div class="stat-sub" title="{NOT_BILLED_NOTE}. {SOURCE_NOTE} — {BLEND_NOTE}.">
				{formatTokens(data.allTasksTotals.tokenTotal)} tokens · what the API would charge
				{#if data.allTasksTotals.unpricedTokens > 0}
					<span class="stat-warn" title="Tokens {UNPRICED_SUM_NOTE}, so they cannot be priced.">
						· {formatTokens(data.allTasksTotals.unpricedTokens)} unpriced
					</span>
				{/if}
			</div>
		{:else}
			<div class="stat-value stat-muted">—</div>
			<div class="stat-sub">Nothing recorded yet</div>
		{/if}
	</div>
</div>

<!-- Priority breakdown -->
{#if a.active > 0}
	<div class="sidebar-panel glass">
		<h3 class="panel-title">Priority Spread</h3>
		<div class="priority-bar">
			{#if a.priorityCounts.critical > 0}<div class="priority-seg seg-critical" style="flex: {a.priorityCounts.critical}" title="{a.priorityCounts.critical} critical"></div>{/if}
			{#if a.priorityCounts.high > 0}<div class="priority-seg seg-high" style="flex: {a.priorityCounts.high}" title="{a.priorityCounts.high} high"></div>{/if}
			{#if a.priorityCounts.medium > 0}<div class="priority-seg seg-medium" style="flex: {a.priorityCounts.medium}" title="{a.priorityCounts.medium} medium"></div>{/if}
			{#if a.priorityCounts.low > 0}<div class="priority-seg seg-low" style="flex: {a.priorityCounts.low}" title="{a.priorityCounts.low} low"></div>{/if}
		</div>
		<div class="priority-legend">
			{#if a.priorityCounts.critical > 0}<span class="legend-item"><span class="legend-dot dot-critical"></span> {a.priorityCounts.critical} Cri</span>{/if}
			{#if a.priorityCounts.high > 0}<span class="legend-item"><span class="legend-dot dot-high"></span> {a.priorityCounts.high} Hi</span>{/if}
			{#if a.priorityCounts.medium > 0}<span class="legend-item"><span class="legend-dot dot-medium"></span> {a.priorityCounts.medium} Med</span>{/if}
			{#if a.priorityCounts.low > 0}<span class="legend-item"><span class="legend-dot dot-low"></span> {a.priorityCounts.low} Low</span>{/if}
		</div>
	</div>
{/if}

<!-- Board Health -->
{#if a.boardHealth.length > 0}
	<div class="sidebar-panel glass">
		<h3 class="panel-title">Board Health Overview</h3>
		<div class="health-list">
			{#each a.boardHealth as hb}
				<div class="health-item">
					<span class="hl-emoji">{hb.emoji}</span>
					<div class="hl-content">
						<div class="hl-header">
							<span class="hl-name">{hb.name}</span>
							<span class="hl-pct" class:hot={hb.pct === 100}>{hb.pct}%</span>
						</div>
						<div class="progress-track"><div class="progress-fill" class:complete={hb.pct === 100} style="width: {hb.pct}%"></div></div>
					</div>
				</div>
			{/each}
		</div>
	</div>
{/if}

<!-- 4-Week Completion Trend -->
{#if a.weeklyTrend.some((w: any) => w.count > 0)}
	<div class="sidebar-panel glass">
		<h3 class="panel-title">4-Week Trend</h3>
		<div class="trend-chart">
			{#each a.weeklyTrend as week}
				<div class="trend-col">
					<div class="trend-bar-track">
						<div class="trend-bar-fill" style="height: {(week.count / maxTrend) * 100}%"></div>
					</div>
					<span class="trend-count">{week.count}</span>
					<span class="trend-label">{week.label}</span>
				</div>
			{/each}
		</div>
	</div>
{/if}

<!-- Category Distribution -->
{#if a.categoryDistribution.length > 0 && totalCatCards > 0}
		<div class="sidebar-panel glass">
			<h3 class="panel-title">Category Distribution</h3>
			<div class="cat-dist-bar">
				{#each a.categoryDistribution as cat}
					{#if cat.count > 0}
						<div class="cat-dist-seg" style="flex: {cat.count}; background: {drawnColour(cat.color)}" title="{cat.name}: {cat.count} cards"></div>
					{/if}
				{/each}
			</div>
			<div class="cat-dist-legend">
				{#each a.categoryDistribution as cat}
					{#if cat.count > 0}
						<span class="cat-dist-item">
							<span class="cat-dist-dot" style="background: {drawnColour(cat.color)}"></span>
							<span class="cat-dist-name">{cat.name}</span>
							<span class="cat-dist-count">{cat.count}</span>
						</span>
					{/if}
				{/each}
			</div>
		</div>
{/if}

<!-- Task Aging -->
{#if a.active > 0}
	<div class="sidebar-panel glass">
		<h3 class="panel-title">Task Aging</h3>
		<div class="aging-grid">
			{#each agingItems as item}
				<div class="aging-cell" class:aging-empty={item.count === 0}>
					<div class="aging-bar-wrap">
						<div class="aging-bar" style="height: {agingTotal > 0 ? (item.count / agingTotal) * 100 : 0}%; background: {drawnColour(item.color)}"></div>
					</div>
					<span class="aging-count" style="color: {drawnColour(item.count > 0 ? item.color : 'var(--text-tertiary)')}">{item.count}</span>
					<span class="aging-label">{item.label}</span>
				</div>
			{/each}
		</div>
	</div>
{/if}

<!-- Team Leaderboard -->
{#if a.teamLeaderboard.length > 0}
	<div class="sidebar-panel glass">
		<h3 class="panel-title">Team Leaderboard</h3>
		<div class="leaderboard-list">
			{#each a.teamLeaderboard as member, i}
				<div class="leader-row">
					<span class="leader-rank">{i === 0 ? '🥇' : i === 1 ? '🥈' : i === 2 ? '🥉' : `${i + 1}.`}</span>
					<span class="leader-emoji">{member.emoji}</span>
					<div class="leader-info">
						<span class="leader-name">{member.username}</span>
						<div class="leader-bar-wrap">
							<div class="leader-bar-track">
								{#if (member.completed + member.active) > 0}
									<div class="leader-bar-done" style="width: {(member.completed / (member.completed + member.active)) * 100}%"></div>
								{/if}
							</div>
						</div>
					</div>
					<div class="leader-stats">
						<span class="leader-done">{member.completed}✓</span>
						<span class="leader-active">{member.active}⚡</span>
					</div>
				</div>
			{/each}
		</div>
	</div>
{/if}

<!-- Upcoming Deadlines -->
{#if due.upcoming.length > 0}
	<div class="sidebar-panel glass">
		<h3 class="panel-title">Upcoming Deadlines</h3>
		<div class="deadlines-list">
			{#each due.upcoming as dl}
				<div class="deadline-item" class:deadline-urgent={deadlineDays(dl.dueDate) <= 1} class:deadline-soon={deadlineDays(dl.dueDate) > 1 && deadlineDays(dl.dueDate) <= 3}>
					<div class="deadline-priority">
						{dl.priority === 'critical' ? '🔴' : dl.priority === 'high' ? '🟠' : dl.priority === 'medium' ? '🟡' : '🟢'}
					</div>
					<div class="deadline-info">
						<span class="deadline-title">{dl.title}</span>
						<span class="deadline-when">{dueLabel(dl.dueDate)}</span>
					</div>
					<span class="deadline-date">{formatDueDate(dl.dueDate, { day: 'numeric', month: 'short' })}</span>
				</div>
			{/each}
		</div>
	</div>
{/if}

<!-- Quick Stats Summary -->
<div class="sidebar-panel glass quick-stats">
	<div class="qs-row">
		<span class="qs-label">On Hold</span>
		<span class="qs-value" class:qs-warn={a.onHoldCount > 0}>{a.onHoldCount}</span>
	</div>
	<div class="qs-row">
		<span class="qs-label">Due Soon (3d)</span>
		<span class="qs-value" class:qs-warn={due.dueSoon > 0}>{due.dueSoon}</span>
	</div>
	<div class="qs-row">
		<span class="qs-label">Monthly Rate</span>
		<span class="qs-value">{a.completedThisMonth}/mo</span>
	</div>
</div>

<!-- Recent Activity -->
{#if a.recentActivity.length > 0}
	<div class="sidebar-panel glass activity-section">
		<h3 class="panel-title">Recent Activity</h3>
		<div class="activity-list">
			{#each a.recentActivity as entry}
				<div class="activity-item">
					<span class="activity-emoji">{entry.userEmoji}</span>
					<div class="activity-text">
						<span class="activity-detail">{entry.detail || entry.action}</span>
						<span class="activity-time">{timeAgo(entry.createdAt)}</span>
					</div>
				</div>
			{/each}
		</div>
	</div>
{/if}

<style>
	/* ─── Sidebar Metrics ────────────────────────────────────────── */
	.metrics-grid {
		display: grid; grid-template-columns: 1fr 1fr; gap: var(--space-sm);
	}
	.stat-card {
		position: relative; overflow: hidden;
		background: var(--bg-card); border: 1px solid var(--glass-border);
		border-radius: var(--radius-lg); padding: var(--space-md);
		transition: all var(--duration-fast) var(--ease-out);
		display: flex; flex-direction: column; min-height: 100px;
	}
	.glass-glow:hover { box-shadow: 0 8px 30px rgba(99, 102, 241, 0.08); border-color: rgba(99, 102, 241, 0.2); transform: translateY(-2px); }
	.stat-card-clickable { cursor: pointer; }
	.stat-card-clickable:hover { border-color: var(--accent-indigo); box-shadow: 0 8px 30px rgba(99, 102, 241, 0.15); }
	.stat-card-hint {
		position: absolute; bottom: 6px; right: 10px;
		font-size: 0.55rem; font-weight: 600; text-transform: uppercase;
		letter-spacing: 0.05em; color: var(--text-tertiary);
		opacity: 0; transition: opacity var(--duration-fast) var(--ease-out);
	}
	.stat-card-clickable:hover .stat-card-hint { opacity: 1; color: var(--accent-indigo); }

	.stat-header { display: flex; align-items: flex-start; justify-content: space-between; margin-bottom: auto; }
	.stat-label { font-size: 0.68rem; font-weight: 700; color: var(--text-tertiary); text-transform: uppercase; letter-spacing: 0.05em; }
	.stat-badge.warn { background: rgba(245, 158, 11, 0.15); color: #d97706; padding: 2px 6px; border-radius: var(--radius-sm); font-size: 0.6rem; font-weight: 700; white-space: nowrap; }

	.stat-value {
		font-size: 1.8rem; font-weight: 800; color: var(--text-primary);
		line-height: 1.1; margin-top: 8px; letter-spacing: -0.03em;
	}
	.text-sm { font-size: 0.8rem; font-weight: 600; opacity: 0.5; }
	.stat-sub { font-size: 0.65rem; color: var(--text-secondary); margin-top: 4px; font-weight: 500; }

	/* Accents */
	.accent-green { border-top-color: rgba(34, 197, 94, 0.5); }
	.accent-green .stat-label { color: #22c55e; }
	.accent-cyan { border-top-color: rgba(6, 182, 212, 0.5); }
	.accent-cyan .stat-label { color: #06b6d4; }
	.accent-rose { border-top-color: rgba(244, 63, 94, 0.5); border-left-color: rgba(244, 63, 94, 0.5); }
	.accent-rose .stat-value { color: var(--accent-rose); }
	.accent-violet .stat-value { color: var(--accent-violet, #8b5cf6); }
	/* Unpriced tokens are a gap in the data, not a small number — flagged rather
	   than folded silently into the total. */
	.stat-warn { color: var(--accent-amber, #f59e0b); }
	.stat-muted { color: var(--text-tertiary); opacity: 0.6; }
	.pulse-text { animation: pulse-red 2s infinite; }
	@keyframes pulse-red { 0%, 100% { opacity: 1; } 50% { opacity: 0.6; } }

	/* Donut Progress */
	.progress-donut {
		position: relative; width: 44px; height: 44px; align-self: flex-end; margin-top: -10px; margin-bottom: 2px;
	}
	.progress-donut svg { width: 100%; height: 100%; transform: rotate(-90deg); }
	.donut-text {
		position: absolute; inset: 0; display: flex; align-items: center; justify-content: center;
	}
	.donut-val { font-size: 0.65rem; font-weight: 800; color: #22c55e; }
	.ring-bg { fill: none; stroke: var(--glass-bg); stroke-width: 4; }
	.ring-fill { fill: none; stroke: #22c55e; stroke-width: 4; stroke-linecap: round; transition: stroke-dasharray 1s cubic-bezier(0.4, 0, 0.2, 1); }

	/* Trend & Sparkline */
	.trend-arrow { font-size: 0.8rem; font-weight: 800; color: var(--text-tertiary); }
	.trend-arrow.up { color: #06b6d4; }
	.sparkline {
		position: absolute; bottom: 0; left: 0; right: 0; height: 30px;
		display: flex; align-items: flex-end; gap: 2px; padding: 0 var(--space-md); opacity: 0.3;
	}
	.spark-bar {
		flex: 1; background: #06b6d4; border-radius: 2px 2px 0 0;
		min-height: 2px; transition: height 0.5s ease-out;
	}

	/* Sidebar Panels */
	.sidebar-panel {
		background: var(--bg-card); border: 1px solid var(--glass-border);
		border-radius: var(--radius-lg); padding: var(--space-md);
	}
	.panel-title { font-size: 0.72rem; font-weight: 700; color: var(--text-primary); text-transform: uppercase; letter-spacing: 0.05em; margin-bottom: var(--space-sm); border-bottom: 1px solid var(--glass-border); padding-bottom: 6px; }

	/* Priority Bar */
	.priority-bar { display: flex; height: 6px; border-radius: 3px; overflow: hidden; gap: 1px; margin-bottom: 8px; }
	.priority-seg { transition: flex 0.5s cubic-bezier(0.4, 0, 0.2, 1); }
	.seg-critical { background: #ef4444; } .seg-high { background: #f97316; } .seg-medium { background: #eab308; } .seg-low { background: #22c55e; }
	.priority-legend { display: flex; gap: 8px; flex-wrap: wrap; }
	.legend-item { display: flex; align-items: center; gap: 4px; font-size: 0.6rem; color: var(--text-secondary); font-weight: 600; }
	.legend-dot { width: 6px; height: 6px; border-radius: 50%; }

	/* Health List */
	.health-list { display: flex; flex-direction: column; gap: 8px; }
	.health-item { display: flex; align-items: center; gap: 8px; }
	.hl-emoji { font-size: 1rem; flex-shrink: 0; }
	.hl-content { flex: 1; min-width: 0; }
	.hl-header { display: flex; justify-content: space-between; margin-bottom: 3px; font-size: 0.68rem; font-weight: 600; color: var(--text-secondary); }
	.hl-name { white-space: nowrap; overflow: hidden; text-overflow: ellipsis; }
	.hl-pct { font-weight: 800; color: var(--text-primary); }
	.hl-pct.hot { color: #22c55e; }


	/* Copied from BoardsTable.svelte: as .dashboard :global() in the page they would outrank its .fill-all. */
	.progress-track { flex: 1; height: 5px; background: var(--glass-bg); border-radius: 3px; overflow: hidden; }
	.progress-fill { height: 100%; background: var(--accent-indigo); border-radius: 3px; transition: width 0.3s; }

	/* ─── Activity ────────────────────────────────────────────────── */
	.activity-section { margin-bottom: var(--space-2xl); }
	.activity-list {
		display: flex; flex-direction: column;
		background: var(--bg-card); border: 1px solid var(--glass-border);
		border-radius: var(--radius-md); overflow: hidden;
	}
	.activity-item {
		display: flex; align-items: center; gap: var(--space-sm);
		padding: 8px var(--space-md);
		border-bottom: 1px solid var(--glass-border);
		font-size: 0.78rem;
	}
	.activity-item:last-child { border-bottom: none; }
	.activity-emoji { flex-shrink: 0; }
	.activity-detail { flex: 1; color: var(--text-secondary); min-width: 0; overflow: hidden; text-overflow: ellipsis; white-space: nowrap; }
	.activity-time { font-size: 0.65rem; color: var(--text-tertiary); white-space: nowrap; }

	@media (max-width: 1024px) {
		.metrics-grid { grid-template-columns: repeat(4, 1fr); }
	}
	@media (max-width: 768px) {
		.metrics-grid { grid-template-columns: repeat(2, 1fr); }
	}

	/* ─── 4-Week Trend Chart ──────────────────────────────────── */
	.trend-chart {
		display: flex; gap: 4px; align-items: flex-end; height: 80px; padding-top: var(--space-sm);
	}
	.trend-col {
		flex: 1; display: flex; flex-direction: column; align-items: center; gap: 2px;
	}
	.trend-bar-track {
		width: 100%; height: 50px; display: flex; align-items: flex-end;
		background: var(--glass-bg); border-radius: 3px 3px 0 0; overflow: hidden;
	}
	.trend-bar-fill {
		width: 100%; border-radius: 3px 3px 0 0; min-height: 2px;
		background: linear-gradient(180deg, var(--accent-indigo), var(--accent-purple));
		transition: height 0.6s cubic-bezier(0.4, 0, 0.2, 1);
	}
	.trend-count { font-size: 0.7rem; font-weight: 800; color: var(--text-primary); }
	.trend-label { font-size: 0.55rem; color: var(--text-tertiary); font-weight: 600; white-space: nowrap; }

	/* ─── Category Distribution ──────────────────────────────── */
	.cat-dist-bar {
		display: flex; height: 8px; border-radius: 4px; overflow: hidden; gap: 1px; margin-bottom: var(--space-sm);
	}
	.cat-dist-seg { transition: flex 0.5s cubic-bezier(0.4, 0, 0.2, 1); min-width: 4px; }
	.cat-dist-legend { display: flex; flex-direction: column; gap: 4px; }
	.cat-dist-item {
		display: flex; align-items: center; gap: 6px; font-size: 0.65rem; font-weight: 500;
	}
	.cat-dist-dot { width: 8px; height: 8px; border-radius: 3px; flex-shrink: 0; }
	.cat-dist-name { color: var(--text-secondary); flex: 1; white-space: nowrap; overflow: hidden; text-overflow: ellipsis; }
	.cat-dist-count { font-weight: 700; color: var(--text-primary); min-width: 20px; text-align: right; }

	/* ─── Task Aging ─────────────────────────────────────────── */
	.aging-grid {
		display: flex; gap: 4px; align-items: flex-end; padding-top: var(--space-sm);
	}
	.aging-cell {
		flex: 1; display: flex; flex-direction: column; align-items: center; gap: 2px;
	}
	.aging-cell.aging-empty { opacity: 0.35; }
	.aging-bar-wrap {
		width: 100%; height: 40px; display: flex; align-items: flex-end;
		background: var(--glass-bg); border-radius: 3px 3px 0 0; overflow: hidden;
	}
	.aging-bar {
		width: 100%; min-height: 2px; border-radius: 3px 3px 0 0;
		transition: height 0.6s cubic-bezier(0.4, 0, 0.2, 1);
	}
	.aging-count { font-size: 0.72rem; font-weight: 800; }
	.aging-label { font-size: 0.55rem; color: var(--text-tertiary); font-weight: 600; }

	/* ─── Team Leaderboard ───────────────────────────────────── */
	.leaderboard-list { display: flex; flex-direction: column; gap: 8px; }
	.leader-row {
		display: flex; align-items: center; gap: 6px;
		padding: 4px 0; border-bottom: 1px solid var(--glass-border);
	}
	.leader-row:last-child { border-bottom: none; }
	.leader-rank { font-size: 0.8rem; min-width: 20px; text-align: center; }
	.leader-emoji { font-size: 0.9rem; flex-shrink: 0; }
	.leader-info { flex: 1; min-width: 0; display: flex; flex-direction: column; gap: 2px; }
	.leader-name { font-size: 0.72rem; font-weight: 600; color: var(--text-primary); white-space: nowrap; overflow: hidden; text-overflow: ellipsis; }
	.leader-bar-wrap { width: 100%; }
	.leader-bar-track { height: 4px; background: var(--glass-bg); border-radius: 2px; overflow: hidden; }
	.leader-bar-done { height: 100%; background: linear-gradient(90deg, var(--accent-emerald), var(--priority-low)); border-radius: 2px; transition: width 0.5s ease; }
	.leader-stats { display: flex; gap: 4px; flex-shrink: 0; }
	.leader-done { font-size: 0.6rem; font-weight: 700; color: var(--accent-emerald); }
	.leader-active { font-size: 0.6rem; font-weight: 700; color: var(--accent-amber); }

	/* ─── Upcoming Deadlines ─────────────────────────────────── */
	.deadlines-list { display: flex; flex-direction: column; gap: 6px; }
	.deadline-item {
		display: flex; align-items: center; gap: 8px; padding: 6px 8px;
		border-radius: var(--radius-sm); background: var(--glass-bg);
		border: 1px solid transparent; transition: all var(--duration-fast) var(--ease-out);
	}
	.deadline-item:hover { background: var(--bg-base); }
	.deadline-urgent {
		border-color: rgba(239, 68, 68, 0.3) !important;
		background: rgba(239, 68, 68, 0.06) !important;
	}
	.deadline-soon {
		border-color: rgba(245, 158, 11, 0.25) !important;
		background: rgba(245, 158, 11, 0.04) !important;
	}
	.deadline-priority { font-size: 0.7rem; flex-shrink: 0; }
	.deadline-info { flex: 1; min-width: 0; display: flex; flex-direction: column; }
	.deadline-title { font-size: 0.72rem; font-weight: 600; color: var(--text-primary); white-space: nowrap; overflow: hidden; text-overflow: ellipsis; }
	.deadline-when { font-size: 0.6rem; color: var(--text-tertiary); font-weight: 500; }
	.deadline-urgent .deadline-when { color: var(--accent-rose); font-weight: 700; }
	.deadline-soon .deadline-when { color: var(--accent-amber); }
	.deadline-date { font-size: 0.6rem; color: var(--text-secondary); font-weight: 600; flex-shrink: 0; }

	/* ─── Quick Stats ────────────────────────────────────────── */
	.quick-stats { padding: var(--space-md); }
	.qs-row {
		display: flex; justify-content: space-between; align-items: center;
		padding: 4px 0; border-bottom: 1px solid var(--glass-border);
	}
	.qs-row:last-child { border-bottom: none; }
	.qs-label { font-size: 0.68rem; font-weight: 600; color: var(--text-tertiary); text-transform: uppercase; letter-spacing: 0.03em; }
	.qs-value { font-size: 0.78rem; font-weight: 800; color: var(--text-primary); }
	.qs-value.qs-warn { color: var(--accent-rose); }
</style>
