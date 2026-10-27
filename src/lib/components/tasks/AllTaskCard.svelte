<!--
  AllTaskCard.svelte — One card on All Tasks: its colour bar, pin and New
  badges, title with Move, board tag, the Blocked, milestone, priority,
  category, subtask, due, created and cost chips, the on-hold note, labels
  and assignees (card 2281, slice C3a-2: moved from src/routes/all/+page.svelte).

  A click opens the page's card window; Move opens the page's Move window.
  What blocks a card is the page's (`blockersFor`), which also filters by
  it; where each board sits in the tree is the page's too. The 15-second
  tick the age and due words move on, and the New badge goes on, is the page's.
-->
<script lang="ts">
	import type { PageData } from '../../../routes/all/$types';
	import type { BoardPlace } from '$lib/board-tree';
	import { boardPathText } from '$lib/board-tree';
	import { formatTokens } from '$lib/tokens';
	import { formatUsd, BLEND_NOTE, NOT_BILLED_NOTE, UNPRICED_SUM_NOTE } from '$lib/pricing';
	import { getRelativeAge, getDueRelative, getDueStatus, formatDueDate, parseUTC, showsNewBadge } from '$lib/utils/date-utils';
	import { subtaskProgress } from '$lib/utils/card-utils';
	import { drawnColour } from '$lib/colours';

	type Bucket = PageData['buckets'][number];
	type Blocker = { id: number; title: string; columnTitle: string; boardName: string; boardId: number | null; withheld: boolean };

	let {
		data,
		card,
		bucket,
		tick,
		boardPlaces,
		blockersFor,
		openCard,
		openMoveModal
	}: {
		/** What All Tasks' load gave it, passed on as it is. */
		data: PageData;
		/** The card, as the page draws it. */
		card: Bucket['cards'][number];
		/** The bucket the card is drawn in: an On Hold card shows its note, and a Complete one no New badge. */
		bucket: Bucket;
		/** The page's: counts up every 15 seconds, so the age and due words move on, and the New badge goes at 24 hours. */
		tick: number;
		/** The page's: where each board sits in the tree (card 1990). */
		boardPlaces: ReadonlyMap<number, BoardPlace>;
		/** The page's: the open blockers of a card, which it also filters by. */
		blockersFor: (cardId: number) => Blocker[];
		/** Opens the page's card window on a card. */
		openCard: (card: any) => void;
		/** Opens the page's Move window for a card. */
		openMoveModal: (card: any) => void;
	} = $props();

	/**
	 * Cost per card. Cards absent from this map have nothing recorded and show
	 * no badge — never a zero, which would assert a measurement never taken.
	 */
	const cardTokens = $derived(
		(data.cardTokens ?? {}) as Record<number, { tokens: number; costUsd: number | null }>
	);

	/** A card's board tag: the boards its board hangs beneath, then its board. */
	function boardTag(card: any): string {
		return boardPathText(boardPlaces.get(card.boardId)?.path ?? [], { emoji: card.boardEmoji, name: card.boardName });
	}

	const milestoneNames = $derived((data.milestoneNames ?? {}) as Record<number, string>);

	/**
	 * Tooltip for the Blocked chip. Every blocker is listed with the column it is
	 * sitting in, and its board — on a cross-board view the board is always worth
	 * showing, because the blocker is usually somewhere else entirely. A blocker
	 * on a board the viewer cannot open is its number and the text in place of
	 * its title, with no board or column (card 2129).
	 */
	function blockerTooltip(cardId: number): string {
		const open = blockersFor(cardId);
		if (open.length === 0) return '';
		return ['Blocked by']
			.concat(open.map((b) => (b.withheld ? `#${b.id} ${b.title}` : `#${b.id} ${b.title} — ${b.boardName} / ${b.columnTitle}`)))
			.join('\n');
	}

	const priorityEmoji: Record<string, string> = { critical: '🔴', high: '🟠', medium: '🟡', low: '🟢' };
</script>

