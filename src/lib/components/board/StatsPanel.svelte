<!--
  StatsPanel.svelte — Side panel showing board statistics.

  Displays total/completed/overdue card counts, average card age,
  per-column distribution bars, per-category distribution bars,
  and cycle time / lead time metrics.
-->
<script lang="ts">
  import type { ColumnType, CategoryType, CardType } from '$lib/types';
  import { getDueStatus } from '$lib/utils/date-utils';
  import { onMount } from 'svelte';
  import CfdChart from './CfdChart.svelte';
  import BurndownChart from './BurndownChart.svelte';

  /**
   * @prop boardColumns — All columns on the board (for per-column stats)
   * @prop boardCategories — All categories on the board
   * @prop boardId — Board ID for fetching metrics
   * @prop onClose — Callback to close the panel
   */
  let {
    boardColumns = [],
    boardCategories = [],
    boardId = 0,
    onClose
  }: {
    boardColumns: ColumnType[];
    boardCategories: CategoryType[];
    boardId?: number;
    onClose: () => void;
  } = $props();

  /** All cards across every column, flattened for aggregate stats. */
  const allCards = $derived(boardColumns.flatMap(c => c.cards));

  /** Total number of cards on the board. */
  const totalCards = $derived(allCards.length);

  /** Cards in columns named "Complete" or "Done". */
  const completedCards = $derived(
    boardColumns
      .filter(c => c.title.toLowerCase() === 'complete' || c.title.toLowerCase() === 'done')
      .flatMap(c => c.cards).length
  );

  /** Cards with a due date in the past. */
  const overdueCards = $derived(
    allCards.filter(c => c.dueDate && getDueStatus(c.dueDate) === 'overdue').length
  );

  /** Average age of all cards in days. Returns a formatted string like "5d". */
  const avgAge = $derived(() => {
    if (allCards.length === 0) return '0d';
    const totalDays = allCards.reduce(
      (sum, c) => sum + Math.floor((Date.now() - new Date(c.createdAt).getTime()) / 86400000), 0
    );
    return `${Math.round(totalDays / allCards.length)}d`;
  });

  // ─── Cycle/Lead Time Metrics ─────────────────────────────────────────
  type MetricsData = {
    days: number;
    completed: number;
    leadTime: { avgFormatted: string; medianFormatted: string } | null;
    cycleTime: { avgFormatted: string; medianFormatted: string } | null;
  };

  let metrics = $state<MetricsData | null>(null);
  let metricsLoading = $state(false);
  let metricsDays = $state(30);

  async function loadMetrics() {
    if (!boardId) return;
    metricsLoading = true;
    try {
      const res = await fetch(`/api/boards/${boardId}/metrics?days=${metricsDays}`);
      if (res.ok) metrics = await res.json();
    } finally { metricsLoading = false; }
  }

  // ─── CFD Chart Data ──────────────────────────────────────────────────
  type CfdColumn = { id: number; title: string; color: string };
  type CfdDataPoint = { date: string; columns: { columnId: number; count: number }[] };

  let cfdColumns = $state<CfdColumn[]>([]);
  let cfdData = $state<CfdDataPoint[]>([]);
  let cfdLoading = $state(false);

  async function loadCfd() {
    if (!boardId) return;
    cfdLoading = true;
    try {
      const res = await fetch(`/api/boards/${boardId}/cfd?days=30`);
      if (res.ok) {
        const json = await res.json();
        cfdColumns = json.columns || [];
        cfdData = json.data || [];
      }
    } finally { cfdLoading = false; }
  }

  // ─── Burndown Data ──────────────────────────────────────────────────────
  type BurndownPoint = { date: string; total: number; completed: number; remaining: number };
  let burndownData = $state<BurndownPoint[]>([]);
  let burndownLoading = $state(false);

  async function loadBurndown() {
    if (!boardId) return;
    burndownLoading = true;
    try {
      const res = await fetch(`/api/boards/${boardId}/burndown?days=30`);
      if (res.ok) {
        const json = await res.json();
        burndownData = json.data || [];
      }
    } finally { burndownLoading = false; }
  }

  onMount(() => { loadMetrics(); loadCfd(); loadBurndown(); });
</script>

