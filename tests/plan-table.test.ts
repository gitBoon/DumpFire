/**
 * A milestone's plan page opens each card of its work table to every one of
 * its subtasks, collapsed by default (card 2221).
 *
 *   - The table listed only the subtasks that carry a dependency, the nodes of
 *     the plan's graph, and always showed them. A card now opens to all of its
 *     subtasks, in its own order (`position`, then id), and is closed until
 *     the viewer opens it. What they open is remembered in their browser.
 *   - Sorting separated a subtask row from its card: the sort ran over every
 *     row. It orders the cards now, and a card's subtasks follow it.
 *   - A search or the state filter that a subtask matches lists its card and
 *     opens it. `#123` matches a card's id only.
 *   - The page load gives the subtasks of every card the caller can open,
 *     beside the summary and not in it, in one read; a card on a board they
 *     cannot open is withheld and gives none (card 2129).
 *
 * A page cannot be run here: no browser, no DOM. What it draws is worked out
 * by `src/lib/plan-table.ts`, called directly with what the page load gives
 * through `pageLoad()`; what the page does with it is read from its source.
 *
 * The plan is `docs/planning/card-plan-page-subtasks.md` (section 6).
 */
import { readdirSync, readFileSync } from 'node:fs';
import { join } from 'node:path';
import ts from 'typescript';
import { beforeEach, describe, expect, it } from 'vitest';
import { eq } from 'drizzle-orm';
import { db } from '$lib/server/db';
import { cards, milestones, subtasks as subtaskTable, type Card, type Subtask } from '$lib/server/db/schema';
import type { SessionUser } from '$lib/server/auth';
import { getMilestoneSummary, planSubtasks } from '$lib/server/planning';
import {
	afterExpandAll,
	afterToggle,
	burndownKey,
	cardGroups,
	expandAllTargets,
	openCardsKey,
	openCardsToStore,
	readOpenCards,
	stateCounts,
	tableRows,
	type CardGroup,
	type OpenCards,
	type TableOptions,
	type TableRow
} from '$lib/plan-table';
import { pageLoad } from './helpers/actions';
import { api } from './helpers/api';
import {
	addBoardMember,
	makeBoard,
	makeCard,
	makeDependency,
	makeMilestone,
	makeSubtask,
	makeUser,
	resetDb,
	type BoardFixture
} from './helpers/fixtures';
import { watchReads } from './helpers/reads';

const PAGE = 'src/routes/plan/[id]/+page.svelte';
/**
 * The page's blocks, components of their own since card 2281's slice C3a-3:
 * the work table, the progress block and the burndown, which hold what the
 * pins below read, and the rest, where none of it may be instead.
 */
const PLAN = 'src/lib/components/plan';
const WORK_TABLE = `${PLAN}/WorkTable.svelte`;
const PROGRESS = `${PLAN}/PlanProgress.svelte`;
const BURNDOWN = `${PLAN}/PlanBurndown.svelte`;
const PLAN_FILES = [
	PAGE,
	...readdirSync(join(process.cwd(), PLAN)).filter((name) => name.endsWith('.svelte')).map((name) => `${PLAN}/${name}`),
	// The graph's geometry, a module of its own.
	'src/lib/plan-graph.ts'
];
/** In every title of the moved card and its subtasks: what the viewer must never be given. */
const MARK_B = 'ZQX-ON-BOARD-B';

let owner: SessionUser;
let viewer: SessionUser;
let A: BoardFixture;
let B: BoardFixture;
let a1: Card;
let a2: Card;
let a3: Card;
/** a1's subtasks, as made: p1 plain and done, o1 ordered, p2 plain, o2 ordered and waiting on o1. */
let p1: Subtask, o1: Subtask, p2: Subtask, o2: Subtask;
/** a3's subtasks: b1 ordered, b2 ordered and waiting on b1, b3 plain. */
let b1: Subtask, b2: Subtask, b3: Subtask;
let milestoneId: number;

/**
 * Board A with a milestone of three cards: a1 with four subtasks, made in an
 * order that is not their `position` order (two at 0, as the API makes them),
 * a2 with none and waiting on a1, and a3, moved to board B after it joined
 * the milestone, which it keeps (card 2129, R4). `viewer` can open A, not B.
 */
