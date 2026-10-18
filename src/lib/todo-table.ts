/**
 * todo-table.ts — the All To Do table's filters, address and sort (card 2240).
 *
 * The page's load sends every To Do card the caller can open, and the page
 * filters and sorts them in the browser: a filter change is instant and
 * re-runs no load. The filters live in the address, so a filtered view can be
 * bookmarked or sent to someone, and this module reads them from it and
 * writes them back. It has no server imports; it is called by the page and
 * by the tests, with no browser.
 *
 * What each filter matches:
 *   - board: `inBoardFilter`, the board and its sub-boards at every depth, or
 *     a grouping and the sub-boards under its boards (card 1990);
 *   - category and label: by name, trimmed and in any case, since each board
 *     has its own, and "Bug" on five boards is one choice;
 *   - assignee: `me` is whoever is viewing, so a shared link means "mine" to
 *     whoever opens it; `none` is unassigned;
 *   - milestone: an id, or `none`;
 *   - state: `blocked` has an open blocker, `startable` has none;
 *   - search: `matchesSearch`, as the board and its list view search.
 */
import { boardPlaces, inBoardFilter, type BoardLink, type BoardPlace } from '$lib/board-tree';
import { matchesSearch } from '$lib/utils/card-utils';
import { PRIORITY_ORDER } from '$lib/utils/constants';
import type { CardType, CategoryType } from '$lib/types';

/** The priorities a filter can choose, most urgent first. */
export const TODO_PRIORITIES = ['critical', 'high', 'medium', 'low'] as const;
/** The states a filter can choose. */
export const TODO_STATES = ['blocked', 'startable'] as const;
/** The columns the table sorts by. Labels and assignees are not: a card has several of each. */
export const TODO_SORTS = ['priority', 'title', 'board', 'category', 'due', 'subtasks', 'milestone', 'blocked'] as const;

export type TodoSort = (typeof TODO_SORTS)[number];
export type SortDir = 'asc' | 'desc';

/** The table's filters and sort, as the address holds them. `''` is a filter's "any" choice. */
export type TodoFilters = {
	/** `all`, a board's id, or `cat:<grouping id>`, as `inBoardFilter` takes it. */
	board: string;
	/** One of `TODO_PRIORITIES`, or `''`. */
	priority: string;
	/** A category's name, or `''`. */
	category: string;
	/** A label's name, or `''`. */
	label: string;
	/** `me`, `none`, a user's id, or `''`. */
	assignee: string;
	/** `none`, a milestone's id, or `''`. */
	milestone: string;
	state: '' | (typeof TODO_STATES)[number];
	/** The search text. */
	q: string;
	/** A column, or `null` for the default order: priority, due date, board name, position. */
	sort: TodoSort | null;
	dir: SortDir;
};

/** Nothing filtered, the default order. */
export const NO_FILTERS: Readonly<TodoFilters> = Object.freeze({
	board: 'all',
	priority: '',
	category: '',
	label: '',
	assignee: '',
	milestone: '',
	state: '',
	q: '',
	sort: null,
	dir: 'asc'
});

/** The address's parameters, in the order they are written. */
const PARAMS = ['board', 'priority', 'category', 'label', 'assignee', 'milestone', 'state', 'q', 'sort', 'dir'] as const;

/** What the table reads of a card: a card as the load sends it has all of this and more. */
export type TodoCard = {
	id: number;
	title: string;
	description: string | null;
	priority: string;
	dueDate: string | null;
	position: number;
	pinned: boolean;
	categoryId: number | null;
	milestoneId: number | null;
	boardId: number;
	boardName: string;
	labelIds: number[];
	assignees: { id: number; username: string; emoji: string | null }[];
	subtasks: { completed: boolean }[];
};

