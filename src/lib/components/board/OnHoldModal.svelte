<!--
  OnHoldModal.svelte — Modal for entering an on-hold reason.

  Shown when a card is dragged into the "On Hold" column.
  Prompts the user to explain why the card is being paused.
-->
<script lang="ts">
  /**
   * @prop cardTitle — The name of the card being put on hold
   * @prop note — Two-way bound note text
   * @prop onConfirm — Callback to save the note and commit the move
   * @prop onCancel — Callback to cancel the move and revert
   */
  let {
    cardTitle,
    note = $bindable(''),
    onConfirm,
    onCancel
  }: {
    cardTitle: string;
    note: string;
    onConfirm: () => void;
    onCancel: () => void;
  } = $props();
</script>

<!-- svelte-ignore a11y_click_events_have_key_events -->
<div class="modal-overlay" onclick={onCancel} role="dialog" aria-modal="true">
  <!-- svelte-ignore a11y_click_events_have_key_events -->
  <div class="modal-content on-hold-modal" onclick={(e) => e.stopPropagation()} role="document">
    <div class="on-hold-header">
      <span class="on-hold-icon">⏸️</span>
      <h2>Put on Hold</h2>
      <p class="on-hold-task-name">"{cardTitle}"</p>
    </div>
    <div class="form-group">
      <label for="hold-note">Why is this on hold? What are you waiting for?</label>
      <textarea
        id="hold-note"
        rows="4"
        placeholder="e.g. Waiting for design approval, blocked by API changes..."
        bind:value={note}
        autofocus
      ></textarea>
    </div>
    <div class="modal-actions">
      <button class="btn-ghost" onclick={onCancel}>Cancel</button>
      <button class="btn-primary on-hold-confirm" onclick={onConfirm}>
        ⏸️ Put on Hold
      </button>
    </div>
  </div>
</div>

<style>
  .on-hold-modal { max-width: 440px; }
  .on-hold-header { text-align: center; margin-bottom: var(--space-xl); }
  .on-hold-icon { font-size: 2rem; display: block; margin-bottom: var(--space-sm); animation: pulse 1.5s ease-in-out infinite; }
  .on-hold-task-name { font-size: 0.9rem; color: var(--text-secondary); font-style: italic; margin-top: var(--space-xs); }
  .on-hold-confirm { background: var(--accent-rose) !important; }
  .on-hold-confirm:hover { background: #dc2626 !important; }
  .form-group { margin-top: var(--space-xl); }
  .form-group label { display: block; font-size: 0.75rem; font-weight: 600; color: var(--text-secondary); text-transform: uppercase; letter-spacing: 0.05em; margin-bottom: var(--space-sm); }
  .modal-actions { display: flex; justify-content: flex-end; gap: var(--space-md); margin-top: var(--space-2xl); }
  @keyframes pulse {
    0%, 100% { transform: scale(1); }
    50% { transform: scale(1.1); }
  }
</style>
