/**
 * All To Do (card 2240): the cards in the To Do column of every board the
 * caller can open, as one table, at `/todo`.
 *
 *   - Which columns are To Do is decided in one place: `columnRole(title)` is
 *     `'todo'` for "To Do" and "Todo", trimmed and in any case. Every such
 *     column of a board counts, as All Tasks' To Do bucket counts them, and a
 *     board with none has nothing listed (no fall-back to its first column).
 *   - The load reads the cards through `readCrossBoardCards`, the reader All
 *     Tasks now shares, so the two pages give a caller the same cards and
 *     the same access: card 1990's sub-board places, card 2128's categories,
 *     card 2129's withheld blockers.
 *   - The filters, the address and the sort are worked out in the browser by
 *     `src/lib/todo-table.ts`, called directly here. The load reads no query
 *     parameter.
 *
 * A page cannot be run here: no browser, no DOM. The page, its board filter
 * and the three links to it are read from their source (tests 15 and 16);
 * its card window's handlers are held with All Tasks' in
 * `tests/page-failures.test.ts` (test 17).
 *
 * The plan is `docs/planning/card-2240-all-to-do-page.md` (section 6, tests 1-12, 15 and 16).
 */
import { readFileSync } from 'node:fs';
import { join } from 'node:path';
import { beforeEach, describe, expect, it } from 'vitest';
import { eq } from 'drizzle-orm';
import { db, sqlite } from '$lib/server/db';
import { boardCategories, boards, cardLabels, cards, categories, taskRequests } from '$lib/server/db/schema';
import type { SessionUser } from '$lib/server/auth';
import { columnRole, isCompleteColumnTitle, isHoldColumnTitle, isTodoColumnTitle, todoColumnIds } from '$lib/column-role';
import { defaultListColumn } from '$lib/board/board-view';
import { placeBoards, type VisibleBoard } from '$lib/board-tree';
import {
	dropUnknownChoices,
	filterChoices,
	filtersFromUrl,
	filtersToUrl,
	isFiltering,
	keepKnownFilters,
	knownBoardFilters,
	NO_FILTERS,
	passesTodoFilters,
	sortTodoRows,
	todoContext,
	type TodoCard,
	type TodoFilters
} from '$lib/todo-table';
import { WITHHELD_BOARD_NAME, WITHHELD_CARD_TITLE } from '$lib/server/planning';
import { pageLoad } from './helpers/actions';
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
	type BoardFixture
} from './helpers/fixtures';

beforeEach(resetDb);

// ─── 1, 2. The rule ─────────────────────────────────────────────────────────

describe('the To Do role (test 1)', () => {
	it('is "To Do" or "Todo", trimmed and in any case, and nothing wider', () => {
		for (const title of ['To Do', 'to do', ' todo ', 'TODO', 'Todo', '  To Do\t']) {
			expect(columnRole(title), title).toBe('todo');
			expect(isTodoColumnTitle(title), title).toBe(true);
		}
		for (const title of ['To-Do', 'Backlog', 'In Progress', 'To Do Soon', 'Todos', '', null, undefined]) {
			expect(columnRole(title), String(title)).not.toBe('todo');
			expect(isTodoColumnTitle(title), String(title)).toBe(false);
		}
		expect(columnRole('To-Do')).toBeNull();
		expect(columnRole('Backlog')).toBeNull();
		expect(columnRole('In Progress')).toBeNull();
	});

	it('leaves the Complete and hold titles as they were', () => {
		for (const title of ['Complete', 'done', ' DONE ']) {
			expect(columnRole(title)).toBe('complete');
			expect(isCompleteColumnTitle(title)).toBe(true);
		}
		for (const title of ['On Hold', 'hold', 'Blocked', 'parked', 'Waiting']) {
			expect(columnRole(title)).toBe('hold');
			expect(isHoldColumnTitle(title)).toBe(true);
		}
		expect(isCompleteColumnTitle('To Do')).toBe(false);
		expect(isHoldColumnTitle('Todo')).toBe(false);
	});

	it('todoColumnIds gives every To Do column among those given, two on one board included', () => {
		const columns = [
			{ id: 1, title: 'Backlog' },
			{ id: 2, title: ' TODO ' },
			{ id: 3, title: 'To Do' },
			{ id: 4, title: 'Done' }
		];
		expect([...todoColumnIds(columns)].sort()).toEqual([2, 3]);
		expect(todoColumnIds([{ id: 9, title: 'Doing' }]).size).toBe(0);
	});
});

describe('the list view’s opening column (test 2)', () => {
	it('is still the first To Do column, else the first column', () => {
		expect(defaultListColumn([{ id: 1, title: 'Backlog' }, { id: 2, title: ' TODO ' }, { id: 3, title: 'To Do' }])).toBe(2);
		expect(defaultListColumn([{ id: 1, title: 'Ideas' }, { id: 2, title: 'To-Do' }])).toBe(1);
		expect(defaultListColumn([])).toBeNull();
	});
});

// ─── 3-6. The table, worked out with no database ────────────────────────────

/**
 *     1 Top        grouping 10
 *     2 Middle     under 1
 *     3 Bottom     under 2
 *     5 Elsewhere  top-level, grouping 20
 */
const TOP: VisibleBoard = { id: 1, name: 'Top', emoji: '📋', categoryId: 10 };
const MIDDLE: VisibleBoard = { id: 2, name: 'Middle', emoji: '📋', categoryId: null };
const BOTTOM: VisibleBoard = { id: 3, name: 'Bottom', emoji: '📋', categoryId: null };
const ELSEWHERE: VisibleBoard = { id: 5, name: 'Elsewhere', emoji: '📋', categoryId: 20 };
const ANCESTRY = new Map<number, number[]>([
	[1, []],
	[2, [1]],
	[3, [1, 2]],
	[5, []]
]);
const LINKS = placeBoards([TOP, MIDDLE, BOTTOM, ELSEWHERE], ANCESTRY, [10, 20]);
const VIEWER = 7;

