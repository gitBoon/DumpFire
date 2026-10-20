<script lang="ts">
	/**
	 * Milestone planning view — the separate view this feature is for.
	 *
	 * Deliberately its own full-screen route rather than a tab on the board. The
	 * Kanban board stays the place where work is tracked; this is the place where
	 * the order of the work is read. It renders five blocks, in the order they
	 * answer a real question:
	 *
	 *   1. Progress        — how far along is this goal
	 *   2. Burndown        — will it land by its date
	 *   3. Critical path   — the one chain that cannot slip
	 *   4. The work        — every card, searchable and sortable, each opening
	 *                        to its subtasks
	 *   5. Dependency graph — the whole shape, laid out left to right
	 *
	 * Block 4 used to be three stacked lists (actionable / blocked / unordered).
	 * They were the same cards partitioned three ways and stopped being scannable
	 * at about thirty, so they are one table with a state filter instead — the
	 * partition is still there, as counts, and a specific card is now findable.
	 * Its rows are arranged by $lib/plan-table, which the tests call.
	 *
	 * Nothing here is computed in the browser. The server hands over a summary
	 * from $lib/server/planning and this file draws it, so the page and the API
	 * can never disagree about what the critical path is.
	 *
	 * Each block is a component of its own in $lib/components/plan, drawn where
	 * its markup was, and the graph's geometry is $lib/plan-graph (card 2281,
	 * slice C3a-3). The page keeps the plan's one PATCH path (mutate) and the
	 * card window.
	 */
	import { invalidateAll } from '$app/navigation';
	import CardModal from '$lib/components/CardModal.svelte';
	import Toast from '$lib/components/Toast.svelte';
	import { toasts } from '$lib/stores/toast';
	import { failureMessage } from '$lib/api';
	import { PageCardWindow } from '$lib/board/page-card-window.svelte';
	import type { CardWindowSave } from '$lib/board/card-window.svelte';
	import type { CardType } from '$lib/types';
	import { key, type Node } from '$lib/plan-graph';
	// The plan's blocks (card 2281, slice C3a-3), each drawn where its markup was.
	import PlanHeader from '$lib/components/plan/PlanHeader.svelte';
	import PlanCardPicker from '$lib/components/plan/PlanCardPicker.svelte';
	import PlanProgress from '$lib/components/plan/PlanProgress.svelte';
	import PlanBurndown from '$lib/components/plan/PlanBurndown.svelte';
	import CriticalPathPanel from '$lib/components/plan/CriticalPathPanel.svelte';
	import WorkTable from '$lib/components/plan/WorkTable.svelte';
	import DependencyGraph from '$lib/components/plan/DependencyGraph.svelte';

	let { data } = $props();

	const summary = $derived(data.summary);
	const milestone = $derived(summary.milestone);
	/** A number, so what reads it is not re-run by every re-read of the plan. */
	const milestoneId = $derived(milestone.id);
	const nodes = $derived(summary.graph.nodes as Node[]);
	const nodeByKey = $derived(new Map(nodes.map((n) => [key(n), n])));

	let busy = $state(false);
	let actionError = $state('');
	let picking = $state(false);

	/**
	 * One PATCH path for every edit on this page, so error handling is uniform.
	 * A refusal is said in the server's words; no answer is said as no answer,
	 * since the change may have been made (card 2314: it said nothing). Each
	 * is said above the blocks and in a toast too, which stays on screen
	 * wherever the page is scrolled to: the ✕ that sent it may be far below.
	 */
	async function mutate(body: Record<string, unknown>) {
		busy = true;
		actionError = '';
		const started = toasts.navigation();
		const failed = (words: string) => {
			actionError = words;
			toasts.add(words, 'error', started);
		};
		try {
			let res: Response;
			try {
				res = await fetch(`/api/milestones/${milestone.id}`, {
					method: 'PATCH',
					headers: { 'Content-Type': 'application/json' },
					body: JSON.stringify(body)
				});
			} catch {
				failed('No answer from the server. It is not known whether that change was saved.');
				return;
			}
			if (!res.ok) {
				failed(await failureMessage(res, 'That change could not be saved'));
				return;
			}
			await invalidateAll();
		} finally {
			busy = false;
		}
	}

	// ─── Card modal, opened in place ─────────────────────────────────────────

	/** The card the window is open on, as its context gave it, with a save shown on it at once and taken back if refused. */
	let modalCard = $state<CardType | null>(null);
	let modalContext = $state<{
		boardId: number;
		categories: any[];
		labels: any[];
		boardUsers: { id: number; username: string; email?: string; emoji: string }[];
		milestones: any[];
	} | null>(null);

	/**
	 * The card window (card 2281, slice C3a-1): saved through the board page's
	 * controller, over the card above. A save sends only the fields changed in
	 * the window, so a change someone else made to the card meanwhile is not
	 * sent back.
	 */
	const cardWindow = new PageCardWindow(
		{ get: () => (modalCard ? [{ cards: [modalCard] }] : []), set: (next) => (modalCard = next[0]?.cards[0] ?? null) },
		() => invalidateAll()
	);

	/**
	 * Open a card without leaving the plan.
	 *
	 * The board page has its whole payload to hand; this view spans boards, so it
	 * fetches the one card's context on demand instead. A refusal is said in
	 * the server's words, and no answer as no answer (card 2314: it said
	 * nothing, and every refusal "Could not open that card").
	 */
	async function openCard(ref: { kind?: string; id: number; parentCardId?: number; withheld?: boolean }) {
		// Work on a board the viewer cannot open has nothing to open: its card
		// would be refused them.
		if (ref.withheld) return;
		// A subtask has no card of its own — open the card it belongs to.
		const cardId = ref.kind === 'subtask' ? ref.parentCardId : ref.id;
		if (!cardId) return;

		const started = toasts.navigation();
		let res: Response;
		try {
			res = await fetch(`/api/cards/${cardId}/context`);
		} catch {
			toasts.add('No answer from the server. The card could not be opened.', 'error', started);
			return;
		}
		if (!res.ok) {
			toasts.add(await failureMessage(res, 'That card could not be opened.'), 'error', started);
			return;
		}
		// An answer that is not the card's context (a proxy's page) was an answer, not none.
		let ctx: { card: CardType; boardId: number } & NonNullable<typeof modalContext>;
		try {
			ctx = await res.json();
		} catch {
			toasts.add("The server's answer could not be read. The card could not be opened.", 'error', started);
			return;
		}
		modalCard = ctx.card;
		modalContext = {
			boardId: ctx.boardId,
			categories: ctx.categories,
			labels: ctx.labels,
			boardUsers: ctx.boardUsers,
			milestones: ctx.milestones
		};
		cardWindow.openCard(ctx.card, ctx.boardId);
	}

	/**
	 * Closing the window re-reads the plan, saved or not: the window writes a
	 * subtask ticked, added or removed at once, before any Save, and the table
	 * shows every subtask (card 2221).
	 */
	async function closeCard() {
		cardWindow.close();
		modalCard = null;
		modalContext = null;
		await invalidateAll();
	}

	/**
	 * Saving goes through the card window's controller the board uses, so the
	 * two screens cannot drift on what a save does: only the fields changed in
	 * the window are sent. A refusal, or no answer, is said and keeps the
	 * window open with what was typed; it used to say "Card updated" whatever
	 * came back. A save with nothing changed sends nothing and says nothing.
	 */
	async function saveCardFromPlan(cardData: CardWindowSave) {
		const started = toasts.navigation();
		const saving = cardWindow.edits;
		const written = await cardWindow.save(cardData);
		if (!written.ok) {
			toasts.add(written.failure, 'error', started);
			return;
		}
		// A column change alters what is blocked and what is startable, so the
		// plan has to be recomputed rather than patched locally: closing does it.
		// A save answered after its window was closed, and another window
		// opened (on another card, or on the same card again: each open has
		// its own `edits`), leaves that window open: the plan alone is read again.
		const stillOpen = cardWindow.cardId === null || cardWindow.edits === saving;
		const reloaded = stillOpen ? closeCard() : invalidateAll();
		for (const { message, failed } of written.told) {
			if (failed) toasts.add(message, 'error', started);
			else toasts.add(message);
		}
		await reloaded;
	}