beforeEach(() => {
	resetDb();
	owner = makeUser({ username: 'owner' });
	viewer = makeUser({ username: 'viewer' });
	A = makeBoard({ owner, name: 'Board A' });
	B = makeBoard({ owner, name: `${MARK_B} board` });
	addBoardMember(A.board, viewer, 'viewer');

	a1 = makeCard(A.cols['To Do'], { title: 'Alpha card' });
	a2 = makeCard(A.cols['To Do'], { title: 'Mike card' });
	a3 = makeCard(A.cols['To Do'], { title: `${MARK_B} moved card` });

	p1 = makeSubtask(a1, { title: 'Plain done step', position: 2, completed: true });
	o1 = makeSubtask(a1, { title: 'Ordered first step', position: 0, priority: 'high' });
	p2 = makeSubtask(a1, { title: 'Plain open zebra step', position: 0 });
	o2 = makeSubtask(a1, { title: 'Ordered second step', position: 3 });
	makeDependency({ blocked: o2, blocker: o1 });
	makeDependency({ blocked: a2, blocker: a1 });

	b1 = makeSubtask(a3, { title: `${MARK_B} ordered one`, position: 0 });
	b2 = makeSubtask(a3, { title: `${MARK_B} ordered two`, position: 1 });
	b3 = makeSubtask(a3, { title: `${MARK_B} plain`, position: 2 });
	makeDependency({ blocked: b2, blocker: b1 });

	milestoneId = makeMilestone({ board: A.board, name: 'The goal', createdBy: owner, cards: [a1, a2, a3] }).id;
	db.update(cards).set({ columnId: B.cols['To Do'].id }).where(eq(cards.id, a3.id)).run();
});

async function planData(user: SessionUser) {
	const res = await pageLoad(`/plan/${milestoneId}`, { user });
	if (res.type !== 'data') throw new Error(`the plan page answered ${JSON.stringify(res)}`);
	return res.data;
}

/** The work table's groups, from what the page load gives `user`, as the page makes them. */
async function groupsFor(user: SessionUser): Promise<CardGroup[]> {
	const data = await planData(user);
	return cardGroups(data.summary.graph.nodes, data.summary.blocked, data.subtasks);
}

const NONE: TableOptions = { query: '', stateFilter: 'all', sortKey: 'id', sortDir: 'asc', open: new Set() };
const ids = (rows: TableRow[]) => rows.map((r) => `${r.kind}:${r.id}`);
const card = (c: { id: number }) => `card:${c.id}`;
const sub = (s: { id: number }) => `subtask:${s.id}`;
/** a1's subtasks in its own order: by position (0, 0, 2, 3), then id. */
const A1_ORDER = () => [sub(o1), sub(p2), sub(p1), sub(o2)];

