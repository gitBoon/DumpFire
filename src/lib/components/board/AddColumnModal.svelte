<!--
  AddColumnModal.svelte — Modal for adding a new column to the board.

  Allows the user to set the column name, position (start, end, or after
  a specific column), and colour from a palette or custom picker.

  On a delivery board with no Options column it can add one (milestone 22,
  card 2459): "Options column" ticked, the name defaults to "Ideas" and the
  position is not asked, since the Options column always goes at the far
  left. On a board that has one, "At the start" is not offered: nothing goes
  left of it, and "After … (Options)" is the start. The name box takes the
  focus as the window opens, Escape closes it, Tab stays inside it, and the
  focus goes back to what had it (`holdFocus`).
-->
<script lang="ts">
  import type { ColumnType } from '$lib/types';
  import { COLUMN_COLORS } from '$lib/utils/constants';
  import { drawnColour } from '$lib/colours';
  import { holdFocus } from '$lib/dialog-focus';
  import { isOptionsColumn } from '$lib/column-role';

  /**
   * @prop columns — Existing columns (for position dropdown options)
   * @prop canAddOptions — The board may have an Options column and has none: "Options column" is offered
   * @prop asOptions — Open with "Options column" ticked (the More menu's Add Options Column)
   * @prop onAdd — Callback with the new column data
   * @prop onClose — Callback to close the modal
   */
  let {
    columns,
    canAddOptions = false,
    asOptions = false,
    onAdd,
    onClose
  }: {
    columns: ColumnType[];
    canAddOptions?: boolean;
    asOptions?: boolean;
    onAdd: (data: { title: string; position: string; color: string; role: 'options' | null }) => void;
    onClose: () => void;
  } = $props();

  let title = $state('');
  let color = $state('#6366f1');
  let position = $state('end');
  // Read once, as the window opens: which kind of column it was opened for.
  // svelte-ignore state_referenced_locally
  let options = $state(canAddOptions && asOptions);
  const hasOptions = $derived(columns.some(isOptionsColumn));

  /** Validates and submits the new column data. */
  function submit() {
    const isOptions = options && canAddOptions;
    onAdd({ title: title.trim() || (isOptions ? 'Ideas' : 'New Column'), position, color, role: isOptions ? 'options' : null });
  }
</script>

<!-- svelte-ignore a11y_click_events_have_key_events -->
<div class="modal-overlay" role="dialog" aria-modal="true" aria-labelledby="add-column-heading">
  <!-- svelte-ignore a11y_click_events_have_key_events -->
  <div class="modal-content" onclick={(e) => e.stopPropagation()} role="document" use:holdFocus={{ first: '#col-name', onEscape: onClose }}>
    <h2 id="add-column-heading">{options && canAddOptions ? 'Add Options Column' : 'Add Column'}</h2>
    {#if canAddOptions}
      <div class="form-group">
        <label class="options-choice">
          <input type="checkbox" bind:checked={options} />
          Options column
        </label>
        <p class="options-hint">Ideas that may or may not be done, kept apart from committed work at the far left of the board. Moving a card out of it commits it.</p>
      </div>
    {/if}
    <div class="form-group">
      <label for="col-name">Column name</label>
      <input id="col-name" type="text" placeholder={options && canAddOptions ? 'Ideas' : 'e.g. Review, Testing...'} bind:value={title} onkeydown={(e) => e.key === 'Enter' && submit()} />
    </div>
    {#if !(options && canAddOptions)}
    <div class="form-group">
      <label for="col-position">Position</label>
      <select id="col-position" bind:value={position}>
        {#if !hasOptions}
          <option value="start">At the start</option>
        {/if}
        {#each columns as col}
          <option value="after-{col.id}">After "{col.title}"{isOptionsColumn(col) ? ' (Options)' : ''}</option>
        {/each}
        <option value="end">At the end</option>
      </select>
    </div>
    {/if}
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
      <button class="btn-primary" onclick={submit}>{options && canAddOptions ? 'Add Options Column' : 'Add Column'}</button>
    </div>
  </div>
</div>

<style>
  .form-group { margin-top: var(--space-xl); }
  .form-group label { display: block; font-size: 0.75rem; font-weight: 600; color: var(--text-secondary); text-transform: uppercase; letter-spacing: 0.05em; margin-bottom: var(--space-sm); }
  .form-group label.options-choice { display: flex; align-items: center; gap: var(--space-sm); cursor: pointer; }
  .options-hint { font-size: 0.78rem; color: var(--text-tertiary); margin: 0; }
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
