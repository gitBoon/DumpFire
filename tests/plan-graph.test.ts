/**
 * The plan page's dependency graph, its geometry: `src/lib/plan-graph.ts`
 * (card 2281, slice C3a-3), moved out of the plan page, where each part was a
 * `$derived` or a function of the page, into plain functions.
 *
 * The layouts pinned here were read from HEAD's page before the move, drawn in
 * jsdom with the same two graphs (each node's box and each edge's path, as
 * the SVG had them), so these cases are evidence the move kept them: a chain
 * with a short cut and a card left alone; and a card whose subtasks block and
 * wait on other cards, collapsed (a cycle once rolled up, so every node is
 * stranded into one layer, with duplicate and self edges dropped) and opened
 * (its box grown to hold them). The graph component wires these functions as
 * `wire` does below; `tests/plan-page.test.ts` draws the same graphs through
 * the page and reads the SVG.
 */
import { describe, expect, it } from 'vitest';
import {
	clip,
	criticalSteps,
	drawnEdges,
	drawnKey,
	drawnNodes,
	edgePath,
	graphHeight,
	graphWidth,
	isCriticalEdge,
	key,
	layers,
	nodeHeight,
	positions,
	type Node,
	type WorkRef
} from '$lib/plan-graph';

const card = (id: number): Node => ({
	kind: 'card', id, title: `Card ${id}`, priority: 'low', columnTitle: 'To Do', boardId: 3, boardName: 'Website', isComplete: false,
	withheld: false, layer: 0, blockedBy: [], blocks: [], openBlockers: [], downstreamCount: 0, onCriticalPath: false
});
const sub = (id: number, parentCardId: number): Node => ({ ...card(id), kind: 'subtask', title: `Sub ${id}`, parentCardId });
const ref = (kind: 'card' | 'subtask', id: number): WorkRef => ({ kind, id });

/** The two graphs HEAD's page was drawn with. */
const GRAPHS = {
	chain: {
		nodes: [card(1), card(2), card(3), card(4)],
		edges: [
			{ from: ref('card', 1), to: ref('card', 2) },
			{ from: ref('card', 2), to: ref('card', 3) },
			{ from: ref('card', 1), to: ref('card', 3) }
		],
		criticalPathNodes: [ref('card', 1), ref('card', 2), ref('card', 3)]
	},
	subtasks: {
		nodes: [card(10), sub(101, 10), sub(102, 10), card(11), card(12)],
		edges: [
			{ from: ref('subtask', 101), to: ref('card', 11) },
			{ from: ref('card', 11), to: ref('subtask', 102) },
			{ from: ref('subtask', 102), to: ref('card', 12) },
			{ from: ref('subtask', 101), to: ref('card', 12) },
			{ from: ref('subtask', 101), to: ref('subtask', 102) }
		],
		criticalPathNodes: [ref('subtask', 101), ref('card', 11), ref('subtask', 102), ref('card', 12)]
	}
};

/**
 * What HEAD's page drew: the SVG's size, each node's box as `first text, x, y,
 * height`, each edge as `crit|plain` and its path, in the order drawn.
 */
const DRAWN = {
	chain: {
		width: 766,
		height: 180,
		nodes: ['#1 24 24 58', '#2 288 24 58', '#3 552 24 58', '#4 24 98 58'],
		edges: ['crit M 214 53 C 251 53, 251 53, 288 53', 'crit M 478 53 C 515 53, 515 53, 552 53', 'plain M 214 53 C 383 53, 383 53, 552 53']
	},
	subtasks: {
		width: 238,
		height: 254,
		nodes: ['#10 24 24 58', '#11 24 98 58', '#12 24 172 58'],
		edges: ['crit M 214 53 C 119 53, 119 127, 24 127', 'crit M 214 127 C 119 127, 119 53, 24 53', 'crit M 214 53 C 119 53, 119 201, 24 201']
	},
	'subtasks opened': {
		width: 1030,
		height: 214,
		nodes: ['#10 24 24 124', '↳ Sub 101 24 164 26', '↳ Sub 102 552 24 26', '#11 288 24 58', '#12 816 24 58'],
		edges: [
			'crit M 214 177 C 251 177, 251 53, 288 53',
			'crit M 478 53 C 515 53, 515 37, 552 37',
			'crit M 742 37 C 779 37, 779 53, 816 53',
			'plain M 214 177 C 515 177, 515 53, 816 53',
			'plain M 214 177 C 383 177, 383 37, 552 37'
		]
	}
};