/** What the filters and the sort look up, built once per load by `todoContext`. */
export type TodoContext = {
	/** Each board's place in the tree, from `boardPlaces`. */
	places: ReadonlyMap<number, BoardPlace>;
	/** The categories the load sent, carried ones included, for names and the search. */
	categories: readonly { id: number; name: string }[];
	/** A category's name by id. */
	categoryNames: ReadonlyMap<number, string>;
	/** A label's name by id. */
	labelNames: ReadonlyMap<number, string>;
	/** Open blockers by card id, as the load sends `blockedState`: a card with none is absent. */
	blockedState: Readonly<Record<number, readonly unknown[]>>;
	milestoneNames: Readonly<Record<number, string>>;
	/** Who is viewing: what `assignee=me` means. */
	viewerId: number;
};

/** The lookups the table needs, from what the load sends and who is viewing. */
export function todoContext(
	data: {
		boards: readonly (BoardLink & { id: number; name: string; emoji: string })[];
		categories: readonly { id: number; name: string }[];
		labels: readonly { id: number; name: string }[];
		blockedState: Readonly<Record<number, readonly unknown[]>>;
		milestoneNames: Readonly<Record<number, string>>;
	},
	viewerId: number
): TodoContext {
	return {
		places: boardPlaces(data.boards),
		categories: data.categories,
		categoryNames: new Map(data.categories.map((c) => [c.id, c.name])),
		labelNames: new Map(data.labels.map((l) => [l.id, l.name])),
		blockedState: data.blockedState,
		milestoneNames: data.milestoneNames,
		viewerId
	};
}

/** A name as filters compare it: trimmed, in any case. */
const nameKey = (name: string) => name.trim().toLowerCase();

const isId = (value: string) => /^\d+$/.test(value) && Number(value) > 0;

/** The boards and groupings the board filter offers: what an address, or a choice kept across a live re-read, may name. */
export type KnownBoardFilters = { boardIds: Iterable<number>; groupingIds?: Iterable<number> };

/**
 * What the board filter offers the caller, from what the load sent: every
 * board, and each grouping that holds one of those boards, as
 * `BoardFilterSelect` lists them. A grouping with none of the caller's boards
 * is not offered, so an address cannot choose it either.
 */
export function knownBoardFilters(data: {
	boards: readonly { id: number; filterCategoryId: number | null }[];
	boardCategories: readonly { id: number }[];
}): { boardIds: number[]; groupingIds: number[] } {
	const held = new Set(data.boards.map((b) => b.filterCategoryId).filter((id): id is number => id !== null));
	return { boardIds: data.boards.map((b) => b.id), groupingIds: data.boardCategories.map((c) => c.id).filter((id) => held.has(id)) };
}

/** A board filter's value in the one spelling the filter gives it: `all`, a board's id, `cat:<id>`; `null` for one it does not offer. */
function knownBoardFilter(board: string, known: KnownBoardFilters): string | null {
	if (board === 'all') return board;
	if (isId(board)) return new Set(known.boardIds).has(Number(board)) ? String(Number(board)) : null;
	const grouping = /^cat:(\d+)$/.exec(board);
	if (grouping === null || !isId(grouping[1])) return null;
	return new Set(known.groupingIds ?? []).has(Number(grouping[1])) ? `cat:${Number(grouping[1])}` : null;
}

/**
 * The filters in an address, and what was in it that the page does not
 * recognise, which is dropped and the filter left on its "any" choice. A
 * board, or a grouping, is kept only when it is among those the board filter
 * offers, `boardIds` and `groupingIds` (`knownBoardFilters`), a grouping
 * kept as `cat:<id>` whatever zeros led it; otherwise `boardRefused` is true, and
 * the page says so in the same words whether the board does not exist or is
 * not the caller's. A category, label, person or milestone that no card in
 * scope has is the page's to drop, with `dropUnknownChoices`, once it has the
 * cards.
 */
