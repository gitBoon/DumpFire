<!--
  CategoryModal.svelte — Modal for managing board categories.

  Displays existing categories with delete buttons, and provides
  an inline form to add new categories with a name and colour.
-->
<script lang="ts">
  import type { CategoryType } from '$lib/types';
  import { COLUMN_COLORS } from '$lib/utils/constants';

  /**
   * @prop categories — Current board categories
   * @prop onAdd — Callback to add a new category
   * @prop onDeleteCategory — Callback to delete a category by ID
   * @prop onClose — Callback to close the modal
   */
  let {
    categories,
    onAdd,
    onDeleteCategory,
    onClose
  }: {
    categories: CategoryType[];
    onAdd: (data: { name: string; color: string }) => void;
    onDeleteCategory: (id: number) => void;
    onClose: () => void;
  } = $props();

  let newName = $state('');
  let newColor = $state('#6366f1');

  /** Validates and submits a new category. */
  function addCategory() {
    if (!newName.trim()) return;
    onAdd({ name: newName.trim(), color: newColor });
    newName = '';
    newColor = '#6366f1';
  }
</script>

<!-- svelte-ignore a11y_click_events_have_key_events -->
<div class="modal-overlay" onclick={onClose} role="dialog" aria-modal="true">
  <!-- svelte-ignore a11y_click_events_have_key_events -->
  <div class="modal-content" onclick={(e) => e.stopPropagation()} role="document">
    <h2>Manage Categories</h2>
    <p class="modal-subtitle">Categories help organise your cards across the board.</p>
    <!-- Existing categories -->
    <div class="category-list">
      {#each categories as cat (cat.id)}
        <span class="category-chip" style="background: {cat.color}15; color: {cat.color}; border: 1px solid {cat.color}35">
          {cat.name}
          <button class="chip-delete" onclick={() => onDeleteCategory(cat.id)} title="Delete" style="color: {cat.color}">
            <svg width="10" height="10" viewBox="0 0 10 10" fill="none"><path d="M2 2l6 6M8 2L2 8" stroke="currentColor" stroke-width="1.5" stroke-linecap="round"/></svg>
          </button>
        </span>
      {:else}
        <p class="empty-cats">No categories yet. Add one below.</p>
      {/each}
    </div>
    <!-- Add new category -->
    <div class="add-category-row">
      <input type="text" placeholder="Category name..." bind:value={newName} onkeydown={(e) => e.key === 'Enter' && addCategory()} />
      <div class="color-row compact">
        {#each COLUMN_COLORS.slice(0, 8) as color}
          <button class="color-swatch small" class:active={newColor === color} style="background: {color}" onclick={() => (newColor = color)}></button>
        {/each}
        <label class="color-custom-wrapper">
          <input type="color" bind:value={newColor} class="color-native-input" />
          <span class="color-swatch small custom" style="background: {newColor}">✎</span>
        </label>
      </div>
      <button class="btn-primary small" onclick={addCategory} disabled={!newName.trim()}>Add</button>
    </div>
    <div class="modal-actions">
      <div style="flex: 1"></div>
      <button class="btn-ghost" onclick={onClose}>Done</button>
    </div>
  </div>
</div>

<style>
  .modal-subtitle { font-size: 0.85rem; color: var(--text-secondary); margin-top: var(--space-sm); }
  .category-list {
    margin-top: var(--space-lg); display: flex; flex-wrap: wrap;
    gap: var(--space-sm); max-height: 200px; overflow-y: auto;
    padding: var(--space-sm); background: var(--bg-base);
    border: 1px solid var(--glass-border); border-radius: var(--radius-md);
  }
  .category-chip {
    display: inline-flex; align-items: center; gap: 6px;
    padding: 4px 10px; border-radius: var(--radius-full);
    font-size: 0.75rem; font-weight: 600; white-space: nowrap;
    transition: all var(--duration-fast) var(--ease-out);
  }
  .category-chip:hover { filter: brightness(1.1); }
  .chip-delete {
    display: flex; align-items: center; background: none; border: none;
    cursor: pointer; padding: 0; opacity: 0.4; transition: opacity var(--duration-fast) var(--ease-out);
  }
  .chip-delete:hover { opacity: 1; }
  .empty-cats { font-size: 0.85rem; color: var(--text-tertiary); text-align: center; padding: var(--space-lg); width: 100%; }
  .add-category-row { margin-top: var(--space-lg); padding-top: var(--space-lg); border-top: 1px solid var(--glass-border); display: flex; flex-direction: column; gap: var(--space-sm); }
  .add-category-row .btn-primary.small { padding: var(--space-sm) var(--space-lg); font-size: 0.8rem; align-self: flex-start; }
  .color-row { display: flex; flex-wrap: wrap; gap: 6px; }
  .color-row.compact { margin-top: var(--space-sm); }
  .color-swatch { width: 24px; height: 24px; border-radius: var(--radius-sm); border: 2px solid transparent; cursor: pointer; transition: all var(--duration-fast) var(--ease-out); }
  .color-swatch:hover { transform: scale(1.15); }
  .color-swatch.active { border-color: var(--text-primary); box-shadow: 0 0 8px rgba(255, 255, 255, 0.2); }
  .color-swatch.small { width: 20px; height: 20px; }
  .color-custom-wrapper { position: relative; cursor: pointer; display: inline-flex; }
  .color-native-input { position: absolute; width: 0; height: 0; opacity: 0; pointer-events: none; }
  .color-swatch.custom {
    display: flex; align-items: center; justify-content: center;
    font-size: 0.6rem; color: white; text-shadow: 0 1px 2px rgba(0,0,0,0.5); cursor: pointer;
  }
  .modal-actions { display: flex; justify-content: flex-end; gap: var(--space-md); margin-top: var(--space-2xl); }
</style>
