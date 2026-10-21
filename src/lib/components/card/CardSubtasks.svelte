<!--
  CardSubtasks.svelte — The card window's Subtasks section: a saved card's
  subtasks with their progress, cost and tick boxes, or a new card's subtasks
  to be made with it (card 2280, slice B4: moved from CardModal.svelte).

  The lists are the window's, bound here, as is the subtask window opened
  over it (`SubtaskModal`, drawn by the window after its own overlay): the
  window fills a saved card's list once per card id, keeps it while another
  tab is shown, and sends a new card's list with its save. A tick is sent
  from here, its answer read: a refusal is said in the window's message box
  (`windowError`, bound) and the box stays as it was. The cost ledger and
  each subtask's share of it are the window's, read once per card id.
-->
<script module lang="ts">
	// Pending subtasks for new card creation (full objects, not just titles)
	export type PendingSubtask = {
		id: number; // temp local ID
		title: string;
		description: string;
		priority: string;
		colorTag: string;
		dueDate: string | null;
		completed: boolean;
	};
</script>

<script lang="ts">
	import CardTokenCost, { type TokenLedger } from './CardTokenCost.svelte';
	import { completionPercent } from '$lib/progress';
	import { formatTokens } from '$lib/tokens';
	import { formatUsd, BLEND_NOTE, SOURCE_NOTE, NOT_BILLED_NOTE } from '$lib/pricing';
	import { daysUntilDue, formatDueDate } from '$lib/utils/date-utils';
	import { failureMessage } from '$lib/api';
	import type { CardType, SubtaskType } from '$lib/types';

	let {
		card,
		boardId,
		cardSubtasks = $bindable(),
		pendingSubtasks,
		tokenLedger,
		tokensExpanded = $bindable(),
		subtaskCost,
		windowError = $bindable(),
		openNewSubtask,
		openEditSubtask,
		openNewPendingSubtask,
		openEditPendingSubtask,
		removePendingSubtask,
		onWrote
	}: {
		card: CardType | null;
		boardId: number;
		cardSubtasks: SubtaskType[];
		pendingSubtasks: PendingSubtask[];
		tokenLedger: TokenLedger | null;
		tokensExpanded: boolean;
		/** Each subtask's share of the card's cost, where something was reported against it. */
		subtaskCost: Map<number, { tokens: number; costUsd: number | null }>;
		windowError: string;
		openNewSubtask: () => void;
		openEditSubtask: (subtask: SubtaskType) => void;
		openNewPendingSubtask: () => void;
		openEditPendingSubtask: (ps: PendingSubtask) => void;
		removePendingSubtask: (id: number) => void;
		/** The window's `onWrote`, called once a tick is saved (card 2324), got no answer and may have been, or was refused (card 2379). */
		onWrote?: () => void;
	} = $props();

	/** What a change that got no answer says: it may or may not have been made. */
	const NO_ANSWER = 'No answer from the server. It is not known whether that was saved.';

	async function toggleSubtask(subtask: SubtaskType) {
		windowError = '';
		let res: Response;
		try {
			res = await fetch(`/api/subtasks/${subtask.id}`, {
				method: 'PUT',
				headers: { 'Content-Type': 'application/json' },
				body: JSON.stringify({ completed: !subtask.completed, boardId })
			});
		} catch {
			windowError = NO_ANSWER;
			// It may have been saved: a plan page reads its goal again (card 2379).
			onWrote?.();
			return;
		}
		if (!res.ok) {
			windowError = await failureMessage(res, 'The subtask was not changed.');
			// A refusal can mean it was already changed elsewhere (a subtask
			// someone else deleted is answered 404): the plan is read again
			// as the window closes, which costs one load (card 2379's review).
			onWrote?.();
			return;
		}
		subtask.completed = !subtask.completed;
		cardSubtasks = [...cardSubtasks];
		onWrote?.();
	}

	const completedCount = $derived(cardSubtasks.filter((st) => st.completed).length);
	const totalCount = $derived(cardSubtasks.length);
	const progress = $derived(completionPercent(completedCount, totalCount));

	function getPriorityLabel(p: string) {
		const m: Record<string, string> = { critical: '🔴', high: '🟠', medium: '🟡', low: '🟢' };
		return m[p] || '🟡';
	}

	function formatDue(d: string | null) {
		if (!d) return '';
		// A due date is a calendar day, counted from the viewer's own today (card 2241).
		const diff = daysUntilDue(d);
		const formatted = formatDueDate(d, { day: 'numeric', month: 'short' });
		if (diff === null) return `📅 ${formatted}`;
		if (diff < 0) return `⚠️ Overdue (${formatted})`;
		if (diff === 0) return `📅 Due today`;
		if (diff === 1) return `📅 Due tomorrow`;
		return `📅 ${formatted}`;
	}
</script>

