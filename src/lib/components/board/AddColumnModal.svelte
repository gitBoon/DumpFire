<!--
  AddColumnModal.svelte — Modal for adding a new column to the board.

  Allows the user to set the column name, position (start, end, or after
  a specific column), and colour from a palette or custom picker.

  It adds ordinary columns only. Every delivery board has its Options column
  already, made with the board (card 2527), so on a board that has one "At
  the start" is not offered: nothing goes left of it, and "After "Options""
  is the start. The name box takes the focus as the window opens, Escape
  closes it, Tab stays inside it, and the focus goes back to what had it
  (`holdFocus`).
-->
<script lang="ts">
  import type { ColumnType } from '$lib/types';
  import { COLUMN_COLORS } from '$lib/utils/constants';
  import { drawnColour } from '$lib/colours';
  import { holdFocus } from '$lib/dialog-focus';
  import { isOptionsColumn, optionsSuffix } from '$lib/column-role';

  /**
   * @prop columns — Existing columns (for position dropdown options)
   * @prop onAdd — Callback with the new column data
   * @prop onClose — Callback to close the modal
   */
  let {
    columns,
    onAdd,
    onClose
  }: {
    columns: ColumnType[];
    onAdd: (data: { title: string; position: string; color: string }) => void;
    onClose: () => void;
  } = $props();

  let title = $state('');
  let color = $state('#6366f1');
  let position = $state('end');
  const hasOptions = $derived(columns.some(isOptionsColumn));

  /** Validates and submits the new column data. */
  function submit() {
    onAdd({ title: title.trim() || 'New Column', position, color });
  }
</script>

<!-- svelte-ignore a11y_click_events_have_key_events -->
<div class="modal-overlay" role="dialog" aria-modal="true" aria-labelledby="add-column-heading">
  <!-- svelte-ignore a11y_click_events_have_key_events -->
  <div class="modal-content" onclick={(e) => e.stopPropagation()} role="document" use:holdFocus={{ first: '#col-name', onEscape: onClose }}>
    <h2 id="add-column-heading">Add Column</h2>
    <div class="form-group">
      <label for="col-name">Column name</label>
      <input id="col-name" type="text" placeholder="e.g. Review, Testing..." bind:value={title} onkeydown={(e) => e.key === 'Enter' && submit()} />
    </div>
    <div class="form-group">
      <label for="col-position">Position</label>
      <select id="col-position" bind:value={position}>
        {#if !hasOptions}
          <option value="start">At the start</option>
        {/if}
        {#each columns as col}
          <option value="after-{col.id}">After "{col.title}"{optionsSuffix(col)}</option>
        {/each}
        <option value="end">At the end</option>
      </select>
    </div>
    <div class="form-group">
      <label>Color</label>
      <div class="color-row">
        {#each COLUMN_COLORS as c}
          <button class="color-swatch" class:active={color === c} style="background: {c}" onclick={() => (color = c)}></button>
        {/each}
        <label class="color-custom-wrapper">
          <input type="color" bind:value={color} class="color-native-input" />
          <span class="color-swatch custom" style="background: {drawnColour(color)}">✎</span>
        </label>
      </div>
    </div>
    <div class="modal-actions">
      <button class="btn-ghost" onclick={onClose}>Cancel</button>
      <button class="btn-primary" onclick={submit}>Add Column</button>
    </div>
  </div>
</div>

<style>
  .form-group { margin-top: var(--space-xl); }
  .form-group label { display: block; font-size: 0.75rem; font-weight: 600; color: var(--text-secondary); text-transform: uppercase; letter-spacing: 0.05em; margin-bottom: var(--space-sm); }
  .color-row { display: flex; flex-wrap: wrap; gap: 6px; }
  .color-swatch { width: 24px; height: 24px; border-radius: var(--radius-sm); border: 2px solid transparent; cursor: pointer; transition: all var(--duration-fast) var(--ease-out); }
  .color-swatch:hover { transform: scale(1.15); }
  .color-swatch.active { border-color: var(--text-primary); box-shadow: 0 0 8px rgba(255, 255, 255, 0.2); }
  .color-custom-wrapper { position: relative; cursor: pointer; display: inline-flex; }
  .color-native-input { position: absolute; width: 0; height: 0; opacity: 0; pointer-events: none; }
  .color-swatch.custom {
    display: flex; align-items: center; justify-content: center;
    font-size: 0.6rem; color: white; text-shadow: 0 1px 2px rgba(0,0,0,0.5); cursor: pointer;
  }
  .modal-actions { display: flex; justify-content: flex-end; gap: var(--space-md); margin-top: var(--space-2xl); }
</style>