<div class="card" class:card-pinned={card.pinned} onclick={() => openCard(card)} role="button" tabindex="0">
	{#if card.colorTag}
		<div class="card-color-bar" style="background: {drawnColour(card.colorTag)}"></div>
	{/if}
	{#if card.pinned}
		<span class="pin-badge" title="Pinned">📌</span>
	{/if}
	{#if showsNewBadge(card, bucket.title === 'Complete', tick)}
		<span class="new-badge">New</span>
	{/if}
	<div class="card-header">
		<span class="card-title"><span class="card-id">#{card.id}</span> {card.title}</span>
		<button class="move-btn" title="Move card" onclick={(e) => { e.stopPropagation(); openMoveModal(card); }}>
			<svg width="14" height="14" viewBox="0 0 14 14" fill="none"><path d="M7 2v10M2 7h10" stroke="currentColor" stroke-width="1.5" stroke-linecap="round"/><path d="M4 4L2 7l2 3M10 4l2 3-2 3M4 4L7 2l3 2M4 10l3 2 3-2" stroke="currentColor" stroke-width="1" stroke-linecap="round" stroke-linejoin="round" opacity="0.5"/></svg>
		</button>
	</div>
	<div class="card-board-tag">
		<span class="board-tag" title={boardTag(card)}>{boardTag(card)}</span>
		{#if card.boardCategoryName}
			<span class="board-cat-badge" style="background: {drawnColour(card.boardCategoryColor)}20; color: {drawnColour(card.boardCategoryColor)}; border: 1px solid {drawnColour(card.boardCategoryColor)}40">{card.boardCategoryName}</span>
		{/if}
	</div>
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
		{#if card.milestoneId && milestoneNames[card.milestoneId]}
			<a
				href="/plan/{card.milestoneId}"
				class="milestone-badge"
				title="Milestone: {milestoneNames[card.milestoneId]} — open the planning view"
				onclick={(e) => e.stopPropagation()}
			>🎯 {milestoneNames[card.milestoneId]}</a>
		{/if}
		<span class="priority-badge priority-{card.priority}">
			{priorityEmoji[card.priority] || '🟡'} {card.priority.toUpperCase()}
		</span>
		{#if card.categoryId}
			{@const cat = data.categories.find((c: any) => c.id === card.categoryId)}
			{#if cat}
				<span class="category-badge" style="background: {drawnColour(cat.color)}20; color: {drawnColour(cat.color)}; border: 1px solid {drawnColour(cat.color)}40">{cat.name}</span>
			{/if}
		{/if}
		{#if subtaskProgress(card as any)}
			{@const prog = subtaskProgress(card as any)!}
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
	{#if card.onHoldNote && bucket.title === 'On Hold'}
		<div class="on-hold-note-badge" title={card.onHoldNote}>
			<svg width="10" height="10" viewBox="0 0 10 10" fill="none"><circle cx="5" cy="5" r="4" stroke="currentColor" stroke-width="1"/><path d="M5 3v2.5h2" stroke="currentColor" stroke-width="1" stroke-linecap="round"/></svg>
			<span>{card.onHoldNote}</span>
		</div>
	{/if}
	{#if card.labelIds && card.labelIds.length > 0}
		<div class="card-labels">
			{#each card.labelIds as labelId}
				{@const label = data.labels.find((l: any) => l.id === labelId)}
				{#if label}
					<span class="label-chip" style="background: {drawnColour(label.color)}25; color: {drawnColour(label.color)}; border: 1px solid {drawnColour(label.color)}40">{label.name}</span>
				{/if}
			{/each}
		</div>
	{/if}
	{#if card.assignees && card.assignees.length > 0}
		<div class="card-assignees">
			{#each card.assignees as assignee}
				<span class="assignee-chip">{assignee.emoji || '👤'} {assignee.username}</span>
			{/each}
		</div>
	{/if}
</div>

<style>
	.card {
		display: flex;
		flex-direction: column;
		gap: var(--space-xs);
		padding: var(--space-md);
		border-radius: var(--radius-md);
		text-decoration: none;
		color: var(--text-primary);
		cursor: pointer;
		transition: all var(--duration-normal) var(--ease-out);
		position: relative;
		overflow: hidden;
		flex-shrink: 0;
		background: var(--bg-card);
		border: 1px solid var(--glass-border);
	}

	.card:hover {
		transform: translateY(-1px);
		box-shadow: var(--shadow-md);
		border-color: var(--glass-border);
	}

	.card-pinned {
		border-top: 2px solid var(--accent-indigo);
	}

	.pin-badge {
		position: absolute;
		top: 4px;
		right: 6px;
		font-size: 0.65rem;
	}

	.new-badge {
		position: absolute;
		top: 4px;
		right: 6px;
		font-size: 0.55rem;
		font-weight: 700;
		text-transform: uppercase;
		letter-spacing: 0.06em;
		padding: 1px 6px;
		border-radius: var(--radius-full);
		background: linear-gradient(135deg, #22c55e, #10b981);
		color: #fff;
		box-shadow: 0 0 8px rgba(34, 197, 94, 0.4);
		animation: newPulse 2s ease-in-out infinite;
	}

	.card-pinned .new-badge {
		right: 24px;
	}

	@keyframes newPulse {
		0%, 100% { box-shadow: 0 0 6px rgba(34, 197, 94, 0.3); }
		50% { box-shadow: 0 0 12px rgba(34, 197, 94, 0.6); }
	}

	.card-header {
		display: flex;
		align-items: flex-start;
		gap: var(--space-sm);
	}

	.card-title {
		font-size: 0.82rem;
		font-weight: 600;
		line-height: 1.3;
	}

	.card-board-tag {
		display: flex;
		align-items: center;
		gap: var(--space-xs);
		flex-wrap: wrap;
	}

	.board-tag {
		font-size: 0.65rem;
		font-weight: 600;
		color: var(--accent-purple);
		background: var(--accent-purple-glow, rgba(139, 92, 246, 0.12));
		padding: 1px 6px;
		border-radius: var(--radius-sm);
		/* A sub-board's tag names the boards above it: one line, cut short with an ellipsis, the whole path in its title. */
		max-width: 100%;
		min-width: 0;
		overflow: hidden;
		text-overflow: ellipsis;
		white-space: nowrap;
	}

	.card-meta {
		display: flex;
		align-items: center;
		gap: var(--space-xs);
		flex-wrap: wrap;
		font-size: 0.7rem;
	}

	/* Blocked / milestone chips and the filter toggle — deliberately identical to
	   the board so a card reads the same wherever it is seen. */
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

	.priority-badge {
		display: inline-flex; align-items: center; gap: 4px;
		font-size: 0.65rem;
		font-weight: 600;
		padding: 2px 8px;
		border-radius: var(--radius-full);
		text-transform: uppercase;
		letter-spacing: 0.04em;
	}

	.priority-critical { background: rgba(239, 68, 68, 0.15); color: #ef4444; border: 1px solid rgba(239, 68, 68, 0.25); }
	.priority-high { background: rgba(249, 115, 22, 0.15); color: #f97316; border: 1px solid rgba(249, 115, 22, 0.25); }
	.priority-medium { background: rgba(234, 179, 8, 0.15); color: #eab308; border: 1px solid rgba(234, 179, 8, 0.25); }
	.priority-low { background: rgba(34, 197, 94, 0.15); color: #22c55e; border: 1px solid rgba(34, 197, 94, 0.25); }

	.subtask-badge {
		font-size: 0.65rem;
		font-weight: 600;
		color: var(--text-secondary);
		display: flex;
		align-items: center;
		gap: 3px;
	}

	.subtask-badge.all-done {
		color: #22c55e;
	}

	.progress-ring { flex-shrink: 0; transition: stroke-dashoffset 0.3s ease-out; }

	.due-badge {
		font-size: 0.6rem;
		font-weight: 600;
		padding: 1px 6px;
		border-radius: var(--radius-sm);
		background: rgba(99, 102, 241, 0.1);
		color: var(--text-secondary);
	}

	.due-overdue { background: rgba(239, 68, 68, 0.15); color: #ef4444; }
	.due-today { background: rgba(245, 158, 11, 0.15); color: #f59e0b; }
	.due-soon { background: rgba(249, 115, 22, 0.12); color: #f97316; }

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
	.card-date {
		font-size: 0.65rem;
		color: var(--text-secondary);
		margin-left: auto;
		flex-shrink: 0;
	}

	.on-hold-note-badge {
		display: flex;
		align-items: flex-start;
		gap: 4px;
		font-size: 0.65rem;
		color: var(--text-tertiary);
		background: rgba(239, 68, 68, 0.06);
		padding: 4px 6px;
		border-radius: var(--radius-sm);
		border-left: 2px solid var(--accent-rose);
	}

	.on-hold-note-badge svg { flex-shrink: 0; margin-top: 2px; }

	.on-hold-note-badge span {
		overflow: hidden;
		text-overflow: ellipsis;
		display: -webkit-box;
		-webkit-line-clamp: 2;
		line-clamp: 2;
		-webkit-box-orient: vertical;
	}

	/* Color tag bar */
	.card-color-bar {
		position: absolute; top: 0; left: 0; right: 0; height: 3px;
		border-radius: var(--radius-md) var(--radius-md) 0 0;
	}

	/* Category badge */
	.category-badge {
		font-size: 0.6rem; font-weight: 600; padding: 1px 6px;
		border-radius: var(--radius-sm);
	}

	/* Board category badge */
	.board-cat-badge {
		font-size: 0.58rem; font-weight: 600; padding: 1px 5px;
		border-radius: var(--radius-sm); white-space: nowrap;
	}

	/* Label chips */
	.card-labels {
		display: flex; flex-wrap: wrap; gap: 3px; margin-top: 2px;
	}
	.label-chip {
		font-size: 0.58rem; font-weight: 600; padding: 1px 5px;
		border-radius: var(--radius-sm); white-space: nowrap;
	}

	/* Assignee chips */
	.card-assignees {
		display: flex; flex-wrap: wrap; gap: 3px; margin-top: 2px;
	}
	.assignee-chip {
		display: inline-flex; align-items: center; gap: 2px;
		font-size: 0.6rem; font-weight: 600;
		padding: 1px 6px; border-radius: var(--radius-full);
		background: rgba(99, 102, 241, 0.1); color: #818cf8;
		border: 1px solid rgba(99, 102, 241, 0.2);
	}

	/* Card interactions */
	.card { cursor: pointer; }
	.card-header { justify-content: space-between; }
	.move-btn {
		flex-shrink: 0; background: none; border: none; cursor: pointer;
		color: var(--text-tertiary); padding: 2px; border-radius: var(--radius-sm);
		opacity: 0; transition: all var(--duration-fast) var(--ease-out);
	}
	.card:hover .move-btn { opacity: 1; }
	.move-btn:hover { color: var(--accent-indigo); background: rgba(99, 102, 241, 0.08); }
</style>
