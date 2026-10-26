<!--
  StatsPanel.svelte — Side panel showing board statistics.

  Displays total/completed/overdue card counts, average card age,
  per-column distribution bars, per-category distribution bars,
  and cycle time / lead time metrics.

  Milestone 22 (card 2462): the figures at the top are `boardStats`'s, which
  count committed work only; a board's options are one line of their own,
  "Options N · discard rate X%". The delivery metrics name lead time "Lead
  time (commitment to done)", put "Committed (all)" beside throughput, and
  show the upstream figures on a board with an upstream column, or where
  any of them is not zero; abandoned work on any board that has some. The
  flow diagram leaves the Options band out unless the viewer turns on "Show
  upstream", which this browser remembers. An ideas board shows its ideas,
  the upstream figures and the flow diagram only.
-->
<script lang="ts">
  import { isUpstreamColumn } from '$lib/column-role';
  import type { ColumnType, CategoryType } from '$lib/types';
  import { boardStats, discardRateText, optionsLine, showsUpstream, type UpstreamFiguresShown } from '$lib/board/board-stats';
  import { onMount } from 'svelte';
  import CfdChart from './CfdChart.svelte';
  import BurndownChart from './BurndownChart.svelte';
  import type { BurndownResult } from '$lib/burndown';
  import { deliveryText, isThin, paceText, plural } from '$lib/burndown-text';
  import InfoTip from '$lib/components/InfoTip.svelte';
  import { drawnColour } from '$lib/colours';

  /**
   * @prop boardColumns — All columns on the board (for per-column stats)
   * @prop boardCategories — All categories on the board
   * @prop boardId — Board ID for fetching metrics
   * @prop boardKind — The board's kind, 'delivery' or 'ideas' (milestone 22): every column of an ideas board is upstream
   * @prop onClose — Callback to close the panel
   */
  let {
    boardColumns = [],
    boardCategories = [],
    boardId = 0,
    boardKind = 'delivery',
    onClose
  }: {
    boardColumns: ColumnType[];
    boardCategories: CategoryType[];
    boardId?: number;
    boardKind?: string | null;
    onClose: () => void;
  } = $props();

  /**
   * The figures at the top and the bars (`boardStats`, card 2462): committed
   * work only, an option in none of them. Each card's age is read as UTC
   * (card 2095), from its commitment where it has one; a card whose time
   * cannot be read is left out of the average.
   */
  const stats = $derived(boardStats(boardColumns, boardKind ?? null));

  /** Whether the board has an upstream column: its Options column, or any column of an ideas board. */
  const hasUpstreamColumn = $derived(boardColumns.some(c => isUpstreamColumn(c, boardKind ?? null)));

  // ─── Cycle/Lead Time Metrics ─────────────────────────────────────────
  type Times = { avgFormatted: string; medianFormatted: string };
  type MetricsData = {
    days: number;
    completed: number;
    leadTime: Times | null;
    cycleTime: Times | null;
    /** "Committed (all)": cards that arrived as committed work in the window (milestone 22). */
    committed?: number;
    /** How long the cards committed from options in the window waited there. */
    timeInOptions?: Times | null;
    upstream?: UpstreamFiguresShown;
  };

  let metrics = $state<MetricsData | null>(null);
  let metricsLoading = $state(false);
  let metricsDays = $state(30);
  /**
   * Whether the last read of the metrics failed (the S4b review's J8): the
   * panel says so, with a retry, where it said "No completed cards in this
   * period", which was not true.
   */
  let metricsFailed = $state(false);

  async function loadMetrics() {
    if (!boardId) return;
    metricsLoading = true;
    metricsFailed = false;
    try {
      const res = await fetch(`/api/boards/${boardId}/metrics?days=${metricsDays}`);
      if (res.ok) metrics = await res.json();
      else {
        metrics = null;
        metricsFailed = true;
      }
    } catch {
      metrics = null;
      metricsFailed = true;
    } finally { metricsLoading = false; }
  }

  /**
   * An ideas board (milestone 22, the S4b review's J2): every card is an idea,
   * so the panel shows how many, the upstream figures and the flow diagram,
   * and none of the delivery tiles, bars, metrics or burndown, which would
   * all read nothing. The kind is the one the page hands it: the board page's
   * and All Tasks' loads both carry it (card 2463), so the panel no longer
   * takes it from the flow diagram's answer.
   */
  const isIdeas = $derived(boardKind === 'ideas');

  /** The board's options line, the discard rate once the metrics have come; null with no option. */
  const optionsText = $derived(optionsLine(stats.optionsCount, metrics?.upstream));
  /** The upstream figures, on a board with an upstream column or where any is not zero. */
  const upstreamShown = $derived(metrics?.upstream ? showsUpstream(hasUpstreamColumn, metrics.upstream, metrics.timeInOptions ?? null) : false);

  // ─── CFD Chart Data ──────────────────────────────────────────────────
  type CfdColumn = { id: number; title: string; color: string; upstream?: boolean };
  type CfdDataPoint = { date: string; columns: { columnId: number; count: number }[] };

  let cfdColumns = $state<CfdColumn[]>([]);
  let cfdData = $state<CfdDataPoint[]>([]);
  let cfdLoading = $state(false);
  /** Whether a chart has been drawn yet: until then "Loading chart...", after it the old chart stays while the next loads. */
  let cfdLoaded = $state(false);
  /**
   * Which read of the flow diagram is the latest (the S4b review's J1). The
   * toggle sends a read each time it is turned; an answer to an earlier one
   * that arrives later is not drawn, so the chart always matches the box.
   */
  let cfdRequest = 0;
  /**
   * Whether the answer's board is a delivery board with an upstream column
   * to show (its `kind` and `hasUpstream`): the toggle's. An ideas board
   * draws every column of its own, with no toggle.
   */
  let offersUpstream = $state(false);

  /**
   * "Show upstream" (milestone 22, ruling h): off by default, and each
   * viewer's choice is kept in this browser for every board. Storage can
   * throw (a private window, blocked site data), and then the choice is not
   * kept and the chart starts without the band.
   */
  const SHOW_UPSTREAM_KEY = 'df-cfd-show-upstream';
  let showUpstream = $state(false);
  try {
    showUpstream = localStorage.getItem(SHOW_UPSTREAM_KEY) === 'true';
  } catch {
    showUpstream = false;
  }

  async function loadCfd() {
    if (!boardId) return;
    const asked = ++cfdRequest;
    cfdLoading = true;
    try {
      // Asked for only where there is an upstream column to draw: a board with
      // none asks as it always has.
      const upstream = showUpstream && boardKind !== 'ideas' && hasUpstreamColumn ? '&upstream=true' : '';
      const res = await fetch(`/api/boards/${boardId}/cfd?days=30${upstream}`);
      if (asked !== cfdRequest) return;
      if (res.ok) {
        const json = await res.json();
        if (asked !== cfdRequest) return;
        cfdColumns = json.columns || [];
        cfdData = json.data || [];
        offersUpstream = json.hasUpstream === true && json.kind !== 'ideas';
        cfdLoaded = true;
      }
    } finally {
      if (asked === cfdRequest) cfdLoading = false;
    }
  }

  function toggleUpstream() {
    showUpstream = !showUpstream;
    try {
      localStorage.setItem(SHOW_UPSTREAM_KEY, String(showUpstream));
    } catch {
      // Not kept; the chart works the same.
    }
    loadCfd();
  }

  // ─── Burndown Data ──────────────────────────────────────────────────────
  let burndown = $state<BurndownResult | null>(null);
  let burndownLoading = $state(false);
  /** Card category to narrow the burndown to; '' = all, 'none' = uncategorised. */
  let burndownCategory = $state('');

  async function loadBurndown() {
    if (!boardId) return;
    burndownLoading = true;
    try {
      // options=true brings back the categories actually used on this board,
      // with counts — the panel's own list is every category in the workspace.
      const cat = burndownCategory ? `&categoryIds=${burndownCategory}` : '';
      const res = await fetch(`/api/burndown?boardIds=${boardId}&days=30&options=true${cat}`);
      if (res.ok) burndown = await res.json();
    } finally { burndownLoading = false; }
  }

  const burndownHref = $derived(
    `/burndown?boardIds=${boardId}${burndownCategory ? `&categoryIds=${burndownCategory}` : ''}`
  );

  /** How long the open work would take, in a few words, under the chart. */
  const burndownEta = $derived(burndown ? deliveryText(burndown.delivery) : null);
  const burndownPace = $derived(burndown ? paceText(burndown.forecast) : null);
  const burndownEtaShort = $derived.by(() => {
    switch (burndown?.delivery.status) {
      case 'done': return 'All done';
      case 'estimated': return `Done in ${burndownEta?.value}`;
      case 'no-pace': return 'No recent pace to go on';
      case 'beyond-horizon': return 'Over two years to go';
      default: return 'Too early to forecast';
    }
  });

  // An ideas board has no burndown to read (J2).
  onMount(() => { loadMetrics(); loadCfd(); if (!isIdeas) loadBurndown(); });
