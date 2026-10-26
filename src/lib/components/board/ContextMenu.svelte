<!--
  ContextMenu.svelte — Right-click context menu for Kanban cards.

  Provides quick actions: move to column, change priority, pin/unpin,
  duplicate, create sub-board, navigate to sub-boards, send an option to
  another board (milestone 22), and archive.
  Positioned at the mouse cursor location.
-->
<script lang="ts">
  import type { CardType, ColumnType } from '$lib/types';
  import { drawnColour } from '$lib/colours';
  import { isOptionsColumn } from '$lib/column-role';

  /**
   * @prop card — The card this context menu is for
   * @prop columnId — The column the card currently belongs to
   * @prop x — Mouse X position for menu placement
   * @prop y — Mouse Y position for menu placement
   * @prop columns — All board columns (for "move to" options)
   * @prop onClose — Callback to close the menu
   * @prop onMove — Callback to move the card to a different column
   * @prop onPriority — Callback to change the card's priority
   * @prop onTogglePin — Callback to pin/unpin the card
   * @prop onDuplicate — Callback to duplicate the card
   * @prop onCreateSubBoard — Callback to create a sub-board for the card
   * @prop onDelete — Callback to archive the card
   * @prop onSend — "Send to board…" (milestone 22, card 2463): given by the board page for an option only, never for committed work
   */
  let {
    card,
    columnId,
    x,
    y,
    columns,
    onClose,
    onMove,
    onPriority,
    onTogglePin,
    onDuplicate,
    onCreateSubBoard,
    onDelete,
    onSend,
    canAddSubBoard = true
  }: {
    card: CardType;
    columnId: number;
    x: number;
    y: number;
    columns: ColumnType[];
    onClose: () => void;
    onMove: (card: CardType, targetColumnId: number) => void;
    onPriority: (card: CardType, priority: string) => void;
    onTogglePin: (card: CardType) => void;
    onDuplicate: (card: CardType) => void;
    onCreateSubBoard: (card: CardType) => void;
    onDelete: (cardId: number) => void;
    onSend?: (card: CardType) => void;
    /** False for an option or an idea, which has no sub-boards (the S5b review's P1): Add Sub-board is not offered; its existing ones still open. */
    canAddSubBoard?: boolean;
  } = $props();
</script>

<!-- Overlay to capture clicks outside the menu -->
<!-- svelte-ignore a11y_click_events_have_key_events -->
<!-- svelte-ignore a11y_no_static_element_interactions -->
<div class="ctx-overlay" onclick={onClose}></div>
<!-- svelte-ignore a11y_click_events_have_key_events -->
<!-- svelte-ignore a11y_no_static_element_interactions -->
<div class="ctx-menu glass" style="left: {x}px; top: {y}px" onclick={(e) => e.stopPropagation()}>
  <!-- Move to column section -->
  <div class="ctx-section">
    <span class="ctx-label">Move to</span>
    {#each columns as col}
      {#if col.id !== columnId}
        <button class="ctx-item" onclick={() => onMove(card, col.id)}>
          <span class="ctx-dot" style="background: {drawnColour(col.color)}"></span> {col.title}{isOptionsColumn(col) ? ' (Options)' : ''}
        </button>
      {/if}
    {/each}
  </div>
  <div class="ctx-divider"></div>
  <!-- Priority section -->
  <div class="ctx-section">
    <span class="ctx-label">Priority</span>
    <div class="ctx-row">
      {#each [['critical', '🔴'], ['high', '🟠'], ['medium', '🟡'], ['low', '🟢']] as [p, emoji]}
        <button class="ctx-item ctx-priority" onclick={() => onPriority(card, p)}>{emoji}</button>
      {/each}
    </div>
  </div>
  <div class="ctx-divider"></div>
  <!-- Pin, duplicate, sub-board -->
  <button class="ctx-item" onclick={() => onTogglePin(card)}>
    {card.pinned ? '📌 Unpin' : '📌 Pin to top'}
  </button>
  <button class="ctx-item" onclick={() => onDuplicate(card)}>📋 Duplicate</button>
  {#if canAddSubBoard}
    <button class="ctx-item" onclick={() => onCreateSubBoard(card)}>🗂️ Add Sub-board</button>
  {/if}
  <!-- An option is sent on to a delivery board; committed work is moved, so is not offered it. -->
  {#if onSend}
    <button class="ctx-item" onclick={() => { onClose(); onSend(card); }}>📤 Send to board…</button>
  {/if}
  <!-- Navigate to existing sub-boards -->
  {#if card.subBoards.length > 0}
    {#each card.subBoards as sb}
      <button class="ctx-item" onclick={() => { window.location.href = `/board/${sb.id}`; }}>→ {sb.emoji} {sb.name}</button>
    {/each}
  {/if}
  <div class="ctx-divider"></div>
  <!-- Archive: the board's onDelete archives the card, and asks first -->
  <button class="ctx-item ctx-danger" onclick={() => { onDelete(card.id); onClose(); }}>🗄️ Archive</button>
</div>

<style>
  .ctx-overlay { position: fixed; inset: 0; z-index: 95; }
  .ctx-menu {
    position: fixed; z-index: 96; min-width: 180px;
    padding: 6px; border-radius: var(--radius-md);
    background: var(--bg-surface) !important;
    border: 1px solid var(--glass-border);
    box-shadow: 0 8px 32px rgba(0,0,0,0.3);
    animation: ctxIn 0.12s ease-out;
  }
  @keyframes ctxIn { from { transform: scale(0.95); opacity: 0; } to { transform: scale(1); opacity: 1; } }
  .ctx-section { padding: 2px 0; }
  .ctx-label { font-size: 0.6rem; font-weight: 700; text-transform: uppercase; letter-spacing: 0.06em; color: var(--text-tertiary); padding: 4px 10px; display: block; }
  .ctx-item {
    display: flex; align-items: center; gap: 6px; width: 100%;
    padding: 5px 10px; border: none; background: none; cursor: pointer;
    font-size: 0.78rem; border-radius: var(--radius-sm);
    color: var(--text-primary); text-align: left; transition: background 0.1s;
    font-family: var(--font-family);
  }
  .ctx-item:hover { background: var(--glass-bg); }
  .ctx-danger { color: var(--accent-rose) !important; }
  .ctx-danger:hover { background: rgba(239, 68, 68, 0.1) !important; }
  .ctx-dot { width: 8px; height: 8px; border-radius: 50%; flex-shrink: 0; }
  .ctx-divider { height: 1px; background: var(--glass-border); margin: 4px 6px; }
  .ctx-row { display: flex; gap: 2px; padding: 0 4px; }
  .ctx-priority { flex: 1; justify-content: center; font-size: 1rem !important; padding: 4px !important; }
</style>