/** As the load sends it. Categories 100 and 101 are both "Bug", on two boards; labels 200 and 201 both "urgent". */
const DATA = {
	boards: [TOP, MIDDLE, BOTTOM, ELSEWHERE].map((b) => ({ id: b.id, name: b.name, emoji: b.emoji || '📋', ...LINKS.get(b.id)! })),
	categories: [
		{ id: 100, name: 'Bug' },
		{ id: 101, name: ' bug ' },
		{ id: 102, name: 'Feature' }
	],
	labels: [
		{ id: 200, name: 'urgent' },
		{ id: 201, name: 'Urgent' },
		{ id: 202, name: 'later' }
	],
	blockedState: { 12: [{ kind: 'card', id: 99 }] } as Record<number, unknown[]>,
	milestoneNames: { 50: 'Beta', 51: 'Alpha' } as Record<number, string>
};
const CTX = todoContext(DATA, VIEWER);

let made = 0;
function row(over: Partial<TodoCard> = {}): TodoCard {
	made += 1;
	return {
		id: made,
		title: `Card ${made}`,
		description: null,
		priority: 'medium',
		dueDate: null,
		position: 0,
		pinned: false,
		categoryId: null,
		milestoneId: null,
		boardId: 1,
		boardName: 'Top',
		labelIds: [],
		assignees: [],
		subtasks: [],
		...over
	};
}

const filters = (over: Partial<TodoFilters> = {}): TodoFilters => ({ ...NO_FILTERS, ...over });
const KNOWN = { boardIds: [1, 2, 3, 5], groupingIds: [10, 20] };
const fromUrl = (search: string) => filtersFromUrl(new URL(`http://localhost/todo${search}`), KNOWN);

describe('filtersFromUrl() and filtersToUrl() (test 3)', () => {
	it('round-trips every parameter', () => {
		const all: TodoFilters = {
			board: '3',
			priority: 'high',
			category: 'Bug',
			label: 'urgent',
			assignee: 'me',
			milestone: '50',
			state: 'blocked',
			q: 'some words',
			sort: 'due',
			dir: 'desc'
		};
		const url = filtersToUrl(new URL('http://localhost/todo'), all);
		expect(url.search).toBe('?board=3&priority=high&category=Bug&label=urgent&assignee=me&milestone=50&state=blocked&q=some+words&sort=due&dir=desc');
		expect(fromUrl(url.search)).toEqual({ filters: all, dropped: [], boardRefused: false });

		for (const other of [{ board: 'cat:10' }, { assignee: 'none' }, { assignee: '7' }, { milestone: 'none' }, { state: 'startable' as const }, { sort: 'title' as const, dir: 'asc' as const }]) {
			const given = filters(other);
			expect(fromUrl(filtersToUrl(new URL('http://localhost/todo'), given).search).filters, JSON.stringify(other)).toEqual(given);
		}
	});

	it('writes nothing for a filter that is off, so the plain page is /todo, and keeps any other parameter', () => {
		expect(filtersToUrl(new URL('http://localhost/todo'), filters()).href).toBe('http://localhost/todo');
		expect(filtersToUrl(new URL('http://localhost/todo?board=3&other=1'), filters()).search).toBe('?other=1');
		expect(fromUrl('')).toEqual({ filters: filters(), dropped: [], boardRefused: false });
	});

	it('takes a board by id or a grouping as cat:N, among those the caller was sent', () => {
		expect(fromUrl('?board=2').filters.board).toBe('2');
		expect(fromUrl('?board=cat:20').filters.board).toBe('cat:20');
		expect(fromUrl('?board=all')).toEqual({ filters: filters(), dropped: [], boardRefused: false });
	});

	it('drops a board or grouping not sent, and says so the same way whatever the reason', () => {
		for (const board of ['999', '4', 'cat:30', 'cat:x', 'abc', '-1', '0']) {
			expect(fromUrl(`?board=${board}`), board).toEqual({ filters: filters(), dropped: ['board'], boardRefused: true });
		}
	});

	it('drops a priority, person, milestone, state, sort or direction it does not know, and keeps the rest', () => {
		const read = fromUrl('?priority=urgent&assignee=someone&milestone=next&state=done&sort=labels&dir=down&label=later');
		expect(read.filters).toEqual(filters({ label: 'later' }));
		expect(read.dropped.sort()).toEqual(['assignee', 'dir', 'milestone', 'priority', 'sort', 'state']);
		expect(read.boardRefused).toBe(false);
		// A direction with no column is dropped; a column with no direction is ascending.
		expect(fromUrl('?dir=desc').dropped).toEqual(['dir']);
		expect(fromUrl('?sort=board').filters).toEqual(filters({ sort: 'board', dir: 'asc' }));
		// Case is not held against a value.
		expect(fromUrl('?priority=HIGH&state=Blocked&assignee=ME').filters).toEqual(filters({ priority: 'high', state: 'blocked', assignee: 'me' }));
	});

	it('writes no search that is blank once trimmed (review fix 6)', () => {
		expect(filtersToUrl(new URL('http://localhost/todo'), filters({ q: '   ' })).href).toBe('http://localhost/todo');
		expect(filtersToUrl(new URL('http://localhost/todo?q=old'), filters({ q: ' \t ', priority: 'low' })).search).toBe('?priority=low');
		// A search with words in it is kept as typed, spaces and all.
		expect(filtersToUrl(new URL('http://localhost/todo'), filters({ q: ' two words ' })).searchParams.get('q')).toBe(' two words ');
	});

	it('keeps a grouping in one spelling, cat:N, as the board filter offers it (review fix 4)', () => {
		expect(fromUrl('?board=cat:010').filters.board).toBe('cat:10');
		expect(fromUrl('?board=cat:0020')).toEqual({ filters: filters({ board: 'cat:20' }), dropped: [], boardRefused: false });
		expect(fromUrl('?board=cat:000')).toEqual({ filters: filters(), dropped: ['board'], boardRefused: true });
	});

	it('knows a grouping only when it holds one of the caller’s boards, as BoardFilterSelect offers it (review fix 4)', () => {
		const data = {
			boards: [
				{ id: 1, filterCategoryId: 10 },
				{ id: 2, filterCategoryId: null },
				{ id: 5, filterCategoryId: 20 }
			],
			// 30 holds none of the caller's boards: the filter does not offer it, so the address cannot choose it.
			boardCategories: [{ id: 10 }, { id: 20 }, { id: 30 }]
		};
		const known = knownBoardFilters(data);
		expect([...known.boardIds]).toEqual([1, 2, 5]);
		expect([...known.groupingIds]).toEqual([10, 20]);
		const at = (search: string) => filtersFromUrl(new URL(`http://localhost/todo${search}`), known);
		expect(at('?board=cat:20').filters.board).toBe('cat:20');
		expect(at('?board=cat:30')).toEqual({ filters: filters(), dropped: ['board'], boardRefused: true });
	});

	it('isFiltering is true while any filter is on, and not for a sort alone', () => {
		expect(isFiltering(filters())).toBe(false);
		expect(isFiltering(filters({ sort: 'due', dir: 'desc' }))).toBe(false);
		expect(isFiltering(filters({ q: '   ' }))).toBe(false);
		for (const on of [{ board: '1' }, { priority: 'low' }, { category: 'Bug' }, { label: 'x' }, { assignee: 'me' }, { milestone: 'none' }, { state: 'blocked' as const }, { q: 'x' }]) {
			expect(isFiltering(filters(on)), JSON.stringify(on)).toBe(true);
		}
	});
});