</script>

<aside class="side-panel">
  <div class="panel-header">
    <h3>📊 Board Stats</h3>
    <button class="btn-ghost close-btn" onclick={onClose}>✕</button>
  </div>
  <div class="panel-body">
    {#if isIdeas}
      <!-- An ideas board: its ideas, and no delivery tiles or bars (J2). -->
      <div class="ideas-count" title="Every card on an ideas board is an idea, not committed to.">{stats.optionsCount} idea{stats.optionsCount !== 1 ? 's' : ''}</div>
    {:else}
    <!-- Summary cards -->
    <div class="stats-grid">
      <div class="stat-card">
        <span class="stat-value">{stats.totalCards}</span>
        <span class="stat-label">Total Cards</span>
      </div>
      <div class="stat-card">
        <span class="stat-value">{stats.completedCards}</span>
        <span class="stat-label">Completed</span>
      </div>
      <div class="stat-card">
        <span class="stat-value">{stats.overdueCards}</span>
        <span class="stat-label">Overdue</span>
      </div>
      <div class="stat-card">
        <span class="stat-value">{stats.avgAge}</span>
        <span class="stat-label">Avg Age</span>
      </div>
    </div>

    <!-- The board's options, counted apart from its committed work (milestone 22). -->
    {#if optionsText}
      <div class="options-line" title="Options are ideas not yet committed to. They are in none of the figures above.">{optionsText}</div>
    {/if}

    <!-- Per-column distribution -->
    <h4 class="stats-section-title">Cards per Column</h4>
    <div class="stats-bars">
      {#each stats.columns as col}
        {@const pct = stats.totalCards > 0 ? (col.count / stats.totalCards) * 100 : 0}
        <div class="stats-bar-row">
          <span class="stats-bar-label">{col.title}</span>
          <div class="stats-bar-track">
            <div class="stats-bar-fill" style="width: {pct}%; background: {drawnColour(col.color)}"></div>
          </div>
          <span class="stats-bar-count">{col.count}</span>
        </div>
      {/each}
    </div>

    <!-- Per-category distribution (if categories exist) -->
    {#if boardCategories.length > 0}
      <h4 class="stats-section-title">By Category</h4>
      <div class="stats-bars">
        {#each boardCategories as cat}
          {@const count = stats.byCategory.get(cat.id) ?? 0}
          {@const pct = stats.totalCards > 0 ? (count / stats.totalCards) * 100 : 0}
          <div class="stats-bar-row">
            <span class="stats-bar-label" style="color: {drawnColour(cat.color)}">{cat.name}</span>
            <div class="stats-bar-track">
              <div class="stats-bar-fill" style="width: {pct}%; background: {drawnColour(cat.color)}"></div>
            </div>
            <span class="stats-bar-count">{count}</span>
          </div>
        {/each}
      </div>
    {/if}
    {/if}

    <!-- Cycle / Lead Time Metrics -->
    <h4 class="stats-section-title">
      {isIdeas ? 'Idea Metrics' : 'Delivery Metrics'}
      <select class="metrics-period-select" bind:value={metricsDays} onchange={() => loadMetrics()}>
        <option value={7}>7 days</option>
        <option value={14}>14 days</option>
        <option value={30}>30 days</option>
        <option value={90}>90 days</option>
      </select>
    </h4>
    {#if !boardId}
      <!-- All Tasks with no board chosen: the metrics are a board's (J8). -->
      <div class="metrics-loading">Choose a board to see its delivery metrics</div>
    {:else if metricsLoading}
      <div class="metrics-loading">Loading metrics...</div>
    {:else if metrics}
      {#if !isIdeas}
      <!-- Lead time runs from the commitment (milestone 22, ruling e). -->
      <div class="metric-head">
        <InfoTip title="Lead time (commitment to done)" width={280}>
          Lead time (commitment to done)
          {#snippet tip()}
            <p>From when a card was committed to, leaving the Options column or created straight into a committed column (any column after Options), to when it reached Complete.</p>
            <p class="muted">Complete is the delivery point, so customer lead time and system lead time are the same here.</p>
          {/snippet}
        </InfoTip>
      </div>
      <div class="stats-grid stats-grid-tight">
        <div class="stat-card">
          <span class="stat-value stat-value-sm">{metrics.leadTime?.avgFormatted ?? '—'}</span>
          <span class="stat-label">Avg Lead Time</span>
        </div>
        <div class="stat-card">
          <span class="stat-value stat-value-sm">{metrics.leadTime?.medianFormatted ?? '—'}</span>
          <span class="stat-label">Median Lead</span>
        </div>
      </div>
      <div class="metric-head">
        <InfoTip title="Cycle time" width={280}>
          Cycle time: time from start of work to done
          {#snippet tip()}
            <p>From when work started, the first move after the card was committed to or a commitment straight into a working column, to when it reached Complete. It is never longer than the lead time.</p>
            <p class="muted">A card created straight into a working column has no recorded start, so it has no cycle time.</p>
          {/snippet}
        </InfoTip>
      </div>
      <div class="stats-grid stats-grid-tight">
        <div class="stat-card">
          <span class="stat-value stat-value-sm">{metrics.cycleTime?.avgFormatted ?? '—'}</span>
          <span class="stat-label">Avg Cycle Time</span>
        </div>
        <div class="stat-card">
          <span class="stat-value stat-value-sm">{metrics.cycleTime?.medianFormatted ?? '—'}</span>
          <span class="stat-label">Median Cycle</span>
        </div>
      </div>
      <!-- What arrived beside what was finished (ruling d). -->
      <div class="stats-grid stats-grid-tight">
        <div class="stat-card">
          <span class="stat-value stat-value-sm">{metrics.completed}</span>
          <span class="stat-label">Throughput</span>
        </div>
        <div class="stat-card">
          <span class="stat-value stat-value-sm">{metrics.committed ?? '—'}</span>
          <span class="stat-label">
            <InfoTip title="Committed (all)" width={260}>
              Committed (all)
              {#snippet tip()}
                <p>The cards that arrived as committed work in the period: committed out of the Options column, or created straight into a committed column (any column after Options).</p>
              {/snippet}
            </InfoTip>
          </span>
        </div>
      </div>
      {#if metrics.upstream && metrics.upstream.abandoned > 0}
        <div class="abandoned-line">
          <InfoTip title="Abandoned" width={260}>
            Abandoned: {metrics.upstream.abandoned}
            {#snippet tip()}
              <p>committed work archived before Complete</p>
            {/snippet}
          </InfoTip>
        </div>
      {/if}
      <div class="metrics-footnote">
        Based on {metrics.completed} card{metrics.completed !== 1 ? 's' : ''} completed in the last {metrics.days} days
      </div>
      {/if}

      <!-- Before the commitment point (milestone 22): on a board with an upstream column, or where any figure is not zero. -->
      {#if upstreamShown && metrics.upstream}
        {@const up = metrics.upstream}
        <h4 class="stats-section-title upstream-title">
          <InfoTip title="Upstream" width={280}>
            Upstream
            {#snippet tip()}
              <p>What happened before the commitment point, in the Options column, over the same period. Options are in none of the figures above.</p>
              <p class="muted">Options now and their ages are as they stand today, whatever the period.</p>
            {/snippet}
          </InfoTip>
        </h4>
        <dl class="upstream-figures">
          <div><dt>Committed from options</dt><dd>{up.committedFromOptions}</dd></div>
          <div><dt>Options now</dt><dd>{up.options}</dd></div>
          <div><dt>Returned to options</dt><dd>{up.returnedToOptions}</dd></div>
          <div><dt>Discarded</dt><dd>{up.discarded}</dd></div>
          <div><dt>Sent to other boards</dt><dd>{up.sentOn}</dd></div>
          <div><dt>Discard rate</dt><dd>{discardRateText(up.discardRate)}</dd></div>
          <div><dt>Oldest option (days)</dt><dd>{up.oldestOptionDays ?? '—'}</dd></div>
          <div><dt>Options over 30 days</dt><dd>{up.agingOptions}</dd></div>
          <div><dt>Time in options</dt><dd>{#if metrics.timeInOptions}{metrics.timeInOptions.avgFormatted} avg · {metrics.timeInOptions.medianFormatted} median{:else}—{/if}</dd></div>
        </dl>
      {/if}
    {:else if metricsFailed}
      <!-- The read failed (J8): said so, with a retry. -->
      <div class="metrics-loading metrics-failed">
        Metrics could not be loaded
        <button class="btn-ghost metrics-retry" onclick={() => loadMetrics()}>Retry</button>
      </div>
    {/if}

    <!-- Cumulative Flow Diagram -->
    <h4 class="stats-section-title">
      Flow Diagram (30 days)
      {#if offersUpstream}
        <InfoTip title="Show upstream" width={280} prefer="top" focusable={false} dotted={false}>
          <label class="upstream-toggle">
            <input type="checkbox" checked={showUpstream} onchange={toggleUpstream} />
            Show upstream
          </label>
          {#snippet tip()}
            <p>Draws the Options band at the bottom of the chart. Its top edge is the commitment point: what is above it is committed work.</p>
            <p class="muted">A column converted to Options during the period is left out with its band, so in this view the committed history it had before the conversion is hidden too. Turn Show upstream on to see it.</p>
          {/snippet}
        </InfoTip>
      {/if}
    </h4>
    <!-- The chart drawn stays while the next read loads (J1). -->
    {#if cfdLoading && !cfdLoaded}
      <div class="metrics-loading">Loading chart...</div>
    {:else}
      <CfdChart columns={cfdColumns} data={cfdData} />
    {/if}

    {#if !isIdeas}
    <!-- Burndown Chart: committed work, so none on an ideas board (J2). -->
    <h4 class="stats-section-title">
      <InfoTip title="Burndown" width={280}>
        Burndown (30 days)
        {#snippet tip()}
          <p>The blue line is how many of this board's committed cards were open at the end of each day. The orange line is what was open 30 days ago plus everything committed since, so the gap between them is what got finished.</p>
          <p class="muted">Pick a category to chart just that part of the board.</p>
        {/snippet}
      </InfoTip>
      {#if burndown?.options && (burndown.options.categories.length > 1 || burndownCategory)}
        <select class="metrics-period-select" bind:value={burndownCategory} onchange={() => loadBurndown()} aria-label="Burndown category">
          <option value="">All categories</option>
          {#each burndown.options.categories as c (c.id)}
            <option value={String(c.id)}>{c.name}</option>
          {/each}
        </select>
      {/if}
    </h4>
    {#if burndownLoading && !burndown}
      <div class="metrics-loading">Loading chart...</div>
    {:else if burndown}
      <BurndownChart
        compact
        series={burndown.series}
        forecast={burndown.forecast}
        target={burndown.target}
        loading={burndownLoading}
        label="Burndown for {burndown.scope.label}"
        --bd-surface="var(--bg-surface)"
      />
      <div class="burndown-foot">
        {#if burndownEta && burndownPace}
          <InfoTip title="Time to deliver" width={280} prefer="top">
            {burndownEtaShort}
            {#snippet tip()}
              <p>How long the <strong>{burndown?.delivery.remaining}</strong> cards open now would take to finish if nothing new were added: {burndownEta.sub.charAt(0).toLowerCase() + burndownEta.sub.slice(1)}.</p>
              <p>Worked out by replaying the board's real daily completions from the last {burndown?.delivery.basisDays} days thousands of times in random order.</p>
              {#if burndown && burndown.delivery.status === 'estimated' && isThin(burndown.delivery.basisFinished)}
                <p class="muted">This rests on only {plural(burndown.delivery.basisFinished, 'finished card')}, so treat it as a rough guide.</p>
              {/if}
              <p class="muted">At this pace: {burndownPace.value.toLowerCase()} — {burndownPace.sub.charAt(0).toLowerCase() + burndownPace.sub.slice(1)}.</p>
            {/snippet}
          </InfoTip>
        {/if}
        <a href={burndownHref}>Full chart →</a>
      </div>
    {/if}
    {/if}
  </div>
</aside>

<style>
  .side-panel {
    width: 340px; height: 100vh; flex-shrink: 0;
    display: flex; flex-direction: column;
    border-left: 1px solid var(--glass-border);
    background: var(--bg-surface);
    animation: panelSlideIn 0.2s ease-out;
  }
  @keyframes panelSlideIn { from { transform: translateX(100%); } to { transform: translateX(0); } }
  .panel-header {
    display: flex; align-items: center; justify-content: space-between;
    padding: var(--space-md) var(--space-lg); border-bottom: 1px solid var(--glass-border);
  }
  .panel-header h3 { font-size: 1rem; font-weight: 700; }
  .panel-body { flex: 1; overflow-y: auto; padding: var(--space-md); }

  .stats-grid {
    display: grid; grid-template-columns: 1fr 1fr; gap: var(--space-sm);
    margin-bottom: var(--space-lg);
  }
  .stat-card {
    display: flex; flex-direction: column; align-items: center;
    padding: var(--space-md); border-radius: var(--radius-md);
    background: var(--glass-bg); border: 1px solid var(--glass-border);
  }
  .stat-value { font-size: 1.5rem; font-weight: 800; color: var(--accent-indigo); }
  .stat-label { font-size: 0.68rem; color: var(--text-tertiary); font-weight: 600; text-transform: uppercase; letter-spacing: 0.04em; }
  .stats-section-title { font-size: 0.75rem; font-weight: 700; text-transform: uppercase; letter-spacing: 0.04em; color: var(--text-secondary); margin-bottom: var(--space-sm); }
  .stats-bars { display: flex; flex-direction: column; gap: var(--space-xs); margin-bottom: var(--space-lg); }
  .stats-bar-row { display: flex; align-items: center; gap: var(--space-sm); }
  .stats-bar-label { font-size: 0.72rem; font-weight: 600; width: 80px; white-space: nowrap; overflow: hidden; text-overflow: ellipsis; flex-shrink: 0; }
  .stats-bar-track { flex: 1; height: 8px; background: var(--glass-bg); border-radius: 4px; overflow: hidden; }
  .stats-bar-fill { height: 100%; border-radius: 4px; transition: width 0.3s ease-out; min-width: 2px; }
  .stats-bar-count { font-size: 0.68rem; font-weight: 700; color: var(--text-secondary); width: 24px; text-align: right; }

  .stat-value-sm { font-size: 1.1rem; }
  .stats-section-title { display: flex; align-items: center; justify-content: space-between; }
  .metrics-period-select {
    font-size: 0.65rem; font-weight: 600; padding: 2px 6px;
    border: 1px solid var(--glass-border); border-radius: var(--radius-sm);
    background: var(--bg-surface); color: var(--text-secondary);
    cursor: pointer; text-transform: none; letter-spacing: 0;
  }
  .metrics-loading { text-align: center; padding: var(--space-md); color: var(--text-tertiary); font-size: 0.8rem; }
  .metrics-footnote { font-size: 0.68rem; color: var(--text-tertiary); text-align: center; padding-top: var(--space-xs); }
  /* Milestone 22: the lead and cycle time headings, the options and abandoned lines, the upstream figures and the flow diagram's toggle. */
  .metric-head { font-size: 0.7rem; font-weight: 600; color: var(--text-secondary); margin-bottom: var(--space-xs); }
  .stats-grid-tight { margin-bottom: var(--space-sm); }
  .options-line, .abandoned-line { font-size: 0.72rem; font-weight: 600; color: var(--text-secondary); margin: calc(-1 * var(--space-sm)) 0 var(--space-lg); }
  .abandoned-line { margin: 0 0 var(--space-xs); text-align: center; }
  .upstream-title { margin-top: var(--space-lg); }
  .ideas-count { font-size: 1.1rem; font-weight: 800; color: var(--accent-indigo); text-align: center; margin-bottom: var(--space-lg); }
  .metrics-failed { display: flex; align-items: center; justify-content: center; gap: var(--space-sm); }
  .metrics-retry { font-size: 0.72rem; font-weight: 600; color: var(--accent-indigo); }
  .upstream-figures { display: grid; grid-template-columns: 1fr 1fr; gap: 2px var(--space-sm); margin: 0 0 var(--space-lg); }
  .upstream-figures div { display: flex; justify-content: space-between; gap: var(--space-xs); font-size: 0.7rem; }
  .upstream-figures dt { color: var(--text-tertiary); }
  .upstream-figures dd { margin: 0; font-weight: 700; color: var(--text-secondary); white-space: nowrap; }
  .upstream-toggle { display: inline-flex; align-items: center; gap: 4px; font-size: 0.65rem; font-weight: 600; text-transform: none; letter-spacing: 0; cursor: pointer; }
  .burndown-foot {
    display: flex; align-items: center; justify-content: space-between; gap: var(--space-sm);
    padding-top: var(--space-xs); font-size: 0.68rem; color: var(--text-tertiary);
  }
  .burndown-foot a { color: var(--accent-indigo); font-weight: 600; text-decoration: none; white-space: nowrap; }
  .burndown-foot a:hover { text-decoration: underline; }
</style>
