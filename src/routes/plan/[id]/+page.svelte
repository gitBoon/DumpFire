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
	 *   2. Critical path   — the one chain that cannot slip
	 *   3. The work        — every card, searchable and sortable
	 *   4. Dependency graph — the whole shape, laid out left to right
	 *
	 * Block 3 used to be three stacked lists (actionable / blocked / unordered).
	 * They were the same cards partitioned three ways and stopped being scannable
	 * at about thirty, so they are one table with a state filter instead — the
	 * partition is still there, as counts, and a specific card is now findable.
	 *
	 * Nothing here is computed in the browser. The server hands over a summary
	 * from $lib/server/planning and this file draws it, so the page and the API
	 * can never disagree about what the critical path is.
	 */
	import { invalidateAll } from '$app/navigation';
	import CardModal from '$lib/components/CardModal.svelte';
	import Toast from '$lib/components/Toast.svelte';
	import { toasts } from '$lib/stores/toast';
	import * as cardActions from '$lib/board/card-actions';
	import type { CardType } from '$lib/types';

	let { data } = $props();

	type WorkKind = 'card' | 'subtask';
	type WorkRef = { kind: WorkKind; id: number };

	type Node = WorkRef & {
		title: string;
		priority: string;
		columnTitle: string;
		boardId: number;
		boardName: string;
		isComplete: boolean;
		parentCardId?: number;
		external?: boolean;
		layer: number;
		blockedBy: WorkRef[];
		blocks: WorkRef[];
		openBlockers: WorkRef[];
		downstreamCount: number;
		onCriticalPath: boolean;
	};

	/** `card:123` / `subtask:456` — matches the server's node key exactly. */
	const key = (r: WorkRef) => `${r.kind}:${r.id}`;

	const summary = $derived(data.summary);
	const milestone = $derived(summary.milestone);
	const nodes = $derived(summary.graph.nodes as Node[]);
	const nodeByKey = $derived(new Map(nodes.map((n) => [key(n), n])));
	const criticalKeys = $derived(
		new Set((summary.criticalPathNodes as WorkRef[]).map(key))
	);

	/** Subtask nodes grouped by the card they belong to. */
	const subtasksByCard = $derived.by(() => {
		const m = new Map<number, Node[]>();
		for (const n of nodes) {
			if (n.kind !== 'subtask' || n.parentCardId === undefined) continue;
			if (!m.has(n.parentCardId)) m.set(n.parentCardId, []);
			m.get(n.parentCardId)!.push(n);
		}
		for (const list of m.values()) list.sort((a, b) => a.id - b.id);
		return m;
	});

	/** Cards whose subtask nodes are currently shown rather than rolled up. */
	let expandedCards = $state<Set<number>>(new Set());

	function toggleCardExpanded(cardId: number) {
		const next = new Set(expandedCards);
		if (next.has(cardId)) next.delete(cardId);
		else next.add(cardId);
		expandedCards = next;
	}

	let editingName = $state(false);
	let nameDraft = $state('');
	let editingTarget = $state(false);

	/**
	 * Overdue only counts while work remains. A goal finished after its target
	 * date is done, not late, and flagging it red would be nagging about
	 * something nobody can act on.
	 */
	/**
	 * Everything in the goal is done, but it has not been closed.
	 *
	 * Closing stays a deliberate act — all the cards you thought of being done is
	 * not the same as the goal being delivered, and cards can still be added — so
	 * nothing auto-closes. But "Open" next to 23/23 reads as a bug, so the chip
	 * says what the state actually is and the Close button steps forward.
	 */
	const readyToClose = $derived(
		milestone.status === 'open' &&
			summary.progress.total > 0 &&
			summary.progress.done === summary.progress.total
	);

	const targetOverdue = $derived.by(() => {
		if (!milestone.targetDate) return false;
		if (summary.progress.total > 0 && summary.progress.done === summary.progress.total) return false;
		return new Date(milestone.targetDate).setHours(0, 0, 0, 0) < new Date().setHours(0, 0, 0, 0);
	});
	let busy = $state(false);
	let actionError = $state('');

	// ─── Card picker: attach existing cards to this goal ─────────────────────

	let picking = $state(false);
	let pickQuery = $state('');
	let pickResults = $state<{ id: number; title: string; boardName: string; boardEmoji: string; columnName: string; milestoneId: number | null }[]>([]);
	let pickSearching = $state(false);
	let pickTimer: ReturnType<typeof setTimeout> | null = null;

	function onPickInput() {
		if (pickTimer) clearTimeout(pickTimer);
		const q = pickQuery.trim();
		if (!q) {
			pickResults = [];
			return;
		}
		pickSearching = true;
		pickTimer = setTimeout(async () => {
			try {
				const res = await fetch(`/api/cards/search?q=${encodeURIComponent(q)}`);
				pickResults = res.ok ? await res.json() : [];
			} finally {
				pickSearching = false;
			}
		}, 250);
	}

	async function attachCard(cardId: number) {
		await mutate({ cardId, attach: true });
		pickQuery = '';
		pickResults = [];
	}

	async function detachCard(cardId: number) {
		await mutate({ cardId, attach: false });
	}

	async function saveName() {
		const name = nameDraft.trim();
		if (!name || name === milestone.name) {
			editingName = false;
			return;
		}
		await mutate({ name });
		editingName = false;
	}

	async function toggleStatus() {
		await mutate({ status: milestone.status === 'open' ? 'closed' : 'open' });
	}

	async function setTargetDate(value: string) {
		await mutate({ targetDate: value || null });
	}

	/** One PATCH path for every edit on this page, so error handling is uniform. */
	async function mutate(body: Record<string, unknown>) {
		busy = true;
		actionError = '';
		try {
			const res = await fetch(`/api/milestones/${milestone.id}`, {
				method: 'PATCH',
				headers: { 'Content-Type': 'application/json' },
				body: JSON.stringify(body)
			});
			if (!res.ok) {
				const err = await res.json().catch(() => ({}));
				actionError = err.message || 'That change could not be saved';
				return;
			}
			await invalidateAll();
		} finally {
			busy = false;
		}
	}

	/**
	 * Reaching the board itself, for anything the modal does not cover. Kept as a
	 * deliberate act rather than the default — following a critical path used to
	 * mean a round trip to another screen for every card on it.
	 */
	function cardHref(n: { id: number; boardId: number }): string {
		return `/board/${n.boardId}?card=${n.id}`;
	}

	// ─── Card modal, opened in place ─────────────────────────────────────────

	let modalCard = $state<CardType | null>(null);
	let modalContext = $state<{
		boardId: number;
		categories: any[];
		labels: any[];
		boardUsers: { id: number; username: string; email?: string; emoji: string }[];
		milestones: any[];
	} | null>(null);
	let modalLoading = $state(false);

	/**
	 * Open a card without leaving the plan.
	 *
	 * The board page has its whole payload to hand; this view spans boards, so it
	 * fetches the one card's context on demand instead.
	 */
	async function openCard(ref: { kind?: string; id: number; parentCardId?: number }) {
		// A subtask has no card of its own — open the card it belongs to.
		const cardId = ref.kind === 'subtask' ? ref.parentCardId : ref.id;
		if (!cardId) return;

		modalLoading = true;
		try {
			const res = await fetch(`/api/cards/${cardId}/context`);
			if (!res.ok) {
				toasts.add('Could not open that card', 'error');
				return;
			}
			const ctx = await res.json();
			modalCard = ctx.card;
			modalContext = {
				boardId: ctx.boardId,
				categories: ctx.categories,
				labels: ctx.labels,
				boardUsers: ctx.boardUsers,
				milestones: ctx.milestones
			};
		} finally {
			modalLoading = false;
		}
	}

	function closeCard() {
		modalCard = null;
		modalContext = null;
	}

	/**
	 * Saving goes through the same shared card-actions path the board uses, so
	 * the two screens cannot drift on what a save does.
	 */
	async function saveCardFromPlan(cardData: Parameters<typeof cardActions.saveCard>[4]) {
		if (!modalCard || !modalContext) return;
		await cardActions.saveCard(modalCard, null, modalContext.boardId, [], cardData);
		closeCard();
		toasts.add('Card updated');
		// A column change alters what is blocked and what is startable, so the
		// plan has to be recomputed rather than patched locally.
		await invalidateAll();
	}

	function formatDate(d: string | null): string {
		if (!d) return '';
		return new Date(d).toLocaleDateString('en-GB', { day: 'numeric', month: 'short', year: 'numeric' });
	}

	// ─── The work table ──────────────────────────────────────────────────────

	type RowState = 'done' | 'ready' | 'blocked';

	interface PlanRow {
		kind: 'card' | 'subtask';
		id: number;
		title: string;
		priority: string;
		boardId: number;
		boardName: string;
		columnTitle: string;
		downstreamCount: number;
		onCriticalPath: boolean;
		state: RowState;
		blockers: { kind?: 'card' | 'subtask'; id: number; title: string; boardName: string; columnTitle: string; boardId: number }[];
		/** 0 for a card, 1 for one of its subtasks. */
		depth: number;
		parentCardId?: number;
	}

	/**
	 * One row per card in the milestone.
	 *
	 * External blockers are deliberately excluded: they are context for the
	 * graph, not scope of the goal, and listing them as rows would misreport how
	 * big the milestone is.
	 */
	const rows = $derived.by<PlanRow[]>(() => {
		const blockersByKey = new Map(
			(summary.blocked as { card: WorkRef; blockers: PlanRow['blockers'] }[]).map((b) => [
				key(b.card),
				b.blockers
			])
		);

		const toRow = (n: Node, depth: number): PlanRow => ({
			kind: n.kind,
			id: n.id,
			title: n.title,
			priority: n.priority,
			boardId: n.boardId,
			boardName: n.boardName,
			columnTitle: n.columnTitle,
			downstreamCount: n.downstreamCount,
			onCriticalPath: n.onCriticalPath,
			state: (n.isComplete ? 'done' : n.openBlockers.length > 0 ? 'blocked' : 'ready') as RowState,
			blockers: blockersByKey.get(key(n)) ?? [],
			depth,
			parentCardId: n.parentCardId
		});

		// Cards in id order, each immediately followed by its subtask rows, so an
		// indented subtask always sits under the card it belongs to regardless of
		// how the table is sorted afterwards.
		const out: PlanRow[] = [];
		for (const n of nodes.filter((x) => !x.external && x.kind === 'card')) {
			out.push(toRow(n, 0));
			for (const st of subtasksByCard.get(n.id) ?? []) {
				if (st.external) continue;
				out.push(toRow(st, 1));
			}
		}
		return out;
	});

	const stateCounts = $derived({
		all: rows.length,
		ready: rows.filter((r) => r.state === 'ready').length,
		blocked: rows.filter((r) => r.state === 'blocked').length,
		done: rows.filter((r) => r.state === 'done').length
	});

	let tableSearch = $state('');
	let stateFilter = $state<'all' | RowState>('all');
	let sortKey = $state<'id' | 'title' | 'boardName' | 'columnTitle' | 'downstreamCount' | 'state'>('id');
	let sortDir = $state<'asc' | 'desc'>('asc');
	let expandedRow = $state<string | null>(null);

	function toggleSort(key: typeof sortKey) {
		if (sortKey === key) {
			sortDir = sortDir === 'asc' ? 'desc' : 'asc';
		} else {
			sortKey = key;
			// Numbers are most useful biggest-first; everything else reads A–Z.
			sortDir = key === 'downstreamCount' ? 'desc' : 'asc';
		}
	}

	/** Blocked before ready before done, so a state sort surfaces problems. */
	const STATE_ORDER: Record<RowState, number> = { blocked: 0, ready: 1, done: 2 };

	const visibleRows = $derived.by(() => {
		const q = tableSearch.trim().toLowerCase();
		// "#123" or a bare number is an exact id match, not a substring one —
		// same rule as the board and All Tasks search, so the same thing typed in
		// three places does the same thing.
		const idMatch = q.match(/^#?(\d+)$/);

		let out = rows.filter((r) => {
			if (stateFilter !== 'all' && r.state !== stateFilter) return false;
			if (!q) return true;
			if (idMatch) return r.id === Number(idMatch[1]);
			return (
				r.title.toLowerCase().includes(q) ||
				r.boardName.toLowerCase().includes(q) ||
				String(r.id).includes(q)
			);
		});

		// A subtask that matches on its own is meaningless without the card it
		// belongs to, so pull that card in for context rather than leaving an
		// orphaned indented row.
		if (q || stateFilter !== 'all') {
			const present = new Set(out.map((r) => `${r.kind}:${r.id}`));
			const extra: PlanRow[] = [];
			for (const r of out) {
				if (r.kind !== 'subtask' || r.parentCardId === undefined) continue;
				const parentKey = `card:${r.parentCardId}`;
				if (present.has(parentKey)) continue;
				const parent = rows.find((x) => x.kind === 'card' && x.id === r.parentCardId);
				if (parent) {
					present.add(parentKey);
					extra.push(parent);
				}
			}
			out = [...out, ...extra];
		}

		const dir = sortDir === 'asc' ? 1 : -1;
		out = [...out].sort((a, b) => {
			let cmp: number;
			switch (sortKey) {
				case 'downstreamCount':
					// Numeric, not lexical — the obvious bug in a table like this.
					cmp = a.downstreamCount - b.downstreamCount;
					break;
				case 'state':
					cmp = STATE_ORDER[a.state] - STATE_ORDER[b.state];
					break;
				case 'id':
					cmp = a.id - b.id;
					break;
				default:
					cmp = String(a[sortKey]).localeCompare(String(b[sortKey]));
			}
			if (cmp !== 0) return cmp * dir;
			// Ties fall back to id, then to kind, so the order never jitters between
			// renders now that a card and a subtask can share an id.
			return a.id - b.id || a.kind.localeCompare(b.kind);
		});
		return out;
	});

	const STATE_LABEL: Record<RowState, string> = { done: 'Done', ready: 'Startable', blocked: 'Blocked' };

	// ─── Graph geometry ──────────────────────────────────────────────────────
	//
	// Laid out by hand as inline SVG rather than with a force layout: the whole
	// point of the graph is that reading left to right is reading the order the
	// work happens in, and a force layout would scramble exactly that. Nodes keep
	// a fixed size and the container scrolls, because shrinking nodes to fit 30
	// cards on screen produces something nobody can read.

	const NODE_W = 190;
	const NODE_H = 58;
	const SUB_H = 26;
	const GAP_X = 74;
	const GAP_Y = 16;
	const PAD = 24;

	/**
	 * Which node a ref is drawn as.
	 *
	 * A subtask whose card is collapsed is drawn as that card — so an edge into
	 * the subtask becomes an edge into the card, rather than pointing at nothing.
	 * Expanding the card reveals the real node and the edge follows it.
	 */
	function drawnKey(r: WorkRef): string {
		if (r.kind !== 'subtask') return key(r);
		const parent = nodeByKey.get(key(r))?.parentCardId;
		if (parent === undefined) return key(r);
		return expandedCards.has(parent) ? key(r) : key({ kind: 'card', id: parent });
	}

	/** Nodes actually drawn: every card, plus the subtasks of expanded cards. */
	const drawnNodes = $derived(
		nodes.filter((n) => n.kind === 'card' || (n.parentCardId !== undefined && expandedCards.has(n.parentCardId)))
	);

	/**
	 * Edges between drawn nodes, with collapsed subtask ends rolled up to their
	 * card. Rolling up can produce duplicates (two subtasks of the same card
	 * blocking the same thing) and self-edges (a card's subtask blocking the same
	 * card), so both are dropped here.
	 */
	const drawnEdges = $derived.by(() => {
		const seen = new Set<string>();
		const out: { from: string; to: string }[] = [];
		for (const e of summary.graph.edges as { from: WorkRef; to: WorkRef }[]) {
			const from = drawnKey(e.from);
			const to = drawnKey(e.to);
			if (from === to) continue;
			const id = `${from}->${to}`;
			if (seen.has(id)) continue;
			seen.add(id);
			out.push({ from, to });
		}
		return out;
	});

	/**
	 * Layer the drawn graph here rather than reusing the server's layers.
	 *
	 * The server layers the FULL graph; rolling collapsed subtasks up to their
	 * cards changes the edge set, and can even introduce a cycle the full graph
	 * does not have (card A's subtask blocks B while B blocks another of A's
	 * subtasks). So this is a Kahn pass over what is actually drawn, with the
	 * same stranded-node fallback the server uses rather than dropping anything.
	 */
	const layers = $derived.by(() => {
		const present = new Set(drawnNodes.map(key));
		const indeg = new Map<string, number>();
		const children = new Map<string, string[]>();
		for (const k of present) {
			indeg.set(k, 0);
			children.set(k, []);
		}
		for (const e of drawnEdges) {
			if (!present.has(e.from) || !present.has(e.to)) continue;
			children.get(e.from)!.push(e.to);
			indeg.set(e.to, (indeg.get(e.to) ?? 0) + 1);
		}

		const byKeyLocal = new Map(drawnNodes.map((n) => [key(n), n]));
		const out: Node[][] = [];
		const placed = new Set<string>();
		let frontier = [...present].filter((k) => indeg.get(k) === 0).sort();

		while (frontier.length > 0) {
			out.push(frontier.map((k) => byKeyLocal.get(k)!).filter(Boolean));
			for (const k of frontier) placed.add(k);
			const next: string[] = [];
			for (const k of frontier) {
				for (const c of children.get(k) ?? []) {
					const left = (indeg.get(c) ?? 0) - 1;
					indeg.set(c, left);
					if (left === 0) next.push(c);
				}
			}
			frontier = next.sort();
		}

		const stranded = [...present].filter((k) => !placed.has(k)).sort();
		if (stranded.length > 0) out.push(stranded.map((k) => byKeyLocal.get(k)!).filter(Boolean));

		return out.filter((l) => l.length > 0);
	});

	/** How tall a node box is — a card grows to hold its expanded subtasks. */
	function nodeHeight(n: Node): number {
		if (n.kind !== 'card' || !expandedCards.has(n.id)) return n.kind === 'subtask' ? SUB_H : NODE_H;
		const subs = subtasksByCard.get(n.id)?.length ?? 0;
		return NODE_H + (subs > 0 ? 6 + subs * (SUB_H + 4) : 0);
	}

	const positions = $derived.by(() => {
		const pos = new Map<string, { x: number; y: number; h: number }>();
		layers.forEach((layer, li) => {
			let y = PAD;
			for (const n of layer) {
				const h = nodeHeight(n);
				pos.set(key(n), { x: PAD + li * (NODE_W + GAP_X), y, h });
				// Stack by actual height so an expanded card never overlaps the node
				// underneath it.
				y += h + GAP_Y;
			}
		});
		return pos;
	});

	const graphWidth = $derived(
		layers.length === 0 ? 0 : PAD * 2 + layers.length * NODE_W + (layers.length - 1) * GAP_X
	);
	const graphHeight = $derived.by(() => {
		if (layers.length === 0) return 0;
		let tallest = 0;
		for (const layer of layers) {
			const h = layer.reduce((sum, n) => sum + nodeHeight(n) + GAP_Y, 0) - GAP_Y;
			if (h > tallest) tallest = h;
		}
		return PAD * 2 + tallest;
	});

	/**
	 * Edge path: a horizontal cubic from the right edge of the blocker to the
	 * left edge of the blocked node. Control points sit halfway across the gap so
	 * the curve leaves and arrives horizontally and never doubles back.
	 */
	function edgePath(fromKey: string, toKey: string): string {
		const a = positions.get(fromKey);
		const b = positions.get(toKey);
		if (!a || !b) return '';
		const x1 = a.x + NODE_W;
		const y1 = a.y + a.h / 2;
		const x2 = b.x;
		const y2 = b.y + b.h / 2;
		const mid = x1 + (x2 - x1) / 2;
		return `M ${x1} ${y1} C ${mid} ${y1}, ${mid} ${y2}, ${x2} ${y2}`;
	}

	/**
	 * Is this drawn edge a step along the critical path?
	 *
	 * Compared on drawn keys so a step that runs through a collapsed subtask
	 * still highlights the card it rolled up into — the chain stays followable
	 * whether or not it is expanded.
	 */
	const criticalSteps = $derived.by(() => {
		const path = (summary.criticalPathNodes as WorkRef[]).map(drawnKey);
		const steps = new Set<string>();
		for (let i = 1; i < path.length; i++) {
			if (path[i - 1] !== path[i]) steps.add(`${path[i - 1]}->${path[i]}`);
		}
		return steps;
	});

	function isCriticalEdge(fromKey: string, toKey: string): boolean {
		return criticalSteps.has(`${fromKey}->${toKey}`);
	}

	/** Trim a title to something that fits a node box on one or two lines. */
	function clip(text: string, max: number): string {
		return text.length <= max ? text : text.slice(0, max - 1).trimEnd() + '…';
	}

	const unorderedNodes = $derived(
		(summary.graph.unordered as number[])
			.map((id) => nodeByKey.get(`card:${id}`))
			.filter((n): n is Node => !!n)
	);
</script>

<svelte:head>
	<title>{milestone.name} — Planning — DumpFire</title>
</svelte:head>

<div class="plan-page">
	<header class="plan-header">
		<div class="plan-header-left">
			<a href="/plan" class="back-btn" title="All milestones" aria-label="All milestones">
				<svg width="16" height="16" viewBox="0 0 16 16" fill="none">
					<path d="M10 3L5 8l5 5" stroke="currentColor" stroke-width="1.5" stroke-linecap="round" stroke-linejoin="round"/>
				</svg>
			</a>
			<span class="plan-title-icon">🎯</span>
			{#if editingName}
				<!-- svelte-ignore a11y_autofocus -->
				<input
					class="name-input"
					bind:value={nameDraft}
					onblur={saveName}
					onkeydown={(e) => { if (e.key === 'Enter') saveName(); if (e.key === 'Escape') editingName = false; }}
					autofocus
				/>
			{:else}
				<!-- svelte-ignore a11y_no_static_element_interactions, a11y_click_events_have_key_events -->
				<h1 ondblclick={() => { nameDraft = milestone.name; editingName = true; }} title="Double-click to rename">
					{milestone.name}
				</h1>
			{/if}
			<span
				class="status-chip"
				class:open={milestone.status === 'open' && !readyToClose}
				class:ready={readyToClose}
				class:closed={milestone.status !== 'open'}
				title={readyToClose ? 'Every card in this goal is complete — close it when you are satisfied it is delivered' : ''}
			>
				{#if readyToClose}Ready to close{:else if milestone.status === 'open'}Open{:else}Closed{/if}
			</span>
		</div>

		<div class="plan-header-right">
			<!--
				The target date reads as a date until you go to change it. A permanent
				empty dd/mm/yyyy input took more room than the milestone name and said
				nothing; this says what the date IS, which is the question being asked.
			-->
			{#if editingTarget}
				<!-- svelte-ignore a11y_autofocus -->
				<input
					class="target-input"
					type="date"
					value={milestone.targetDate ?? ''}
					autofocus
					onchange={(e) => { setTargetDate((e.target as HTMLInputElement).value); editingTarget = false; }}
					onblur={() => (editingTarget = false)}
					onkeydown={(e) => { if (e.key === 'Escape') editingTarget = false; }}
				/>
			{:else}
				<button
					class="target-btn"
					class:is-set={!!milestone.targetDate}
					class:overdue={targetOverdue}
					onclick={() => (editingTarget = true)}
					title={milestone.targetDate ? 'Change the target date' : 'Set a target date'}
				>
					<svg width="13" height="13" viewBox="0 0 16 16" fill="none" aria-hidden="true">
						<rect x="2" y="3" width="12" height="11" rx="2" stroke="currentColor" stroke-width="1.3"/>
						<path d="M2 6.5h12M5.5 2v2.5M10.5 2v2.5" stroke="currentColor" stroke-width="1.3" stroke-linecap="round"/>
					</svg>
					{#if milestone.targetDate}
						{formatDate(milestone.targetDate)}
						{#if targetOverdue}<span class="overdue-tag">overdue</span>{/if}
					{:else}
						Set target
					{/if}
				</button>
			{/if}

			<a
				class="hdr-btn"
				href="/api/milestones/{milestone.id}/pdf"
				title="Download this plan as a PDF, in the same style as the board reports"
			>
				<svg width="13" height="13" viewBox="0 0 16 16" fill="none" aria-hidden="true">
					<path d="M8 2v8m0 0L5 7m3 3l3-3" stroke="currentColor" stroke-width="1.4" stroke-linecap="round" stroke-linejoin="round"/>
					<path d="M2.5 11.5v1a1 1 0 001 1h9a1 1 0 001-1v-1" stroke="currentColor" stroke-width="1.4" stroke-linecap="round"/>
				</svg>
				PDF
			</a>

			<button class="hdr-btn" class:ready={readyToClose} onclick={toggleStatus} disabled={busy}>
				{milestone.status === 'open' ? 'Close' : 'Reopen'}
			</button>

			<button class="hdr-btn primary" class:is-on={picking} onclick={() => (picking = !picking)}>
				<svg width="13" height="13" viewBox="0 0 16 16" fill="none" aria-hidden="true">
					<path d="M8 3.5v9M3.5 8h9" stroke="currentColor" stroke-width="1.6" stroke-linecap="round"/>
				</svg>
				Add cards
			</button>
		</div>
	</header>

	<div class="plan-body">
		{#if actionError}
			<div class="action-error">{actionError}</div>
		{/if}

		{#if picking}
			<section class="panel picker-panel">
				<div class="picker-row">
					<input
						class="picker-input"
						type="text"
						placeholder="Search by #id or title, across every board you can see…"
						bind:value={pickQuery}
						oninput={onPickInput}
					/>
					<button class="btn-ghost" onclick={() => { picking = false; pickQuery = ''; pickResults = []; }}>Done</button>
				</div>
				{#if pickSearching}
					<p class="muted">Searching…</p>
				{:else if pickQuery.trim() && pickResults.length === 0}
					<p class="muted">No cards match “{pickQuery.trim()}”.</p>
				{:else if pickResults.length > 0}
					<div class="picker-results">
						{#each pickResults as r}
							<button
								class="picker-result"
								disabled={r.milestoneId === milestone.id || busy}
								onclick={() => attachCard(r.id)}
							>
								<span class="card-id">#{r.id}</span>
								<span class="card-title">{r.title}</span>
								<span class="card-where">{r.boardEmoji} {r.boardName} / {r.columnName}</span>
								{#if r.milestoneId === milestone.id}
									<span class="already">already in</span>
								{:else if r.milestoneId}
									<span class="already">moves from another goal</span>
								{/if}
							</button>
						{/each}
					</div>
				{/if}
			</section>
		{/if}

		<!-- ── 1. Progress ─────────────────────────────────────────────────── -->
		<section class="panel">
			<div class="panel-head">
				<h2>Progress</h2>
				{#if milestone.targetDate}
					<span class="panel-note">Target {formatDate(milestone.targetDate)}</span>
				{/if}
			</div>

			<div class="progress-row">
				<div class="progress-track">
					<div class="progress-fill" style="width: {summary.progress.percent}%"></div>
				</div>
				<span class="progress-big">{summary.progress.percent}%</span>
			</div>

			<div class="stat-row">
				<div class="stat">
					<span class="stat-value">{summary.progress.done}/{summary.progress.total}</span>
					<span class="stat-label">cards complete</span>
				</div>
				<div class="stat">
					<span class="stat-value">{summary.nextActionable.length}</span>
					<span class="stat-label">startable now</span>
				</div>
				<div class="stat">
					<span class="stat-value">{summary.blocked.length}</span>
					<span class="stat-label">blocked</span>
				</div>
				<div class="stat">
					<span class="stat-value">{summary.progress.openSubtasks}</span>
					<span class="stat-label">open subtasks</span>
				</div>
			</div>

			<div class="chip-row">
				{#each summary.progress.byColumn as c}
					<span class="chip">{c.columnTitle} · {c.count}</span>
				{/each}
				{#each summary.progress.boards as b}
					<a class="chip board-chip" href="/board/{b.id}">{b.name} · {b.cardCount}</a>
				{/each}
			</div>
		</section>

		<!-- ── 2. Critical path ────────────────────────────────────────────── -->
		<section class="panel">
			<div class="panel-head">
				<h2>Critical path</h2>
				<span class="panel-note">The longest chain of work still to do — if any of these slips, the goal slips</span>
			</div>

			{#if summary.criticalPathNodes.length === 0}
				<p class="muted">
					No chain yet. Record what blocks what — in a card's or subtask's
					Dependencies section — and the chain that cannot slip shows up here.
				</p>
			{:else}
				<ol class="chain">
					{#each summary.criticalPathNodes as step, i}
						{@const n = nodeByKey.get(key(step))}
						{#if n}
							<li class="chain-step">
								<span class="chain-index">{i + 1}</span>
								<button class="chain-card" onclick={() => openCard(n)}>
									{#if n.kind === 'subtask'}
										<span class="kind-tag">subtask</span>
									{:else}
										<span class="card-id">#{n.id}</span>
									{/if}
									<span class="card-title">{n.title}</span>
									<span class="card-where">
										{#if n.external}<span class="ext-tag">outside this goal</span>{/if}
										{#if n.kind === 'subtask'}of #{n.parentCardId} · {/if}{n.boardName} / {n.columnTitle}
									</span>
								</button>
							</li>
						{/if}
					{/each}
				</ol>
			{/if}
		</section>

		<!-- ── 3. The work ─────────────────────────────────────────────────── -->
		<section class="panel">
			<div class="panel-head">
				<h2>The work</h2>
				<span class="panel-note">Every card in this goal — search it, sort it, see what each one is waiting on</span>
			</div>

			<div class="table-controls">
				<div class="table-search">
					<svg width="14" height="14" viewBox="0 0 14 14" fill="none" aria-hidden="true">
						<circle cx="6" cy="6" r="4.5" stroke="currentColor" stroke-width="1.5"/>
						<path d="M9.5 9.5L13 13" stroke="currentColor" stroke-width="1.5" stroke-linecap="round"/>
					</svg>
					<input type="text" placeholder="Search by #id, title or board…" bind:value={tableSearch} />
					{#if tableSearch}
						<button class="search-clear" onclick={() => (tableSearch = '')} title="Clear search">✕</button>
					{/if}
				</div>

				<!-- The three lists this table replaced, preserved as counts: the
				     partition is still readable at a glance, without scrolling
				     three sections to find out how much is blocked. -->
				<div class="state-filter">
					<button class:active={stateFilter === 'all'} onclick={() => (stateFilter = 'all')}>
						All <span class="fc">{stateCounts.all}</span>
					</button>
					<button class:active={stateFilter === 'ready'} onclick={() => (stateFilter = 'ready')}>
						Startable <span class="fc">{stateCounts.ready}</span>
					</button>
					<button class:active={stateFilter === 'blocked'} onclick={() => (stateFilter = 'blocked')}>
						Blocked <span class="fc">{stateCounts.blocked}</span>
					</button>
					<button class:active={stateFilter === 'done'} onclick={() => (stateFilter = 'done')}>
						Done <span class="fc">{stateCounts.done}</span>
					</button>
				</div>
			</div>

			{#if rows.length === 0}
				<p class="muted">No cards in this milestone yet — use “+ Add cards” above.</p>
			{:else if visibleRows.length === 0}
				<p class="muted">
					{#if tableSearch.trim()}
						Nothing matches “{tableSearch.trim()}”{#if stateFilter !== 'all'} among {stateFilter === 'ready' ? 'startable' : stateFilter} cards{/if}.
					{:else if stateFilter === 'ready'}
						Nothing is startable — every remaining card is waiting on something.
					{:else if stateFilter === 'blocked'}
						Nothing is blocked.
					{:else}
						Nothing is complete yet.
					{/if}
				</p>
			{:else}
				<div class="table-scroll">
					<table class="work-table">
						<thead>
							<tr>
								<th class="col-expand"><span class="sr-only">Blockers</span></th>
								<th class="col-id">
									<button class="sort-btn" class:sorted={sortKey === 'id'} onclick={() => toggleSort('id')}>
										ID{#if sortKey === 'id'}<span class="sort-arrow">{sortDir === 'asc' ? '▲' : '▼'}</span>{/if}
									</button>
								</th>
								<th class="col-title">
									<button class="sort-btn" class:sorted={sortKey === 'title'} onclick={() => toggleSort('title')}>
										Title{#if sortKey === 'title'}<span class="sort-arrow">{sortDir === 'asc' ? '▲' : '▼'}</span>{/if}
									</button>
								</th>
								<th class="col-board">
									<button class="sort-btn" class:sorted={sortKey === 'boardName'} onclick={() => toggleSort('boardName')}>
										Board{#if sortKey === 'boardName'}<span class="sort-arrow">{sortDir === 'asc' ? '▲' : '▼'}</span>{/if}
									</button>
								</th>
								<th class="col-col">
									<button class="sort-btn" class:sorted={sortKey === 'columnTitle'} onclick={() => toggleSort('columnTitle')}>
										Column{#if sortKey === 'columnTitle'}<span class="sort-arrow">{sortDir === 'asc' ? '▲' : '▼'}</span>{/if}
									</button>
								</th>
								<th class="col-num">
									<button class="sort-btn" class:sorted={sortKey === 'downstreamCount'} onclick={() => toggleSort('downstreamCount')}>
										Unblocks{#if sortKey === 'downstreamCount'}<span class="sort-arrow">{sortDir === 'asc' ? '▲' : '▼'}</span>{/if}
									</button>
								</th>
								<th class="col-state">
									<button class="sort-btn" class:sorted={sortKey === 'state'} onclick={() => toggleSort('state')}>
										State{#if sortKey === 'state'}<span class="sort-arrow">{sortDir === 'asc' ? '▲' : '▼'}</span>{/if}
									</button>
								</th>
								<th class="col-actions"><span class="sr-only">Actions</span></th>
							</tr>
						</thead>
						<tbody>
							{#each visibleRows as r (r.kind + ':' + r.id)}
								<tr class="row-{r.state}" class:on-critical={r.onCriticalPath} class:is-subtask={r.kind === 'subtask'}>
									<td class="col-expand">
										{#if r.blockers.length > 0}
											<button
												class="expander"
												class:open={expandedRow === r.kind + ':' + r.id}
												title={expandedRow === r.kind + ':' + r.id ? 'Hide blockers' : `Show the ${r.blockers.length} thing${r.blockers.length === 1 ? '' : 's'} this is waiting on`}
												onclick={() => (expandedRow = expandedRow === r.kind + ':' + r.id ? null : r.kind + ':' + r.id)}
											>▸</button>
										{/if}
									</td>
									<td class="col-id">
										{#if r.kind === 'card'}
											<button class="id-link" onclick={() => openCard(r)}>#{r.id}</button>
										{:else}
											<span class="sub-id" title="Subtask of #{r.parentCardId}">↳</span>
										{/if}
									</td>
									<td class="col-title" class:indented={r.depth > 0}>
										<button class="title-link" onclick={() => openCard(r)} title={r.title}>
											<span class="prio-dot prio-{r.priority}" title="Priority: {r.priority}"></span>
											<span class="title-text">{r.title}</span>
										</button>
										{#if r.onCriticalPath}<span class="crit-chip">critical path</span>{/if}
									</td>
									<td class="col-board">
										{#if r.kind === 'card'}
											<a class="board-link" href="/board/{r.boardId}">{r.boardName}</a>
										{:else}
											<span class="kind-tag">subtask</span>
										{/if}
									</td>
									<td class="col-col">{r.kind === 'card' ? r.columnTitle : ''}</td>
									<td class="col-num">
										{#if r.downstreamCount > 0}
											<span class="unblock-chip" title="Finishing this frees up {r.downstreamCount} thing{r.downstreamCount === 1 ? '' : 's'} downstream">
												{r.downstreamCount}
											</span>
										{:else}
											<span class="dash">—</span>
										{/if}
									</td>
									<td class="col-state"><span class="state-chip state-{r.state}">{STATE_LABEL[r.state]}</span></td>
									<td class="col-actions">
										{#if r.kind === 'card'}
											<button class="detach" title="Remove from this milestone" onclick={() => detachCard(r.id)}>✕</button>
										{/if}
									</td>
								</tr>
								{#if expandedRow === r.kind + ':' + r.id && r.blockers.length > 0}
									<tr class="blocker-row">
										<td></td>
										<td colspan="7">
											<div class="blocker-list">
												{#each r.blockers as blocker}
													<button class="blocker" onclick={() => openCard(blocker)}>
														waiting on
														{#if blocker.kind === 'subtask'}
															<span class="kind-tag">subtask</span>
															<span class="blocker-title">{blocker.title}</span>
														{:else}
															<span class="card-id">#{blocker.id}</span>
															<span class="blocker-title">{blocker.title}</span>
														{/if}
														<span class="card-where">{blocker.boardName} / {blocker.columnTitle}</span>
													</button>
												{/each}
											</div>
										</td>
									</tr>
								{/if}
							{/each}
						</tbody>
					</table>
				</div>
			{/if}
		</section>


		<!-- ── 4. Dependency graph ─────────────────────────────────────────── -->
		<section class="panel">
			<div class="panel-head">
				<h2>Dependency graph</h2>
				<span class="panel-note">Left to right is the order the work has to happen in</span>
			</div>

			{#if layers.length === 0}
				<p class="muted">No cards to draw yet.</p>
			{:else}
				<div class="graph-legend">
					<span class="legend-item"><span class="legend-swatch critical"></span>Critical path</span>
					<span class="legend-item"><span class="legend-swatch complete"></span>Complete</span>
					<span class="legend-item"><span class="legend-swatch blocked"></span>Blocked</span>
					<span class="legend-item"><span class="legend-swatch ready"></span>Startable</span>
					<span class="legend-item"><span class="legend-swatch external"></span>Outside this goal</span>
				</div>

				<!-- Scrolls in its own container: nodes keep a readable size and the
				     page body never scrolls sideways. -->
				<div class="graph-scroll">
					<svg width={graphWidth} height={graphHeight} role="img" aria-label="Dependency graph for {milestone.name}">
						<defs>
							<marker id="arrow" viewBox="0 0 8 8" refX="7" refY="4" markerWidth="6" markerHeight="6" orient="auto-start-reverse">
								<path d="M0 0 L8 4 L0 8 z" fill="var(--text-tertiary)" />
							</marker>
							<marker id="arrow-crit" viewBox="0 0 8 8" refX="7" refY="4" markerWidth="6" markerHeight="6" orient="auto-start-reverse">
								<path d="M0 0 L8 4 L0 8 z" fill="#f43f5e" />
							</marker>
						</defs>

						{#each drawnEdges as e}
							{@const crit = isCriticalEdge(e.from, e.to)}
							<path
								d={edgePath(e.from, e.to)}
								fill="none"
								stroke={crit ? '#f43f5e' : 'var(--text-tertiary)'}
								stroke-width={crit ? 2.2 : 1.2}
								stroke-opacity={crit ? 0.9 : 0.35}
								marker-end={crit ? 'url(#arrow-crit)' : 'url(#arrow)'}
							/>
						{/each}

						{#each drawnNodes as n (key(n))}
							{@const p = positions.get(key(n))}
							{#if p}
								{@const state = n.isComplete
									? 'complete'
									: n.external
										? 'external'
										: n.openBlockers.length > 0
											? 'blocked'
											: 'ready'}
								{@const subs = n.kind === 'card' ? (subtasksByCard.get(n.id) ?? []) : []}
								{@const isOpen = n.kind === 'card' && expandedCards.has(n.id)}
								<g class="node node-{state}" class:node-critical={n.onCriticalPath} class:node-subtask={n.kind === 'subtask'}>
									<rect x={p.x} y={p.y} width={NODE_W} height={p.h} rx={n.kind === 'subtask' ? 5 : 8} />

									{#if n.kind === 'subtask'}
										<!-- svelte-ignore a11y_click_events_have_key_events -->
										<g class="node-link" role="button" tabindex="0" onclick={() => openCard(n)}>
											<text class="node-sub-title" x={p.x + 10} y={p.y + 17}>↳ {clip(n.title, 28)}</text>
										</g>
									{:else}
										<!-- svelte-ignore a11y_click_events_have_key_events -->
										<g class="node-link" role="button" tabindex="0" onclick={() => openCard(n)}>
											<text class="node-id" x={p.x + 11} y={p.y + 19}>#{n.id}</text>
											<text class="node-col" x={p.x + NODE_W - 11} y={p.y + 19} text-anchor="end">
												{n.columnTitle}
											</text>
											<text class="node-title" x={p.x + 11} y={p.y + 37}>{clip(n.title, 26)}</text>
											<text class="node-sub" x={p.x + 11} y={p.y + 50}>
												{#if n.external}
													{clip(n.boardName, 20)} · outside goal
												{:else if n.downstreamCount > 0}
													unblocks {n.downstreamCount}
												{:else if n.isComplete}
													done
												{:else}
													{n.priority}
												{/if}
											</text>
										</g>

										{#if subs.length > 0}
											<!-- Collapsed by default: drawing every ordered subtask inline
											     would swamp a graph of any size, so the card carries a count
											     and opens on demand. The critical path is computed over the
											     full graph either way, so this is display only. -->
											<!-- svelte-ignore a11y_click_events_have_key_events -->
											<g
												class="sub-toggle"
												role="button"
												tabindex="0"
												aria-label="{isOpen ? 'Hide' : 'Show'} {subs.length} ordered subtask{subs.length === 1 ? '' : 's'}"
												onclick={() => toggleCardExpanded(n.id)}
											>
												<rect x={p.x + NODE_W - 46} y={p.y + NODE_H - 21} width="38" height="16" rx="8" />
												<text x={p.x + NODE_W - 27} y={p.y + NODE_H - 9} text-anchor="middle">
													{isOpen ? '−' : '+'}{subs.length}
												</text>
											</g>
										{/if}
									{/if}
								</g>
							{/if}
						{/each}
					</svg>
				</div>

				{#if unorderedNodes.length > 0}
					<!-- Cards nobody has sequenced must still be visible, or the plan
					     quietly under-reports what is in the goal. -->
					<div class="unordered">
						<h3>Parallel / unordered</h3>
						<p class="muted">
							In this milestone but with no dependencies recorded either way — they
							can happen at any time, or nobody has sequenced them yet.
						</p>
						<div class="card-list">
							{#each unorderedNodes as n}
								<button class="list-card" onclick={() => openCard(n)}>
									<span class="prio-dot prio-{n.priority}" title="Priority: {n.priority}"></span>
									<span class="card-id">#{n.id}</span>
									<span class="card-title">{n.title}</span>
									<span class="card-where">{n.boardName} / {n.columnTitle}</span>
								</button>
							{/each}
						</div>
					</div>
				{/if}
			{/if}
		</section>
	</div>
</div>

<Toast />

{#if modalCard && modalContext}
	<CardModal
		card={modalCard}
		categories={modalContext.categories}
		labels={modalContext.labels}
		boardId={modalContext.boardId}
		boardUsers={modalContext.boardUsers}
		milestones={modalContext.milestones}
		onSave={saveCardFromPlan}
		onClose={closeCard}
	/>
{/if}

<style>
	/* These were links until cards started opening in place. They are buttons
	   now — the browser's button defaults have to be undone so nothing shifts. */
	.chain-card,
	.title-link,
	.id-link,
	.blocker,
	button.list-card {
		appearance: none; background: none; border: none; font: inherit;
		padding: 0; text-align: left; cursor: pointer; color: inherit;
	}
	.id-link {
		padding: 0; font-size: 0.7rem; font-weight: 700; color: var(--text-tertiary);
		font-variant-numeric: tabular-nums;
	}
	.id-link:hover { color: var(--accent-indigo); }
	.chain-card:hover,
	.blocker:hover { background: var(--bg-elevated); }
	.node-link { cursor: pointer; }

	.plan-page { display: flex; flex-direction: column; min-height: 100vh; background: var(--bg-deep); }

	/* ─── Header ───────────────────────────────────────────────────────── */

	.plan-header {
		display: flex; align-items: center; justify-content: space-between;
		gap: var(--space-md); padding: var(--space-md) var(--space-xl);
		background: var(--bg-surface); border-bottom: 1px solid var(--glass-border);
		position: sticky; top: 0; z-index: 10;
	}
	.plan-header-left { display: flex; align-items: center; gap: var(--space-md); min-width: 0; flex: 1; }
	.plan-header-right { display: flex; align-items: center; gap: 6px; flex-shrink: 0; }

	.back-btn {
		display: flex; align-items: center; justify-content: center;
		width: 32px; height: 32px; border-radius: var(--radius-sm);
		color: var(--text-secondary); transition: all 0.15s; flex-shrink: 0;
	}
	.back-btn:hover { background: var(--glass-hover); color: var(--text-primary); }

	.plan-title-icon { font-size: 1.3rem; flex-shrink: 0; }

	.plan-header h1 {
		font-size: 1.1rem; font-weight: 700; color: var(--text-primary);
		letter-spacing: -0.02em; min-width: 0;
		overflow: hidden; text-overflow: ellipsis; white-space: nowrap; cursor: text;
	}

	.name-input {
		flex: 1; min-width: 0; padding: 5px 10px;
		background: var(--bg-elevated); border: 1px solid var(--accent-indigo);
		border-radius: var(--radius-sm); color: var(--text-primary);
		font-family: var(--font-family); font-size: 1.05rem; font-weight: 700;
	}
	.name-input:focus { outline: none; }

	.status-chip {
		flex-shrink: 0; padding: 1px 8px; border-radius: var(--radius-full);
		font-size: 0.62rem; font-weight: 700; text-transform: uppercase; letter-spacing: 0.04em;
	}
	.status-chip.closed {
		background: rgba(136, 136, 170, 0.12); color: var(--text-tertiary);
		border: 1px solid rgba(136, 136, 170, 0.25);
	}
	.status-chip.ready {
		background: rgba(99, 102, 241, 0.14); color: #818cf8;
		border: 1px solid rgba(99, 102, 241, 0.3); cursor: help;
	}
	/* When there is nothing left to do, closing is the obvious next action. */
	.hdr-btn.ready {
		background: rgba(99, 102, 241, 0.14); color: #818cf8;
		border-color: rgba(99, 102, 241, 0.35);
	}
	.status-chip.open {
		background: rgba(16, 185, 129, 0.12); color: var(--accent-emerald);
		border: 1px solid rgba(16, 185, 129, 0.25);
	}

	/* Header controls share one size and never wrap — the title truncates when
	   space runs out, because the controls are the part you still need. */
	.hdr-btn {
		display: inline-flex; align-items: center; gap: 5px; white-space: nowrap;
		height: 30px; padding: 0 11px;
		background: var(--bg-elevated); border: 1px solid var(--glass-border);
		border-radius: var(--radius-sm); color: var(--text-secondary);
		font-family: var(--font-family); font-size: 0.76rem; font-weight: 600;
		cursor: pointer; text-decoration: none;
		transition: all var(--duration-fast) var(--ease-out);
	}
	.hdr-btn:hover { color: var(--text-primary); border-color: var(--text-tertiary); }
	.hdr-btn:disabled { opacity: 0.5; cursor: wait; }
	.hdr-btn.primary {
		background: var(--accent-indigo); border-color: var(--accent-indigo); color: #fff;
	}
	.hdr-btn.primary:hover { filter: brightness(1.08); border-color: var(--accent-indigo); }
	.hdr-btn.primary.is-on { background: #4f46e5; }

	/* Reads as a date, becomes an input only when you go to change it. */
	.target-btn {
		display: inline-flex; align-items: center; gap: 6px; white-space: nowrap;
		height: 30px; padding: 0 11px;
		background: none; border: 1px dashed var(--glass-border);
		border-radius: var(--radius-sm); color: var(--text-tertiary);
		font-family: var(--font-family); font-size: 0.76rem; font-weight: 600;
		cursor: pointer; transition: all var(--duration-fast) var(--ease-out);
	}
	.target-btn:hover { color: var(--text-primary); border-color: var(--text-tertiary); }
	.target-btn.is-set { border-style: solid; color: var(--text-secondary); }
	.target-btn.overdue {
		background: rgba(244, 63, 94, 0.1); color: var(--accent-rose);
		border-color: rgba(244, 63, 94, 0.3); border-style: solid;
	}
	.overdue-tag {
		font-size: 0.6rem; font-weight: 700; text-transform: uppercase;
		letter-spacing: 0.04em; opacity: 0.85;
	}

	.target-input {
		height: 30px; padding: 0 9px; background: var(--bg-elevated);
		border: 1px solid var(--accent-indigo); border-radius: var(--radius-sm);
		color: var(--text-primary); font-family: var(--font-family); font-size: 0.76rem;
	}
	.target-input:focus { outline: none; }

	/* ─── Body & panels ────────────────────────────────────────────────── */

	.plan-body {
		padding: var(--space-xl); max-width: 1100px; width: 100%; margin: 0 auto;
		display: flex; flex-direction: column; gap: var(--space-lg);
	}

	.action-error {
		padding: 10px 14px; font-size: 0.8rem; border-radius: var(--radius-sm);
		background: rgba(244, 63, 94, 0.1); color: var(--accent-rose);
		border: 1px solid rgba(244, 63, 94, 0.25);
	}

	.panel {
		background: var(--bg-card); border: 1px solid var(--glass-border);
		border-radius: var(--radius-md); padding: var(--space-lg);
	}

	.panel-head {
		display: flex; align-items: baseline; gap: var(--space-md);
		flex-wrap: wrap; margin-bottom: var(--space-md);
	}
	.panel-head h2 {
		margin: 0; font-size: 0.9rem; font-weight: 700; color: var(--text-primary);
		text-transform: uppercase; letter-spacing: 0.05em;
	}
	.panel-note { font-size: 0.74rem; color: var(--text-tertiary); line-height: 1.4; }

	.muted { margin: 0; font-size: 0.8rem; line-height: 1.55; color: var(--text-secondary); }

	/* ─── Picker ───────────────────────────────────────────────────────── */

	.picker-panel { border-color: rgba(99, 102, 241, 0.35); }
	.picker-row { display: flex; gap: var(--space-sm); margin-bottom: var(--space-sm); }
	.picker-input {
		flex: 1; min-width: 0; padding: 8px 12px;
		background: var(--bg-surface); border: 1px solid var(--glass-border);
		border-radius: var(--radius-sm); color: var(--text-primary);
		font-family: var(--font-family); font-size: 0.85rem;
	}
	.picker-input:focus { outline: none; border-color: var(--accent-indigo); }

	.picker-results {
		display: flex; flex-direction: column; gap: 2px;
		max-height: 300px; overflow-y: auto;
		border: 1px solid var(--glass-border); border-radius: var(--radius-sm); padding: 3px;
	}
	.picker-result {
		display: flex; align-items: baseline; gap: 8px; width: 100%; text-align: left;
		padding: 6px 10px; background: none; border: none; cursor: pointer; font: inherit;
		border-radius: var(--radius-sm); transition: background var(--duration-fast) var(--ease-out);
	}
	.picker-result:hover:not(:disabled) { background: var(--bg-elevated); }
	.picker-result:disabled { opacity: 0.5; cursor: default; }
	.already { font-size: 0.66rem; color: var(--text-tertiary); font-style: italic; }

	/* ─── Progress ─────────────────────────────────────────────────────── */

	.progress-row { display: flex; align-items: center; gap: var(--space-md); margin-bottom: var(--space-md); }
	.progress-track {
		flex: 1; height: 10px; border-radius: var(--radius-full);
		background: rgba(136, 136, 170, 0.15); overflow: hidden;
	}
	.progress-fill {
		height: 100%; border-radius: var(--radius-full); background: var(--accent-emerald);
		transition: width var(--duration-normal) var(--ease-out);
	}
	.progress-big {
		font-size: 1.1rem; font-weight: 700; color: var(--text-primary);
		font-variant-numeric: tabular-nums; flex-shrink: 0;
	}

	.stat-row { display: flex; flex-wrap: wrap; gap: var(--space-xl); margin-bottom: var(--space-md); }
	.stat { display: flex; flex-direction: column; gap: 2px; }
	.stat-value {
		font-size: 1.25rem; font-weight: 700; color: var(--text-primary);
		font-variant-numeric: tabular-nums; line-height: 1.1;
	}
	.stat-label {
		font-size: 0.68rem; color: var(--text-tertiary);
		text-transform: uppercase; letter-spacing: 0.04em; font-weight: 600;
	}

	.chip-row { display: flex; flex-wrap: wrap; gap: 5px; }
	.chip {
		padding: 2px 9px; border-radius: var(--radius-full);
		font-size: 0.68rem; font-weight: 600; text-decoration: none;
		background: rgba(136, 136, 170, 0.1); color: var(--text-secondary);
		border: 1px solid rgba(136, 136, 170, 0.2);
	}
	.board-chip {
		background: rgba(99, 102, 241, 0.1); color: #818cf8;
		border-color: rgba(99, 102, 241, 0.22);
		transition: all var(--duration-fast) var(--ease-out);
	}
	.board-chip:hover { background: rgba(99, 102, 241, 0.2); border-color: rgba(99, 102, 241, 0.45); }

	/* ─── Chain (critical path) ────────────────────────────────────────── */

	.chain { list-style: none; margin: 0; padding: 0; display: flex; flex-direction: column; gap: 4px; }
	.chain-step { display: flex; align-items: stretch; gap: var(--space-sm); position: relative; }
	/* The connector makes the chain read as one run rather than four rows. */
	.chain-step:not(:last-child)::after {
		content: ''; position: absolute; left: 11px; top: 26px; bottom: -6px;
		width: 2px; background: rgba(244, 63, 94, 0.35);
	}
	.chain-index {
		flex-shrink: 0; width: 24px; height: 24px; border-radius: 50%;
		display: flex; align-items: center; justify-content: center;
		font-size: 0.68rem; font-weight: 700; z-index: 1;
		background: rgba(244, 63, 94, 0.14); color: var(--accent-rose);
		border: 1px solid rgba(244, 63, 94, 0.3);
	}
	.chain-card {
		flex: 1; min-width: 0; display: flex; align-items: baseline; gap: 8px;
		padding: 4px 10px; border-radius: var(--radius-sm); text-decoration: none;
		transition: background var(--duration-fast) var(--ease-out);
	}
	.chain-card:hover { background: var(--bg-elevated); }

	/* ─── The work table ───────────────────────────────────────────────── */

	.sr-only {
		position: absolute; width: 1px; height: 1px; padding: 0; margin: -1px;
		overflow: hidden; clip: rect(0 0 0 0); white-space: nowrap; border: 0;
	}

	.table-controls {
		display: flex; align-items: center; gap: var(--space-md);
		flex-wrap: wrap; margin-bottom: var(--space-md);
	}

	.table-search {
		position: relative; display: flex; align-items: center;
		flex: 1 1 260px; min-width: 0;
	}
	.table-search svg {
		position: absolute; left: 10px; color: var(--text-tertiary); pointer-events: none;
	}
	.table-search input {
		width: 100%; padding: 7px 30px 7px 32px;
		background: var(--bg-surface); border: 1px solid var(--glass-border);
		border-radius: var(--radius-full); color: var(--text-primary);
		font-family: var(--font-family); font-size: 0.82rem;
	}
	.table-search input:focus { outline: none; border-color: var(--accent-indigo); }
	.search-clear {
		position: absolute; right: 8px; width: 18px; height: 18px; padding: 0;
		display: flex; align-items: center; justify-content: center;
		background: none; border: none; cursor: pointer; font: inherit;
		font-size: 0.66rem; color: var(--text-tertiary); border-radius: 50%;
	}
	.search-clear:hover { background: var(--bg-elevated); color: var(--text-primary); }

	.state-filter {
		display: flex; flex-shrink: 0; border-radius: var(--radius-full);
		border: 1px solid var(--glass-border); overflow: hidden;
	}
	.state-filter button {
		display: inline-flex; align-items: center; gap: 5px;
		padding: 6px 12px; background: var(--bg-surface); border: none;
		border-right: 1px solid var(--glass-border);
		color: var(--text-secondary); font-family: var(--font-family);
		font-size: 0.75rem; font-weight: 600; cursor: pointer; white-space: nowrap;
		transition: all var(--duration-fast) var(--ease-out);
	}
	.state-filter button:last-child { border-right: none; }
	.state-filter button:hover { background: var(--bg-elevated); color: var(--text-primary); }
	.state-filter button.active { background: var(--accent-indigo); color: #fff; }
	.fc {
		font-variant-numeric: tabular-nums; font-size: 0.68rem;
		opacity: 0.75; font-weight: 700;
	}

	/* The table scrolls here, never the page body. */
	.table-scroll {
		overflow-x: auto;
		border: 1px solid var(--glass-border); border-radius: var(--radius-sm);
	}

	.work-table { width: 100%; border-collapse: collapse; font-size: 0.8rem; }

	.work-table thead th {
		position: sticky; top: 0; z-index: 1;
		background: var(--bg-surface); text-align: left;
		border-bottom: 1px solid var(--glass-border);
		padding: 0; white-space: nowrap;
	}

	.sort-btn {
		display: inline-flex; align-items: center; gap: 4px;
		width: 100%; padding: 8px 10px;
		background: none; border: none; cursor: pointer; font: inherit;
		font-size: 0.68rem; font-weight: 700; text-transform: uppercase;
		letter-spacing: 0.04em; color: var(--text-tertiary); text-align: left;
		transition: color var(--duration-fast) var(--ease-out);
	}
	.sort-btn:hover { color: var(--text-primary); }
	.sort-btn.sorted { color: var(--accent-indigo); }
	.sort-arrow { font-size: 0.55rem; }

	.work-table tbody tr { border-bottom: 1px solid var(--glass-border); }
	.work-table tbody tr:last-child { border-bottom: none; }
	.work-table tbody tr:hover { background: var(--bg-elevated); }
	.work-table td { padding: 7px 10px; vertical-align: middle; }

	/* Done rows step back so open work reads first; the critical path keeps the
	   same red marker it has in the chain and the graph. */
	.work-table tbody tr.row-done { opacity: 0.55; }
	.work-table tbody tr.on-critical td:first-child { box-shadow: inset 3px 0 0 var(--accent-rose); }

	.col-expand { width: 26px; }
	.col-id { width: 64px; }
	.col-id a {
		font-size: 0.72rem; font-weight: 700; color: var(--text-tertiary);
		font-variant-numeric: tabular-nums; text-decoration: none;
	}
	.col-id a:hover { color: var(--accent-indigo); }

	.col-title { max-width: 0; width: 45%; }
	.title-link {
		display: inline-flex; align-items: center; gap: 7px; max-width: 100%;
		text-decoration: none; color: var(--text-primary); vertical-align: middle;
	}
	.title-text { overflow: hidden; text-overflow: ellipsis; white-space: nowrap; }
	.title-link:hover .title-text { color: var(--accent-indigo); }

	.col-board { width: 130px; }
	.board-link {
		font-size: 0.74rem; color: var(--text-secondary); text-decoration: none;
		overflow: hidden; text-overflow: ellipsis; white-space: nowrap; display: block;
	}
	.board-link:hover { color: var(--accent-indigo); }

	.col-col { width: 96px; font-size: 0.74rem; color: var(--text-tertiary); white-space: nowrap; }
	.col-num { width: 82px; text-align: center; font-variant-numeric: tabular-nums; }
	.dash { color: var(--text-tertiary); opacity: 0.5; }
	.col-state { width: 96px; }
	.col-actions { width: 34px; }

	.state-chip {
		display: inline-block; padding: 1px 8px; border-radius: var(--radius-full);
		font-size: 0.64rem; font-weight: 700; white-space: nowrap;
	}
	.state-ready {
		background: rgba(99, 102, 241, 0.12); color: #818cf8;
		border: 1px solid rgba(99, 102, 241, 0.28);
	}
	.state-blocked {
		background: rgba(245, 158, 11, 0.14); color: #f59e0b;
		border: 1px solid rgba(245, 158, 11, 0.3);
	}
	.state-done {
		background: rgba(16, 185, 129, 0.12); color: var(--accent-emerald);
		border: 1px solid rgba(16, 185, 129, 0.25);
	}

	.expander {
		width: 20px; height: 20px; padding: 0;
		display: flex; align-items: center; justify-content: center;
		background: none; border: none; cursor: pointer; font: inherit;
		font-size: 0.7rem; color: #f59e0b; border-radius: var(--radius-sm);
		transition: transform var(--duration-fast) var(--ease-out);
	}
	.expander:hover { background: rgba(245, 158, 11, 0.15); }
	.expander.open { transform: rotate(90deg); }

	/* Subtask rows sit under their card, indented, and slightly recessed so a
	   card row still reads as the top-level thing. */
	.work-table tbody tr.is-subtask { background: rgba(139, 92, 246, 0.035); }
	.work-table tbody tr.is-subtask:hover { background: rgba(139, 92, 246, 0.08); }
	.col-title.indented { padding-left: 26px; }
	.sub-id { color: #a78bfa; font-size: 0.8rem; }
	.kind-tag {
		display: inline-block; padding: 0 6px; border-radius: var(--radius-full);
		font-size: 0.6rem; font-weight: 700; text-transform: uppercase; letter-spacing: 0.04em;
		background: rgba(139, 92, 246, 0.12); color: #a78bfa;
		border: 1px solid rgba(139, 92, 246, 0.25);
	}

	.blocker-row { background: rgba(245, 158, 11, 0.04); }
	.blocker-row td { padding: 4px 10px 8px; }

	@media (max-width: 900px) {
		/* Board and column are the first things worth losing on a narrow screen —
		   id, title and state are what the table is actually for. */
		.col-board, .col-col { display: none; }
	}

	/* ─── Card lists ───────────────────────────────────────────────────── */

	.card-list { display: flex; flex-direction: column; gap: 4px; }

	.list-card {
		display: flex; align-items: baseline; gap: 8px;
		padding: 7px 10px; text-decoration: none;
		background: var(--bg-surface); border: 1px solid var(--glass-border);
		border-radius: var(--radius-sm);
		transition: all var(--duration-fast) var(--ease-out);
	}
	.list-card:hover { border-color: var(--accent-indigo); }
	.list-card.on-critical { border-left: 3px solid var(--accent-rose); }

	.prio-dot { width: 7px; height: 7px; border-radius: 50%; flex-shrink: 0; align-self: center; }
	.prio-critical { background: #f43f5e; }
	.prio-high { background: #f59e0b; }
	.prio-medium { background: #6366f1; }
	.prio-low { background: #64748b; }

	.card-id {
		font-size: 0.7rem; font-weight: 700; color: var(--text-tertiary);
		font-variant-numeric: tabular-nums; flex-shrink: 0;
	}
	.card-title {
		font-size: 0.82rem; color: var(--text-primary); min-width: 0;
		overflow: hidden; text-overflow: ellipsis; white-space: nowrap;
	}
	.card-where {
		margin-left: auto; flex-shrink: 0; font-size: 0.68rem;
		color: var(--text-tertiary); white-space: nowrap;
	}
	.ext-tag { font-style: italic; margin-right: 4px; }

	.unblock-chip {
		flex-shrink: 0; padding: 1px 7px; border-radius: var(--radius-full);
		font-size: 0.64rem; font-weight: 700;
		background: rgba(16, 185, 129, 0.12); color: var(--accent-emerald);
		border: 1px solid rgba(16, 185, 129, 0.25);
	}
	.crit-chip {
		flex-shrink: 0; padding: 1px 7px; border-radius: var(--radius-full);
		font-size: 0.64rem; font-weight: 700;
		background: rgba(244, 63, 94, 0.12); color: var(--accent-rose);
		border: 1px solid rgba(244, 63, 94, 0.25);
	}

	.detach {
		flex-shrink: 0; width: 20px; height: 20px; padding: 0; align-self: center;
		display: flex; align-items: center; justify-content: center;
		background: none; border: none; cursor: pointer; font: inherit;
		font-size: 0.68rem; color: var(--text-tertiary); border-radius: var(--radius-sm);
		opacity: 0; transition: all var(--duration-fast) var(--ease-out);
	}
	.list-card:hover .detach { opacity: 1; }
	.detach:hover { background: rgba(244, 63, 94, 0.15); color: var(--accent-rose); }

	/* ─── Blocked groups ───────────────────────────────────────────────── */

	.blocked-group { display: flex; flex-direction: column; gap: 3px; margin-bottom: 6px; }
	.blocker-list { display: flex; flex-direction: column; gap: 2px; padding-left: var(--space-lg); }
	.blocker {
		display: flex; align-items: baseline; gap: 6px;
		padding: 3px 10px; text-decoration: none; border-radius: var(--radius-sm);
		font-size: 0.72rem; color: var(--text-tertiary);
		border-left: 2px solid rgba(245, 158, 11, 0.35);
		transition: background var(--duration-fast) var(--ease-out);
	}
	.blocker:hover { background: var(--bg-elevated); }
	.blocker-title {
		color: var(--text-secondary); min-width: 0;
		overflow: hidden; text-overflow: ellipsis; white-space: nowrap;
	}

	/* ─── Graph ────────────────────────────────────────────────────────── */

	.graph-legend { display: flex; flex-wrap: wrap; gap: var(--space-md); margin-bottom: var(--space-md); }
	.legend-item {
		display: inline-flex; align-items: center; gap: 5px;
		font-size: 0.68rem; color: var(--text-tertiary); font-weight: 600;
	}
	.legend-swatch { width: 12px; height: 12px; border-radius: 3px; border: 1.5px solid; }
	.legend-swatch.critical { background: rgba(244, 63, 94, 0.15); border-color: #f43f5e; }
	.legend-swatch.complete { background: rgba(16, 185, 129, 0.12); border-color: var(--accent-emerald); }
	.legend-swatch.blocked { background: rgba(245, 158, 11, 0.12); border-color: #f59e0b; }
	.legend-swatch.ready { background: rgba(99, 102, 241, 0.12); border-color: var(--accent-indigo); }
	.legend-swatch.external { background: rgba(136, 136, 170, 0.1); border-color: rgba(136, 136, 170, 0.5); }

	/* Wide graphs scroll here, never on the page body. */
	.graph-scroll {
		overflow-x: auto; overflow-y: hidden; padding-bottom: var(--space-sm);
		border: 1px solid var(--glass-border); border-radius: var(--radius-sm);
		background: var(--bg-surface);
	}

	/* Subtask nodes: smaller, indented visually by their shorter box, and
	   dashed-free so they read as 'inside' rather than 'elsewhere'. */
	.node-subtask rect { stroke-dasharray: none; }
	.node-sub-title { font-size: 10.5px; fill: var(--text-primary); }

	.sub-toggle { cursor: pointer; }
	.sub-toggle rect {
		fill: rgba(139, 92, 246, 0.16); stroke: rgba(139, 92, 246, 0.45); stroke-width: 1;
	}
	.sub-toggle text {
		font-size: 9.5px; font-weight: 700; fill: #a78bfa;
		font-family: var(--font-family); pointer-events: none;
	}
	.sub-toggle:hover rect { fill: rgba(139, 92, 246, 0.3); }

	.node-link { text-decoration: none; }
	.node rect {
		fill: var(--bg-card); stroke: rgba(136, 136, 170, 0.35); stroke-width: 1.5;
		transition: stroke-width 0.12s ease-out;
	}
	.node:hover rect { stroke-width: 2.5; }

	.node-ready rect { stroke: var(--accent-indigo); fill: rgba(99, 102, 241, 0.07); }
	.node-blocked rect { stroke: #f59e0b; fill: rgba(245, 158, 11, 0.07); }
	.node-complete rect { stroke: var(--accent-emerald); fill: rgba(16, 185, 129, 0.07); }
	/* Greyed, as the card asks: done work should recede so the open chain reads. */
	.node-complete text { opacity: 0.55; }
	.node-external rect { stroke: rgba(136, 136, 170, 0.5); stroke-dasharray: 4 3; }
	.node-critical rect { stroke: #f43f5e; stroke-width: 2.5; fill: rgba(244, 63, 94, 0.07); }

	.node text { font-family: var(--font-family); }
	.node-id { font-size: 10px; font-weight: 700; fill: var(--text-tertiary); }
	.node-col { font-size: 9px; font-weight: 600; fill: var(--text-tertiary); }
	.node-title { font-size: 12px; font-weight: 600; fill: var(--text-primary); }
	.node-sub { font-size: 9.5px; fill: var(--text-tertiary); }

	.unordered { margin-top: var(--space-lg); }
	.unordered h3 {
		margin: 0 0 4px; font-size: 0.78rem; font-weight: 700;
		color: var(--text-secondary); text-transform: uppercase; letter-spacing: 0.05em;
	}
	.unordered .muted { margin-bottom: var(--space-sm); }

	@media (max-width: 720px) {
		.plan-header { flex-wrap: wrap; }
		.plan-body { padding: var(--space-md); }
		.stat-row { gap: var(--space-lg); }
	}
</style>