describe('passesTodoFilters() (test 4)', () => {
	const passing = (cards: TodoCard[], over: Partial<TodoFilters>) => cards.filter((c) => passesTodoFilters(c, filters(over), CTX)).map((c) => c.id);

	it('a board lets in its sub-boards two deep, and a grouping the sub-boards under its boards', () => {
		const onTop = row({ boardId: 1 });
		const onMiddle = row({ boardId: 2 });
		const onBottom = row({ boardId: 3 });
		const elsewhere = row({ boardId: 5 });
		const cards = [onTop, onMiddle, onBottom, elsewhere];

		expect(passing(cards, {})).toEqual(cards.map((c) => c.id));
		expect(passing(cards, { board: '1' })).toEqual([onTop.id, onMiddle.id, onBottom.id]);
		expect(passing(cards, { board: '2' })).toEqual([onMiddle.id, onBottom.id]);
		expect(passing(cards, { board: 'cat:10' })).toEqual([onTop.id, onMiddle.id, onBottom.id]);
		expect(passing(cards, { board: 'cat:20' })).toEqual([elsewhere.id]);
	});

	it('category and label by name across boards, in any case', () => {
		const bugHere = row({ categoryId: 100 });
		const bugThere = row({ categoryId: 101, boardId: 5 });
		const feature = row({ categoryId: 102 });
		const none = row();
		expect(passing([bugHere, bugThere, feature, none], { category: 'BUG' })).toEqual([bugHere.id, bugThere.id]);

		const urgent = row({ labelIds: [202, 200] });
		const Urgent = row({ labelIds: [201] });
		const later = row({ labelIds: [202] });
		expect(passing([urgent, Urgent, later, none], { label: ' urgent ' })).toEqual([urgent.id, Urgent.id]);
	});

	it('assignee me is the viewer, none is unassigned, and an id that person', () => {
		const mine = row({ assignees: [{ id: VIEWER, username: 'me', emoji: null }] });
		const shared = row({ assignees: [{ id: 8, username: 'pat', emoji: null }, { id: VIEWER, username: 'me', emoji: null }] });
		const theirs = row({ assignees: [{ id: 8, username: 'pat', emoji: null }] });
		const nobody = row();
		const cards = [mine, shared, theirs, nobody];
		expect(passing(cards, { assignee: 'me' })).toEqual([mine.id, shared.id]);
		expect(passing(cards, { assignee: 'none' })).toEqual([nobody.id]);
		expect(passing(cards, { assignee: '8' })).toEqual([shared.id, theirs.id]);
	});

	it('milestone by id, and none', () => {
		const beta = row({ milestoneId: 50 });
		const alpha = row({ milestoneId: 51 });
		const none = row();
		expect(passing([beta, alpha, none], { milestone: '50' })).toEqual([beta.id]);
		expect(passing([beta, alpha, none], { milestone: 'none' })).toEqual([none.id]);
	});

	it('blocked and startable from the blocked state', () => {
		made = 11;
		const blocked = row(); // card 12
		const free = row();
		expect(blocked.id).toBe(12);
		expect(passing([blocked, free], { state: 'blocked' })).toEqual([blocked.id]);
		expect(passing([blocked, free], { state: 'startable' })).toEqual([free.id]);
	});

	it('priority, and the search as the board searches: #12 is card 12 alone, else the id, title, description, category or assignee', () => {
		made = 0;
		const cards = Array.from({ length: 13 }, () => row());
		const twelve = cards[11];
		expect(passing(cards, { q: '#12' })).toEqual([twelve.id]);
		// "12" alone is a part of an id: 12 only, here.
		expect(passing(cards, { q: '12' })).toEqual([12]);

		const titled = row({ title: 'Fix the login page' });
		const described = row({ description: 'The LOGIN button' });
		const filed = row({ categoryId: 102 });
		const assigned = row({ assignees: [{ id: 8, username: 'loginhelper', emoji: null }] });
		const high = row({ priority: 'high', title: 'login too' });
		const all = [titled, described, filed, assigned, high];
		expect(passing(all, { q: 'login' })).toEqual([titled.id, described.id, assigned.id, high.id]);
		expect(passing(all, { q: 'feature' })).toEqual([filed.id]);
		expect(passing(all, { priority: 'high' })).toEqual([high.id]);
	});

	it('every filter together', () => {
		made = 11;
		const match = row({ boardId: 3, priority: 'high', categoryId: 101, labelIds: [201], assignees: [{ id: VIEWER, username: 'me', emoji: null }], milestoneId: 50, title: 'The one' });
		const misses = [
			{ ...match, id: 100, boardId: 5 },
			{ ...match, id: 101, priority: 'low' },
			{ ...match, id: 102, categoryId: 102 },
			{ ...match, id: 103, labelIds: [202] },
			{ ...match, id: 104, assignees: [] },
			{ ...match, id: 105, milestoneId: null },
			{ ...match, id: 106, title: 'Another' }
		];
		// Every one of them blocked, so each misses on one filter alone.
		const ctx = { ...CTX, blockedState: Object.fromEntries([match, ...misses].map((c) => [c.id, [{}]])) };
		const on = filters({ board: '1', priority: 'high', category: 'bug', label: 'URGENT', assignee: 'me', milestone: '50', state: 'blocked', q: 'the one' });
		expect([match, ...misses].filter((c) => passesTodoFilters(c, on, ctx)).map((c) => c.id)).toEqual([match.id]);
		expect(passesTodoFilters(match, on, { ...CTX, blockedState: {} })).toBe(false);
	});
});

