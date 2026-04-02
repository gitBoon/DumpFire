<!--
  BulkActionBar.svelte — Floating action bar for bulk card operations.

  Appears at the bottom of the screen when cards are selected in
  selection mode. Provides move-to-column, priority change, and delete actions.
-->
<script lang="ts">
  import type { ColumnType } from '$lib/types';

  /**
   * @prop selectedCount — Number of currently selected cards
   * @prop columns — Board columns (for "move to" buttons)
   * @prop onMove — Callback to move selected cards to a column
   * @prop onPriority — Callback to set priority on selected cards
   * @prop onDelete — Callback to delete selected cards
   * @prop onClear — Callback to clear selection and exit selection mode
   */
  let {
    selectedCount,
    columns,
    onMove,
    onPriority,
    onDelete,
    onClear
  }: {
    selectedCount: number;
    columns: ColumnType[];
    onMove: (columnId: number) => void;
    onPriority: (priority: string) => void;
    onDelete: () => void;
    onClear: () => void;
  } = $props();
</script>

<div class="bulk-bar glass">
  <span class="bulk-count">{selectedCount} selected</span>
  <div class="bulk-actions">
    <!-- Move to column -->
    <div class="bulk-group">
      <span class="bulk-label">Move to:</span>
      {#each columns as col}
        <button class="btn-ghost bulk-btn" onclick={() => onMove(col.id)}>{col.title}</button>
      {/each}
    </div>
    <div class="bulk-divider"></div>
    <!-- Set priority -->
    <div class="bulk-group">
      <span class="bulk-label">Priority:</span>
      <button class="btn-ghost bulk-btn" onclick={() => onPriority('critical')}>🔴</button>
      <button class="btn-ghost bulk-btn" onclick={() => onPriority('high')}>🟠</button>
      <button class="btn-ghost bulk-btn" onclick={() => onPriority('medium')}>🟡</button>
      <button class="btn-ghost bulk-btn" onclick={() => onPriority('low')}>🟢</button>
    </div>
    <div class="bulk-divider"></div>
    <!-- Delete selected -->
    <button class="btn-ghost bulk-btn bulk-danger" onclick={onDelete}>🗑️ Delete</button>
  </div>
  <button class="btn-ghost" onclick={onClear}>✕</button>
</div>

<style>
  .bulk-bar {
    position: fixed; bottom: 24px; left: 50%; transform: translateX(-50%);
    display: flex; align-items: center; gap: var(--space-md);
    padding: var(--space-sm) var(--space-lg);
    border-radius: var(--radius-lg);
    border: 1px solid var(--glass-border);
    background: var(--bg-base) !important;
    box-shadow: 0 8px 32px rgba(0,0,0,0.3);
    z-index: 80;
    animation: bulkSlide 0.2s ease-out;
  }
  @keyframes bulkSlide { from { transform: translateX(-50%) translateY(20px); opacity: 0; } to { transform: translateX(-50%) translateY(0); opacity: 1; } }
  .bulk-count { font-weight: 700; font-size: 0.85rem; white-space: nowrap; }
  .bulk-actions { display: flex; align-items: center; gap: var(--space-xs); }
  .bulk-group { display: flex; align-items: center; gap: 2px; }
  .bulk-label { font-size: 0.68rem; font-weight: 600; color: var(--text-tertiary); margin-right: 4px; white-space: nowrap; }
  .bulk-btn { font-size: 0.72rem !important; padding: 3px 8px !important; }
  .bulk-danger { color: var(--accent-rose) !important; }
  .bulk-divider { width: 1px; height: 20px; background: var(--glass-border); margin: 0 4px; }
</style>