describe('the work table, collapsed by default', () => {
	it('gives card rows only when nothing is open and nothing searched, each with its count of subtasks', async () => {
		const rows = tableRows(await groupsFor(owner), NONE);
		expect(ids(rows)).toEqual([card(a1), card(a2), card(a3)]);
		expect(rows.every((r) => !r.expanded)).toBe(true);

		const byId = new Map(rows.map((r) => [r.id, r]));
		expect(byId.get(a1.id)).toMatchObject({ subtaskDone: 1, subtaskTotal: 4 });
		expect(byId.get(a2.id)).toMatchObject({ subtaskDone: 0, subtaskTotal: 0 });
		// To the owner, who can open board B, the moved card has its three.
		expect(byId.get(a3.id)).toMatchObject({ subtaskDone: 0, subtaskTotal: 3 });
	});

	it('shows every subtask of an open card under it, in its order, the plain ones Done or Open and the ordered ones as the plan has them', async () => {
		const rows = tableRows(await groupsFor(owner), { ...NONE, open: new Set([a1.id]) });
		expect(ids(rows)).toEqual([card(a1), ...A1_ORDER(), card(a2), card(a3)]);

		const byKey = new Map(rows.map((r) => [`${r.kind}:${r.id}`, r]));
		expect(byKey.get(card(a1))!.expanded).toBe(true);
		expect(byKey.get(sub(p1))).toMatchObject({ state: 'done', inGraph: false, blockers: [], downstreamCount: 0, depth: 1, parentCardId: a1.id });
		expect(byKey.get(sub(p2))).toMatchObject({ state: 'open', inGraph: false, blockers: [], downstreamCount: 0, parentCardId: a1.id });
		expect(byKey.get(sub(o1))).toMatchObject({ state: 'ready', inGraph: true, downstreamCount: 1, priority: 'high', parentCardId: a1.id });
		expect(byKey.get(sub(o2))).toMatchObject({ state: 'blocked', inGraph: true, parentCardId: a1.id });
		expect(byKey.get(sub(o2))!.blockers.map((b) => b.id)).toEqual([o1.id]);
		// A plain subtask's place is its card's, so a click opens that card.
		expect(byKey.get(sub(p2))).toMatchObject({ boardId: A.board.id, boardName: 'Board A' });
	});

	it('keeps every subtask under its own card, in its order, whatever the sort', async () => {
		const groups = await groupsFor(owner);
		const open = new Set([a1.id, a3.id]);
		const subsOf = (rows: TableRow[], cardId: number) => {
			const at = rows.findIndex((r) => r.kind === 'card' && r.id === cardId);
			const out: TableRow[] = [];
			for (let i = at + 1; i < rows.length && rows[i].kind === 'subtask'; i++) out.push(rows[i]);
			return out;
		};

		const byTitle = tableRows(groups, { ...NONE, open, sortKey: 'title', sortDir: 'desc' });
		expect(byTitle.filter((r) => r.kind === 'card').map((r) => r.id)).toEqual([a3.id, a2.id, a1.id]);
		expect(ids(subsOf(byTitle, a1.id))).toEqual(A1_ORDER());
		expect(subsOf(byTitle, a3.id)).toHaveLength(3);
		expect(byTitle).toHaveLength(3 + 4 + 3);

		for (const sortDir of ['asc', 'desc'] as const) {
			const byState = tableRows(groups, { ...NONE, open, sortKey: 'state', sortDir });
			expect(ids(subsOf(byState, a1.id))).toEqual(A1_ORDER());
			expect(subsOf(byState, a3.id)).toHaveLength(3);
			expect(byState).toHaveLength(3 + 4 + 3);
		}
	});
});

describe('a search and the state filter', () => {
	it("list a card and open it, with that subtask alone, when only a plain subtask's title matches, and remember nothing", async () => {
		const groups = await groupsFor(owner);
		const open = new Set<number>();
		const rows = tableRows(groups, { ...NONE, query: 'ZEBRA', open });
		expect(ids(rows)).toEqual([card(a1), sub(p2)]);
		expect(rows[0].expanded).toBe(true);
		expect(open.size).toBe(0);

		// Cleared: closed again.
		expect(ids(tableRows(groups, { ...NONE, open }))).toEqual([card(a1), card(a2), card(a3)]);
	});

	it("draw all of an open card's subtasks when the card's own title matches", async () => {
		const groups = await groupsFor(owner);
		expect(ids(tableRows(groups, { ...NONE, query: 'alpha', open: new Set([a1.id]) }))).toEqual([card(a1), ...A1_ORDER()]);
		// Not open, and no subtask matches: the card alone.
		expect(ids(tableRows(groups, { ...NONE, query: 'alpha' }))).toEqual([card(a1)]);
	});

	it('leave a card closed that the viewer closed under that search', async () => {
		const groups = await groupsFor(owner);
		const rows = tableRows(groups, { ...NONE, query: 'zebra', shut: new Set([a1.id]) });
		expect(ids(rows)).toEqual([card(a1)]);
		expect(rows[0].expanded).toBe(false);
	});

	it('Blocked: the blocked ordered subtask under its card, opened; a plain subtask never matches a state', async () => {
		const groups = await groupsFor(owner);
		// a1 is startable, o2 blocked: a1 listed for o2 and opened with it alone.
		// a2 is blocked itself, with no subtasks. a3 is startable, b2 blocked.
		expect(ids(tableRows(groups, { ...NONE, stateFilter: 'blocked' }))).toEqual([card(a1), sub(o2), card(a2), card(a3), sub(b2)]);
		// p1 is a plain subtask that is ticked: Done does not find it, so its
		// card, which is not done, is not listed.
		expect(ids(tableRows(groups, { ...NONE, stateFilter: 'done' }))).toEqual([]);
		// Startable: a1 and a3 match themselves, and o1 and b1 open them, with
		// all their subtasks, the plain ones too, because the card matches.
		expect(ids(tableRows(groups, { ...NONE, stateFilter: 'ready' }))).toEqual([
			card(a1),
			...A1_ORDER(),
			card(a3),
			sub(b1),
			sub(b2),
			sub(b3)
		]);
	});

	it("match a card's id only with #<id> or a bare number, never a subtask's", async () => {
		const groups = await groupsFor(owner);
		const cardIds = new Set([a1.id, a2.id, a3.id]);
		const lone = [p1, o1, p2, o2].find((s) => !cardIds.has(s.id));
		expect(lone, 'a subtask whose id is no card id').toBeDefined();
		expect(tableRows(groups, { ...NONE, query: `#${lone!.id}` })).toEqual([]);
		expect(tableRows(groups, { ...NONE, query: String(lone!.id) })).toEqual([]);
		expect(ids(tableRows(groups, { ...NONE, query: `#${a2.id}` }))).toEqual([card(a2)]);
	});
});