{#if card}
	<div class="subtasks-section">
		<div class="subtask-header">
			<label>
				Subtasks
				{#if totalCount > 0}
					<span class="subtask-counter">{completedCount}/{totalCount}</span>
				{/if}
			</label>
			<button class="btn-ghost add-st-btn" onclick={openNewSubtask}>
				<svg width="14" height="14" viewBox="0 0 14 14" fill="none">
					<path d="M7 2v10M2 7h10" stroke="currentColor" stroke-width="1.5" stroke-linecap="round" />
				</svg>
				Add
			</button>
		</div>

		{#if totalCount > 0}
			<div class="progress-bar-container">
				<div class="progress-bar" style="width: {progress}%" class:complete={progress === 100}></div>
			</div>
		{/if}

		{#if card && tokenLedger}
			<CardTokenCost {tokenLedger} bind:tokensExpanded />
		{/if}

		<div class="subtask-list">
			{#each cardSubtasks as subtask (subtask.id)}
				<div class="subtask-item" class:completed={subtask.completed}>
					<button class="subtask-checkbox" class:checked={subtask.completed} onclick={(e) => { e.stopPropagation(); toggleSubtask(subtask); }}>
						{#if subtask.completed}
							<svg width="12" height="12" viewBox="0 0 12 12" fill="none">
								<path d="M2 6l3 3 5-5" stroke="currentColor" stroke-width="2" stroke-linecap="round" stroke-linejoin="round"/>
							</svg>
						{/if}
					</button>
					<!-- svelte-ignore a11y_click_events_have_key_events -->
					<div class="subtask-info" onclick={() => openEditSubtask(subtask)} role="button" tabindex="0">
						<div class="subtask-title-row">
							<span class="st-priority">{getPriorityLabel(subtask.priority)}</span>
							<span class="subtask-title">{subtask.title}</span>
							{#if subtaskCost.get(subtask.id)}
								{@const sc = subtaskCost.get(subtask.id)!}
								<span class="st-cost" title="{formatTokens(sc.tokens)} tokens · {NOT_BILLED_NOTE}. {SOURCE_NOTE} — {BLEND_NOTE}.">
									{formatTokens(sc.tokens)}{#if sc.costUsd !== null} · {formatUsd(sc.costUsd)}{/if}
								</span>
							{/if}
						</div>
						{#if subtask.description || subtask.dueDate}
							<div class="subtask-detail-row">
								{#if subtask.description}
									<span class="st-desc-preview">{subtask.description.slice(0, 60)}{subtask.description.length > 60 ? '…' : ''}</span>
								{/if}
								{#if subtask.dueDate}
									<span class="st-due" class:overdue={(daysUntilDue(subtask.dueDate) ?? 0) < 0}>
										{formatDue(subtask.dueDate)}
									</span>
								{/if}
							</div>
						{/if}
					</div>
				</div>
			{/each}
		</div>

		{#if totalCount === 0}
			<button class="add-subtask-inline" onclick={openNewSubtask}>
				<svg width="14" height="14" viewBox="0 0 14 14" fill="none"><path d="M7 2v10M2 7h10" stroke="currentColor" stroke-width="1.5" stroke-linecap="round"/></svg>
				Add subtask
			</button>
		{/if}
	</div>
{:else}
	<!-- New card: rich subtask management -->
	<div class="subtasks-section">
		<div class="subtask-header">
			<label>
				Subtasks
				{#if pendingSubtasks.length > 0}
					<span class="subtask-counter">{pendingSubtasks.length}</span>
				{/if}
			</label>
			<button class="btn-ghost add-st-btn" onclick={openNewPendingSubtask}>
				<svg width="14" height="14" viewBox="0 0 14 14" fill="none">
					<path d="M7 2v10M2 7h10" stroke="currentColor" stroke-width="1.5" stroke-linecap="round" />
				</svg>
				Add
			</button>
		</div>

		<div class="subtask-list">
			{#each pendingSubtasks as ps (ps.id)}
				<div class="subtask-item pending">
					<span class="st-priority">{getPriorityLabel(ps.priority)}</span>
					<!-- svelte-ignore a11y_click_events_have_key_events -->
					<div class="subtask-info" onclick={() => openEditPendingSubtask(ps)} role="button" tabindex="0">
						<div class="subtask-title-row">
							<span class="subtask-title">{ps.title}</span>
						</div>
						{#if ps.description || ps.dueDate}
							<div class="subtask-detail-row">
								{#if ps.description}
									<span class="st-desc-preview">{ps.description.slice(0, 60)}{ps.description.length > 60 ? '…' : ''}</span>
								{/if}
								{#if ps.dueDate}
									<span class="st-due">{formatDue(ps.dueDate)}</span>
								{/if}
							</div>
						{/if}
					</div>
					<button class="btn-ghost pending-remove" onclick={() => removePendingSubtask(ps.id)} title="Remove">
						<svg width="10" height="10" viewBox="0 0 10 10" fill="none"><path d="M2 2l6 6M8 2L2 8" stroke="currentColor" stroke-width="1.5" stroke-linecap="round"/></svg>
					</button>
				</div>
			{/each}
		</div>

		{#if pendingSubtasks.length === 0}
			<button class="add-subtask-inline" onclick={openNewPendingSubtask}>
				<svg width="14" height="14" viewBox="0 0 14 14" fill="none"><path d="M7 2v10M2 7h10" stroke="currentColor" stroke-width="1.5" stroke-linecap="round"/></svg>
				Add subtask
			</button>
		{/if}
	</div>
{/if}

<style>
	/* Subtasks */
	.subtasks-section { border-top: 1px solid var(--glass-border); padding-top: var(--space-lg); margin-bottom: var(--space-lg); }

	.subtask-header {
		display: flex; align-items: center; justify-content: space-between; margin-bottom: var(--space-md);
	}
	.add-st-btn { font-size: 0.75rem !important; }

	.subtask-counter {
		font-size: 0.7rem; font-weight: 600; color: var(--text-tertiary);
		background: var(--bg-base); padding: 1px 6px; border-radius: var(--radius-full);
		text-transform: none; letter-spacing: 0;
	}

	/* Per-subtask cost. Only present where something was recorded, so it never
	   becomes a row of dashes down the list. */
	.st-cost {
		margin-left: auto; padding: 1px 7px; border-radius: var(--radius-full);
		background: var(--glass-hover); color: var(--text-secondary);
		font-size: 0.68rem; font-variant-numeric: tabular-nums; white-space: nowrap;
	}

	.progress-bar-container {
		height: 4px; background: var(--bg-base); border-radius: var(--radius-full);
		margin-bottom: var(--space-md); overflow: hidden;
	}
	.progress-bar {
		height: 100%; background: var(--accent-indigo); border-radius: var(--radius-full);
		transition: width var(--duration-normal) var(--ease-out);
	}
	.progress-bar.complete { background: var(--accent-emerald); }

	.subtask-list {
		display: flex; flex-direction: column; gap: 2px;
		max-height: 180px; overflow-y: auto; overflow-x: hidden;
		scrollbar-width: thin;
	}

	.subtask-item {
		display: flex; align-items: flex-start; gap: var(--space-sm);
		padding: var(--space-sm); border-radius: var(--radius-sm);
		transition: background var(--duration-fast) var(--ease-out);
	}
	.subtask-item:hover { background: var(--glass-bg); }
	.subtask-item.completed .subtask-title { text-decoration: line-through; color: var(--text-tertiary); }

	.subtask-checkbox {
		width: 18px; height: 18px; border-radius: 4px; flex-shrink: 0; margin-top: 2px;
		border: 2px solid var(--glass-border); background: transparent;
		display: flex; align-items: center; justify-content: center;
		transition: all var(--duration-fast) var(--ease-out); padding: 0;
		color: white; cursor: pointer;
	}
	.subtask-checkbox:hover { border-color: var(--accent-indigo); }
	.subtask-checkbox.checked { background: var(--accent-emerald); border-color: var(--accent-emerald); }

	.subtask-info {
		flex: 1; min-width: 0; cursor: pointer; padding: 2px 0;
		border-radius: var(--radius-sm);
	}

	.subtask-title-row { display: flex; align-items: center; gap: var(--space-xs); }
	.st-priority { font-size: 0.7rem; flex-shrink: 0; }
	.subtask-title { font-size: 0.85rem; min-width: 0; overflow: hidden; text-overflow: ellipsis; white-space: nowrap; }

	.subtask-detail-row {
		display: flex; align-items: center; gap: var(--space-sm);
		margin-top: 2px; flex-wrap: wrap;
	}
	.st-desc-preview { font-size: 0.72rem; color: var(--text-tertiary); }
	.st-due { font-size: 0.68rem; color: var(--text-secondary); white-space: nowrap; }
	.st-due.overdue { color: var(--accent-rose); }

	/* Pending subtasks for new cards */
	.subtask-item.pending {
		display: flex; align-items: center; gap: var(--space-sm);
		padding: var(--space-sm);
	}
	.pending-remove { padding: 2px !important; opacity: 0.5; }
	.pending-remove:hover { opacity: 1; }

	/* Add subtask inline button */
	.add-subtask-inline {
		display: flex; align-items: center; gap: var(--space-sm);
		padding: var(--space-sm) var(--space-md); font-size: 0.82rem; font-weight: 500;
		color: var(--text-tertiary); background: transparent; border: none;
		cursor: pointer; transition: all 0.15s; border-radius: var(--radius-sm);
	}
	.add-subtask-inline:hover { color: var(--text-secondary); background: var(--bg-elevated); }
</style>
