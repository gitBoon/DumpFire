/**
 * Sub-boards on All Tasks (card 1990).
 *
 * The search on All Tasks already reached the cards of every sub-board the
 * caller can open, at every depth: the load takes every board they can open
 * and the search runs over every card it loads. What hid a sub-board's cards
 * was the board filter beside it, which let in only the chosen board's own
 * cards, and the category filter, which counted a board only by its own
 * category, which no sub-board is made with. And nothing on a card said which
 * board its board hangs beneath. Now:
 *   - choosing a board lets in its sub-boards at every depth;
 *   - a sub-board with no category counts in that of the nearest board above
 *     it that the caller can open and that has one;
 *   - the board filter lists each sub-board straight after its parent;
 *   - a card's board tag names the boards above its board.
 *
 * Access does not change: a sub-board is shown only to a caller who can open
 * it, and a board above it that they cannot open is never named, by name or
 * by id. The picker's search (`GET /api/cards/search`) already found sub-board
 * cards; a test pins it.
 *
 * A page cannot be run here: no browser, no DOM. What it shows of the tree is
 * worked out by `src/lib/board-tree.ts`, called directly and with what the
 * page load gives through `pageLoad()`.
 *
 * The plan is `docs/planning/card-1990-all-tasks-sub-board-search.md` (section 6).
 */
import { readFileSync } from 'node:fs';
import { join } from 'node:path';
import { beforeEach, describe, expect, it } from 'vitest';
import { eq } from 'drizzle-orm';
import { db, sqlite } from '$lib/server/db';
import {
	boardCategories,
	boards,
	cardLabels,
	cards as cardsTable,
	categories,
	taskRequests,
	users as usersTable,
	type Card
} from '$lib/server/db/schema';
import type { SessionUser } from '$lib/server/auth';
import { boardAncestry } from '$lib/server/board-tree';
import {
	boardOptionLabel,
	boardOptions,
	boardPathText,
	boardPlaces,
	chosenBoardId,
	inBoardFilter,
	MAX_OPTION_INDENT,
	placeBoards,
	type BoardPlace,
	type VisibleBoard
} from '$lib/board-tree';
import { pageLoad } from './helpers/actions';
import { api } from './helpers/api';
import {
	addBoardMember,
	assignCard,
	makeBoard,
	makeCard,
	makeDependency,
	makeLabel,
	makeMilestone,
	makeSubBoard,
	makeSubtask,
	makeUser,
	resetDb,
	type BoardFixture,
	type SubBoardFixture
} from './helpers/fixtures';
import { readBudget } from './helpers/reads';

beforeEach(resetDb);

// ─── The tree, worked out with no database ──────────────────────────────────

/**
 * Three levels and a board beside them:
 *
 *     1 Top        category 10
 *     2 Middle     under 1, no category
 *     3 Bottom     under 2, no category
 *     4 Leaf       under 3, category 20
 *     5 Elsewhere  top-level, category 20
 */
const TOP: VisibleBoard = { id: 1, name: 'Top', emoji: '📋', categoryId: 10 };
const MIDDLE: VisibleBoard = { id: 2, name: 'Middle', emoji: '🗂️', categoryId: null };
const BOTTOM: VisibleBoard = { id: 3, name: 'Bottom', emoji: null, categoryId: null };
const LEAF: VisibleBoard = { id: 4, name: 'Leaf', emoji: '🍃', categoryId: 20 };
const ELSEWHERE: VisibleBoard = { id: 5, name: 'Elsewhere', emoji: '📋', categoryId: 20 };
const ANCESTRY = new Map<number, number[]>([
	[1, []],
	[2, [1]],
	[3, [1, 2]],
	[4, [1, 2, 3]],
	[5, []]
]);
const step = (b: VisibleBoard) => ({ id: b.id, name: b.name, emoji: b.emoji || '📋' });
/** The caller's board categories. */
const CATEGORIES = [10, 20, 40];

/**
 * The places the page works out: `placeBoards` on the server, what the load
 * sends of each board, then `boardPlaces` in the browser.
 */