describe('sortTodoRows() (test 5)', () => {
	const ids = (cards: TodoCard[]) => cards.map((c) => c.id);

	it('by default: priority, then due date with none last, then board name, then position; a pin is not put first', () => {
		made = 0;
		const lowSoon = row({ priority: 'low', dueDate: '2026-10-01' });
		const critical = row({ priority: 'critical' });
		const highNoDue = row({ priority: 'high' });
		const highLater = row({ priority: 'high', dueDate: '2026-12-01' });
		const highSoonB = row({ priority: 'high', dueDate: '2026-11-01', boardName: 'Beta' });
		const highSoonA2 = row({ priority: 'high', dueDate: '2026-11-01', boardName: 'Alpha', position: 2 });
		const highSoonA1 = row({ priority: 'high', dueDate: '2026-11-01', boardName: 'Alpha', position: 1, pinned: false });
		const pinnedLow = row({ priority: 'low', pinned: true });
		const given = [lowSoon, critical, highNoDue, highLater, highSoonB, highSoonA2, highSoonA1, pinnedLow];
		const copy = [...given];

		expect(ids(sortTodoRows(given, null, 'asc', CTX))).toEqual(ids([critical, highSoonA1, highSoonA2, highSoonB, highLater, highNoDue, lowSoon, pinnedLow]));
		// The array given is not reordered.
		expect(given).toEqual(copy);
	});

	it('each column both ways, a card with no value last either way', () => {
		// Card 12 is the blocked one in CTX.
		made = 11;
		const a = row({ title: 'apple', boardName: 'Zed', categoryId: 102, dueDate: '2026-11-02', milestoneId: 51, priority: 'low', subtasks: [{ completed: false }, { completed: false }] }); // 12, blocked
		const b = row({ title: 'Banana', boardName: 'alpha', categoryId: 100, dueDate: '2026-11-01', milestoneId: 50, priority: 'critical', subtasks: [{ completed: true }] });
		const empty = row({ title: '  ', boardName: 'Middle', priority: 'unheard-of' });
		const cards = [empty, a, b];

		const expectOrder = (sort: Parameters<typeof sortTodoRows>[1], asc: TodoCard[], desc: TodoCard[]) => {
			expect(ids(sortTodoRows(cards, sort, 'asc', CTX)), `${sort} asc`).toEqual(ids(asc));
			expect(ids(sortTodoRows(cards, sort, 'desc', CTX)), `${sort} desc`).toEqual(ids(desc));
		};
		expectOrder('priority', [b, a, empty], [a, b, empty]);
		expectOrder('title', [a, b, empty], [b, a, empty]);
		expectOrder('board', [b, empty, a], [a, empty, b]);
		// "Bug" before "Feature"; no category last.
		expectOrder('category', [b, a, empty], [a, b, empty]);
		expectOrder('due', [b, a, empty], [a, b, empty]);
		// Open steps: none open, then two; no steps at all last.
		expectOrder('subtasks', [b, a, empty], [a, b, empty]);
		// By name: Alpha (51) before Beta (50).
		expectOrder('milestone', [a, b, empty], [b, a, empty]);
		// Blocked first, ascending; among equals the default order (b is critical, empty unknown).
		expectOrder('blocked', [a, b, empty], [b, empty, a]);
	});
});

describe('filterChoices() and dropUnknownChoices() (test 6)', () => {
	it('draws the choices from the cards the board filter lets in, each name once', () => {
		const pat = { id: 8, username: 'pat', emoji: null };
		const alex = { id: 9, username: 'Alex', emoji: '🦊' };
		const cards = [
			row({ boardId: 1, categoryId: 100, labelIds: [200, 202], assignees: [pat], milestoneId: 50 }),
			row({ boardId: 3, categoryId: 101, labelIds: [201], assignees: [pat, alex] }),
			row({ boardId: 5, categoryId: 102, labelIds: [202], assignees: [{ id: 10, username: 'zoe', emoji: null }], milestoneId: 51 })
		];

		expect(filterChoices(cards, 'all', CTX)).toEqual({
			categories: ['Bug', 'Feature'],
			labels: ['later', 'urgent'],
			assignees: [alex, pat, { id: 10, username: 'zoe', emoji: null }],
			milestones: [
				{ id: 51, name: 'Alpha' },
				{ id: 50, name: 'Beta' }
			]
		});
		expect(filterChoices(cards, '1', CTX)).toEqual({
			categories: ['Bug'],
			labels: ['later', 'urgent'],
			assignees: [alex, pat],
			milestones: [{ id: 50, name: 'Beta' }]
		});
	});

	it('puts a category, label, person or milestone no card in scope has back on any', () => {
		const choices = { categories: ['Bug'], labels: ['urgent'], assignees: [{ id: 8, username: 'pat', emoji: null }], milestones: [{ id: 50, name: 'Beta' }] };
		const kept = filters({ category: 'bug', label: 'URGENT', assignee: '8', milestone: '50' });
		expect(dropUnknownChoices(kept, choices)).toEqual({ filters: kept, dropped: [] });
		expect(dropUnknownChoices(filters({ assignee: 'me', milestone: 'none' }), choices).dropped).toEqual([]);

		const unknown = dropUnknownChoices(filters({ category: 'Nope', label: 'gone', assignee: '99', milestone: '77', priority: 'high' }), choices);
		expect(unknown.filters).toEqual(filters({ priority: 'high' }));
		expect(unknown.dropped).toEqual(['category', 'label', 'assignee', 'milestone']);
	});

	it('after a live re-read, puts a board no longer sent back on every board, and a choice no card has back on any (review fix 5)', () => {
		const pat = { id: 8, username: 'pat', emoji: null };
		const cards = [row({ boardId: 3, categoryId: 100, labelIds: [200], assignees: [pat], milestoneId: 50 }), row({ boardId: 5, categoryId: 102 })];
		const on = filters({ board: '3', category: 'Bug', label: 'urgent', assignee: '8', milestone: '50', priority: 'high', q: 'x' });

		// Everything still there: nothing changes and nothing is refused.
		expect(keepKnownFilters(on, cards, KNOWN, CTX)).toEqual({ filters: on, dropped: [], boardRefused: false });

		// Board 3 is no longer one the caller can open: every board, said so, the rest kept where a card still has it.
		const gone = keepKnownFilters(on, cards, { boardIds: [1, 2, 5], groupingIds: [10, 20] }, CTX);
		expect(gone.boardRefused).toBe(true);
		expect(gone.filters).toEqual({ ...on, board: 'all' });
		expect(gone.dropped).toEqual(['board']);
		// A grouping no longer offered is the same.
		expect(keepKnownFilters(filters({ board: 'cat:20' }), cards, { boardIds: [1, 2, 3, 5], groupingIds: [10] }, CTX)).toEqual({
			filters: filters(),
			dropped: ['board'],
			boardRefused: true
		});

		// The last card with that label, person and milestone has left To Do: those go back on any, quietly.
		const left = keepKnownFilters(on, [cards[1], row({ boardId: 3, categoryId: 100 })], KNOWN, CTX);
		expect(left).toEqual({ filters: { ...on, label: '', assignee: '', milestone: '' }, dropped: ['label', 'assignee', 'milestone'], boardRefused: false });
	});
});

