<!--
  KanbanCardBody.svelte — What one card on the board page's Kanban columns
  shows (card 2280, slice B3: moved from the board page; made from the
  markup the board draws, card 2012's decision 15).

  Its cover and category strips, pin, New badge, selection tick and drag
  handle; its title, renamed in place on a double-click, with the priority
  dot that cycles it; its description and On Hold note; and its badges:
  blocked, goal, priority, category, subtasks, sub-boards, due date, age,
  cost, labels and assignees.

  It holds no state of its own and sends nothing. The title being typed is
  the page's, bound here, and every change is handed to the page's own
  functions. The page keeps the card element itself, the direct child of
  its column's keyed `{#each}` that `animate:flip` and the cards' drag zone
  need, with its classes and its click, and styles this body's hover from it
  (`.kanban-card:hover`, `.kanban-card.card-pinned`). The list view keeps
  its own row, `CardListRow.svelte`.
-->
<script lang="ts">
	import type { CardType, CategoryType, LabelType } from '$lib/types';
	import type { BoardBlockerType } from '$lib/board/contents-answer';
	import { parseUTC, getRelativeAge, getDueRelative, getDueStatus, formatDueDate, showsNewBadge } from '$lib/utils/date-utils';
	import { subtaskProgress, getCategoryById, getLabelById, getPriorityLabel } from '$lib/utils/card-utils';
	import { isCoverValue } from '$lib/colours';
	import { drawnColour } from '$lib/colours';
	import { formatTokens } from '$lib/tokens';
	import { formatUsd, BLEND_NOTE, NOT_BILLED_NOTE, UNPRICED_SUM_NOTE } from '$lib/pricing';

	let {
		card,
		isComplete,
		isOnHold,
		categories,
		labels,
		blockersFor,
		blockerTooltip,
		milestoneNameById,
		cardTokens,
		tick,
		selectionMode,
		selected,
		editing,
		editValue = $bindable(),
		onStartEdit,
		onSaveEdit,
		onEditKeydown,
		onCyclePriority
	}: {
		card: CardType;
		/** The card is in a Complete column. */
		isComplete: boolean;
		/** The card is in an On Hold column: its note is shown. */
		isOnHold: boolean;
		categories: CategoryType[];
		labels: LabelType[];
		/** Open blockers of a card, by its id. */
		blockersFor: (cardId: number) => BoardBlockerType[];
		blockerTooltip: (cardId: number) => string;
		milestoneNameById: Map<number, string>;
		cardTokens: Record<number, { tokens: number; costUsd: number | null }>;
		/** The live timestamps' counter, which redraws the ages, due dates and New badge. */
		tick: number;
		selectionMode: boolean;
		selected: boolean;
		/** The title is being renamed in place: the box is shown, on `editValue`. */
		editing: boolean;
		editValue: string;
		onStartEdit: (card: CardType, e: MouseEvent) => void;
		/** The box's blur, and Enter through `onEditKeydown`: the page sends the title, once. */
		onSaveEdit: (cardId: number) => void;
		onEditKeydown: (e: KeyboardEvent, cardId: number) => void;
		onCyclePriority: (card: CardType, e: MouseEvent) => void;
	} = $props();
</script>

<!-- The cover: a strip across the top, drawn only for a colour or a preset (card 2010). -->
{#if isCoverValue(card.coverUrl)}<div class="card-cover-strip" style="background: {card.coverUrl}" aria-hidden="true"></div>{/if}
{#if card.pinned}
	<span class="pin-indicator" title="Pinned">📌</span>
{/if}
{#if showsNewBadge(card, isComplete, tick)}
	<span class="new-badge">New</span>
{/if}
{#if selectionMode}
	<div class="select-checkbox" class:checked={selected}>
		{#if selected}✓{/if}
	</div>
{/if}
<div class="drag-handle" aria-hidden="true">
	<svg width="8" height="14" viewBox="0 0 8 14" fill="currentColor">
		<circle cx="2" cy="2" r="1.2"/><circle cx="6" cy="2" r="1.2"/>
		<circle cx="2" cy="7" r="1.2"/><circle cx="6" cy="7" r="1.2"/>
		<circle cx="2" cy="12" r="1.2"/><circle cx="6" cy="12" r="1.2"/>
	</svg>
</div>
{#if getCategoryById(card.categoryId, categories)?.color}
	<div class="card-color-strip" style="background: {drawnColour(getCategoryById(card.categoryId, categories)?.color)}; --strip-color: {drawnColour(getCategoryById(card.categoryId, categories)?.color)}"></div>
{/if}
{#if editing}
	<!-- svelte-ignore a11y_autofocus -->
	<input
		class="inline-edit-input"
		bind:value={editValue}
		onkeydown={(e) => onEditKeydown(e, card.id)}
		onblur={() => onSaveEdit(card.id)}
		onclick={(e) => e.stopPropagation()}
		autofocus
	/>
{:else}
	<!-- svelte-ignore a11y_no_static_element_interactions -->
	<h4 class="card-title" ondblclick={(e) => onStartEdit(card, e)}>
		<!-- svelte-ignore a11y_click_events_have_key_events -->
		<!-- svelte-ignore a11y_no_static_element_interactions -->
		<span class="priority-dot priority-{card.priority}" onclick={(e) => onCyclePriority(card, e)} title="Priority: {card.priority} (click to cycle)"></span>
		<span class="card-id">#{card.id}</span>
		{card.title}
	</h4>
{/if}
{#if card.description}
	<p class="card-description">{card.description}</p>
{/if}
{#if isOnHold && card.onHoldNote}
	<div class="on-hold-note-badge">
		<svg width="10" height="10" viewBox="0 0 10 10" fill="none"><path d="M5 1v4M5 7v1" stroke="currentColor" stroke-width="1.5" stroke-linecap="round"/></svg>
		{card.onHoldNote}
	</div>
{/if}
<div class="card-meta">
	{#if blockersFor(card.id).length > 0}
		{@const blockers = blockersFor(card.id)}
		<span class="blocked-badge" title={blockerTooltip(card.id)}>
			<svg width="10" height="10" viewBox="0 0 10 10" fill="none" aria-hidden="true">
				<circle cx="5" cy="5" r="4" stroke="currentColor" stroke-width="1.4"/>
				<path d="M2.2 7.8L7.8 2.2" stroke="currentColor" stroke-width="1.4" stroke-linecap="round"/>
			</svg>
			Blocked{#if blockers.length > 1}&nbsp;({blockers.length}){/if}
		</span>
	{/if}
	{#if card.milestoneId && milestoneNameById.get(card.milestoneId)}
		<a
			href="/plan/{card.milestoneId}"
			class="milestone-badge"
			title="Milestone: {milestoneNameById.get(card.milestoneId)} — open the planning view"
			onclick={(e) => e.stopPropagation()}
		>🎯 {milestoneNameById.get(card.milestoneId)}</a>
	{/if}
	<span class="priority-badge priority-{card.priority}">
		{getPriorityLabel(card.priority)}
	</span>
	{#if getCategoryById(card.categoryId, categories)}
		{@const cat = getCategoryById(card.categoryId, categories)!}
		<span class="category-badge" style="background: {drawnColour(cat.color)}20; color: {drawnColour(cat.color)}; border: 1px solid {drawnColour(cat.color)}40">
			{cat.name}
		</span>
	{/if}
	{#if subtaskProgress(card)}
		{@const prog = subtaskProgress(card)!}
		{@const pct = prog.done / prog.total}
		<span class="subtask-badge" class:all-done={prog.done === prog.total}>
			<svg class="progress-ring" width="14" height="14" viewBox="0 0 14 14">
				<circle cx="7" cy="7" r="5.5" fill="none" stroke="var(--glass-border)" stroke-width="2"/>
				<circle cx="7" cy="7" r="5.5" fill="none"
					stroke={prog.done === prog.total ? '#22c55e' : '#6366f1'}
					stroke-width="2"
					stroke-dasharray={2 * Math.PI * 5.5}
					stroke-dashoffset={2 * Math.PI * 5.5 * (1 - pct)}
					transform="rotate(-90 7 7)"
					stroke-linecap="round"/>
			</svg>
			{prog.done}/{prog.total}
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
		{@const dueStatus = getDueStatus(card.dueDate)}
		<span class="due-badge" class:due-overdue={dueStatus === 'overdue'} class:due-today={dueStatus === 'today'} class:due-soon={dueStatus === 'soon'} title="Due {formatDueDate(card.dueDate)}">
			{#if dueStatus === 'overdue'}⚠️{:else if dueStatus === 'today'}🔥{:else if dueStatus === 'soon'}📅{:else}📅{/if}
			Due {getDueRelative(card.dueDate, tick)}
		</span>
	{/if}
	<span class="card-date" title="Created {parseUTC(card.createdAt).toLocaleDateString('en-GB', { day: 'numeric', month: 'short', year: 'numeric' })}">Created {getRelativeAge(card.createdAt, tick)}</span>
	{#if cardTokens[card.id]}
		{@const tc = cardTokens[card.id]}
		<span class="cost-badge" title="{formatTokens(tc.tokens)} tokens{tc.costUsd !== null ? ` · ${formatUsd(tc.costUsd)} at API rates — ${NOT_BILLED_NOTE}. ${BLEND_NOTE}` : ` · ${UNPRICED_SUM_NOTE}, so it cannot be priced`}">
			{formatTokens(tc.tokens)}{#if tc.costUsd !== null} · {formatUsd(tc.costUsd)}{/if}
		</span>
	{/if}
</div>
{#if card.labelIds && card.labelIds.length > 0}
	<div class="card-labels">
		{#each card.labelIds as labelId}
		{@const label = getLabelById(labelId, labels)}
			{#if label}
				<span class="label-chip" style="background: {drawnColour(label.color)}25; color: {drawnColour(label.color)}; border: 1px solid {drawnColour(label.color)}40">{label.name}</span>
			{/if}
		{/each}
	</div>
{/if}
{#if card.assignees && card.assignees.length > 0}
	<div class="card-assignees">
		{#each card.assignees as assignee}
			<span class="assignee-chip">{assignee.emoji} {assignee.username}</span>
		{/each}
	</div>
{/if}

<style>
	/* Amber, not red: a blocked card is waiting, not broken. On Hold already owns
	   red on this board and the two states have to stay distinguishable. */
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
		font-size: 0.66rem; font-weight: 600; text-decoration: none;
		max-width: 170px; overflow: hidden; text-overflow: ellipsis; white-space: nowrap;
		background: rgba(139, 92, 246, 0.1); color: #a78bfa;
		border: 1px solid rgba(139, 92, 246, 0.22);
		transition: all var(--duration-fast) var(--ease-out);
	}
	.milestone-badge:hover { background: rgba(139, 92, 246, 0.2); border-color: rgba(139, 92, 246, 0.45); }

	/* On Hold note badge — still rendered inline in card */
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
	/* Absolute, as the category strip is, so that nothing else on the card moves. */
	.card-cover-strip { position: absolute; left: 0; right: 0; top: 0; height: 6px; pointer-events: none; }
	.card-title { font-size: 0.85rem; font-weight: 500; line-height: 1.4; margin-bottom: var(--space-xs); cursor: text; }
	.inline-edit-input {
		width: 100%; font-size: 0.85rem; font-weight: 500; line-height: 1.4;
		margin-bottom: var(--space-xs); padding: 2px 4px; border: 1px solid var(--accent-indigo);
		border-radius: var(--radius-sm); background: var(--bg-base); color: var(--text-primary);
		font-family: var(--font-family); outline: none;
		box-shadow: 0 0 0 2px rgba(99, 102, 241, 0.15);
	}
	.priority-dot {
		display: inline-block; width: 7px; height: 7px; border-radius: 50%;
		margin-right: 4px; vertical-align: middle; cursor: pointer;
		transition: transform 0.15s ease;
	}
	.priority-dot:hover { transform: scale(1.5); }
	.priority-dot.priority-low { background: #94a3b8; }
	.priority-dot.priority-medium { background: #3b82f6; }
	.priority-dot.priority-high { background: #f59e0b; }
	.priority-dot.priority-critical { background: #ef4444; }
	.card-description { font-size: 0.75rem; color: var(--text-tertiary); line-height: 1.4; display: -webkit-box; -webkit-line-clamp: 2; line-clamp: 2; -webkit-box-orient: vertical; overflow: hidden; margin-bottom: var(--space-sm); }
	.card-meta { display: flex; align-items: center; gap: var(--space-sm); flex-wrap: wrap; }
	/* Cost sits beside the creation date: both are facts about the card over
	   time, and read together they answer "how long, and how much". Only shown
	   when something was recorded — never a zero or a dash, which would put a
	   false measurement on every card that predates the ledger. */
	.cost-badge {
		font-size: 0.65rem; flex-shrink: 0; white-space: nowrap;
		padding: 1px 6px; border-radius: var(--radius-full);
		background: var(--glass-hover); color: var(--text-secondary);
		font-variant-numeric: tabular-nums;
	}
	.card-date { font-size: 0.65rem; color: var(--text-secondary); margin-left: auto; flex-shrink: 0; }
	.category-badge { display: inline-flex; align-items: center; padding: 1px 8px; border-radius: var(--radius-full); font-size: 0.68rem; font-weight: 600; }

	/* Drag handle: shown on the card's hover, `.kanban-card:hover :global(.drag-handle)`, in the page. */
	.drag-handle {
		position: absolute; top: 50%; left: 4px; transform: translateY(-50%);
		color: var(--text-tertiary); opacity: 0; transition: opacity 0.15s;
		cursor: grab;
	}

	/* Due date badge */
	.due-badge {
		display: inline-flex; align-items: center; gap: 2px;
		font-size: 0.62rem; font-weight: 600; padding: 1px 6px;
		border-radius: var(--radius-full); white-space: nowrap;
		background: rgba(136, 136, 170, 0.08); color: var(--text-secondary);
	}
	.due-badge.due-overdue { background: rgba(239, 68, 68, 0.12); color: #ef4444; border: 1px solid rgba(239, 68, 68, 0.25); }
	.due-badge.due-today { background: rgba(245, 158, 11, 0.12); color: #f59e0b; border: 1px solid rgba(245, 158, 11, 0.25); }
	.due-badge.due-soon { background: rgba(234, 179, 8, 0.08); color: #eab308; border: 1px solid rgba(234, 179, 8, 0.15); }

	.subtask-badge {
		display: inline-flex; align-items: center; gap: 3px;
		padding: 1px 8px; border-radius: var(--radius-full);
		font-size: 0.68rem; font-weight: 600;
		background: rgba(136, 136, 170, 0.1); color: var(--text-secondary);
		border: 1px solid rgba(136, 136, 170, 0.2);
	}
	.subtask-badge.all-done { background: rgba(16, 185, 129, 0.1); color: var(--accent-emerald); border-color: rgba(16, 185, 129, 0.2); }

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

	/* Card labels */
	.card-labels { display: flex; flex-wrap: wrap; gap: 3px; margin-top: 4px; }
	.label-chip { display: inline-flex; align-items: center; padding: 0px 6px; border-radius: var(--radius-full); font-size: 0.58rem; font-weight: 600; white-space: nowrap; }
	.card-assignees { display: flex; align-items: center; flex-wrap: wrap; gap: 4px; margin-top: 6px; }
	.assignee-chip {
		display: inline-flex; align-items: center; gap: 3px;
		padding: 1px 8px; border-radius: var(--radius-full);
		font-size: 0.65rem; font-weight: 600; white-space: nowrap;
		background: rgba(99, 102, 241, 0.08); color: var(--accent-indigo);
		border: 1px solid rgba(99, 102, 241, 0.2);
	}

	/* Selection checkbox */
	.select-checkbox {
		position: absolute; top: 6px; right: 6px; width: 18px; height: 18px;
		border: 2px solid var(--glass-border); border-radius: 4px;
		display: flex; align-items: center; justify-content: center;
		font-size: 0.65rem; font-weight: 800; z-index: 2;
		background: var(--bg-surface); color: var(--accent-indigo); transition: all 0.15s;
	}
	.select-checkbox.checked { background: var(--accent-indigo); color: white; border-color: var(--accent-indigo); }

	/* Pin indicator */
	.pin-indicator { position: absolute; top: 4px; right: 4px; font-size: 0.7rem; z-index: 2; opacity: 0.7; }

	/* New badge: moved left of the pin on a pinned card, `.kanban-card.card-pinned :global(.new-badge)`, in the page. */
	.new-badge {
		position: absolute; top: 4px; right: 4px; z-index: 2;
		font-size: 0.5rem; font-weight: 700; text-transform: uppercase;
		letter-spacing: 0.06em; padding: 1px 6px;
		border-radius: var(--radius-full);
		background: linear-gradient(135deg, #22c55e, #10b981);
		color: #fff;
		box-shadow: 0 0 8px rgba(34, 197, 94, 0.4);
		animation: newPulse 2s ease-in-out infinite;
	}
	@keyframes newPulse {
		0%, 100% { box-shadow: 0 0 6px rgba(34, 197, 94, 0.3); }
		50% { box-shadow: 0 0 12px rgba(34, 197, 94, 0.6); }
	}

	/* Progress ring */
	.progress-ring { flex-shrink: 0; transition: stroke-dashoffset 0.3s ease-out; }

	/* ─── Mobile Responsive ──────────────────────────────────────────────── */

	@media (max-width: 768px) {
		.card-title { font-size: 0.9rem; }
	}
</style>