function place(visible: VisibleBoard[], ancestry: ReadonlyMap<number, readonly number[]> = ANCESTRY): Map<number, BoardPlace> {
	const links = placeBoards(visible, ancestry, CATEGORIES);
	return boardPlaces(visible.map((b) => ({ id: b.id, name: b.name, emoji: b.emoji || '📋', ...links.get(b.id)! })));
}

describe('placeBoards()', () => {
	it('sends of each board its nearest parent the caller can open, whether boards they cannot open come between, and its filter category', () => {
		const all = placeBoards([TOP, MIDDLE, BOTTOM, LEAF, ELSEWHERE], ANCESTRY, CATEGORIES);
		expect(all.get(1)).toEqual({ parentId: null, hiddenAbove: false, filterCategoryId: 10 });
		expect(all.get(4)).toEqual({ parentId: 3, hiddenAbove: false, filterCategoryId: 20 });

		// Middle and Bottom are not the caller's.
		const some = placeBoards([TOP, LEAF], ANCESTRY, CATEGORIES);
		expect(some.get(4)).toEqual({ parentId: 1, hiddenAbove: true, filterCategoryId: 20 });
		expect(placeBoards([BOTTOM], ANCESTRY, CATEGORIES).get(3)).toEqual({ parentId: null, hiddenAbove: true, filterCategoryId: null });
	});
});

describe('placeBoards() and boardPlaces()', () => {
	it('gives each board the boards above it from the top down, and the category of the nearest that has one', () => {
		const places = place([TOP, MIDDLE, BOTTOM, LEAF, ELSEWHERE]);

		expect(places.get(1)).toEqual({ path: [], filterCategoryId: 10 });
		expect(places.get(2)).toEqual({ path: [step(TOP)], filterCategoryId: 10 });
		expect(places.get(3)).toEqual({ path: [step(TOP), step(MIDDLE)], filterCategoryId: 10 });
		// Its own category, which it keeps.
		expect(places.get(4)).toEqual({ path: [step(TOP), step(MIDDLE), step(BOTTOM)], filterCategoryId: 20 });
		expect(places.get(5)).toEqual({ path: [], filterCategoryId: 20 });
	});

	it('names no board the caller cannot open: it is a null, and a run of them is one null', () => {
		// Middle and Bottom are not the caller's.
		const places = place([TOP, LEAF]);
		expect(places.get(4)).toEqual({ path: [step(TOP), null], filterCategoryId: 20 });
		expect(place([BOTTOM]).get(3)).toEqual({ path: [null], filterCategoryId: null });
		expect(JSON.stringify([...place([TOP, BOTTOM])])).not.toContain('Middle');
		expect(JSON.stringify([...placeBoards([TOP, BOTTOM], ANCESTRY, CATEGORIES)])).not.toMatch(/Middle|"parentId":2\b/);
	});

	it('takes no category from a board the caller cannot open: the one above it lends its own', () => {
		// Middle is not the caller's, so what it holds is not given at all: Bottom counts in Top's.
		const places = place([TOP, BOTTOM]);
		expect(places.get(3)).toEqual({ path: [step(TOP), null], filterCategoryId: 10 });
		// With only Bottom open, nothing above it lends one.
		expect(place([BOTTOM]).get(3)!.filterCategoryId).toBeNull();
	});

	it('shows a loop once round, closing on the board it came back to, as the breadcrumbs do', () => {
		const a: VisibleBoard = { id: 7, name: 'A', emoji: '📋', categoryId: null };
		const b: VisibleBoard = { id: 8, name: 'B', emoji: '📋', categoryId: 40 };
		const places = place([a, b], new Map([[7, [7, 8]], [8, [8, 7]]]));

		expect(places.get(7)).toEqual({ path: [step(a), step(b)], filterCategoryId: 40 });
		expect(places.get(8)!.path).toEqual([step(b), step(a)]);
		// A board under one of its own cards, and a loop through a board the caller cannot open (9).
		const s: VisibleBoard = { id: 10, name: 'S', emoji: '📋', categoryId: null };
		expect(place([s], new Map([[10, [10]]])).get(10)!.path).toEqual([step(s)]);
		expect(place([a], new Map([[7, [7, 9]]])).get(7)!.path).toEqual([step(a), null]);
	});
});