<!-- svelte-ignore a11y_click_events_have_key_events -->
<!-- svelte-ignore a11y_no_static_element_interactions -->
<div class="panel-overlay" onclick={onClose}></div>
<aside class="side-panel glass">
  <div class="panel-header">
    <h3>📊 Board Stats</h3>
    <button class="btn-ghost close-btn" onclick={onClose}>✕</button>
  </div>
  <div class="panel-body">
    <!-- Summary cards -->
    <div class="stats-grid">
      <div class="stat-card">
        <span class="stat-value">{totalCards}</span>
        <span class="stat-label">Total Cards</span>
      </div>
      <div class="stat-card">
        <span class="stat-value">{completedCards}</span>
        <span class="stat-label">Completed</span>
      </div>
      <div class="stat-card">
        <span class="stat-value">{overdueCards}</span>
        <span class="stat-label">Overdue</span>
      </div>
      <div class="stat-card">
        <span class="stat-value">{avgAge()}</span>
        <span class="stat-label">Avg Age</span>
      </div>
    </div>

    <!-- Per-column distribution -->
    <h4 class="stats-section-title">Cards per Column</h4>
    <div class="stats-bars">
      {#each boardColumns as col}
        {@const pct = totalCards > 0 ? (col.cards.length / totalCards) * 100 : 0}
        <div class="stats-bar-row">
          <span class="stats-bar-label">{col.title}</span>
          <div class="stats-bar-track">
            <div class="stats-bar-fill" style="width: {pct}%; background: {col.color}"></div>
          </div>
          <span class="stats-bar-count">{col.cards.length}</span>
        </div>
      {/each}
    </div>

    <!-- Per-category distribution (if categories exist) -->
    {#if boardCategories.length > 0}
      <h4 class="stats-section-title">By Category</h4>
      <div class="stats-bars">
        {#each boardCategories as cat}
          {@const count = allCards.filter(c => c.categoryId === cat.id).length}
          {@const pct = totalCards > 0 ? (count / totalCards) * 100 : 0}
          <div class="stats-bar-row">
            <span class="stats-bar-label" style="color: {cat.color}">{cat.name}</span>
            <div class="stats-bar-track">
              <div class="stats-bar-fill" style="width: {pct}%; background: {cat.color}"></div>
            </div>
            <span class="stats-bar-count">{count}</span>
          </div>
        {/each}
      </div>
    {/if}

    <!-- Cycle / Lead Time Metrics -->
    <h4 class="stats-section-title">
      Delivery Metrics
      <select class="metrics-period-select" bind:value={metricsDays} onchange={() => loadMetrics()}>
        <option value={7}>7 days</option>
        <option value={14}>14 days</option>
        <option value={30}>30 days</option>
        <option value={90}>90 days</option>
      </select>
    </h4>
    {#if metricsLoading}
      <div class="metrics-loading">Loading metrics...</div>
    {:else if metrics}
      <div class="stats-grid" style="margin-bottom: var(--space-md);">
        <div class="stat-card">
          <span class="stat-value stat-value-sm">{metrics.leadTime?.avgFormatted ?? '—'}</span>
          <span class="stat-label">Avg Lead Time</span>
        </div>
        <div class="stat-card">
          <span class="stat-value stat-value-sm">{metrics.leadTime?.medianFormatted ?? '—'}</span>
          <span class="stat-label">Median Lead</span>
        </div>
        <div class="stat-card">
          <span class="stat-value stat-value-sm">{metrics.cycleTime?.avgFormatted ?? '—'}</span>
          <span class="stat-label">Avg Cycle Time</span>
        </div>
        <div class="stat-card">
          <span class="stat-value stat-value-sm">{metrics.cycleTime?.medianFormatted ?? '—'}</span>
          <span class="stat-label">Median Cycle</span>
        </div>
      </div>
      <div class="metrics-footnote">
        Based on {metrics.completed} card{metrics.completed !== 1 ? 's' : ''} completed in the last {metrics.days} days
      </div>
    {:else}
      <div class="metrics-loading">No completed cards in this period</div>
    {/if}

    <!-- Cumulative Flow Diagram -->
    <h4 class="stats-section-title">Flow Diagram (30 days)</h4>
    {#if cfdLoading}
      <div class="metrics-loading">Loading chart...</div>
    {:else}
      <CfdChart columns={cfdColumns} data={cfdData} />
    {/if}

    <!-- Burndown Chart -->
    <h4 class="stats-section-title">Burndown (30 days)</h4>
    {#if burndownLoading}
      <div class="metrics-loading">Loading chart...</div>
    {:else}
      <BurndownChart data={burndownData} />
    {/if}
  </div>
</aside>

<style>
  .panel-overlay {
    position: fixed; inset: 0; background: rgba(0,0,0,0.3); z-index: 90;
  }
  .side-panel {
    position: fixed; top: 0; right: 0; bottom: 0; width: 360px;
    z-index: 91; display: flex; flex-direction: column;
    border-left: 1px solid var(--glass-border);
    background: var(--bg-base) !important;
    animation: panelSlide 0.2s ease-out;
  }
  @keyframes panelSlide { from { transform: translateX(100%); } to { transform: translateX(0); } }
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
</style>