describe('the counts and Expand all', () => {
	it('count the cards and the ordered subtasks, as before, and not the plain ones', async () => {
		const data = await planData(owner);
		const groups = cardGroups(data.summary.graph.nodes, data.summary.blocked, data.subtasks);
		// What the table counted before card 2221: every card and ordered subtask of the goal.
		const before = (data.summary.graph.nodes as { kind: string; external?: boolean; parentCardId?: number }[]).filter(
			(n) => !n.external && (n.kind === 'card' || n.parentCardId !== undefined)
		);
		// No option in this goal (milestone 22): its count is 0.
		expect(stateCounts(groups)).toEqual({ all: before.length, ready: 4, blocked: 3, done: 0, option: 0 });
		expect(before).toHaveLength(7);
	});

	it('open every card with a subtask, and the cards remembered are those still in the milestone', async () => {
		const groups = await groupsFor(owner);
		expect(expandAllTargets(tableRows(groups, NONE))).toEqual({ ids: [a1.id, a3.id], allOpen: false });

		expect(openCardsKey(milestoneId)).toBe(`df-plan-open-${milestoneId}`);
		expect(openCardsToStore(new Set([a3.id, 99999, a1.id]), groups)).toBe(JSON.stringify([a1.id, a3.id]));
		expect([...readOpenCards(JSON.stringify([a1.id, a3.id]))]).toEqual([a1.id, a3.id]);
		for (const stored of [null, '', 'not json', '{"a":1}', '"5"', '[1.5,"2",-3,0,null]']) {
			expect([...readOpenCards(stored)], String(stored)).toEqual([]);
		}
	});
});