export function filtersFromUrl(
	url: URL | URLSearchParams,
	known: KnownBoardFilters
): { filters: TodoFilters; dropped: (keyof TodoFilters)[]; boardRefused: boolean } {
	const params = url instanceof URL ? url.searchParams : url;
	const filters: TodoFilters = { ...NO_FILTERS };
	const dropped: (keyof TodoFilters)[] = [];
	const read = (key: (typeof PARAMS)[number]) => params.get(key)?.trim() ?? '';
	const take = <K extends keyof TodoFilters>(key: K, value: string, ok: boolean, as: TodoFilters[K]) => {
		if (value === '') return;
		if (ok) filters[key] = as;
		else dropped.push(key);
	};

	const board = read('board');
	const boardKept = knownBoardFilter(board, known);
	take('board', board, boardKept !== null, boardKept ?? board);

	const priority = read('priority').toLowerCase();
	take('priority', priority, (TODO_PRIORITIES as readonly string[]).includes(priority), priority);
	take('category', read('category'), true, read('category'));
	take('label', read('label'), true, read('label'));
	const assignee = read('assignee').toLowerCase();
	take('assignee', assignee, assignee === 'me' || assignee === 'none' || isId(assignee), isId(assignee) ? String(Number(assignee)) : assignee);
	const milestone = read('milestone').toLowerCase();
	take('milestone', milestone, milestone === 'none' || isId(milestone), isId(milestone) ? String(Number(milestone)) : milestone);
	const state = read('state').toLowerCase();
	take('state', state, (TODO_STATES as readonly string[]).includes(state), state as TodoFilters['state']);
	// The search is kept as typed, spaces and all.
	filters.q = params.get('q') ?? '';

	const sort = read('sort').toLowerCase();
	take('sort', sort, (TODO_SORTS as readonly string[]).includes(sort), sort as TodoSort);
	const dir = read('dir').toLowerCase();
	take('dir', dir, filters.sort !== null && (dir === 'asc' || dir === 'desc'), dir as SortDir);

	return { filters, dropped, boardRefused: dropped.includes('board') };
}

/**
 * The address with these filters in it: each one that is on, and none that
 * is off, so the plain page is `/todo`; a search of nothing but spaces is
 * off, as it filters nothing. Every other parameter of `url` is kept. A new
 * URL; `url` is not changed.
 */
export function filtersToUrl(url: URL, filters: TodoFilters): URL {
	const next = new URL(url);
	for (const key of PARAMS) next.searchParams.delete(key);
	if (filters.board !== NO_FILTERS.board) next.searchParams.set('board', filters.board);
	for (const key of ['priority', 'category', 'label', 'assignee', 'milestone', 'state'] as const) {
		if (filters[key] !== '') next.searchParams.set(key, filters[key]);
	}
	if (filters.q.trim() !== '') next.searchParams.set('q', filters.q);
	if (filters.sort !== null) {
		next.searchParams.set('sort', filters.sort);
		next.searchParams.set('dir', filters.dir);
	}
	return next;
}

/** True while any filter is on. The sort is not a filter. */
export function isFiltering(filters: TodoFilters): boolean {
	return (
		filters.board !== NO_FILTERS.board ||
		filters.priority !== '' ||
		filters.category !== '' ||
		filters.label !== '' ||
		filters.assignee !== '' ||
		filters.milestone !== '' ||
		filters.state !== '' ||
		filters.q.trim() !== ''
	);
}

/** True if the card is blocked: it has an open blocker, as the Blocked chip shows. */
export function isBlocked(card: Pick<TodoCard, 'id'>, ctx: Pick<TodoContext, 'blockedState'>): boolean {
	return (ctx.blockedState[card.id]?.length ?? 0) > 0;
}

/** True if the card passes the board filter alone: what the other filters' choices are drawn from. */
export function inTodoBoardScope(card: Pick<TodoCard, 'boardId'>, board: string, ctx: Pick<TodoContext, 'places'>): boolean {
	return inBoardFilter(card.boardId, board, ctx.places);
}