/** The functions wired as the graph component wires them, over one graph with the cards in `opened` open. */
function wire(graph: (typeof GRAPHS)['chain'], opened: number[] = []) {
	const nodes = graph.nodes;
	const summary = { graph: { edges: graph.edges }, criticalPathNodes: graph.criticalPathNodes };
	const nodeByKey = new Map(nodes.map((n) => [key(n), n]));
	const expandedCards = new Set(opened);
	const subtasksByCard = new Map<number, Node[]>();
	for (const n of nodes) if (n.kind === 'subtask' && n.parentCardId !== undefined) subtasksByCard.set(n.parentCardId, [...(subtasksByCard.get(n.parentCardId) ?? []), n]);

	const keyOf = (r: WorkRef) => drawnKey(r, nodeByKey, expandedCards);
	const height = (n: Node) => nodeHeight(n, expandedCards, subtasksByCard);
	const drawn = drawnNodes(nodes, expandedCards);
	const edges = drawnEdges(summary, keyOf);
	const laid = layers(drawn, edges);
	const at = positions(laid, height);
	const steps = criticalSteps(summary, keyOf);
	return {
		width: graphWidth(laid),
		height: graphHeight(laid, height),
		// The first text of a node: its id, or a subtask's arrow and title.
		nodes: drawn.map((n) => {
			const p = at.get(key(n))!;
			return `${n.kind === 'subtask' ? `↳ ${clip(n.title, 28)}` : `#${n.id}`} ${p.x} ${p.y} ${p.h}`;
		}),
		edges: edges.map((e) => `${isCriticalEdge(e.from, e.to, steps) ? 'crit' : 'plain'} ${edgePath(e.from, e.to, at)}`),
		laid,
		edgeList: edges
	};
}

describe('the plan page’s graph, laid out as HEAD’s page laid it out (card 2281, slice C3a-3)', () => {
	it('a chain with a short cut, and a card on its own: layered left to right, the lone card under the first', () => {
		const { width, height, nodes, edges } = wire(GRAPHS.chain);
		expect({ width, height, nodes, edges }).toEqual(DRAWN.chain);
	});

	it('a card whose subtasks block and wait on other cards, collapsed: rolled up into a cycle, every node stranded into one layer', () => {
		const { width, height, nodes, edges, laid, edgeList } = wire(GRAPHS.subtasks);
		expect({ width, height, nodes, edges }).toEqual(DRAWN.subtasks);
		expect(laid.map((layer) => layer.map(key))).toEqual([['card:10', 'card:11', 'card:12']]);
		// Five edges, rolled up: the subtask-to-subtask one becomes card 10 to itself and the two into card 12 one.
		expect(edgeList).toEqual([
			{ from: 'card:10', to: 'card:11' },
			{ from: 'card:11', to: 'card:10' },
			{ from: 'card:10', to: 'card:12' }
		]);
	});

	it('the same card opened: its box grown to hold its two subtasks, each drawn where its edges put it', () => {
		const { width, height, nodes, edges } = wire(GRAPHS.subtasks, [10]);
		expect({ width, height, nodes, edges }).toEqual(DRAWN['subtasks opened']);
	});

	it('draws a subtask of a collapsed card as its card, and an empty graph at no size', () => {
		const nodeByKey = new Map(GRAPHS.subtasks.nodes.map((n) => [key(n), n]));
		expect(drawnKey(ref('subtask', 101), nodeByKey, new Set())).toBe('card:10');
		expect(drawnKey(ref('subtask', 101), nodeByKey, new Set([10]))).toBe('subtask:101');
		// A subtask the plan does not have stays itself.
		expect(drawnKey(ref('subtask', 999), nodeByKey, new Set())).toBe('subtask:999');
		expect(graphWidth([])).toBe(0);
		expect(graphHeight([], () => 58)).toBe(0);
		expect(edgePath('card:1', 'card:2', new Map())).toBe('');
	});

	it('clips a title to fit a node box', () => {
		expect(clip('Short', 26)).toBe('Short');
		expect(clip('A title that runs on past the box', 12)).toBe('A title tha…');
		// A space where it is cut is not kept before the ellipsis.
		expect(clip('Ends in a space here', 9)).toBe('Ends in…');
	});
});