</script>

<svelte:head>
	<title>{milestone.name} — Planning — DumpFire</title>
</svelte:head>

<div class="plan-page">
	<PlanHeader {summary} {milestone} {busy} {mutate} bind:picking />

	<div class="plan-body">
		{#if actionError}
			<div class="action-error">{actionError}</div>
		{/if}

		<PlanCardPicker {milestone} {busy} {mutate} bind:picking />

		<!-- ── 1. Progress ─────────────────────────────────────────────────── -->
		<PlanProgress {summary} {milestone} />

		<!-- ── Burndown: will it land by its date? ──────────────────────────── -->
		<PlanBurndown {milestone} {milestoneId} {nodes} />

		<!-- ── 2. Critical path ────────────────────────────────────────────── -->
		<CriticalPathPanel {summary} {nodeByKey} {openCard} />

		<!-- ── 3. The work ─────────────────────────────────────────────────── -->
		<WorkTable {data} {summary} {nodes} {milestone} {milestoneId} {openCard} {mutate} />


		<!-- ── 4. Dependency graph ─────────────────────────────────────────── -->
		<DependencyGraph {data} {summary} {nodes} {nodeByKey} {milestone} {openCard} />
	</div>
</div>

<Toast />

{#if cardWindow.open && cardWindow.card && modalContext}
	{#key cardWindow.edits}
	<CardModal
		card={cardWindow.card}
		categories={modalContext.categories}
		labels={modalContext.labels}
		boardId={modalContext.boardId}
		boardUsers={modalContext.boardUsers}
		milestones={modalContext.milestones}
		onSave={saveCardFromPlan}
		onClose={closeCard}
		edits={cardWindow.edits}
	/>
	{/key}
{/if}

<style>
	.plan-page { display: flex; flex-direction: column; min-height: 100vh; background: var(--bg-deep); }

	/* ─── Body & panels ────────────────────────────────────────────────── */

	/* The page's last line stops above the user badge (card 2239). */
	.plan-body {
		padding: var(--space-xl) var(--space-xl) var(--user-badge-space); max-width: 1100px; width: 100%; margin: 0 auto;
		display: flex; flex-direction: column; gap: var(--space-lg);
	}

	.action-error {
		padding: 10px 14px; font-size: 0.8rem; border-radius: var(--radius-sm);
		background: rgba(244, 63, 94, 0.1); color: var(--accent-rose);
		border: 1px solid rgba(244, 63, 94, 0.25);
	}

	/*
	 * Shared by the plan's blocks (card 2281, slice C3a-3), each a component
	 * of its own drawn in the page's body, out of reach of the page's scoped
	 * rules. None has a rule of its own over these elements that they would
	 * now outrank; the panel's frame, which would, is copied into each.
	 */
	.plan-body :global(.panel-head) {
		display: flex; align-items: baseline; gap: var(--space-md);
		flex-wrap: wrap; margin-bottom: var(--space-md);
	}
	.plan-body :global(.panel-head h2) {
		margin: 0; font-size: 0.9rem; font-weight: 700; color: var(--text-primary);
		text-transform: uppercase; letter-spacing: 0.05em;
	}
	.plan-body :global(.panel-note) { font-size: 0.74rem; color: var(--text-tertiary); line-height: 1.4; }

	/* The burndown's explanations open outside the body: PlanBurndown keeps a copy for them. */
	.plan-body :global(.muted) { margin: 0; font-size: 0.8rem; line-height: 1.55; color: var(--text-secondary); }

	.plan-body :global(.prio-dot) { width: 7px; height: 7px; border-radius: 50%; flex-shrink: 0; align-self: center; }
	.plan-body :global(.prio-critical) { background: #f43f5e; }
	.plan-body :global(.prio-high) { background: #f59e0b; }
	.plan-body :global(.prio-medium) { background: #6366f1; }
	.plan-body :global(.prio-low) { background: #64748b; }

	.plan-body :global(.card-id) {
		font-size: 0.7rem; font-weight: 700; color: var(--text-tertiary);
		font-variant-numeric: tabular-nums; flex-shrink: 0;
	}
	.plan-body :global(.card-title) {
		font-size: 0.82rem; color: var(--text-primary); min-width: 0;
		overflow: hidden; text-overflow: ellipsis; white-space: nowrap;
	}
	.plan-body :global(.card-where) {
		margin-left: auto; flex-shrink: 0; font-size: 0.68rem;
		color: var(--text-tertiary); white-space: nowrap;
	}
	.plan-body :global(.kind-tag) {
		display: inline-block; padding: 0 6px; border-radius: var(--radius-full);
		font-size: 0.6rem; font-weight: 700; text-transform: uppercase; letter-spacing: 0.04em;
		background: rgba(139, 92, 246, 0.12); color: #a78bfa;
		border: 1px solid rgba(139, 92, 246, 0.25);
	}

	@media (max-width: 720px) {
		.plan-body { padding: var(--space-md) var(--space-md) var(--user-badge-space); }
	}
</style>