describe('opening and closing under a search or filter', () => {
	const state = (stored: number[] = [], viewOpen: number[] = [], viewShut: number[] = []): OpenCards => ({
		stored: new Set(stored),
		viewOpen: new Set(viewOpen),
		viewShut: new Set(viewShut)
	});
	/** The options the page passes for a state: what is remembered and what is open for the view, less what is shut. */
	const optsFor = (s: OpenCards, more: Partial<TableOptions> = {}): TableOptions => ({
		...NONE,
		...more,
		open: new Set([...s.stored, ...s.viewOpen]),
		shut: s.viewShut
	});

	it('draws a remembered card closed once it is shut for the view', async () => {
		const groups = await groupsFor(owner);
		const rows = tableRows(groups, { ...NONE, query: 'card', open: new Set([a1.id]), shut: new Set([a1.id]) });
		expect(rows.find((r) => r.id === a1.id && r.kind === 'card')!.expanded).toBe(false);
		expect(rows.filter((r) => r.kind === 'subtask')).toEqual([]);
	});

	it('closes a remembered card under a search for that view alone, and never takes it out of what is stored', async () => {
		const groups = await groupsFor(owner);
		const before = state([a1.id]);
		const rows = tableRows(groups, optsFor(before, { query: 'alpha' }));
		expect(rows[0]).toMatchObject({ id: a1.id, expanded: true });

		const after = afterToggle(before, rows[0], true);
		expect(after.stored).toBe(before.stored);
		expect([...after.stored]).toEqual([a1.id]);
		expect([...after.viewShut]).toEqual([a1.id]);
		expect(ids(tableRows(groups, optsFor(after, { query: 'alpha' })))).toEqual([card(a1)]);

		// Opened again under the search: for the view, still nothing stored.
		const reopened = afterToggle(after, { id: a1.id, expanded: false }, true);
		expect(reopened.stored).toBe(before.stored);
		expect([...reopened.viewOpen]).toEqual([a1.id]);
		expect(reopened.viewShut.size).toBe(0);

		// With nothing filtered the toggle is remembered, and the view is dropped.
		const plain = afterToggle(before, { id: a1.id, expanded: true }, false);
		expect(plain.stored).not.toBe(before.stored);
		expect([...plain.stored]).toEqual([]);
		expect(plain.viewShut.size + plain.viewOpen.size).toBe(0);
	});

	it('labels Expand all by what is drawn, and acts on it for the view without storing anything', async () => {
		const groups = await groupsFor(owner);
		const before = state();
		// "zebra" lists a1 alone, drawn open by the search: Collapse all, though a3 is closed.
		const zebra = tableRows(groups, optsFor(before, { query: 'zebra' }));
		expect(expandAllTargets(zebra)).toEqual({ ids: [a1.id], allOpen: true });

		const collapsed = afterExpandAll(before, zebra, true);
		expect(collapsed.stored).toBe(before.stored);
		const after = tableRows(groups, optsFor(collapsed, { query: 'zebra' }));
		expect(ids(after)).toEqual([card(a1)]);
		expect(expandAllTargets(after)).toEqual({ ids: [a1.id], allOpen: false });

		// Blocked lists a1 and a3, each opened by a blocked subtask, and a2, which has none.
		const blocked = tableRows(groups, optsFor(before, { stateFilter: 'blocked' }));
		expect(expandAllTargets(blocked)).toEqual({ ids: [a1.id, a3.id], allOpen: true });

		// A card listed for its own title, not open: Expand all opens it for the view.
		const alpha = tableRows(groups, optsFor(before, { query: 'alpha' }));
		expect(expandAllTargets(alpha)).toEqual({ ids: [a1.id], allOpen: false });
		const expanded = afterExpandAll(before, alpha, true);
		expect(expanded.stored).toBe(before.stored);
		expect(ids(tableRows(groups, optsFor(expanded, { query: 'alpha' })))).toEqual([card(a1), ...A1_ORDER()]);

		// With nothing filtered: every card with subtasks, remembered; then none.
		const all = afterExpandAll(before, tableRows(groups, optsFor(before)), false);
		expect([...all.stored]).toEqual([a1.id, a3.id]);
		expect([...afterExpandAll(all, tableRows(groups, optsFor(all)), false).stored]).toEqual([]);
	});
});

describe('the burndown is fetched again only when the work it charts changes', () => {
	const keyFor = async () => {
		const data = await planData(owner);
		return burndownKey(data.summary.milestone, data.summary.graph.nodes);
	};

	it('is the same after a re-read with nothing changed, a subtask ticked, or a card moved between open columns', async () => {
		const first = await keyFor();
		expect(await keyFor()).toBe(first);

		db.update(subtaskTable).set({ completed: true }).where(eq(subtaskTable.id, p2.id)).run();
		expect(await keyFor()).toBe(first);

		db.update(cards).set({ columnId: A.cols['In Progress'].id }).where(eq(cards.id, a2.id)).run();
		expect(await keyFor()).toBe(first);
	});

	it('changes when a card is done, a card joins, or the target date moves', async () => {
		const first = await keyFor();

		db.update(cards).set({ columnId: A.cols['Complete'].id }).where(eq(cards.id, a2.id)).run();
		const done = await keyFor();
		expect(done).not.toBe(first);

		const joined = makeCard(A.cols['To Do'], { title: 'Joins later' });
		db.update(cards).set({ milestoneId }).where(eq(cards.id, joined.id)).run();
		const bigger = await keyFor();
		expect(bigger).not.toBe(done);

		db.update(milestones).set({ targetDate: '2030-01-01' }).where(eq(milestones.id, milestoneId)).run();
		expect(await keyFor()).not.toBe(bigger);
	});
});