describe('inBoardFilter()', () => {
	const places = place([TOP, MIDDLE, BOTTOM, LEAF, ELSEWHERE]);
	const letIn = (filter: string) => [1, 2, 3, 4, 5].filter((id) => inBoardFilter(id, filter, places));

	it('a board lets in its sub-boards at every depth, and no other board', () => {
		expect(letIn('1')).toEqual([1, 2, 3, 4]);
		expect(letIn('3')).toEqual([3, 4]);
		expect(letIn('4')).toEqual([4]);
		expect(letIn('5')).toEqual([5]);
	});

	it('a category lets in the sub-boards under its boards that have none of their own', () => {
		expect(letIn('cat:10')).toEqual([1, 2, 3]);
		expect(letIn('cat:20')).toEqual([4, 5]);
		expect(letIn('cat:99')).toEqual([]);
	});

	it('all lets in every board, one not placed among them', () => {
		expect([1, 2, 99].every((id) => inBoardFilter(id, 'all', places))).toBe(true);
		expect(inBoardFilter(99, '1', places)).toBe(false);
		expect(inBoardFilter(99, 'cat:10', places)).toBe(false);
	});
});

describe('boardOptions()', () => {
	type Option = { id: number; parentId: number | null; hiddenAbove: boolean };
	const options = (list: Option[]) => boardOptions(list).map(({ board, depth }) => [board.id, depth]);
	const placed = placeBoards([TOP, MIDDLE, BOTTOM, LEAF, ELSEWHERE], ANCESTRY, CATEGORIES);
	const option = (id: number): Option => ({ id, ...placed.get(id)! });

	it('lists each sub-board straight after its parent, one level deeper, whatever order they come in', () => {
		expect(options([option(4), option(5), option(3), option(1), option(2)])).toEqual([
			[5, 0],
			[1, 0],
			[2, 1],
			[3, 2],
			[4, 3]
		]);
	});

	it('lists at the top level a sub-board whose parent is not in the group, or is a board the caller cannot open', () => {
		// Leaf's parent, Bottom, is in another group.
		expect(options([option(1), option(2), option(4)])).toEqual([
			[1, 0],
			[2, 1],
			[4, 0]
		]);
		// 6 hangs two below Top, through a board the caller cannot open.
		expect(options([option(1), { id: 3, parentId: null, hiddenAbove: true }, { id: 6, parentId: 1, hiddenAbove: true }])).toEqual([
			[1, 0],
			[3, 0],
			[6, 0]
		]);
	});

	it('lists every board of a loop, once', () => {
		const a = { id: 7, parentId: 8, hiddenAbove: false };
		const b = { id: 8, parentId: 7, hiddenAbove: false };
		const s = { id: 9, parentId: 9, hiddenAbove: false };
		expect(options([a, b, s])).toEqual([
			[9, 0],
			[7, 0],
			[8, 1]
		]);
	});
});

describe('boardOptionLabel()', () => {
	it('indents a sub-board three spaces a level after the first, and past the cap says how deep it is instead', () => {
		const board = { emoji: '📋', name: 'B' };
		const nbsp = (levels: number) => '\u00a0'.repeat(3 * levels);
		expect(boardOptionLabel(board, 0)).toBe('📋 B');
		expect(boardOptionLabel(board, 1)).toBe('↳ 📋 B');
		expect(boardOptionLabel(board, 2)).toBe(`${nbsp(1)}↳ 📋 B`);
		expect(boardOptionLabel(board, MAX_OPTION_INDENT)).toBe(`${nbsp(MAX_OPTION_INDENT - 1)}↳ 📋 B`);
		expect(boardOptionLabel(board, MAX_OPTION_INDENT + 1)).toBe(`${nbsp(MAX_OPTION_INDENT - 1)}↳ ${MAX_OPTION_INDENT + 1} 📋 B`);
		expect(boardOptionLabel(board, 400)).toBe(`${nbsp(MAX_OPTION_INDENT - 1)}↳ 400 📋 B`);
	});
});