// ─── 7-12. The load ─────────────────────────────────────────────────────────

/** In the names of the boards above a sub-board: what a member of the sub-board alone must never be given. */
const MARK = 'ZQX-ABOVE';
/** In the name and card of a sub-board someone else made, and of a board the caller cannot open. */
const OTHERS = 'ZQX-OTHERS';

async function load(path: string, user: SessionUser) {
	const res = await pageLoad(path, { user });
	if (res.type !== 'data') throw new Error(`${path} answered ${JSON.stringify(res)}`);
	return res.data;
}
const todoIds = (data: any): number[] => data.cards.map((c: any) => c.id).sort((a: number, b: number) => a - b);
const allTasksTodoIds = (data: any): number[] =>
	data.buckets
		.find((b: any) => b.title === 'To Do')
		.cards.map((c: any) => c.id)
		.sort((a: number, b: number) => a - b);

describe('the load, as a board’s owner (test 7)', () => {
	it('gives the cards of the To Do column and none other, each as the card window reads it', async () => {
		const owner = makeUser({ username: 'owner' });
		const helper = makeUser({ username: 'helper' });
		const { board, cols } = makeBoard({ owner, name: 'Work' });
		addBoardMember(board, helper, 'editor');
		const todo = makeCard(cols['To Do'], { title: 'Waiting', summary: 'A plain summary', theme: 'maintenance', customerImpact: 'none', closeReason: null, releaseState: null });
		makeCard(cols['On Hold'], { title: 'Paused' });
		makeCard(cols['In Progress'], { title: 'Started' });
		makeCard(cols['Complete'], { title: 'Finished' });
		makeCard(cols['To Do'], { title: 'Archived', archivedAt: '2026-10-15 00:00:00' });
		const step = makeSubtask(todo, { title: 'A step' });
		const label = makeLabel(board, 'urgent');
		db.insert(cardLabels).values({ cardId: todo.id, labelId: label.id }).run();
		assignCard(todo, helper);
		db.insert(taskRequests)
			.values({ targetType: 'user', targetId: owner.id, requesterName: 'Someone', requesterEmail: 'someone@example.test', title: 'Please', status: 'accepted', resolvedCardId: todo.id })
			.run();

		const data = await load('/todo', owner);

		expect(todoIds(data)).toEqual([todo.id]);
		expect(data.cards[0]).toMatchObject({
			id: todo.id,
			title: 'Waiting',
			summary: 'A plain summary',
			theme: 'maintenance',
			customerImpact: 'none',
			closeReason: null,
			releaseState: null,
			subtasks: [{ id: step.id, title: 'A step' }],
			labelIds: [label.id],
			assignees: [{ id: helper.id, username: 'helper' }],
			requestOrigin: { requesterName: 'Someone', requestTitle: 'Please' },
			boardId: board.id,
			boardName: 'Work',
			boardEmoji: '📋',
			columnTitle: 'To Do'
		});
		// What the page is sent, and no more: no columns, no token figures, no completed cards.
		expect(Object.keys(data).sort()).toEqual(['allUsers', 'blockedState', 'boardCategories', 'boards', 'cards', 'categories', 'labels', 'milestoneNames']);
		expect(data.boards).toEqual([{ id: board.id, name: 'Work', emoji: '📋', parentId: null, hiddenAbove: false, filterCategoryId: null, hasTodo: true }]);
		expect(data.labels.map((l: any) => l.id)).toEqual([label.id]);
		expect(data.allUsers).toEqual(expect.arrayContaining([{ id: helper.id, username: 'helper', emoji: '👤' }]));
		// No address but the caller's own: the requester's is not on the card.
		expect(JSON.stringify(data)).not.toContain('someone@example.test');
	});
});

describe('a board with no To Do column (test 8)', () => {
	it('has none of its cards listed, and is sent with hasTodo false; one titled " TODO " counts', async () => {
		const owner = makeUser({ username: 'owner' });
		const none = makeBoard({ owner, name: 'No To Do', columns: ['Backlog', 'Doing', 'Done'] });
		for (const title of ['Backlog', 'Doing', 'Done']) makeCard(none.cols[title]);
		const spaced = makeBoard({ owner, name: 'Spaced', columns: [' TODO ', 'Done'] });
		const listed = makeCard(spaced.cols[' TODO ']);
		makeCard(spaced.cols['Done']);

		const data = await load('/todo', owner);

		expect(todoIds(data)).toEqual([listed.id]);
		const hasTodo = Object.fromEntries(data.boards.map((b: any) => [b.id, b.hasTodo]));
		expect(hasTodo).toEqual({ [none.board.id]: false, [spaced.board.id]: true });
	});
});