describe('the page load', () => {
	it('gives every subtask of every card the caller can open, in its order', async () => {
		const data = await planData(owner);
		expect(data.subtasks[a1.id]).toEqual(
			[o1, p2, p1, o2].map((s) => ({ id: s.id, title: s.title, priority: s.priority, completed: s.completed }))
		);
		// The card is the record's key; each subtask does not say it again.
		for (const st of data.subtasks[a1.id]) expect(Object.keys(st).sort()).toEqual(['completed', 'id', 'priority', 'title']);
		expect(data.subtasks[a2.id]).toBeUndefined();
		// The summary is as it was: no subtask list in it.
		expect(JSON.stringify(data.summary)).not.toContain('Plain open zebra step');
	});

	it('gives none of a card on a board the caller cannot open, and nothing of it anywhere', async () => {
		const toViewer = await planData(viewer);
		expect(toViewer.subtasks[a3.id]).toBeUndefined();
		expect(toViewer.subtasks[a1.id]).toHaveLength(4);
		expect(JSON.stringify(toViewer)).not.toContain(MARK_B);

		const rows = tableRows(cardGroups(toViewer.summary.graph.nodes, toViewer.summary.blocked, toViewer.subtasks), {
			...NONE,
			open: new Set([a1.id, a3.id])
		});
		const moved = rows.find((r) => r.kind === 'card' && r.id === a3.id)!;
		expect(moved).toMatchObject({ withheld: true, subtaskTotal: 0, expanded: false });
		expect(rows.filter((r) => r.parentCardId === a3.id)).toEqual([]);

		expect((await planData(owner)).subtasks[a3.id]).toHaveLength(3);
	});

	it('reads the subtasks once for forty cards', () => {
		const many = Array.from({ length: 40 }, (_, i) => makeCard(A.cols['To Do'], { title: `Card ${i}` }));
		for (const c of many) makeSubtask(c);
		const goal = makeMilestone({ board: A.board, createdBy: owner, cards: many });
		const summary = getMilestoneSummary(goal.id, owner)!;

		const reads = watchReads('subtasks');
		let given: ReturnType<typeof planSubtasks>;
		try {
			given = planSubtasks(summary);
		} finally {
			reads.restore();
		}
		expect(reads.inTransaction).toHaveLength(1);
		expect(Object.keys(given)).toHaveLength(40);
	});
});

