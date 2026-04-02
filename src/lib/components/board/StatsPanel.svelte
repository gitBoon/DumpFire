<!--
  StatsPanel.svelte — Side panel showing board statistics.

  Displays total/completed/overdue card counts, average card age,
  per-column distribution bars, and per-category distribution bars.
-->
<script lang="ts">
  import type { ColumnType, CategoryType, CardType } from '$lib/types';
  import { getDueStatus } from '$lib/utils/date-utils';

  /**
   * @prop boardColumns — All columns on the board (for per-column stats)
   * @prop boardCategories — All categories on the board
   * @prop onClose — Callback to close the panel
   */
  let {
    boardColumns = [],
    boardCategories = [],
    onClose
  }: {
    boardColumns: ColumnType[];
    boardCategories: CategoryType[];
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
</style>
