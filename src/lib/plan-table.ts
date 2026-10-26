/**
 * The work table of a milestone's plan page, worked out with no DOM (card 2221).
 *
 * The page (`src/routes/plan/[id]/+page.svelte`) lists every card of the goal,
 * one row each, collapsed. A card the viewer opens shows every one of its
 * subtasks under it, in the card's own order. Which rows are drawn, in what
 * order, and what a search or the state filter does to them is decided here,
 * so that `tests/plan-table.test.ts` can call it: a page cannot be run there.
 *
 * A subtask row is one of two kinds:
 *   - ordered: the subtask carries a dependency, so it is a node of the plan's
 *     graph, with a state (Startable, Blocked or Done), its blockers, its
 *     Unblocks count and whether it is on the critical path;
 *   - plain: it is in no plan, and is Done or Open and nothing more.
 *
 * Nothing here works out a plan. The states, blockers and counts are the
 * server's (`getMilestoneSummary`); this only arranges them into rows.
 */

export type WorkKind = 'card' | 'subtask';
export type WorkRef = { kind: WorkKind; id: number };

/**
 * One subtask of a card the caller can open, as the page load gives it
 * (`planSubtasks` in `$lib/server/planning`): a card's list is in its own
 * order, by `position` and then id, as the card window has it. Its card is
 * the key of the record it is listed under, so it does not say it again.
 */
export interface PlanSubtask {
	id: number;
	title: string;
	priority: string;
	completed: boolean;
}

/** What the table reads of a node of the plan's graph. */
export interface TableNode extends WorkRef {
	title: string;
	priority: string | null;
	columnTitle: string;
	boardId: number | null;
	boardName: string;
	isComplete: boolean;
	/**
	 * An option, or a subtask of one: in an Options column or on an ideas
	 * board (milestone 22, the summary's `isOption`). Never startable, nor
	 * waiting: it is no work anyone has committed to.
	 */
	isOption?: boolean;
	parentCardId?: number;
	external?: boolean;
	/** On a board the viewer cannot open (card 2129). */
	withheld: boolean;
	openBlockers: WorkRef[];
	downstreamCount: number;
	onCriticalPath: boolean;
}

/** One thing a blocked row is waiting on, as the summary's `blocked` lists it. */
export interface PlanBlocker {
	kind?: WorkKind;
	id: number;
	title: string;
	boardName: string;
	columnTitle: string;
	boardId: number | null;
	withheld: boolean;
}

/**
 * Startable, Blocked and Done are the plan's states. Open is a plain subtask
 * not yet ticked. Option is a card in an Options column or on an ideas board,
 * or an ordered subtask of one, not ticked (milestone 22): never startable or
 * blocked, as the server never offers it to start nor lists it as waiting.
 */
export type RowState = 'done' | 'ready' | 'blocked' | 'open' | 'option';
export type StateFilter = 'all' | 'ready' | 'blocked' | 'done' | 'option';
export type SortKey = 'id' | 'title' | 'boardName' | 'columnTitle' | 'downstreamCount' | 'state';

export interface PlanRow {
	kind: WorkKind;
	id: number;
	title: string;
	priority: string | null;
	boardId: number | null;
	boardName: string;
	columnTitle: string;
	withheld: boolean;
	downstreamCount: number;
	onCriticalPath: boolean;
	state: RowState;
	blockers: PlanBlocker[];
	/** 0 for a card, 1 for one of its subtasks. */
	depth: number;
	parentCardId?: number;
	/** A card, or an ordered subtask: a node of the plan, whose state the filter and the counts read. */
	inGraph: boolean;
	/** On a card row, how many of its subtasks are ticked and how many it has. 0 on a subtask row. */
	subtaskDone: number;
	subtaskTotal: number;
}

/** A card's row and its subtask rows, in the card's order. */
export interface CardGroup {
	card: PlanRow;
	subtasks: PlanRow[];
}

/** A row as drawn. `expanded` is true on a card row whose subtask rows follow it. */
export type TableRow = PlanRow & { expanded: boolean };

/** `card:123` / `subtask:456`: the server's node key. */
const key = (r: WorkRef) => `${r.kind}:${r.id}`;

/**
 * Every card of the milestone with its subtask rows.
 *
 * External nodes are left out: they are context for the graph, not scope of
 * the goal, and listing them as rows would misreport how big it is. A card's
 * subtasks are the page load's list, in its order; one that is a node of the
 * graph is drawn from the node, so it keeps its state, blockers and Unblocks.
 * A withheld card has no list (the load gives none), so it has no subtasks.
 */