/** True if the card passes every filter that is on. */
export function passesTodoFilters(card: TodoCard, filters: TodoFilters, ctx: TodoContext): boolean {
	if (!inTodoBoardScope(card, filters.board, ctx)) return false;
	if (filters.priority !== '' && card.priority !== filters.priority) return false;
	if (filters.category !== '') {
		const name = card.categoryId === null ? undefined : ctx.categoryNames.get(card.categoryId);
		if (name === undefined || nameKey(name) !== nameKey(filters.category)) return false;
	}
	if (filters.label !== '') {
		const wanted = nameKey(filters.label);
		if (!card.labelIds.some((id) => nameKey(ctx.labelNames.get(id) ?? '') === wanted)) return false;
	}
	if (filters.assignee === 'none') {
		if (card.assignees.length > 0) return false;
	} else if (filters.assignee !== '') {
		const who = filters.assignee === 'me' ? ctx.viewerId : Number(filters.assignee);
		if (!card.assignees.some((a) => a.id === who)) return false;
	}
	if (filters.milestone === 'none') {
		if (card.milestoneId !== null) return false;
	} else if (filters.milestone !== '' && card.milestoneId !== Number(filters.milestone)) return false;
	if (filters.state === 'blocked' && !isBlocked(card, ctx)) return false;
	if (filters.state === 'startable' && isBlocked(card, ctx)) return false;
	if (filters.q.trim() !== '' && !matchesSearch(card as unknown as CardType, filters.q, ctx.categories as CategoryType[])) return false;
	return true;
}

/** The choices of the category, label, assignee and milestone dropdowns. */
export type TodoChoices = {
	/** Category names, each once (by name, in any case), as the first card in scope spells it, A to Z. */
	categories: string[];
	/** Label names, the same way. */
	labels: string[];
	/** Each person assigned to a card in scope, by name. "Anyone", "Me" and "Unassigned" are the page's. */
	assignees: { id: number; username: string; emoji: string | null }[];
	/** Each milestone of a card in scope, by name. "Any" and "No milestone" are the page's. */
	milestones: { id: number; name: string }[];
};

/**
 * The dropdowns' choices, drawn from the cards that pass the board filter:
 * a category of a board the filter leaves out is not offered.
 */
export function filterChoices(cards: readonly TodoCard[], board: string, ctx: TodoContext): TodoChoices {
	const categories = new Map<string, string>();
	const labels = new Map<string, string>();
	const assignees = new Map<number, { id: number; username: string; emoji: string | null }>();
	const milestones = new Map<number, { id: number; name: string }>();
	const once = (into: Map<string, string>, name: string | undefined) => {
		if (name === undefined || name.trim() === '') return;
		if (!into.has(nameKey(name))) into.set(nameKey(name), name.trim());
	};

	for (const card of cards) {
		if (!inTodoBoardScope(card, board, ctx)) continue;
		if (card.categoryId !== null) once(categories, ctx.categoryNames.get(card.categoryId));
		for (const id of card.labelIds) once(labels, ctx.labelNames.get(id));
		for (const a of card.assignees) if (!assignees.has(a.id)) assignees.set(a.id, { id: a.id, username: a.username, emoji: a.emoji });
		if (card.milestoneId !== null && !milestones.has(card.milestoneId)) {
			milestones.set(card.milestoneId, { id: card.milestoneId, name: ctx.milestoneNames[card.milestoneId] ?? `Milestone ${card.milestoneId}` });
		}
	}

	const byText = (a: string, b: string) => a.localeCompare(b, undefined, { sensitivity: 'base' });
	return {
		categories: [...categories.values()].sort(byText),
		labels: [...labels.values()].sort(byText),
		assignees: [...assignees.values()].sort((a, b) => byText(a.username, b.username) || a.id - b.id),
		milestones: [...milestones.values()].sort((a, b) => byText(a.name, b.name) || a.id - b.id)
	};
}

/**
 * The filters with any category, label, person or milestone that is not
 * among the choices put back on "any", and which those were: what the page
 * does with an address naming one nobody in scope uses.
 */
export function dropUnknownChoices(filters: TodoFilters, choices: TodoChoices): { filters: TodoFilters; dropped: (keyof TodoFilters)[] } {
	const next = { ...filters };
	const dropped: (keyof TodoFilters)[] = [];
	const has = (names: string[], name: string) => names.some((n) => nameKey(n) === nameKey(name));
	if (next.category !== '' && !has(choices.categories, next.category)) dropped.push('category');
	if (next.label !== '' && !has(choices.labels, next.label)) dropped.push('label');
	if (isId(next.assignee) && !choices.assignees.some((a) => a.id === Number(next.assignee))) dropped.push('assignee');
	if (isId(next.milestone) && !choices.milestones.some((m) => m.id === Number(next.milestone))) dropped.push('milestone');
	for (const key of dropped) (next as Record<string, unknown>)[key] = '';
	return { filters: next, dropped };
}

