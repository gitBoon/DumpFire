<!--
  CardListRow.svelte — One card as a row of the board's list view (card 2079).

  The row has room for what a tile clamps away: the title in full, the card's
  summary (the plain-English line written for reports), five lines of its
  description, and one line of what the tile shows beneath (blocked,
  milestone, priority, category, assignees, age, due date, subtasks, cost).
  Labels and sub-boards are left to the card window. A card made in the last
  24 hours, and not complete, has the board's New badge beside its title, by
  the board's own rule (`showsNewBadge`, card 2537).

  It makes no request: a click, Enter or Space is the board's own open (or,
  with Bulk Select on, its select), and a right-click is the board's own
  context menu.

  The row is an article, its title a heading, and what opens it a real button
  over the title, whose name is the card's number and title. The button is
  stretched over the whole row (the stretched-link pattern), so a click
  anywhere on the row is a click on it; the milestone link, the Blocked
  chip, whose tooltip names each blocker, and the New badge, whose tooltip
  says what it means, sit above the stretch.
-->
<script lang="ts">
	import type { CardType, CategoryType } from '$lib/types';
	import { parseUTC, getRelativeAge, getDueRelative, getDueStatus, formatDueDate, showsNewBadge } from '$lib/utils/date-utils';
	import { subtaskProgress, getCategoryById, getPriorityLabel } from '$lib/utils/card-utils';
	import { formatTokens } from '$lib/tokens';
	import { formatUsd, BLEND_NOTE, NOT_BILLED_NOTE, UNPRICED_SUM_NOTE } from '$lib/pricing';
	import { drawnColour } from '$lib/colours';

	let {
		card,
		onHold,
		completed,
		categories,
		blockerCount,
		blockerTooltip,
		milestoneName,
		tokens,
		tick,
		selected,
		selectionMode,
		onOpen,
		onContextMenu
	}: {
		card: CardType;
		/** The row is in an On Hold column, where the hold note is shown. */
		onHold: boolean;
		/** The row is in a Complete column. */
		completed: boolean;
		categories: CategoryType[];
		/** Open blockers of the card. */
		blockerCount: number;
		/** The board's tooltip naming each open blocker. */
		blockerTooltip: string;
		milestoneName: string | null;
		/** What the card cost, when something was recorded; nothing is shown otherwise. */
		tokens: { tokens: number; costUsd: number | null } | undefined;
		/** The page's live-timestamp counter, so "Created … ago" and the New badge stay current. */
		tick: number;
		selected: boolean;
		selectionMode: boolean;
		onOpen: (card: CardType, e: Event) => void;
		onContextMenu: (e: MouseEvent, card: CardType) => void;
	} = $props();

	const category = $derived(getCategoryById(card.categoryId, categories));
	const progress = $derived(subtaskProgress(card));

	/**
	 * Enter and Space are the button's own. A held Enter repeats a button's
	 * click, which in Bulk Select would select and unselect the row over and
	 * over: only the first press counts.
	 */
	function onKeydown(e: KeyboardEvent) {
		if (e.key === 'Enter' && e.repeat) e.preventDefault();
	}
</script>

<article
	class="list-row"
	class:row-selected={selected}
	class:row-pinned={card.pinned}
	class:row-on-hold={onHold}
	class:row-completed={completed}
	id="list-card-{card.id}"
	oncontextmenu={(e) => onContextMenu(e, card)}