export function cardGroups(
	nodes: TableNode[],
	blocked: { card: WorkRef; blockers: PlanBlocker[] }[],
	subtasks: Record<number, PlanSubtask[]>
): CardGroup[] {
	const blockersByKey = new Map(blocked.map((b) => [key(b.card), b.blockers]));

	const nodeRow = (n: TableNode, depth: number): PlanRow => ({
		kind: n.kind,
		id: n.id,
		title: n.title,
		priority: n.priority,
		boardId: n.boardId,
		boardName: n.boardName,
		columnTitle: n.columnTitle,
		withheld: n.withheld,
		downstreamCount: n.downstreamCount,
		onCriticalPath: n.onCriticalPath,
		state: n.isComplete ? 'done' : n.isOption ? 'option' : n.openBlockers.length > 0 ? 'blocked' : 'ready',
		blockers: blockersByKey.get(key(n)) ?? [],
		depth,
		parentCardId: n.parentCardId,
		inGraph: true,
		subtaskDone: 0,
		subtaskTotal: 0
	});

	const plainRow = (st: PlanSubtask, card: TableNode): PlanRow => ({
		kind: 'subtask',
		id: st.id,
		title: st.title,
		priority: st.priority,
		boardId: card.boardId,
		boardName: card.boardName,
		columnTitle: card.columnTitle,
		withheld: false,
		downstreamCount: 0,
		onCriticalPath: false,
		state: st.completed ? 'done' : 'open',
		blockers: [],
		depth: 1,
		parentCardId: card.id,
		inGraph: false,
		subtaskDone: 0,
		subtaskTotal: 0
	});

	// Ordered subtasks by the card they belong to. A withheld one has no
	// parent card, so it is under none, as it is in the graph.
	const orderedByCard = new Map<number, Map<number, TableNode>>();
	for (const n of nodes) {
		if (n.kind !== 'subtask' || n.external || n.parentCardId === undefined) continue;
		if (!orderedByCard.has(n.parentCardId)) orderedByCard.set(n.parentCardId, new Map());
		orderedByCard.get(n.parentCardId)!.set(n.id, n);
	}

	return nodes
		.filter((n) => !n.external && n.kind === 'card')
		.map((n) => {
			const ordered = orderedByCard.get(n.id) ?? new Map<number, TableNode>();
			const rows: PlanRow[] = [];
			const drawn = new Set<number>();
			for (const st of subtasks[n.id] ?? []) {
				const node = ordered.get(st.id);
				rows.push(node ? nodeRow(node, 1) : plainRow(st, n));
				drawn.add(st.id);
			}
			// An ordered subtask the list does not hold would be one added between
			// the summary's read and the list's. Both reads are synchronous in one
			// tick of the same load (better-sqlite3), so no write runs between
			// them: this cannot normally happen, and nor can a card moved between
			// them to a board the viewer cannot open leak a subtask. It is kept so
			// that such a subtask would still be drawn under its card, after the rest.
			for (const node of [...ordered.values()].filter((o) => !drawn.has(o.id)).sort((a, b) => a.id - b.id)) {
				rows.push(nodeRow(node, 1));
			}
			const card = nodeRow(n, 0);
			card.subtaskTotal = rows.length;
			card.subtaskDone = rows.filter((r) => r.state === 'done').length;
			return { card, subtasks: rows };
		});
}

/**
 * A card's subtask nodes in the graph, in the card's own order (card 2223): by
 * where each stands in `listed`, the card's list from the page load (position,
 * then id), and a node the list does not hold after the rest, by id, as
 * `cardGroups` places such a row. The graph sorted them by id, so a subtask
 * moved to the top by a `PUT` of its `position` stayed where it was there
 * while the table moved it.
 */
export function orderSubtaskNodes<T extends { id: number }>(nodes: readonly T[], listed: readonly { id: number }[] | undefined): T[] {
	const at = new Map((listed ?? []).map((s, i) => [s.id, i]));
	const rank = (n: T) => at.get(n.id) ?? Infinity;
	return [...nodes].sort((a, b) => rank(a) - rank(b) || a.id - b.id);
}

/**
 * The state filter's counts: cards and ordered subtasks, as they were before a
 * card could be opened to its plain subtasks, which have no Startable or
 * Blocked and are never what a filter finds. `option` counts the options
 * (milestone 22), 0 for a goal with none.
 */
export function stateCounts(groups: CardGroup[]): { all: number; ready: number; blocked: number; done: number; option: number } {
	const rows = groups.flatMap((g) => [g.card, ...g.subtasks.filter((s) => s.inGraph)]);
	return {
		all: rows.length,
		ready: rows.filter((r) => r.state === 'ready').length,
		blocked: rows.filter((r) => r.state === 'blocked').length,
		done: rows.filter((r) => r.state === 'done').length,
		option: rows.filter((r) => r.state === 'option').length
	};
}