describe('chosenBoardId()', () => {
	it('is the chosen board as a number, from a string or a number, and 0 for all boards or a category', () => {
		expect([chosenBoardId('all'), chosenBoardId('cat:3'), chosenBoardId('12'), chosenBoardId(12)]).toEqual([0, 0, 12, 12]);
	});
});

describe('boardPathText()', () => {
	it('names the boards above, then the board; a board the caller cannot open is "…"', () => {
		expect(boardPathText([], { emoji: '📋', name: 'Top' })).toBe('📋 Top');
		expect(boardPathText([step(TOP), null], { emoji: '🍃', name: 'Leaf' })).toBe('📋 Top › … › 🍃 Leaf');
	});
});

describe('boardAncestry()', () => {
	it('follows a parent card that is archived, and reads the boards once however deep they nest', () => {
		const depth = 2000;
		const board = sqlite.prepare('INSERT INTO boards (name, parent_card_id) VALUES (?, ?)');
		const column = sqlite.prepare("INSERT INTO columns (board_id, title) VALUES (?, 'To Do')");
		const card = sqlite.prepare("INSERT INTO cards (column_id, title, archived_at) VALUES (?, ?, '2026-10-15 00:00:00')");
		const ids: number[] = [];
		sqlite.transaction(() => {
			let parent: number | null = null;
			for (let level = 0; level < depth; level++) {
				const boardId: number = Number(board.run(`Level ${level}`, parent).lastInsertRowid);
				ids.push(boardId);
				const columnId: number = Number(column.run(boardId).lastInsertRowid);
				parent = Number(card.run(columnId, `Card ${level}`).lastInsertRowid);
			}
		})();

		const budget = readBudget(1000);
		let ancestry: Map<number, number[]>;
		try {
			ancestry = boardAncestry([ids[0], ids[1], ids[depth - 1]]);
		} finally {
			budget.restore();
		}

		expect(budget.spent).toBe(false);
		expect(budget.count).toBe(1);
		expect(ancestry.get(ids[0])).toEqual([]);
		expect(ancestry.get(ids[1])).toEqual([ids[0]]);
		expect(ancestry.get(ids[depth - 1])).toEqual(ids.slice(0, depth - 1));
	});
});

// ─── The page load ──────────────────────────────────────────────────────────

/** In the names of the boards above the sub-boards: what a member of a sub-board alone must never be given. */
const MARK = 'ZQX-ABOVE';
/** In the name and card of a sub-board someone else made: what the parent board's editor must never be given. */
const OTHERS = 'ZQX-OTHERS';

let owner: SessionUser;
let T: BoardFixture;
let holder: Card;
let M: SubBoardFixture;
let L: SubBoardFixture;
let categoryId: number;

/**
 * `owner`'s board T, in a category, with sub-board M under a card on it and
 * L under a card on M, each with one card in To Do.
 */
function world() {
	owner = makeUser({ username: 'owner' });
	categoryId = db.insert(boardCategories).values({ name: 'Projects' }).returning().get().id;
	T = makeBoard({ owner, name: `${MARK} top` });
	db.update(boards).set({ categoryId }).where(eq(boards.id, T.board.id)).run();
	holder = makeCard(T.cols['To Do'], { title: 'Holds the middle board' });
	M = makeSubBoard(holder, { owner, name: `${MARK} middle` });
	L = makeSubBoard(M.cards[0], { owner, name: 'Lower board' });
}

async function allTasks(user: SessionUser) {
	const res = await pageLoad('/all', { user });
	if (res.type !== 'data') throw new Error(`All Tasks answered ${JSON.stringify(res)}`);
	return res.data;
}