describe('the page, as source', () => {
	/** A file of the page's, its source and its script (a module's whole text is its script). */
	const read = (file: string) => {
		const source = readFileSync(join(process.cwd(), file), 'utf8');
		const code = file.endsWith('.ts') ? source : /<script lang="ts">([\s\S]*?)<\/script>/.exec(source)![1];
		const script = ts.createSourceFile(file, code, ts.ScriptTarget.Latest, true);
		return { file, source, script };
	};
	const page = read(PAGE);
	const everyFile = PLAN_FILES.map(read);

	function all(node: ts.Node, test: (n: ts.Node) => boolean, out: ts.Node[] = []): ts.Node[] {
		if (test(node)) out.push(node);
		node.forEachChild((child) => void all(child, test, out));
		return out;
	}

	it('draws the table from $lib/plan-table, with the subtasks the load gives', () => {
		// In the work table, and nowhere else on the page (card 2281, slice C3a-3).
		const { script } = read(WORK_TABLE);
		const imported = all(script, (n) => ts.isImportDeclaration(n) && (n.moduleSpecifier as ts.StringLiteral).text === '$lib/plan-table');
		expect(imported).toHaveLength(1);
		const names = all(imported[0], ts.isImportSpecifier).map((n) => ((n as ts.ImportSpecifier).propertyName ?? (n as ts.ImportSpecifier).name).text);
		expect(names).toEqual(expect.arrayContaining(['cardGroups', 'tableRows']));

		const callsIn = (tree: ts.Node, name: string) =>
			all(tree, (n) => ts.isCallExpression(n) && n.expression.getText() === name) as ts.CallExpression[];
		const calls = (name: string) => callsIn(script, name);
		expect(calls('cardGroups').map((c) => c.arguments.map((a) => a.getText()))).toEqual([['nodes', 'summary.blocked', 'data.subtasks']]);
		expect(calls('tableRows')).toHaveLength(1);
		for (const other of everyFile.filter((f) => f.file !== WORK_TABLE)) {
			for (const name of ['cardGroups', 'tableRows']) expect(callsIn(other.script, name), `${other.file} ${name}`).toEqual([]);
		}
	});

	it('says whether each expander is open', () => {
		const { source } = read(WORK_TABLE);
		const button = (cls: string) => {
			const at = source.indexOf(`class="${cls}"`);
			expect(at, cls).toBeGreaterThan(-1);
			return source.slice(at, source.indexOf('</button>', at));
		};
		expect(button('sub-btn')).toContain('aria-expanded={r.expanded}');
		// Its name is its text, "1/4 subtasks of #12", whether open or not: no
		// aria-label to replace the text and say Show or Hide over aria-expanded.
		expect(button('sub-btn')).not.toContain('aria-label');
		expect(button('sub-btn')).toMatch(/\{r\.subtaskDone\}\/\{r\.subtaskTotal\} subtask[^<]*<span class="sr-only"> of #\{r\.id\}<\/span>/);
		expect(button('expander')).toContain('aria-expanded=');
	});

	it('reads open subtasks against all of them, as it reads cards complete (card 2225)', () => {
		expect(read(PROGRESS).source).toMatch(
			/<span class="stat-value">\{summary\.progress\.openSubtasks\}\/\{summary\.progress\.totalSubtasks\}<\/span>\s*<span class="stat-label">open subtasks \/ all<\/span>/
		);
	});

	it('touches localStorage only inside a try', () => {
		// Anywhere on the page: the work table remembers what is open (card 2281, slice C3a-3).
		const uses = everyFile.flatMap(({ script }) => all(script, (n) => ts.isIdentifier(n) && n.text === 'localStorage'));
		expect(uses.length).toBeGreaterThanOrEqual(2);
		for (const use of uses) {
			let inTry = false;
			for (let n: ts.Node = use; n.parent; n = n.parent) {
				if (ts.isTryStatement(n.parent) && n.parent.tryBlock === n) inTry = true;
			}
			expect(inTry, use.parent.getText()).toBe(true);
		}
	});

	it('fetches the burndown on what it charts, not on every new summary', () => {
		const effectsIn = (script: ts.SourceFile) =>
			all(script, (n) => ts.isCallExpression(n) && n.expression.getText() === '$effect' && n.getText().includes('loadBurndown'));
		// In the burndown block alone (card 2281, slice C3a-3), which is handed the goal's id as a number by the page.
		const { source, script } = read(BURNDOWN);
		const effects = effectsIn(script);
		expect(effects).toHaveLength(1);
		expect(everyFile.filter((f) => f.file !== BURNDOWN).flatMap((f) => effectsIn(f.script))).toEqual([]);
		const reads = all(effects[0], ts.isIdentifier).map((n) => (n as ts.Identifier).text);
		expect(reads).toContain('burndownSource');
		expect(reads).not.toContain('summary');
		expect(reads).not.toContain('milestone');
		expect(source).toMatch(/const burndownSource = \$derived\(burndownKey\(milestone, nodes\)\)/);
		expect(page.source).toContain('const milestoneId = $derived(milestone.id);');
		expect(page.source).toContain('<PlanBurndown {milestone} {milestoneId} {nodes} />');
	});

	it('writes what is open to storage only when what is remembered changed', () => {
		// In the work table alone (card 2281, slice C3a-3).
		const { source, script } = read(WORK_TABLE);
		const writes = all(script, (n) => ts.isPropertyAccessExpression(n) && n.getText() === 'localStorage.setItem');
		expect(writes).toHaveLength(1);
		expect(everyFile.flatMap((f) => all(f.script, (n) => ts.isPropertyAccessExpression(n) && n.getText() === 'localStorage.setItem'))).toHaveLength(1);
		let fn: ts.Node = writes[0];
		while (!ts.isFunctionDeclaration(fn)) fn = fn.parent;
		expect((fn as ts.FunctionDeclaration).name!.text).toBe('applyOpen');
		// It returns before the write when the state given back kept the same stored set.
		const guards = all(
			fn,
			(n) =>
				ts.isIfStatement(n) &&
				n.expression.getText() === 'next.stored === openCards' &&
				ts.isReturnStatement(n.thenStatement) &&
				n.getStart() < writes[0].getStart()
		);
		expect(guards).toHaveLength(1);
		// Every toggle and Expand all goes through the module, told whether a search or filter is in force.
		expect(source).toContain('applyOpen(afterToggle(openNow, row, filtering))');
		expect(source).toContain('applyOpen(afterExpandAll(openNow, visibleRows, filtering))');
	});

	it('re-reads the plan when the card window closes only after the window wrote something the plan draws (card 2324)', () => {
		// The card window is the page's own.
		const closeCard = all(page.script, (n) => ts.isFunctionDeclaration(n) && n.name?.text === 'closeCard');
		expect(closeCard).toHaveLength(1);
		const reads = all(closeCard[0], (n) => ts.isCallExpression(n) && n.expression.getText() === 'invalidateAll');
		expect(reads).toHaveLength(1);
		// Under `if (wrote)`: it re-read on every close (card 2221's rule, narrowed by card 2324).
		let held: ts.Node = reads[0];
		while (!ts.isIfStatement(held) && held !== closeCard[0]) held = held.parent;
		expect(ts.isIfStatement(held) && held.expression.getText()).toBe('wrote');
		// And the window's onClose is closeCard; its onWrote is windowWrote, which sets the flag
		// for the window open now and re-reads at once for one that has gone (card 2379).
		expect(page.source).toMatch(/onClose=\{closeCard\}/);
		expect(page.source).toContain('onWrote={windowWrote}');
		const windowWrote = all(page.script, (n) => ts.isFunctionDeclaration(n) && n.name?.text === 'windowWrote');
		expect(windowWrote).toHaveLength(1);
		expect(windowWrote[0].getText()).toContain('from === cardWindow.edits) wrote = true;');
		expect(windowWrote[0].getText()).toContain('else void invalidateAll();');
	});

	it('leaves no name in the page or its blocks that nothing reads (card 2323: the split left two)', () => {
		const unread: string[] = [];
		for (const { file, source, script } of everyFile.filter((f) => f.file.endsWith('.svelte'))) {
			// What the markup reads: the file less its script, its styles and its comments.
			const markup = source
				.replace(/<script lang="ts">[\s\S]*?<\/script>/, '')
				.replace(/<style>[\s\S]*?<\/style>/, '')
				.replace(/<!--[\s\S]*?-->/g, '');
			// Each name the script declares at its top: an import, a function, a const or a let (the props apart, which are the component's API).
			const declared = script.statements.flatMap((statement): ts.Identifier[] => {
				if (ts.isImportDeclaration(statement)) {
					const clause = statement.importClause;
					const named = clause?.namedBindings && ts.isNamedImports(clause.namedBindings) ? clause.namedBindings.elements.map((e) => e.name) : [];
					const whole = clause?.namedBindings && ts.isNamespaceImport(clause.namedBindings) ? [clause.namedBindings.name] : [];
					return [...(clause?.name ? [clause.name] : []), ...named, ...whole];
				}
				if (ts.isFunctionDeclaration(statement) && statement.name) return [statement.name];
				if (ts.isVariableStatement(statement)) return statement.declarationList.declarations.map((d) => d.name).filter(ts.isIdentifier);
				return [];
			});
			// A plain assignment's left side writes the name and does not read it: a `let` only ever set is unread.
			const written = (n: ts.Node) =>
				ts.isBinaryExpression(n.parent) && n.parent.left === n && n.parent.operatorToken.kind === ts.SyntaxKind.EqualsToken;
			for (const name of declared) {
				const inScript = all(script, (n) => ts.isIdentifier(n) && n !== name && n.text === name.text && !written(n)).length > 0;
				if (!inScript && !new RegExp(`\\b${name.text}\\b`).test(markup)) unread.push(`${file} ${name.text}`);
			}
		}
		expect(unread).toEqual([]);
	});
});

// Card 2472: the goal's name is a rename button only for someone the PATCH would take a rename from.
describe('who the plan page offers the rename to (card 2472)', () => {
	it('offers it to whoever can edit the goal’s board and to an administrator, not to a viewer, as the PATCH answers each', async () => {
		const admin = makeUser({ username: 'admin', role: 'admin' });
		expect((await planData(owner)).canRename).toBe(true);
		expect((await planData(admin)).canRename).toBe(true);
		expect((await planData(viewer)).canRename).toBe(false);

		const rename = (user: SessionUser, name: string) => api('PATCH', `/api/milestones/${milestoneId}`, { user, body: { name } });
		expect((await rename(viewer, 'Not taken')).status).toBe(403);
		expect((await rename(owner, 'Taken')).status).toBe(200);
	});

	it('offers a goal across boards to its maker, not to another who can open it', async () => {
		const other = makeUser({ username: 'other' });
		addBoardMember(A.board, other, 'editor');
		const across = makeMilestone({ name: 'Across', createdBy: owner, cards: [a2] }).id;
		const load = async (user: SessionUser) => {
			const res = await pageLoad(`/plan/${across}`, { user });
			if (res.type !== 'data') throw new Error(`the plan page answered ${JSON.stringify(res)}`);
			return res.data.canRename;
		};
		expect(await load(owner)).toBe(true);
		expect(await load(other)).toBe(false);
		expect((await api('PATCH', `/api/milestones/${across}`, { user: other, body: { name: 'Not taken' } })).status).toBe(403);
	});
});