/** Blocked before ready before options before done, so a state sort surfaces problems. */
const STATE_ORDER: Record<RowState, number> = { blocked: 0, ready: 1, open: 1, option: 2, done: 3 };

export interface TableOptions {
	query: string;
	stateFilter: StateFilter;
	sortKey: SortKey;
	sortDir: 'asc' | 'desc';
	/** The cards the viewer opened: those remembered, and those opened for this view. */
	open: ReadonlySet<number>;
	/**
	 * The cards the viewer closed under the search or filter in force, opened
	 * or not otherwise: drawn closed. The page keeps it for that search and
	 * filter only (`afterToggle`, `afterExpandAll`).
	 */
	shut?: ReadonlySet<number>;
}

/**
 * The rows to draw, in order: each card that is listed, followed by its
 * subtask rows when it is drawn open.
 *
 *   - A card is listed when it matches, or when one of its subtasks does.
 *   - A card's subtasks are drawn when the viewer opened it, or when a search
 *     or the state filter is in force and one of its subtasks matches, unless
 *     the viewer closed it under that search. What is remembered is not
 *     changed by a search.
 *   - Inside an open card, under a search or filter, all its subtasks are drawn
 *     when the card itself matches, otherwise only the ones that match.
 *   - A subtask matches a search on its title. Its board is its card's, which
 *     the card matches on. Only an ordered subtask has a state the filter reads.
 *   - `#123` or a bare number matches a card's id only: no subtask id is shown.
 *   - The sort orders the cards. A card's subtasks follow it in its own order.
 */
