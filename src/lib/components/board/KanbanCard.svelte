<!--
  KanbanCard.svelte — A single card within a Kanban column.

  Renders the card's title, description preview, category colour strip,
  priority badge, subtask progress ring, sub-board badges, due date badge,
  labels, drag handle, pin indicator, selection checkbox, and the blocked /
  milestone chips that come from the planning view's two recorded facts.
-->
<script lang="ts">
  import type { CardType, CategoryType, LabelType } from '$lib/types';
  import { subtaskProgress, getCategoryById, getLabelById, getPriorityLabel, isCompleteColumn, isOnHoldColumn } from '$lib/utils/card-utils';
  import { getRelativeAge, getDueStatus, getDueRelative, isStale, parseUTC } from '$lib/utils/date-utils';
  import { formatTokens } from '$lib/tokens';
  import { formatUsd, BLEND_NOTE } from '$lib/pricing';

  /**
   * @prop card — The card data to render
   * @prop columnTitle — Title of the column this card is in
   * @prop isComplete — Whether this card is in the Complete column
   * @prop isOnHold — Whether this card is in the On Hold column
   * @prop categories — Board categories for colour strip / badge
   * @prop labels — Board labels for label chips
   * @prop tick — Reactive tick counter for live-updating timestamps
   * @prop selectionMode — Whether bulk selection mode is active
   * @prop isSelected — Whether this card is currently selected
   * @prop matchesSearch — Whether this card matches the search query
   * @prop blockers — Open blockers for this card, from the board loader's
   *        single-pass blocked state. Empty or absent means nothing is blocking it.
   * @prop milestoneName — Name of the milestone this card belongs to, if any
   * @prop tokenCost — What this card cost, or null when nothing has been recorded.
   *   Absent renders as nothing at all rather than a zero, because a card that
   *   predates the ledger was not free — its cost is simply unknown.
   */
  let {
    card,
    columnTitle,
    isComplete = false,
    isOnHold = false,
    categories,
    labels,
    tick,
    selectionMode = false,
    isSelected = false,
    matchesSearch = true,
    blockers = [],
    milestoneName = null,
    tokenCost = null
  }: {
    card: CardType;
    columnTitle: string;
    isComplete: boolean;
    isOnHold: boolean;
    categories: CategoryType[];
    labels: LabelType[];
    tick: number;
    selectionMode: boolean;
    isSelected: boolean;
    matchesSearch: boolean;
    blockers?: { id: number; title: string; columnTitle: string; boardName: string; boardId: number }[];
    milestoneName?: string | null;
    tokenCost?: { tokens: number; costUsd: number | null } | null;
  } = $props();

  /**
   * Tooltip listing every blocker with the column it is sitting in — "Blocked"
   * on its own tells you to stop but not what to go and do.
   */
  const blockerTooltip = $derived(
    blockers.length === 0
      ? ''
      : ['Blocked by']
          .concat(
            blockers.map(
              (b) => `#${b.id} ${b.title} — ${b.columnTitle}${b.boardName ? ` (${b.boardName})` : ''}`
            )
          )
          .join('\n')
  );

  /** Compute subtask progress for the progress ring. */
  const progress = $derived(subtaskProgress(card));

  /** Resolve the card's category for the colour strip. */
  const category = $derived(getCategoryById(card.categoryId, categories));

  /** Due date status for colour-coded badge. */
  const dueStatus = $derived(card.dueDate ? getDueStatus(card.dueDate) : null);
</script>

<div
  class="kanban-card"
  class:card-completed={isComplete}
  class:card-on-hold={isOnHold}
  class:card-hidden={!matchesSearch}
  class:card-stale={isStale(card.createdAt) && !isComplete}
  class:card-selected={isSelected}
  class:card-pinned={card.pinned}
  class:has-cover={!!card.coverUrl}
  id="card-{card.id}"