describe('All To Do and the To Do bucket of All Tasks (test 9)', () => {
	it('list the same cards, for an owner, a member and an administrator', async () => {
		const owner = makeUser({ username: 'owner' });
		const member = makeUser({ username: 'member' });
		const admin = makeUser({ username: 'admin', role: 'admin' });
		const one = makeBoard({ owner, name: 'One' });
		const two = makeBoard({ owner, name: 'Two', columns: ['Backlog', ' TODO ', 'To Do', 'Done'] });
		const none = makeBoard({ owner, name: 'None', columns: ['Ideas', 'Doing', 'Done'] });
		const theirs = makeBoard({ owner: member, name: 'Theirs', columns: ['todo', 'Done'] });
		addBoardMember(two.board, member, 'viewer');
		for (const fixture of [one, two, none, theirs]) for (const column of Object.values(fixture.cols)) makeCard(column);
		makeCard(one.cols['To Do'], { archivedAt: '2026-10-15 00:00:00' });
		const sub = makeSubBoard(makeCard(one.cols['To Do']), { owner, cards: { 'To Do': 2, 'In Progress': 1 } });

		for (const user of [owner, member, admin]) {
			const todo = todoIds(await load('/todo', user));
			const all = allTasksTodoIds(await load('/all', user));
			expect(todo, user.username).toEqual(all);
			expect(todo.length, user.username).toBeGreaterThan(0);
		}
		// The owner's include both of board Two's To Do columns and the sub-board's.
		const asOwner = todoIds(await load('/todo', owner));
		for (const column of [two.cols[' TODO '], two.cols['To Do']]) {
			const onIt = db.select({ id: cards.id }).from(cards).where(eq(cards.columnId, column.id)).all().map((c) => c.id);
			for (const id of onIt) expect(asOwner).toContain(id);
		}
		for (const card of sub.cards.slice(0, 2)) expect(asOwner).toContain(card.id);
		expect(asOwner).not.toContain(sub.cards[2].id);
	});
});

describe('access, as card 1990’s tests ask it (test 10)', () => {
	let owner: SessionUser;
	let T: BoardFixture;

	function world() {
		owner = makeUser({ username: 'owner' });
		T = makeBoard({ owner, name: `${MARK} top` });
		const middle = makeSubBoard(makeCard(T.cols['To Do'], { title: `${MARK} holder` }), { owner, name: `${MARK} middle` });
		return makeSubBoard(middle.cards[0], { owner, name: 'Lower board' });
	}

	it('a member of the lowest sub-board alone: its To Do cards, its path hidden above, nothing of the boards above it', async () => {
		const lower = world();
		const member = makeUser({ username: 'member' });
		addBoardMember(lower.board, member, 'editor');

		const data = await load('/todo', member);

		expect(todoIds(data)).toEqual([lower.cards[0].id]);
		expect(data.boards).toEqual([{ id: lower.board.id, name: 'Lower board', emoji: '📋', parentId: null, hiddenAbove: true, filterCategoryId: null, hasTodo: true }]);
		expect(JSON.stringify(data)).not.toContain(MARK);
	});

	it('an editor of the top board: no card or name of a sub-board someone else made under it', async () => {
		world();
		const editor = makeUser({ username: 'editor' });
		const other = makeUser({ username: 'other' });
		addBoardMember(T.board, editor, 'editor');
		const theirs = makeSubBoard(makeCard(T.cols['To Do'], { title: 'Holds theirs' }), { owner: other, name: `${OTHERS} board` });
		sqlite.prepare('UPDATE cards SET title = ? WHERE id = ?').run(`${OTHERS} card`, theirs.cards[0].id);

		const data = await load('/todo', editor);

		expect(todoIds(data)).not.toContain(theirs.cards[0].id);
		expect(data.boards.map((b: any) => b.id)).not.toContain(theirs.board.id);
		expect(JSON.stringify(data)).not.toContain(OTHERS);
	});

	it('an outsider: nothing of a board they cannot open', async () => {
		world();
		const outsider = makeUser({ username: 'outsider' });
		const data = await load('/todo', outsider);
		expect(data.cards).toEqual([]);
		expect(data.boards).toEqual([]);
		expect(JSON.stringify(data)).not.toContain(MARK);
	});
});

describe('blockers and categories (test 11)', () => {
	it('withholds a blocker on a board the caller cannot open, and names a carried category, marked carried', async () => {
		const owner = makeUser({ username: 'owner' });
		const stranger = makeUser({ username: 'stranger' });
		const mine = makeBoard({ owner, name: 'Mine' });
		const hidden = makeBoard({ owner: stranger, name: `${OTHERS} board` });
		const blocker = makeCard(hidden.cols['To Do'], { title: `${OTHERS} blocker` });
		const otherCategory = db.insert(categories).values({ boardId: hidden.board.id, name: `${OTHERS} category` }).returning().get();
		const waiting = makeCard(mine.cols['To Do'], { title: 'Waiting', categoryId: otherCategory.id });
		makeDependency({ blocked: waiting, blocker });

		const data = await load('/todo', owner);

		const ends = data.blockedState[waiting.id];
		expect(ends).toHaveLength(1);
		expect(ends[0]).toMatchObject({ withheld: true, title: WITHHELD_CARD_TITLE, boardName: WITHHELD_BOARD_NAME, boardId: null });
		expect(JSON.stringify(data.blockedState)).not.toContain(OTHERS);
		expect(data.categories.find((c: any) => c.id === otherCategory.id)).toMatchObject({ name: `${OTHERS} category`, carried: true });
		// As the Blocked filter reads it.
		expect(passesTodoFilters(data.cards[0], filters({ state: 'blocked' }), todoContext(data, owner.id))).toBe(true);
	});
});

describe('the load ignores the address (test 12)', () => {
	it('/todo?board=…&priority=…&q=… gives the same answer as /todo', async () => {
		const owner = makeUser({ username: 'owner' });
		const groupingId = db.insert(boardCategories).values({ name: 'Projects' }).returning().get().id;
		const a = makeBoard({ owner, name: 'A' });
		const b = makeBoard({ owner, name: 'B' });
		db.update(boards).set({ categoryId: groupingId }).where(eq(boards.id, a.board.id)).run();
		makeCard(a.cols['To Do'], { priority: 'high', title: 'x marks it' });
		makeCard(a.cols['To Do'], { priority: 'low' });
		makeCard(b.cols['To Do'], { priority: 'high' });
		makeMilestone({ board: a.board, name: 'Goal', cards: [makeCard(b.cols['To Do'])] });

		const plain = await load('/todo', owner);
		expect(plain.cards).toHaveLength(4);
		for (const search of [`?board=${a.board.id}&priority=high&q=x`, `?board=cat:${groupingId}&state=blocked&sort=due&dir=desc`, '?board=999999']) {
			expect(await load(`/todo${search}`, owner), search).toEqual(plain);
		}
	});
});