export function tableRows(groups: CardGroup[], opts: TableOptions): TableRow[] {
	const q = opts.query.trim().toLowerCase();
	// "#123" or a bare number is an exact id match, not a substring one: the
	// same rule as the board and All Tasks search.
	const idMatch = q.match(/^#?(\d+)$/);
	const filtering = q !== '' || opts.stateFilter !== 'all';
	const shut = opts.shut ?? new Set<number>();

	const cardMatches = (r: PlanRow): boolean => {
		if (opts.stateFilter !== 'all' && r.state !== opts.stateFilter) return false;
		if (!q) return true;
		if (idMatch) return r.id === Number(idMatch[1]);
		return r.title.toLowerCase().includes(q) || r.boardName.toLowerCase().includes(q);
	};
	const subtaskMatches = (r: PlanRow): boolean => {
		if (opts.stateFilter !== 'all' && (!r.inGraph || r.state !== opts.stateFilter)) return false;
		if (!q) return true;
		if (idMatch) return false;
		return r.title.toLowerCase().includes(q);
	};

	const listed: { card: PlanRow; subtasks: PlanRow[]; expanded: boolean }[] = [];
	for (const g of groups) {
		const matching = filtering ? g.subtasks.filter(subtaskMatches) : [];
		const cardHit = !filtering || cardMatches(g.card);
		if (!cardHit && matching.length === 0) continue;
		const expanded =
			g.subtasks.length > 0 &&
			!shut.has(g.card.id) &&
			(opts.open.has(g.card.id) || matching.length > 0);
		listed.push({ card: g.card, subtasks: !expanded ? [] : cardHit ? g.subtasks : matching, expanded });
	}

	const dir = opts.sortDir === 'asc' ? 1 : -1;
	const sortKey = opts.sortKey;
	listed.sort((x, y) => {
		const a = x.card;
		const b = y.card;
		let cmp: number;
		switch (sortKey) {
			case 'downstreamCount':
				// Numeric, not lexical: the obvious bug in a table like this.
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
		// Ties fall back to id, so the order never jitters between renders.
		return a.id - b.id;
	});

	return listed.flatMap((l) => [
		{ ...l.card, expanded: l.expanded },
		...l.subtasks.map((s) => ({ ...s, expanded: false }))
	]);
}

/**
 * What the viewer has opened and closed.
 *
 *   - `stored`: the cards opened while nothing was searched or filtered,
 *     remembered in this browser. Only a toggle or Expand all made with
 *     nothing filtered changes it; otherwise it is given back as it came, the
 *     same object, and the page writes nothing.
 *   - `viewOpen`, `viewShut`: the cards opened and closed under the search
 *     and filter in force, for that view only. The page forgets them when the
 *     search or filter changes.
 */
export interface OpenCards {
	stored: ReadonlySet<number>;
	viewOpen: ReadonlySet<number>;
	viewShut: ReadonlySet<number>;
}

/** The view's sets emptied: what a toggle with nothing filtered leaves. */
const noView = (stored: ReadonlySet<number>): OpenCards => ({ stored, viewOpen: new Set(), viewShut: new Set() });

/**
 * A card's subtask button pressed. With nothing filtered it opens or closes
 * the card and that is remembered. Under a search or filter it does so for
 * that view alone: a card closed there is shut, never taken out of what is
 * remembered, and a card opened there is not added to it.
 */
export function afterToggle(s: OpenCards, row: { id: number; expanded: boolean }, filtering: boolean): OpenCards {
	if (!filtering) {
		const stored = new Set(s.stored);
		if (row.expanded) stored.delete(row.id);
		else stored.add(row.id);
		return noView(stored);
	}
	const viewOpen = new Set(s.viewOpen);
	const viewShut = new Set(s.viewShut);
	if (row.expanded) {
		viewOpen.delete(row.id);
		viewShut.add(row.id);
	} else {
		viewShut.delete(row.id);
		viewOpen.add(row.id);
	}
	return { stored: s.stored, viewOpen, viewShut };
}

/**
 * What Expand all / Collapse all acts on: the cards drawn that have subtasks,
 * and whether every one of them is drawn open, which makes it Collapse all.
 * It follows what is drawn, so under a search it is about the cards listed.
 */
export function expandAllTargets(rows: TableRow[]): { ids: number[]; allOpen: boolean } {
	const cardsDrawn = rows.filter((r) => r.kind === 'card' && r.subtaskTotal > 0 && !r.withheld);
	return { ids: cardsDrawn.map((r) => r.id), allOpen: cardsDrawn.length > 0 && cardsDrawn.every((r) => r.expanded) };
}

/**
 * Expand all or Collapse all pressed, `rows` being what is drawn. With
 * nothing filtered, every card with subtasks is opened, or every card closed,
 * and that is remembered. Under a search or filter, the cards listed are
 * opened or shut for that view alone, and nothing remembered changes.
 */
export function afterExpandAll(s: OpenCards, rows: TableRow[], filtering: boolean): OpenCards {
	const { ids, allOpen } = expandAllTargets(rows);
	if (!filtering) return noView(allOpen ? new Set() : new Set([...s.stored, ...ids]));
	const viewOpen = new Set(s.viewOpen);
	const viewShut = new Set(s.viewShut);
	for (const id of ids) {
		if (allOpen) {
			viewOpen.delete(id);
			viewShut.add(id);
		} else {
			viewShut.delete(id);
			viewOpen.add(id);
		}
	}
	return { stored: s.stored, viewOpen, viewShut };
}

/**
 * What the plan page's burndown is drawn from, as one string: the milestone,
 * its target date, and each of its cards with its board and whether it is
 * done. Closing the card window re-reads the plan after any write the plan
 * draws (card 2324), a subtask ticked among them, and the summary is then a
 * new object even when none of this changed; the page fetches
 * the burndown again only when this string changes. A subtask ticked, or a
 * card moved between two open columns, leaves it as it was, as it leaves the
 * burndown.
 */
export function burndownKey(
	milestone: { id: number; targetDate: string | null },
	nodes: Pick<TableNode, 'kind' | 'id' | 'boardId' | 'isComplete' | 'external'>[]
): string {
	const memberCards = nodes
		.filter((n) => n.kind === 'card' && !n.external)
		.map((n) => `${n.id}@${n.boardId ?? '-'}${n.isComplete ? ':done' : ''}`)
		.sort();
	return `${milestone.id}|${milestone.targetDate ?? ''}|${memberCards.join(',')}`;
}

/** Where a browser remembers which cards of a milestone are open. */
export function openCardsKey(milestoneId: number): string {
	return `df-plan-open-${milestoneId}`;
}

/** The cards remembered open, from what was stored. Anything else reads as none open. */
export function readOpenCards(stored: string | null): Set<number> {
	if (!stored) return new Set();
	try {
		const value: unknown = JSON.parse(stored);
		if (!Array.isArray(value)) return new Set();
		return new Set(value.filter((id): id is number => Number.isInteger(id) && id > 0));
	} catch {
		return new Set();
	}
}

/** What to store: the open cards still in the milestone, so a card that left it is dropped. */
export function openCardsToStore(open: ReadonlySet<number>, groups: CardGroup[]): string {
	const inMilestone = new Set(groups.map((g) => g.card.id));
	return JSON.stringify([...open].filter((id) => inMilestone.has(id)).sort((a, b) => a - b));
}