>
	{#if category?.color}
		<div class="row-color-strip" style="background: {drawnColour(category.color)}" aria-hidden="true"></div>
	{/if}
	<h4 class="row-title">
		<span class="priority-dot priority-{card.priority}" title="Priority: {card.priority}"></span>
		<button
			type="button"
			class="row-open"
			aria-pressed={selectionMode ? selected : undefined}
			onclick={(e) => onOpen(card, e)}
			onkeydown={onKeydown}
		><span class="row-id">#{card.id}</span> <span class="row-title-text">{card.title}</span></button>
		{#if card.pinned}<span class="row-pin" title="Pinned">📌</span>{/if}
		{#if showsNewBadge(card, completed, tick)}<span class="row-new-badge" title="Created in the last 24 hours">New</span>{/if}
	</h4>
	{#if card.summary}
		<p class="row-summary">{card.summary}</p>
	{/if}
	{#if card.description}
		<p class="row-description">{card.description}</p>
	{/if}
	{#if onHold && card.onHoldNote}
		<div class="row-hold-note">
			<svg width="10" height="10" viewBox="0 0 10 10" fill="none" aria-hidden="true"><path d="M5 1v4M5 7v1" stroke="currentColor" stroke-width="1.5" stroke-linecap="round"/></svg>
			{card.onHoldNote}
		</div>
	{/if}
	<div class="row-meta">
		{#if blockerCount > 0}
			<span class="chip chip-blocked" title={blockerTooltip}>
				<svg width="10" height="10" viewBox="0 0 10 10" fill="none" aria-hidden="true">
					<circle cx="5" cy="5" r="4" stroke="currentColor" stroke-width="1.4"/>
					<path d="M2.2 7.8L7.8 2.2" stroke="currentColor" stroke-width="1.4" stroke-linecap="round"/>
				</svg>
				<span class="chip-text">Blocked{#if blockerCount > 1}&nbsp;({blockerCount}){/if}</span>
			</span>
		{/if}
		{#if card.milestoneId && milestoneName}
			<a
				href="/plan/{card.milestoneId}"
				class="chip chip-milestone"
				title="Milestone: {milestoneName} — open the planning view"
			><span class="chip-text">🎯 {milestoneName}</span></a>
		{/if}
		<span class="priority-badge priority-{card.priority}">{getPriorityLabel(card.priority)}</span>
		{#if category}
			<span class="chip" style="background: {drawnColour(category.color)}20; color: {drawnColour(category.color)}; border: 1px solid {drawnColour(category.color)}40"><span class="chip-text">{category.name}</span></span>
		{/if}
		{#each card.assignees ?? [] as assignee (assignee.id)}
			<span class="chip chip-assignee"><span class="chip-text">{assignee.emoji} {assignee.username}</span></span>
		{/each}
		<span class="row-date" title="Created {parseUTC(card.createdAt).toLocaleDateString('en-GB', { day: 'numeric', month: 'short', year: 'numeric' })}">Created {getRelativeAge(card.createdAt, tick)}</span>
		{#if card.dueDate}
			{@const dueStatus = getDueStatus(card.dueDate)}
			<span class="chip chip-due" class:due-overdue={dueStatus === 'overdue'} class:due-today={dueStatus === 'today'} class:due-soon={dueStatus === 'soon'} title="Due {formatDueDate(card.dueDate)}">
				{#if dueStatus === 'overdue'}⚠️{:else if dueStatus === 'today'}🔥{:else}📅{/if}
				Due {getDueRelative(card.dueDate, tick)}
			</span>
		{/if}
		{#if progress}
			<span class="chip chip-subtasks" class:all-done={progress.done === progress.total} title="Subtasks done">☑ {progress.done}/{progress.total}</span>
		{/if}
		{#if tokens}
			<span class="chip chip-cost" title="{formatTokens(tokens.tokens)} tokens{tokens.costUsd !== null ? ` · ${formatUsd(tokens.costUsd)} at API rates — ${NOT_BILLED_NOTE}. ${BLEND_NOTE}` : ` · ${UNPRICED_SUM_NOTE}, so it cannot be priced`}">
				{formatTokens(tokens.tokens)}{#if tokens.costUsd !== null} · {formatUsd(tokens.costUsd)}{/if}
			</span>
		{/if}
	</div>
</article>

<style>
	.list-row {
		position: relative; overflow: hidden;
		background: var(--bg-card); border: 1px solid var(--glass-border);
		border-radius: var(--radius-md);
		padding: var(--space-md) var(--space-lg) var(--space-md) calc(var(--space-lg) + 4px);
		cursor: pointer; min-width: 0;
		transition: border-color var(--duration-fast) var(--ease-out), box-shadow var(--duration-fast) var(--ease-out);
	}
	.list-row:hover { box-shadow: var(--shadow-md); }
	/* The ring is the row's while its button has the keyboard's focus. Selected
	   is one ring inside; focused, one outside; a focused selected row has both. */
	.list-row.row-selected { outline: 2px solid var(--accent-indigo); outline-offset: -2px; }
	.list-row:has(.row-open:focus-visible) { outline: 2px solid var(--accent-indigo); outline-offset: 1px; }
	.list-row.row-selected:has(.row-open:focus-visible) { box-shadow: inset 0 0 0 2px var(--accent-indigo); }
	.list-row.row-pinned { border-top: 2px solid var(--accent-indigo); }
	.list-row.row-on-hold { background: rgba(239, 68, 68, 0.05); border-color: rgba(239, 68, 68, 0.15); }
	.list-row.row-completed { background: rgba(16, 185, 129, 0.06); border-color: rgba(16, 185, 129, 0.15); }

	.row-color-strip { position: absolute; left: 0; top: 0; bottom: 0; width: 5px; }

	/* The title wraps rather than being cut: at portrait width most fit one line. */
	.row-title {
		font-size: 0.95rem; font-weight: 600; line-height: 1.4;
		margin: 0 0 var(--space-xs); overflow-wrap: anywhere;
	}
	/* The button reads as the title; its ::after stretches over the row, so a
	   click anywhere on it opens the card, and right-click reaches the row. */
	.row-open {
		display: inline; padding: 0; margin: 0; border: none; background: none;
		font: inherit; color: inherit; text-align: left; cursor: pointer;
	}
	.row-open::after { content: ''; position: absolute; inset: 0; z-index: 0; }
	.row-open:focus-visible { outline: none; }
	.chip-milestone, .chip-blocked { position: relative; z-index: 1; }
	.row-id { color: var(--text-tertiary); font-weight: 500; }
	.row-pin { font-size: 0.75rem; margin-left: 4px; }
	/* The board's New badge, in its colours, as a pill in the title's line
	   rather than in a tile's corner; above the stretch, so its tooltip shows. */
	.row-new-badge {
		position: relative; z-index: 1;
		display: inline-block; margin-left: 6px; vertical-align: middle; cursor: help;
		font-size: 0.6rem; font-weight: 700; text-transform: uppercase;
		letter-spacing: 0.06em; line-height: 1.5; padding: 0 6px;
		border-radius: var(--radius-full);
		background: linear-gradient(135deg, #22c55e, #10b981);
		color: #fff;
		box-shadow: 0 0 6px rgba(34, 197, 94, 0.3);
	}
	.priority-dot {
		display: inline-block; width: 8px; height: 8px; border-radius: 50%;
		margin-right: 4px; vertical-align: middle;
	}
	.priority-dot.priority-low { background: #94a3b8; }
	.priority-dot.priority-medium { background: #3b82f6; }
	.priority-dot.priority-high { background: #f59e0b; }
	.priority-dot.priority-critical { background: #ef4444; }

	.row-summary {
		font-size: 0.82rem; color: var(--text-secondary); line-height: 1.45;
		margin: 0 0 var(--space-xs); overflow-wrap: anywhere;
	}
	/* Plain text as on the board, with five lines where a tile has two. */
	.row-description {
		font-size: 0.78rem; color: var(--text-tertiary); line-height: 1.45;
		display: -webkit-box; -webkit-line-clamp: 5; line-clamp: 5; -webkit-box-orient: vertical;
		overflow: hidden; overflow-wrap: anywhere; margin: 0 0 var(--space-sm);
	}
	.row-hold-note {
		display: flex; align-items: flex-start; gap: 4px;
		padding: 4px 8px; margin-bottom: var(--space-sm);
		background: rgba(239, 68, 68, 0.08); border: 1px solid rgba(239, 68, 68, 0.15);
		border-radius: var(--radius-sm); font-size: 0.72rem; color: var(--accent-rose);
		line-height: 1.4; font-style: italic; overflow-wrap: anywhere;
	}
	.row-hold-note svg { flex-shrink: 0; margin-top: 2px; }

	.row-meta { display: flex; align-items: center; gap: 6px; flex-wrap: wrap; min-width: 0; }
	.chip {
		display: inline-flex; align-items: center; gap: 3px;
		padding: 1px 8px; border-radius: var(--radius-full);
		font-size: 0.68rem; font-weight: 600; white-space: nowrap;
		max-width: 100%; min-width: 0; overflow: hidden;
		background: rgba(136, 136, 170, 0.1); color: var(--text-secondary);
		border: 1px solid rgba(136, 136, 170, 0.2);
	}
	/* An inline-flex box does not ellipsise its text; a span inside it does. */
	.chip-text { min-width: 0; overflow: hidden; text-overflow: ellipsis; white-space: nowrap; }
	/* Amber, as on the board: a blocked card is waiting, not broken. */
	.chip-blocked {
		background: rgba(245, 158, 11, 0.14); color: #f59e0b;
		border-color: rgba(245, 158, 11, 0.3); font-weight: 700; cursor: help;
	}
	.chip-milestone {
		text-decoration: none; max-width: 220px;
		background: rgba(139, 92, 246, 0.1); color: #a78bfa;
		border-color: rgba(139, 92, 246, 0.22);
	}
	.chip-milestone:hover { background: rgba(139, 92, 246, 0.2); border-color: rgba(139, 92, 246, 0.45); }
	.chip-assignee { background: rgba(99, 102, 241, 0.08); color: var(--accent-indigo); border-color: rgba(99, 102, 241, 0.2); }
	.chip-due.due-overdue { background: rgba(239, 68, 68, 0.12); color: #ef4444; border-color: rgba(239, 68, 68, 0.25); }
	.chip-due.due-today { background: rgba(245, 158, 11, 0.12); color: #f59e0b; border-color: rgba(245, 158, 11, 0.25); }
	.chip-due.due-soon { background: rgba(234, 179, 8, 0.08); color: #eab308; border-color: rgba(234, 179, 8, 0.15); }
	.chip-subtasks.all-done { background: rgba(16, 185, 129, 0.1); color: var(--accent-emerald); border-color: rgba(16, 185, 129, 0.2); }
	.chip-cost { background: var(--glass-hover); border-color: transparent; font-variant-numeric: tabular-nums; }
	.row-date { font-size: 0.68rem; color: var(--text-secondary); white-space: nowrap; }

	@media (max-width: 480px) {
		.list-row { padding: var(--space-sm) var(--space-md) var(--space-sm) calc(var(--space-md) + 4px); }
	}
</style>