const cardIdsOf = (data: any): number[] => data.buckets.flatMap((b: any) => b.cards.map((c: any) => c.id)).sort((a: number, b: number) => a - b);
const placesOf = (data: any) => boardPlaces(data.boards);

describe('the All Tasks load', () => {
	it('as the owner: every sub-board card, each board with its path and the category it is filtered under', async () => {
		world();
		const data = await allTasks(owner);

		expect(cardIdsOf(data)).toEqual([holder.id, M.cards[0].id, L.cards[0].id]);
		const places = placesOf(data);
		const name = (f: BoardFixture) => ({ id: f.board.id, name: f.board.name, emoji: '📋' });
		expect(places.get(T.board.id)).toMatchObject({ path: [], filterCategoryId: categoryId });
		expect(places.get(M.board.id)).toMatchObject({ path: [name(T)], filterCategoryId: categoryId });
		expect(places.get(L.board.id)).toMatchObject({ path: [name(T), name(M)], filterCategoryId: categoryId });

		// Choosing T, or its category, lets in the card two levels down, as the page asks of each card.
		const lower = data.buckets.flatMap((b: any) => b.cards).find((c: any) => c.id === L.cards[0].id);
		expect(lower.boardId).toBe(L.board.id);
		expect(inBoardFilter(lower.boardId, String(T.board.id), places)).toBe(true);
		expect(inBoardFilter(lower.boardId, `cat:${categoryId}`, places)).toBe(true);
	});

	it('as a member of the lowest sub-board alone: its cards, with no name of a board above it', async () => {
		world();
		const member = makeUser({ username: 'member' });
		addBoardMember(L.board, member, 'editor');

		const data = await allTasks(member);

		expect(cardIdsOf(data)).toEqual([L.cards[0].id]);
		expect(placesOf(data).get(L.board.id)).toMatchObject({ path: [null], filterCategoryId: null });
		expect(JSON.stringify(data)).not.toContain(MARK);
	});

	it('as an editor of the top board: nothing of a sub-board someone else made under it, which they cannot open', async () => {
		world();
		const editor = makeUser({ username: 'editor' });
		const other = makeUser({ username: 'other' });
		addBoardMember(T.board, editor, 'editor');
		const theirs = makeSubBoard(makeCard(T.cols['To Do'], { title: 'Holds theirs' }), { owner: other, name: `${OTHERS} board` });
		sqlite.prepare('UPDATE cards SET title = ? WHERE id = ?').run(`${OTHERS} card`, theirs.cards[0].id);

		const data = await allTasks(editor);

		expect(cardIdsOf(data)).not.toContain(theirs.cards[0].id);
		expect(data.boards.map((b: any) => b.id)).not.toContain(theirs.board.id);
		expect(JSON.stringify(data)).not.toContain(OTHERS);
	});
});

describe('the picker’s search, GET /api/cards/search', () => {
	it('finds a card two sub-boards down, by its title and by its number', async () => {
		world();
		sqlite.prepare('UPDATE cards SET title = ? WHERE id = ?').run('Deep sub-board task', L.cards[0].id);

		const byTitle = await api('GET', '/api/cards/search?q=Deep%20sub-board', { user: owner });
		const byNumber = await api('GET', `/api/cards/search?q=%23${L.cards[0].id}`, { user: owner });

		expect(byTitle.status).toBe(200);
		expect(byTitle.body.map((c: any) => c.id)).toEqual([L.cards[0].id]);
		expect(byNumber.body.map((c: any) => [c.id, c.boardId])).toEqual([[L.cards[0].id, L.board.id]]);
	});
});

// ─── The page ───────────────────────────────────────────────────────────────