>
  <!-- Cover strip -->
  {#if card.coverUrl}
    <div class="card-cover-strip" style="background: {card.coverUrl}"></div>
  {/if}
  <!-- Pin indicator -->
  {#if card.pinned}
    <span class="pin-indicator" title="Pinned">📌</span>
  {/if}
  <!-- Selection checkbox (visible only in selection mode) -->
  {#if selectionMode}
    <div class="select-checkbox" class:checked={isSelected}>
      {#if isSelected}✓{/if}
    </div>
  {/if}
  <!-- Drag handle dots -->
  <div class="drag-handle" aria-hidden="true">
    <svg width="8" height="14" viewBox="0 0 8 14" fill="currentColor">
      <circle cx="2" cy="2" r="1.2"/><circle cx="6" cy="2" r="1.2"/>
      <circle cx="2" cy="7" r="1.2"/><circle cx="6" cy="7" r="1.2"/>
      <circle cx="2" cy="12" r="1.2"/><circle cx="6" cy="12" r="1.2"/>
    </svg>
  </div>
  <!-- Category colour strip on the left edge -->
  {#if category?.color}
    <div class="card-color-strip" style="background: {category.color}; --strip-color: {category.color}"></div>
  {/if}
  <!-- Card title -->
  <h4 class="card-title">{card.title}</h4>
  <!-- Description preview (first 2 lines) -->
  {#if card.description}
    <p class="card-description">{card.description}</p>
  {/if}
  <!-- On-hold reason note -->
  {#if isOnHold && card.onHoldNote}
    <div class="on-hold-note-badge">
      <svg width="10" height="10" viewBox="0 0 10 10" fill="none"><path d="M5 1v4M5 7v1" stroke="currentColor" stroke-width="1.5" stroke-linecap="round"/></svg>
      {card.onHoldNote}
    </div>
  {/if}
  <!-- Metadata row: priority, category, subtask progress, sub-boards, due date, age -->
  <div class="card-meta">
    {#if blockers.length > 0}
      <span class="blocked-badge" title={blockerTooltip}>
        <svg width="10" height="10" viewBox="0 0 10 10" fill="none" aria-hidden="true">
          <circle cx="5" cy="5" r="4" stroke="currentColor" stroke-width="1.4"/>
          <path d="M2.2 7.8L7.8 2.2" stroke="currentColor" stroke-width="1.4" stroke-linecap="round"/>
        </svg>
        Blocked{#if blockers.length > 1}&nbsp;({blockers.length}){/if}
      </span>
    {/if}
    {#if milestoneName}
      <span class="milestone-badge" title="Milestone: {milestoneName}">🎯 {milestoneName}</span>
    {/if}
    <span class="priority-badge priority-{card.priority}">
      {getPriorityLabel(card.priority)}
    </span>
    {#if category}
      <span class="category-badge" style="background: {category.color}20; color: {category.color}; border: 1px solid {category.color}40">
        {category.name}
      </span>
    {/if}
    {#if progress}
      {@const pct = progress.done / progress.total}
      <span class="subtask-badge" class:all-done={progress.done === progress.total}>
        <svg class="progress-ring" width="14" height="14" viewBox="0 0 14 14">
          <circle cx="7" cy="7" r="5.5" fill="none" stroke="var(--glass-border)" stroke-width="2"/>
          <circle cx="7" cy="7" r="5.5" fill="none"
            stroke={progress.done === progress.total ? '#22c55e' : '#6366f1'}
            stroke-width="2"
            stroke-dasharray={2 * Math.PI * 5.5}
            stroke-dashoffset={2 * Math.PI * 5.5 * (1 - pct)}
            transform="rotate(-90 7 7)"
            stroke-linecap="round"/>
        </svg>
        {progress.done}/{progress.total}
      </span>
    {/if}
    {#if card.subBoards.length > 0}
      {#each card.subBoards as sb}
        <a href="/board/{sb.id}" class="subboard-badge" class:all-done={sb.total > 0 && sb.done === sb.total} title="{sb.emoji} {sb.name} — {sb.done}/{sb.total} complete" onclick={(e) => e.stopPropagation()}>
          🗂️ {sb.name} {sb.done}/{sb.total}
        </a>
      {/each}
    {/if}
    {#if card.dueDate}
      <span class="due-badge" class:due-overdue={dueStatus === 'overdue'} class:due-today={dueStatus === 'today'} class:due-soon={dueStatus === 'soon'} title="Due {new Date(card.dueDate).toLocaleDateString('en-GB', { day: 'numeric', month: 'short', year: 'numeric' })}">
        {#if dueStatus === 'overdue'}⚠️{:else if dueStatus === 'today'}🔥{:else if dueStatus === 'soon'}📅{:else}📅{/if}
        Due {getDueRelative(card.dueDate, tick)}
      </span>
    {/if}
    <span class="card-date" title="Created {parseUTC(card.createdAt).toLocaleDateString('en-GB', { day: 'numeric', month: 'short', year: 'numeric' })}">Created {getRelativeAge(card.createdAt, tick)}</span>
    {#if tokenCost}
      <span class="cost-badge" title="{formatTokens(tokenCost.tokens)} tokens{tokenCost.costUsd !== null ? ` · estimated ${formatUsd(tokenCost.costUsd)}, ${BLEND_NOTE}` : ' · no model recorded, so it cannot be priced'}">
        {formatTokens(tokenCost.tokens)}{#if tokenCost.costUsd !== null} · {formatUsd(tokenCost.costUsd)}{/if}
      </span>
    {/if}
  </div>
  <!-- Label chips -->
  {#if card.labelIds && card.labelIds.length > 0}
    <div class="card-labels">
      {#each card.labelIds as labelId}
        {@const label = getLabelById(labelId, labels)}
        {#if label}
          <span class="label-chip" style="background: {label.color}25; color: {label.color}; border: 1px solid {label.color}40">{label.name}</span>
        {/if}
      {/each}
    </div>
  {/if}
  <!-- Assignee avatars -->
  {#if card.assignees && card.assignees.length > 0}
    <div class="card-assignees">
      {#each card.assignees as assignee}
        <span class="assignee-avatar" title={assignee.username}>{assignee.emoji}</span>
      {/each}
    </div>
  {/if}
</div>

<style>
  .kanban-card {
    background: var(--bg-card); border: 1px solid var(--glass-border);
    border-radius: var(--radius-md); padding: var(--space-md); cursor: pointer;
    transition: all var(--duration-normal) var(--ease-out); position: relative; overflow: hidden;
    flex-shrink: 0; padding-left: calc(var(--space-md) + 12px);
  }
  .kanban-card.has-cover { padding-top: 0; }
  .kanban-card:hover { border-color: var(--glass-border); transform: translateY(-1px); box-shadow: var(--shadow-md); }
  .kanban-card.card-completed { background: rgba(16, 185, 129, 0.06); border-color: rgba(16, 185, 129, 0.15); }
  .kanban-card.card-completed:hover { border-color: rgba(16, 185, 129, 0.25); box-shadow: 0 4px 12px rgba(16, 185, 129, 0.1); }
  .kanban-card.card-on-hold { background: rgba(239, 68, 68, 0.05); border-color: rgba(239, 68, 68, 0.15); }
  .kanban-card.card-on-hold:hover { border-color: rgba(239, 68, 68, 0.25); box-shadow: 0 4px 12px rgba(239, 68, 68, 0.1); }
  .kanban-card.card-hidden { display: none; }
  .kanban-card.card-stale { border-left: 2px solid rgba(136, 136, 170, 0.3); }
  .kanban-card.card-selected { outline: 2px solid var(--accent-indigo); outline-offset: -2px; }
  .kanban-card.card-pinned { border-top: 2px solid var(--accent-indigo); }

  .card-cover-strip {
    height: 6px; margin: 0 calc(-1 * var(--space-md)) 0 -12px;
    width: calc(100% + var(--space-md) + 12px);
    border-radius: var(--radius-md) var(--radius-md) 0 0;
    margin-bottom: var(--space-sm);
  }

  .on-hold-note-badge {
    display: flex; align-items: flex-start; gap: 4px;
    padding: 4px 8px; margin-bottom: var(--space-sm);
    background: rgba(239, 68, 68, 0.08); border: 1px solid rgba(239, 68, 68, 0.15);
    border-radius: var(--radius-sm); font-size: 0.7rem; color: var(--accent-rose);
    line-height: 1.4; font-style: italic;
  }
  .on-hold-note-badge svg { flex-shrink: 0; margin-top: 2px; }

  .card-color-strip {
    position: absolute; left: 0; top: 0; bottom: 0; width: 5px;
    border-radius: 5px 0 0 5px;
    box-shadow: 2px 0 8px var(--strip-color, transparent);
  }
  .card-title { font-size: 0.85rem; font-weight: 500; line-height: 1.4; margin-bottom: var(--space-xs); }
  .card-description { font-size: 0.75rem; color: var(--text-tertiary); line-height: 1.4; display: -webkit-box; -webkit-line-clamp: 2; line-clamp: 2; -webkit-box-orient: vertical; overflow: hidden; margin-bottom: var(--space-sm); }
  .card-meta { display: flex; align-items: center; gap: var(--space-sm); flex-wrap: wrap; }
  .card-date { font-size: 0.65rem; color: var(--text-secondary); margin-left: auto; flex-shrink: 0; }
  /* Cost sits beside the creation date: both are facts about the card over
     time, and reading them together answers "how long, and how much". Only
     present when something was recorded — never a zero or a dash, which would
     put a false measurement on every historical card. */
  .cost-badge {
    font-size: 0.65rem; flex-shrink: 0; white-space: nowrap;
    padding: 1px 6px; border-radius: var(--radius-full);
    background: var(--glass-hover); color: var(--text-secondary);
    font-variant-numeric: tabular-nums;
  }
  .category-badge { display: inline-flex; align-items: center; padding: 1px 8px; border-radius: var(--radius-full); font-size: 0.68rem; font-weight: 600; }

  .drag-handle {
    position: absolute; top: 50%; left: 4px; transform: translateY(-50%);
    color: var(--text-tertiary); opacity: 0; transition: opacity 0.15s; cursor: grab;
  }
  .kanban-card:hover .drag-handle { opacity: 0.4; }
  .kanban-card:hover .drag-handle:hover { opacity: 0.8; }

  .due-badge {
    display: inline-flex; align-items: center; gap: 2px;
    font-size: 0.62rem; font-weight: 600; padding: 1px 6px;
    border-radius: var(--radius-full); white-space: nowrap;
    background: rgba(136, 136, 170, 0.08); color: var(--text-secondary);
  }
  .due-badge.due-overdue { background: rgba(239, 68, 68, 0.12); color: #ef4444; border: 1px solid rgba(239, 68, 68, 0.25); }
  .due-badge.due-today { background: rgba(245, 158, 11, 0.12); color: #f59e0b; border: 1px solid rgba(245, 158, 11, 0.25); }
  .due-badge.due-soon { background: rgba(234, 179, 8, 0.08); color: #eab308; border: 1px solid rgba(234, 179, 8, 0.15); }

  /* Amber, not red: a blocked card is waiting, not broken. On Hold already
     owns red on this board and the two states must stay distinguishable. */
  .blocked-badge {
    display: inline-flex; align-items: center; gap: 3px;
    padding: 1px 8px; border-radius: var(--radius-full);
    font-size: 0.68rem; font-weight: 700; white-space: nowrap;
    background: rgba(245, 158, 11, 0.14); color: #f59e0b;
    border: 1px solid rgba(245, 158, 11, 0.3);
    cursor: help;
  }

  .milestone-badge {
    display: inline-flex; align-items: center; gap: 3px;
    padding: 1px 8px; border-radius: var(--radius-full);
    font-size: 0.66rem; font-weight: 600;
    max-width: 160px; overflow: hidden; text-overflow: ellipsis; white-space: nowrap;
    background: rgba(139, 92, 246, 0.1); color: #a78bfa;
    border: 1px solid rgba(139, 92, 246, 0.22);
  }

  .subtask-badge {
    display: inline-flex; align-items: center; gap: 3px;
    padding: 1px 8px; border-radius: var(--radius-full);
    font-size: 0.68rem; font-weight: 600;
    background: rgba(136, 136, 170, 0.1); color: var(--text-secondary);
    border: 1px solid rgba(136, 136, 170, 0.2);
  }
  .subtask-badge.all-done { background: rgba(16, 185, 129, 0.1); color: var(--accent-emerald); border-color: rgba(16, 185, 129, 0.2); }
  .progress-ring { flex-shrink: 0; transition: stroke-dashoffset 0.3s ease-out; }

  .subboard-badge {
    display: inline-flex; align-items: center; gap: 3px;
    padding: 1px 8px; border-radius: var(--radius-full);
    font-size: 0.68rem; font-weight: 600;
    background: rgba(99, 102, 241, 0.1); color: #818cf8;
    border: 1px solid rgba(99, 102, 241, 0.2);
    text-decoration: none; transition: all var(--duration-fast) var(--ease-out);
  }
  .subboard-badge:hover { background: rgba(99, 102, 241, 0.2); border-color: rgba(99, 102, 241, 0.4); }
  .subboard-badge.all-done { background: rgba(16, 185, 129, 0.1); color: var(--accent-emerald); border-color: rgba(16, 185, 129, 0.2); }

  .pin-indicator { position: absolute; top: 4px; right: 4px; font-size: 0.7rem; z-index: 2; opacity: 0.7; }

  .select-checkbox {
    position: absolute; top: 6px; right: 6px; width: 18px; height: 18px;
    border: 2px solid var(--glass-border); border-radius: 4px;
    display: flex; align-items: center; justify-content: center;
    font-size: 0.65rem; font-weight: 800; z-index: 2;
    background: var(--bg-surface); color: var(--accent-indigo);
    transition: all 0.15s;
  }
  .select-checkbox.checked { background: var(--accent-indigo); color: white; border-color: var(--accent-indigo); }

  .card-labels { display: flex; flex-wrap: wrap; gap: 3px; margin-top: 4px; }
  .label-chip {
    display: inline-flex; align-items: center;
    padding: 0px 6px; border-radius: var(--radius-full);
    font-size: 0.58rem; font-weight: 600; white-space: nowrap;
  }

  .card-assignees {
    display: flex; align-items: center; margin-top: 4px;
  }
  .assignee-avatar {
    display: inline-flex; align-items: center; justify-content: center;
    width: 22px; height: 22px; border-radius: 50%;
    font-size: 0.72rem; line-height: 1;
    background: var(--bg-surface); border: 2px solid var(--bg-card);
    margin-left: -6px; cursor: default;
    transition: transform 0.15s ease;
  }
  .assignee-avatar:first-child { margin-left: 0; }
  .assignee-avatar:hover { transform: scale(1.2); z-index: 1; }

  :global(.kanban-card[aria-grabbed="true"]) {
    transform: rotate(2deg) scale(1.03);
    box-shadow: 0 12px 40px rgba(0,0,0,0.3);
    opacity: 0.9;
  }
</style>