// ─── 15, 16. The page and the links to it, read from their source ───────────

const read = (file: string) => readFileSync(join(process.cwd(), file), 'utf8');

describe('the page, src/routes/todo/+page.svelte, read from its source (test 15)', () => {
	const source = read('src/routes/todo/+page.svelte');
	const script = /<script lang="ts">([\s\S]*?)<\/script>/.exec(source)![1];
	const css = source.slice(source.indexOf('<style>'));

	it('writes the address with goto and replaceState, never a shallow replaceState or window.history, and re-reads live', () => {
		// A shallow replaceState never changes page.url and leaves the arrival
		// address in the history entry, so Back from a board lost the filters
		// (review fix 1). goto with replaceState is a real navigation that
		// re-runs no load: neither /todo's load nor the layout's reads `url`.
		expect(script).toMatch(/import \{[^}]*\bgoto\b[^}]*\} from '\$app\/navigation';/);
		expect(script).not.toMatch(/import \{[^}]*\breplaceState\b[^}]*\} from '\$app\/navigation';/);
		expect(script).not.toMatch(/(?<![.\w])replaceState\(/);
		expect(script).toContain('goto(next, { replaceState: true, keepFocus: true, noScroll: true })');
		expect(script).toContain('filtersToUrl(page.url, filters)');
		// Still a quarter second after the last change.
		expect(script).toMatch(/setTimeout\(\(\) => \{[\s\S]*?goto\(next, [\s\S]*?\}, 250\);/);
		expect(source).not.toMatch(/\bhistory\.(replaceState|pushState)\b|window\.location\.href\s*=/);
		for (const load of ['src/routes/todo/+page.server.ts', 'src/routes/+layout.server.ts']) {
			expect(read(load), load).not.toMatch(/\burl\b/);
		}
		// Opened when the page is, closed when it goes. What each update said,
		// and each gap, tells the open card window whether its comments
		// changed (card 2282): `connectLiveRefresh`'s calls of `onEvent` are
		// held in `tests/card-window-comments.svelte.test.ts`. And its files
		// (card 2337), as `attachmentsChanged` says.
		expect(script).toMatch(
			/onMount\(\(\) => \{\s*closeLive = connectLiveRefresh\(\(\) => invalidateAll\(\), \(event\) => \{\s*if \(commentsChanged\(event, cardWindow\.cardId\)\) commentsTold\+\+;\s*if \(attachmentsChanged\(event, cardWindow\.cardId\)\) attachmentsTold\+\+;\s*\}\);/
		);
		expect(source).toMatch(/<CardModal\b(?:(?!\/>)[\s\S])*\{commentsTold\}(?:(?!\/>)[\s\S])*\/>/);
		expect(source).toMatch(/<CardModal\b(?:(?!\/>)[\s\S])*\{attachmentsTold\}(?:(?!\/>)[\s\S])*\/>/);
		expect(script).toMatch(/onDestroy\(\(\) => \{\s*closeLive\?\.\(\);/);
	});

	it('reads the filters again when the address changes under the same page, and not for its own write (review fix 1)', () => {
		// A visit to /todo while on /todo (Back or Forward between two of its
		// entries) keeps the page, so the filters follow page.url, not only arrival.
		expect(script).toMatch(/\$effect\(\(\) => \{\s*const search = page\.url\.search;\s*untrack\(\(\) => \{\s*if \(search === written\) return;/);
		expect(script).toMatch(/written = next\.search;\s*goto\(next, /);
		expect(script).toMatch(/import \{[^}]*\buntrack\b[^}]*\} from 'svelte';/);
	});

	it('checks the filters again after a live re-read (review fix 5)', () => {
		expect(script).toMatch(/\$effect\(\(\) => \{\s*const known = knownBoardFilters\(data\);[\s\S]*?keepKnownFilters\(filters, cards, known, context\)/);
		expect(script).toContain('filtersFromUrl(page.url, knownBoardFilters(data))');
	});

	it('scrolls a table wider than the window inside its own box, which the keyboard can scroll, and lets the title wrap (review fix 2)', () => {
		expect(source).toMatch(/<div class="table-scroll" tabindex="0" role="region" aria-label="[^"]+">\s*<table class="todo-table">/);
		expect(/\.table-scroll \{([^}]*)\}/.exec(css)![1]).toContain('overflow-x: auto;');
		const title = /\.c-title \{([^}]*)\}/.exec(css)![1];
		expect(title).not.toMatch(/min-width: 220px|white-space: nowrap/);
		expect(css).toMatch(/\.table-scroll:focus-visible \{/);
	});

	it('says a chosen board with an empty To Do as that board, with Show every board, and every column empty only for every board (review fix 3)', () => {
		const empty = source.slice(source.indexOf('{:else if scopeCards.length === 0}'), source.indexOf('{:else if rows.length === 0}'));
		expect(empty).toMatch(/\{#if filters\.board === 'all'\}\s*<p>Nothing to do: every To Do column is empty\.<\/p>\s*\{:else\}\s*<p>\{scopeName\.name\} has nothing in To Do\.<\/p>\s*<button class="hdr-control" onclick=\{\(\) => chooseBoard\('all'\)\}>Show every board<\/button>\s*\{\/if\}/);
	});

	it('filters and sorts through $lib/todo-table, as the tests above run it', () => {
		for (const call of [
			'filtersFromUrl(page.url',
			'dropUnknownChoices(',
			'filterChoices(data.cards, filters.board, ctx)',
			'passesTodoFilters(card, filters, ctx)',
			'sortTodoRows(',
			'todoContext(data, viewerId)'
		]) {
			expect(script, call).toContain(call);
		}
		// The notice for a board the caller cannot open, the same words whether it exists or not.
		expect(source).toContain('{#if boardRefused}');
		expect(source).toContain('The board in the address is not one you can open.');
	});

	it('sorts from real buttons in the headers, which say how the column is sorted', () => {
		for (const column of ['title', 'priority', 'board', 'category', 'due', 'subtasks', 'milestone', 'blocked']) {
			expect(source, column).toContain(`<th aria-sort={ariaSort('${column}')}><button class="sort-head" onclick={() => sortBy('${column}')}>`);
		}
		expect(source).toContain('<th>Labels</th>');
		expect(source).toContain('<th>Assignees</th>');
		// The title is a button; the row's own click does the same, and each link in the row stops it.
		expect(source).toContain('<tr class="todo-row" onclick={() => openCard(card)}>');
		expect(source).toContain('<button class="row-title" onclick={(e) => { e.stopPropagation(); openCard(card); }}>');
		expect(source).toContain('<a href="/board/{card.boardId}?card={card.id}" class="board-link"');
		expect(source.match(/onclick=\{\(e\) => e\.stopPropagation\(\)\}/g)).toHaveLength(2);
	});

	it('is a table at 1000 px and wider, blocks below with the filters folded, and ends clear of the user badge at both', () => {
		const at = css.indexOf('@media (max-width: 999px)');
		expect(at).toBeGreaterThan(-1);
		const narrow = css.slice(at);
		expect(/\.todo-page \{([^}]*)\}/.exec(css)![1]).toContain('padding: 0 var(--space-xl) var(--user-badge-space);');
		expect(narrow).toContain('.todo-page { padding: 0 16px var(--user-badge-space); }');
		expect(narrow).toContain('.filter-panel { display: none; width: 100%; }');
		expect(narrow).toContain('.filter-panel.open { display: flex; }');
		expect(narrow).toContain('.todo-table thead { display: none; }');
		expect(narrow).toContain('.todo-table td.is-empty { display: none; }');
		expect(source).toContain('Filters{#if foldedOn > 0}&nbsp;({foldedOn}){/if}');
	});

	it('prints a due date through formatDueDate, the day stored in any zone, and no stored value with new Date()', () => {
		// dueOn read it through parseStamp; card 2241 made one formatter for every page.
		expect(source).toContain('title="Due {formatDueDate(card.dueDate)}"');
		expect(script).not.toContain('function dueOn(');
		expect(source).not.toMatch(/new Date\(/);
	});
});

describe('the board filter, src/lib/components/BoardFilterSelect.svelte (test 15)', () => {
	const source = read('src/lib/components/BoardFilterSelect.svelte');
	const select = source.slice(source.indexOf('<select'), source.indexOf('</select>'));

	it('gives every board option its id as a string, so the chosen value is never a number (card 1990’s review)', () => {
		expect(select.match(/<option value=\{String\(option\.id\)\}>/g)).toHaveLength(2);
		expect(select).not.toMatch(/(?<!bind:)value=\{(?!String\()/);
		expect(select).toContain('<option value="all">All Boards</option>');
		expect(select).toContain('<option value="cat:{group.grouping.id}">');
	});

	it('groups the boards by the grouping each is filtered under, in boardOptions order', () => {
		expect(source).toContain('b.filterCategoryId === grouping.id');
		expect(source).toContain('!b.filterCategoryId');
		expect(source).toContain('boardOptions(group).map(({ board, depth }) => ({ id: board.id, label: boardOptionLabel(board, depth) }))');
		expect(source).not.toMatch(/\bb\.categoryId\b/);
	});
});

describe('the three ways in (test 16)', () => {
	it('the board’s More menu links to /todo?board=<id> after Planning, with BoardViewSwitch still first in the header', () => {
		// The board's header, moved from the board page by card 2280's slice B3; the page hands it the board's id.
		// Card 2466 moved Planning, All To Do and Add Column from the header's bar into its More menu, in that order.
		const header = read('src/lib/components/board/BoardHeader.svelte');
		const page = read('src/routes/board/[id]/+page.svelte');
		expect(page).toMatch(/<BoardHeader\s+boardId=\{data\.board\.id\}/);
		expect(page).toMatch(/<BoardMoreMenu[\s\S]*?boardId=\{data\.board\.id\}/);
		expect(header).toMatch(/<div class="board-header-right">\s*<BoardViewSwitch /);
		expect(header).not.toContain('/todo?board=');
		const source = read('src/lib/components/board/BoardMoreMenu.svelte');
		const planning = source.indexOf('href="/plan?board={boardId}"');
		const todo = source.indexOf('href="/todo?board={boardId}"');
		const addColumn = source.indexOf('title="Add column"');
		expect(planning).toBeGreaterThan(-1);
		expect(todo).toBeGreaterThan(planning);
		expect(addColumn).toBeGreaterThan(todo);
	});

	it('the dashboard has All To Do first in its Views menu, after the All Tasks pill', () => {
		// In the dashboard's header (card 2281, slice C2: moved from src/routes/+page.svelte).
		// Card 2466 moved it from a pill of its own into Views; mounted, in tests/header-menus.svelte.test.ts.
		const source = read('src/lib/components/dashboard/DashboardHeader.svelte');
		const all = source.indexOf('<a href="/all" class="nav-pill wide-only">');
		const views = source.indexOf('<HeaderMenu label="Views"');
		const todo = source.indexOf('<a href="/todo" class="hm-item" role="menuitem" tabindex="-1" id="todo-link">');
		const reports = source.indexOf('<a href="/reports" class="hm-item"');
		expect(all).toBeGreaterThan(-1);
		expect(views).toBeGreaterThan(all);
		expect(todo).toBeGreaterThan(views);
		expect(reports).toBeGreaterThan(todo);
	});

	it('All Tasks links to /todo beside Planning, carrying its board filter', () => {
		// In its header (card 2281, slice C3a-2: moved from src/routes/all/+page.svelte).
		const source = read('src/lib/components/tasks/AllTasksHeader.svelte');
		expect(source).toContain(
			"const todoHref = $derived(String(boardFilter) === 'all' ? '/todo' : `/todo?${new URLSearchParams({ board: String(boardFilter) })}`);"
		);
		const planning = source.indexOf("href={chosenBoard ? `/plan?board=${chosenBoard}` : '/plan'}");
		const todo = source.indexOf('<a href={todoHref} class="hdr-control hdr-action"');
		expect(planning).toBeGreaterThan(-1);
		expect(todo).toBeGreaterThan(planning);
		// What the link hands /todo is read back there as the same board filter.
		for (const board of ['12', 'cat:3']) {
			const url = new URL(`http://x/todo?${new URLSearchParams({ board })}`);
			expect(filtersFromUrl(url, { boardIds: [12], groupingIds: [3] }).filters.board).toBe(board);
		}
	});
});