describe('the All Tasks page, src/routes/all/+page.svelte, read from its source', () => {
	const source = readFileSync(join(process.cwd(), 'src/routes/all/+page.svelte'), 'utf8');
	const between = (start: string, end: string) => {
		const from = source.indexOf(start);
		const to = source.indexOf(end, from);
		if (from < 0 || to < 0) throw new Error(`the page has no "${start}" … "${end}"`);
		return source.slice(from, to);
	};

	it('filters each card through inBoardFilter, and by no board or category test of its own', () => {
		const filters = between('function matchesFilters(', 'function getFilteredCount(');
		expect(filters).toContain('inBoardFilter(card.boardId, boardFilter, boardPlaces)');
		expect(filters).not.toMatch(/categoryId|Number\(boardFilter\)/);
	});

	it('groups the board filter by the category each board is filtered under, each group in boardOptions order', () => {
		const select = between('<select class="hdr-control board-filter"', '</select>');
		expect(select).toContain('b.filterCategoryId === cat.id');
		expect(select).toContain('!b.filterCategoryId');
		expect(select.match(/filterOptions\(/g)).toHaveLength(2);
		expect(select).not.toMatch(/\bb\.categoryId\b/);
	});

	it('tags each card with the boards above its board, the whole path in the title', () => {
		expect(between('<div class="card-board-tag">', '</div>')).toContain('<span class="board-tag" title={boardTag(card)}>{boardTag(card)}</span>');
	});
});

// ─── The review's fixes ─────────────────────────────────────────────────────

describe('the review of card 1990', () => {
	it('the board filter passes strings: a board option gives its id as a string, so the chosen value is never a number', () => {
		const source = readFileSync(join(process.cwd(), 'src/routes/all/+page.svelte'), 'utf8');
		const from = source.indexOf('<select class="hdr-control board-filter"');
		const select = source.slice(from, source.indexOf('</select>', from));
		// Svelte 5 gives a bound select the option's value as it was passed: a number made `boardFilter` one.
		expect(select.match(/value=\{String\(option\.id\)\}/g)).toHaveLength(2);
		expect(select).not.toMatch(/(?<!bind:)value=\{(?!String\()/);
		// And every other reader of the filter goes through chosenBoardId or inBoardFilter, which take either.
		expect(source).not.toMatch(/boardFilter\.startsWith|Number\(boardFilter\)|\$\{boardFilter\}/);
		expect(source).toContain('chosenBoardId(boardFilter)');
	});

	it('inBoardFilter takes a board id that has become a number, and does not throw', () => {
		const places = new Map<number, BoardPlace>([
			[1, { path: [], filterCategoryId: 10 }],
			[4, { path: [{ id: 1, name: 'Top', emoji: '📋' }, null], filterCategoryId: 20 }],
			[5, { path: [], filterCategoryId: 20 }]
		]);
		const chosen = 1 as unknown as string;
		expect([1, 4, 5].filter((id) => inBoardFilter(id, chosen, places))).toEqual([1, 4]);
		expect(inBoardFilter(5, 5 as unknown as string, places)).toBe(true);
	});

	it('the load sends of each board only what the page reads: no parent card, maker or category of a board above', async () => {
		world();
		const member = makeUser({ username: 'member' });
		addBoardMember(L.board, member, 'editor');

		const data = await allTasks(member);

		const json = JSON.stringify(data.boards);
		expect(json).not.toContain('parentCardId');
		expect(json).not.toContain('createdBy');
		expect(json).not.toContain('categoryId":');
		expect(JSON.stringify(data)).not.toContain('parentCardId');
		expect(Object.keys(data.boards[0]).sort()).toEqual(['emoji', 'filterCategoryId', 'hiddenAbove', 'id', 'name', 'parentId']);
	});

	it('the boards the load sends grow with how many there are, not with the square of their depth', async () => {
		const depth = 400;
		const admin = makeUser({ username: 'admin', role: 'superadmin' });
		const board = sqlite.prepare('INSERT INTO boards (name, parent_card_id) VALUES (?, ?)');
		const column = sqlite.prepare("INSERT INTO columns (board_id, title) VALUES (?, 'To Do')");
		const card = sqlite.prepare('INSERT INTO cards (column_id, title) VALUES (?, ?)');
		const ids: number[] = [];
		sqlite.transaction(() => {
			let parent: number | null = null;
			for (let level = 0; level < depth; level++) {
				const boardId: number = Number(board.run(`A board with a name of ordinary length, level ${level}`, parent).lastInsertRowid);
				ids.push(boardId);
				const columnId: number = Number(column.run(boardId).lastInsertRowid);
				parent = Number(card.run(columnId, `Card ${level}`).lastInsertRowid);
			}
		})();

		const data = await allTasks(admin);

		// About 1,000 bytes a board would be 400 KB; the path of every board, 4.3 MB.
		expect(JSON.stringify(data.boards).length).toBeLessThan(200_000);
		// And the page still works out the whole path of the deepest.
		const places = boardPlaces(data.boards);
		expect(places.get(ids[depth - 1])!.path.map((s) => s?.id)).toEqual(ids.slice(0, depth - 1));
		expect(inBoardFilter(ids[depth - 1], String(ids[0]), places)).toBe(true);
	});

	it('a category no longer among the caller\'s board categories (deleted) counts as none, and is lent to no sub-board', () => {
		const top: VisibleBoard = { ...TOP, categoryId: 99 };
		const places = placeBoards([top, MIDDLE, BOTTOM, LEAF, ELSEWHERE], ANCESTRY, [10, 20]);
		expect(places.get(1)!.filterCategoryId).toBeNull();
		expect(places.get(2)!.filterCategoryId).toBeNull();
		expect(places.get(3)!.filterCategoryId).toBeNull();
		expect(places.get(4)!.filterCategoryId).toBe(20);
		// A deleted category on a sub-board does not stop it taking its parent's.
		const middle: VisibleBoard = { ...MIDDLE, categoryId: 99 };
		expect(placeBoards([TOP, middle], ANCESTRY, [10, 20]).get(2)!.filterCategoryId).toBe(10);
	});

	it('the load: a board whose category was deleted, and the sub-boards under it, are listed under no category', async () => {
		world();
		sqlite.prepare('DELETE FROM board_categories WHERE id = ?').run(categoryId);

		const data = await allTasks(owner);

		const filtered = new Map(data.boards.map((b: any) => [b.id, b.filterCategoryId]));
		expect([T, M, L].map((f) => filtered.get(f.board.id))).toEqual([null, null, null]);
	});
});

// ─── The answer, pinned before its reading moved (card 2240) ───────────────

/**
 * Card 2240 moved the reading of All Tasks into `readCrossBoardCards`, which
 * All To Do shares. The answer was to be the same afterwards, key for key and
 * value for value, so this was written and passing on the load as it stood
 * before the move, and guards it since.
 */
describe('the All Tasks answer, pinned (card 2240)', () => {
	it('keeps its keys, its bucket order, every To Do-titled column in To Do, and each card and board as they were', async () => {
		const owner = makeUser({ username: 'pinned' });
		const helper = makeUser({ username: 'helper' });
		const groupingId = db.insert(boardCategories).values({ name: 'Grouping', color: '#123456' }).returning().get().id;
		const { board, cols } = makeBoard({ owner, name: 'Pinned board', columns: ['Backlog', ' TODO ', 'To Do', 'Done'] });
		db.update(boards).set({ categoryId: groupingId }).where(eq(boards.id, board.id)).run();
		addBoardMember(board, helper, 'editor');
		const category = db.insert(categories).values({ boardId: board.id, name: 'Bug' }).returning().get();

		const backlog = makeCard(cols['Backlog'], { title: 'In the backlog', position: 0 });
		const upper = makeCard(cols[' TODO '], { title: 'In TODO', position: 1, priority: 'high' });
		const todo = makeCard(cols['To Do'], { title: 'In To Do', position: 2, categoryId: category.id });
		const done = makeCard(cols['Done'], { title: 'Finished', position: 3, completedAt: '2026-10-16 09:00:00' });
		makeCard(cols['To Do'], { title: 'Archived', position: 4, archivedAt: '2026-10-15 00:00:00' });
		const step = makeSubtask(todo, { title: 'A step' });
		const label = makeLabel(board, 'A label');
		db.insert(cardLabels).values({ cardId: todo.id, labelId: label.id }).run();
		assignCard(todo, helper);
		db.insert(taskRequests)
			.values({ targetType: 'user', targetId: owner.id, requesterName: 'Someone', requesterEmail: 'someone@example.test', title: 'Please', status: 'accepted', resolvedCardId: todo.id })
			.run();
		const milestone = makeMilestone({ board, name: 'Goal', cards: [todo] });
		makeDependency({ blocked: todo, blocker: upper });

		const data = await allTasks(owner);

		expect(Object.keys(data).sort()).toEqual([
			'allTokenSummary',
			'allUsers',
			'boardCategories',
			'boards',
			'blockedState',
			'buckets',
			'cardTokens',
			'categories',
			'columns',
			'completedCards',
			'completedLimit',
			'hasMoreCompleted',
			'labels',
			'milestoneNames',
			'totalCards',
			'totalCompletedCount'
		].sort());

		// Both To Do-titled columns in one To Do bucket, first; any other title a bucket of its own.
		expect(data.buckets.map((b: any) => b.title)).toEqual(['To Do', 'Backlog', 'On Hold', 'In Progress', 'Complete']);
		const inBucket = (title: string) => data.buckets.find((b: any) => b.title === title).cards.map((c: any) => c.id);
		expect(inBucket('To Do')).toEqual([upper.id, todo.id]);
		expect(inBucket('Backlog')).toEqual([backlog.id]);
		expect(inBucket('On Hold')).toEqual([]);
		expect(inBucket('In Progress')).toEqual([]);
		expect(inBucket('Complete')).toEqual([done.id]);

		// A card, every field of it.
		const row = db.select().from(cardsTable).where(eq(cardsTable.id, todo.id)).get()!;
		const helperRow = db.select().from(usersTable).where(eq(usersTable.id, helper.id)).get()!;
		const card = data.buckets[0].cards.find((c: any) => c.id === todo.id);
		expect(card).toEqual({
			...row,
			subtasks: [step],
			labelIds: [label.id],
			assignees: [{ id: helper.id, username: 'helper', emoji: helperRow.emoji }],
			requestOrigin: { requesterName: 'Someone', requestTitle: 'Please' },
			boardName: 'Pinned board',
			boardEmoji: '📋',
			boardId: board.id,
			boardCategoryName: 'Grouping',
			boardCategoryColor: '#123456',
			columnTitle: 'To Do',
			bucket: 'To Do'
		});
		expect(data.buckets[0].cards.find((c: any) => c.id === upper.id)).toMatchObject({ columnTitle: ' TODO ', bucket: 'To Do' });

		// A board, every field of it.
		expect(data.boards).toEqual([{ id: board.id, name: 'Pinned board', emoji: '📋', parentId: null, hiddenAbove: false, filterCategoryId: groupingId }]);

		// The rest of the answer.
		expect(Object.keys(data.blockedState).map(Number)).toEqual([todo.id]);
		expect(data.blockedState[todo.id].map((n: any) => [n.kind, n.id, n.withheld])).toEqual([['card', upper.id, false]]);
		expect(data.milestoneNames).toEqual({ [milestone.id]: 'Goal' });
		expect(data.columns.map((c: any) => c.id)).toEqual([cols['Backlog'].id, cols[' TODO '].id, cols['To Do'].id, cols['Done'].id]);
		expect(data.labels.map((l: any) => l.id)).toEqual([label.id]);
		expect(data.categories.map((c: any) => c.id)).toContain(category.id);
		expect(data.boardCategories.map((c: any) => c.id)).toEqual([groupingId]);
		expect(data.allUsers).toEqual(expect.arrayContaining([{ id: helper.id, username: 'helper', emoji: helperRow.emoji || '👤' }]));
		expect(data).toMatchObject({
			cardTokens: {},
			allTokenSummary: null,
			totalCards: 4,
			completedCards: 1,
			hasMoreCompleted: false,
			totalCompletedCount: 1,
			completedLimit: 50
		});
	});
});