/**
 * The filters checked again against a fresh load, as after a live re-read: a
 * board or grouping the filter no longer offers goes back to every board, and
 * `boardRefused` is true so the page says so as it does for an address; then
 * a category, label, person or milestone no card in scope has any more goes
 * back on "any", quietly, as `dropUnknownChoices` does on arrival. Filters
 * that are all still good come back with the same values and nothing dropped.
 */
export function keepKnownFilters(
	filters: TodoFilters,
	cards: readonly TodoCard[],
	known: KnownBoardFilters,
	ctx: TodoContext
): { filters: TodoFilters; dropped: (keyof TodoFilters)[]; boardRefused: boolean } {
	const board = knownBoardFilter(filters.board, known);
	const scoped = board === null ? { ...filters, board: NO_FILTERS.board } : filters;
	const rest = dropUnknownChoices(scoped, filterChoices(cards, scoped.board, ctx));
	return { filters: rest.filters, dropped: board === null ? ['board', ...rest.dropped] : rest.dropped, boardRefused: board === null };
}

/** The default order: priority (critical first), due date (soonest, none last), board name, position on the board. */
function byDefault(a: TodoCard, b: TodoCard): number {
	return (
		compareKeys(priorityKey(a), priorityKey(b)) ||
		compareKeys(dueKey(a), dueKey(b)) ||
		a.boardName.localeCompare(b.boardName) ||
		a.position - b.position ||
		a.id - b.id
	);
}

type Key = number | string | null;

const priorityKey = (card: TodoCard): Key => (Object.hasOwn(PRIORITY_ORDER, card.priority) ? PRIORITY_ORDER[card.priority] : null);
const dueKey = (card: TodoCard): Key => card.dueDate || null;

/** Two keys in ascending order, no value after any value. */
function compareKeys(a: Key, b: Key): number {
	if (a === null || b === null) return a === b ? 0 : a === null ? 1 : -1;
	if (typeof a === 'number' && typeof b === 'number') return a - b;
	return String(a).localeCompare(String(b), undefined, { sensitivity: 'base' });
}

/** The key a column sorts on; `null` is no value, which sorts last either way. */
function sortKey(card: TodoCard, sort: TodoSort, ctx: TodoContext): Key {
	switch (sort) {
		case 'priority':
			return priorityKey(card);
		case 'title':
			return card.title.trim() || null;
		case 'board':
			return card.boardName;
		case 'category':
			return (card.categoryId !== null && ctx.categoryNames.get(card.categoryId)) || null;
		case 'due':
			return dueKey(card);
		case 'subtasks':
			// Open steps; a card with no steps at all has no value.
			return card.subtasks.length === 0 ? null : card.subtasks.filter((s) => !s.completed).length;
		case 'milestone':
			return card.milestoneId === null ? null : (ctx.milestoneNames[card.milestoneId] ?? `Milestone ${card.milestoneId}`);
		case 'blocked':
			// Ascending puts the blocked cards first.
			return isBlocked(card, ctx) ? 0 : 1;
	}
}

/**
 * The cards in the table's order, as a new array. With no column chosen,
 * the default order; with one, by it, `desc` reversing it, a card with no
 * value last either way, and the default order among equals. A pinned card
 * is not put first: across boards a pin would stop "sort by due date"
 * sorting by due date.
 */
export function sortTodoRows<C extends TodoCard>(cards: readonly C[], sort: TodoSort | null, dir: SortDir, ctx: TodoContext): C[] {
	const sorted = [...cards];
	if (sort === null) return sorted.sort(byDefault);
	const flip = dir === 'desc' ? -1 : 1;
	return sorted.sort((a, b) => {
		const ka = sortKey(a, sort, ctx);
		const kb = sortKey(b, sort, ctx);
		if (ka === null || kb === null) return compareKeys(ka, kb) || byDefault(a, b);
		return flip * compareKeys(ka, kb) || byDefault(a, b);
	});
}
