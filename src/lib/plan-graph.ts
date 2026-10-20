/**
 * The plan page's dependency graph: its nodes and how each is drawn, laid
 * out left to right (card 2281, slice C3a-3: moved from
 * src/routes/plan/[id]/+page.svelte, where each was a `$derived` or a
 * function of the page). Plain functions, no runes: the graph component,
 * $lib/components/plan/DependencyGraph.svelte, derives each from what it
 * draws, and hands in what the page's code read from around it under the
 * same name (the cards opened, the nodes by key, the layers), so each body
 * is the page's, unchanged.
 */

export type WorkKind = 'card' | 'subtask';
export type WorkRef = { kind: WorkKind; id: number };

export type Node = WorkRef & {
	title: string;
	priority: string | null;
	columnTitle: string;
	boardId: number | null;
	boardName: string;
	isComplete: boolean;
	parentCardId?: number;
	external?: boolean;
	/**
	 * On a board the viewer cannot open: the title and board are text put in
	 * their place, and it is drawn with no link and no board or column (card 2129).
	 */
	withheld: boolean;
	layer: number;
	blockedBy: WorkRef[];
	blocks: WorkRef[];
	openBlockers: WorkRef[];
	downstreamCount: number;
	onCriticalPath: boolean;
};

/** `card:123` / `subtask:456` — matches the server's node key exactly. */
export const key = (r: WorkRef) => `${r.kind}:${r.id}`;

// ─── Graph geometry ──────────────────────────────────────────────────────
//
// Laid out by hand as inline SVG rather than with a force layout: the whole
// point of the graph is that reading left to right is reading the order the
// work happens in, and a force layout would scramble exactly that. Nodes keep
// a fixed size and the container scrolls, because shrinking nodes to fit 30
// cards on screen produces something nobody can read.

export const NODE_W = 190;
export const NODE_H = 58;
export const SUB_H = 26;
export const GAP_X = 74;
export const GAP_Y = 16;
export const PAD = 24;

/**
 * Which node a ref is drawn as.
 *
 * A subtask whose card is collapsed is drawn as that card — so an edge into
 * the subtask becomes an edge into the card, rather than pointing at nothing.
 * Expanding the card reveals the real node and the edge follows it.
 */
export function drawnKey(r: WorkRef, nodeByKey: ReadonlyMap<string, Node>, expandedCards: ReadonlySet<number>): string {
	if (r.kind !== 'subtask') return key(r);
	const parent = nodeByKey.get(key(r))?.parentCardId;
	if (parent === undefined) return key(r);
	return expandedCards.has(parent) ? key(r) : key({ kind: 'card', id: parent });
}

/** Nodes actually drawn: every card, plus the subtasks of expanded cards. */
export const drawnNodes = (nodes: Node[], expandedCards: ReadonlySet<number>): Node[] => (
	nodes.filter((n) => n.kind === 'card' || (n.parentCardId !== undefined && expandedCards.has(n.parentCardId)))
);

/**
 * Edges between drawn nodes, with collapsed subtask ends rolled up to their
 * card. Rolling up can produce duplicates (two subtasks of the same card
 * blocking the same thing) and self-edges (a card's subtask blocking the same
 * card), so both are dropped here.
 */
export function drawnEdges(summary: { graph: { edges: unknown[] } }, drawnKey: (r: WorkRef) => string): { from: string; to: string }[] {
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
}

/**
 * Layer the drawn graph here rather than reusing the server's layers.
 *
 * The server layers the FULL graph; rolling collapsed subtasks up to their
 * cards changes the edge set, and can even introduce a cycle the full graph
 * does not have (card A's subtask blocks B while B blocks another of A's
 * subtasks). So this is a Kahn pass over what is actually drawn, with the
 * same stranded-node fallback the server uses rather than dropping anything.
 */
export function layers(drawnNodes: Node[], drawnEdges: { from: string; to: string }[]): Node[][] {
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
}

/** How tall a node box is — a card grows to hold its expanded subtasks. */
export function nodeHeight(n: Node, expandedCards: ReadonlySet<number>, subtasksByCard: ReadonlyMap<number, Node[]>): number {
	if (n.kind !== 'card' || !expandedCards.has(n.id)) return n.kind === 'subtask' ? SUB_H : NODE_H;
	const subs = subtasksByCard.get(n.id)?.length ?? 0;
	return NODE_H + (subs > 0 ? 6 + subs * (SUB_H + 4) : 0);
}

/** Where each drawn node sits, its layer for its column and stacked by height in it. */
export function positions(layers: Node[][], nodeHeight: (n: Node) => number): Map<string, { x: number; y: number; h: number }> {
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
}

export const graphWidth = (layers: Node[][]): number => (
	layers.length === 0 ? 0 : PAD * 2 + layers.length * NODE_W + (layers.length - 1) * GAP_X
);
export function graphHeight(layers: Node[][], nodeHeight: (n: Node) => number): number {
	if (layers.length === 0) return 0;
	let tallest = 0;
	for (const layer of layers) {
		const h = layer.reduce((sum, n) => sum + nodeHeight(n) + GAP_Y, 0) - GAP_Y;
		if (h > tallest) tallest = h;
	}
	return PAD * 2 + tallest;
}

/**
 * Edge path: a horizontal cubic from the right edge of the blocker to the
 * left edge of the blocked node. Control points sit halfway across the gap so
 * the curve leaves and arrives horizontally and never doubles back.
 */
export function edgePath(fromKey: string, toKey: string, positions: ReadonlyMap<string, { x: number; y: number; h: number }>): string {
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
export function criticalSteps(summary: { criticalPathNodes: unknown[] }, drawnKey: (r: WorkRef) => string): Set<string> {
	const path = (summary.criticalPathNodes as WorkRef[]).map(drawnKey);
	const steps = new Set<string>();
	for (let i = 1; i < path.length; i++) {
		if (path[i - 1] !== path[i]) steps.add(`${path[i - 1]}->${path[i]}`);
	}
	return steps;
}

export function isCriticalEdge(fromKey: string, toKey: string, criticalSteps: ReadonlySet<string>): boolean {
	return criticalSteps.has(`${fromKey}->${toKey}`);
}

/** Trim a title to something that fits a node box on one or two lines. */
export function clip(text: string, max: number): string {
	return text.length <= max ? text : text.slice(0, max - 1).trimEnd() + '…';
}
