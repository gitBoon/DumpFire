<!--
  CategoryModal.svelte — Modal for managing board categories.

  Displays existing categories with delete buttons, and provides
  an inline form to add new categories with a name and colour. The name box
  takes the focus as the window opens, Escape closes it, Tab stays inside
  it, and the focus goes back to what had it (`holdFocus`, card 2473).
-->
<script lang="ts">
  import type { CategoryType } from '$lib/types';
  import { COLUMN_COLORS } from '$lib/utils/constants';
  import { drawnColour } from '$lib/colours';
  import { holdFocus } from '$lib/dialog-focus';
  import ColourSwatches from '$lib/components/ColourSwatches.svelte';

  /**
   * @prop categories — Current board categories
   * @prop onAdd — Callback to add a new category; resolves to whether it was added
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
    onAdd: (data: { name: string; color: string }) => Promise<boolean>;
    onDeleteCategory: (id: number) => void;
    onClose: () => void;
  } = $props();

  let newName = $state('');
  let newColor = $state('#6366f1');
  /** An add is out: Add and Enter send no second one (the B2b re-check). */
  let adding = $state(false);

  /**
   * Validates and submits a new category, one at a time. The name typed is
   * cleared only once the page says it was added, and only while the box
   * still holds the name sent: a refusal keeps it, to change and try again,
   * and a name typed meanwhile is kept (card 2280, the B2b review and
   * re-check).
   */
  async function addCategory() {
    const name = newName.trim();
    if (!name || adding) return;
    adding = true;
    try {
      const added = await onAdd({ name, color: newColor });
      if (!added || newName.trim() !== name) return;
      newName = '';
      newColor = '#6366f1';
    } finally {
      adding = false;
    }
  }
</script>

<!-- svelte-ignore a11y_click_events_have_key_events -->
<div class="modal-overlay" role="dialog" aria-modal="true" aria-labelledby="category-heading">
  <!-- svelte-ignore a11y_click_events_have_key_events -->
  <div class="modal-content" onclick={(e) => e.stopPropagation()} role="document" use:holdFocus={{ first: '#category-name', onEscape: onClose }}>
    <h2 id="category-heading">Manage Categories</h2>
    <p class="modal-subtitle">Categories help organise your cards across the board.</p>
    <!-- Existing categories -->
    <div class="category-list">
      {#each categories as cat (cat.id)}
        <span class="category-chip" style="background: {drawnColour(cat.color)}15; color: {drawnColour(cat.color)}; border: 1px solid {drawnColour(cat.color)}35">
          {cat.name}
          <button type="button" class="chip-delete" onclick={() => onDeleteCategory(cat.id)} title="Delete" aria-label="Delete category {cat.name}" style="color: {drawnColour(cat.color)}">
            <svg width="10" height="10" viewBox="0 0 10 10" fill="none"><path d="M2 2l6 6M8 2L2 8" stroke="currentColor" stroke-width="1.5" stroke-linecap="round"/></svg>
          </button>
        </span>
      {:else}
        <p class="empty-cats">No categories yet. Add one below.</p>
      {/each}
    </div>
    <!-- Add new category -->
    <div class="add-category-row">
      <input id="category-name" type="text" placeholder="Category name..." bind:value={newName} onkeydown={(e) => e.key === 'Enter' && addCategory()} />
      <!-- Named swatches, and the browser's own picker laid over the ✎ swatch (card 2473's follow-up, now shared: card 2546). -->
      <div class="swatches">
        <ColourSwatches colours={COLUMN_COLORS.slice(0, 8)} bind:value={newColor} size="small" label="Category colour" />
      </div>
      <button class="btn-primary small" onclick={addCategory} disabled={!newName.trim() || adding}>Add</button>
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
  .swatches { margin-top: var(--space-sm); }
  .modal-actions { display: flex; justify-content: flex-end; gap: var(--space-md); margin-top: var(--space-2xl); }
</style>
