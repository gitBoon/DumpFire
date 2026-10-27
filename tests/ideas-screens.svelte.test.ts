// @vitest-environment jsdom
/**
 * An ideas board on the screens (milestone 22, card 2463, slice S5b): the
 * kind on Create Board, the header's "Ideas board", the More menu's kind
 * items, an ideas board's columns, "Send to board…" in the card menu and the
 * card window, and the Send window itself. The server side is slice S5a's, in
 * `tests/ideas-board.test.ts`, which also holds the page's own words, said
 * before it asks, to the server's, and the read the Send window lists.
 *
 * Mounted with Svelte's client runtime, as `tests/upstream-screens.svelte.test.ts`
 * is, where a component can be drawn on its own; read from the source where
 * it is the board page, as the kanban-column-header and header-menus tests
 * read it. Each block first draws a delivery board and shows that it looks as
 * it did.
 *
 * The plan is `docs/planning/milestone-22-upstream-kanban.md`, section 3's
 * card E and section 7 (rulings i, j and l, the S5a review's L1, L2 and L6).
 */
import { readFileSync } from 'node:fs';
import { join } from 'node:path';
import { pathToFileURL } from 'node:url';
import { afterEach, describe, expect, it, vi, type Mock } from 'vitest';
import type * as Svelte from 'svelte';
import CreateBoardModal from '$lib/components/dashboard/CreateBoardModal.svelte';
import BoardHeader from '$lib/components/board/BoardHeader.svelte';
import BoardMoreMenu from '$lib/components/board/BoardMoreMenu.svelte';
import KanbanColumnHeader from '$lib/components/board/KanbanColumnHeader.svelte';
import ContextMenu from '$lib/components/board/ContextMenu.svelte';
import SendToBoardModal from '$lib/components/board/SendToBoardModal.svelte';
import CardSubBoards from '$lib/components/card/CardSubBoards.svelte';
import BoardContextMenu from '$lib/components/dashboard/BoardContextMenu.svelte';
import { BoardState } from '$lib/board/board-state.svelte';
import type { BoardContentsData } from '$lib/board/contents-answer';
import {
	columnDeleteRefusal,
	convertBoardAndRead,
	deliverySwitch,
	ideasConversion,
	isUpstreamCard,
	sendOption,
	switchBoardKindAndRead
} from '$lib/board/ideas-board';
import { cardArchiveWarning, deliveryBoardRefusal, deliveryBoardWarning, ideasBoardColumnRefusal, ideasBoardSubBoardRefusal, ideasBoardWarning } from '$lib/api';
import type { CardType, ColumnType } from '$lib/types';

// A bare 'svelte' is the server's (see the XP bars' file), whose `onMount`
// never runs: the Send window reads its boards in one. So every import of it
// here, the components' too, is the browser's.
vi.mock('svelte', async () => {
	const { join: joinPath } = await import('node:path');
	const { pathToFileURL: toUrl } = await import('node:url');
	return await import(/* @vite-ignore */ toUrl(joinPath(process.cwd(), 'node_modules/svelte/src/index-client.js')).href);
});

// Create Board opens the new board with `goto`, which only a running SvelteKit app has.
const went = vi.hoisted(() => ({ to: [] as string[] }));
vi.mock('$app/navigation', () => ({
	goto: async (to: string) => {
		went.to.push(to);
	},
	invalidateAll: async () => {}
}));

const clientEntry = pathToFileURL(join(process.cwd(), 'node_modules/svelte/src/index-client.js')).href;
const { flushSync, mount, unmount }: typeof Svelte = await import(/* @vite-ignore */ clientEntry);

const source = (path: string) => readFileSync(join(process.cwd(), path), 'utf8');
const BOARD_PAGE = 'src/routes/board/[id]/+page.svelte';

let drawn: { component: ReturnType<typeof mount>; target: HTMLElement }[] = [];

function draw(component: unknown, props: Record<string, unknown>): HTMLElement {
	const target = document.createElement('div');
	document.body.appendChild(target);
	drawn.push({ component: mount(component as Parameters<typeof mount>[0], { target, props } as never), target });
	flushSync();
	return target;
}

afterEach(() => {
	for (const { component, target } of drawn) {
		unmount(component);
		target.remove();
	}
	drawn = [];
	went.to = [];
	vi.unstubAllGlobals();
});

/** Every fetch made, settled, and the page drawn again. */
async function settle() {
	for (let i = 0; i < 5; i++) await new Promise((resolve) => setTimeout(resolve, 0));
	flushSync();
}

const text = (el: Element | null | undefined) => el?.textContent?.replace(/\s+/g, ' ').trim() ?? null;
const noop = () => {};

// ─── Create Board ────────────────────────────────────────────────────────────

describe('Create Board’s kind (card 2463)', () => {
	let posted: Mock<(url: string, init?: RequestInit) => Promise<Response>>;

	function drawCreate() {
		posted = vi.fn(async () => ({ ok: true, status: 201, json: async () => ({ id: 42 }) }) as Response);
		vi.stubGlobal('fetch', posted);
		return draw(CreateBoardModal, { data: { allCategories: [] }, showCreate: true });
	}

	async function create(target: HTMLElement, name: string) {
		const box = target.querySelector<HTMLInputElement>('#board-name')!;
		box.value = name;
		box.dispatchEvent(new Event('input', { bubbles: true }));
		flushSync();
		[...target.querySelectorAll<HTMLButtonElement>('button')].find((b) => text(b) === 'Create Board')!.click();
		await settle();
		return JSON.parse(String(posted.mock.calls[0][1]!.body));
	}

	it('makes a delivery board as before, the kind chosen by default and said', async () => {
		const target = drawCreate();
		const kinds = [...target.querySelectorAll<HTMLInputElement>('input[name="board-kind"]')];
		expect(kinds.map((k) => [k.value, k.checked, text(k.closest('label'))])).toEqual([
			['delivery', true, 'Delivery board'],
			['ideas', false, 'Ideas board']
		]);
		expect(text(target.querySelector('.board-kind legend'))).toBe('Kind');
		// It names the Options column every delivery board is made with (card 2527, R11).
		expect(text(target.querySelector('.kind-hint'))).toBe(
			'A delivery board holds committed work, in To Do, On Hold, In Progress and Complete, with an Options column at the far left for ideas not yet committed to, folded away until it is opened.'
		);

		// Asked for as it always was: no kind, the server's default (tests/dashboard.test.ts holds the same body).
		expect(await create(target, 'Sprint 24')).toEqual({ name: 'Sprint 24', emoji: '📋', categoryId: null });
		expect(posted.mock.calls[0][0]).toBe('/api/boards');
		expect(went.to).toEqual(['/board/42']);
	});

	it('makes an ideas board when Ideas board is chosen, saying in one line what one is', async () => {
		const target = drawCreate();
		target.querySelector<HTMLInputElement>('input[value="ideas"]')!.click();
		flushSync();
		expect(text(target.querySelector('.kind-hint'))).toBe(
			'An ideas board holds ideas not yet committed to, in New Ideas, Shaping and Ready for Replenishment. Each is sent on to a delivery board when it is chosen.'
		);
		expect(await create(target, 'Ideas')).toEqual({ name: 'Ideas', emoji: '📋', categoryId: null, kind: 'ideas' });
	});

	it('offers no kind where a sub-board is made: a sub-board is always a delivery board', () => {
		// The dashboard's New Sub-board and the card window's Add Sub-board send none, so the server makes a delivery board.
		expect(source('src/lib/components/dashboard/BoardContextMenu.svelte')).toContain("body: JSON.stringify({ name, emoji: '🗂️', parentCardId })");
		const cardActions = source('src/lib/board/card-actions.ts');
		expect(cardActions).toContain('api.createBoard({');
		expect(cardActions).not.toMatch(/kind:/);
	});
});

// ─── The board header and its More menu ──────────────────────────────────────

describe('the board header’s "Ideas board" (card 2463)', () => {
	function drawHeader(boardKind?: string) {
		return draw(BoardHeader, {
			boardId: 7, boardName: 'Website', boardEmoji: '📋', ...(boardKind ? { boardKind } : {}),
			breadcrumbs: [], tokenSummary: null, editingName: false, nameDraft: '', searchQuery: '',
			filterAssigneeId: null, hideBlocked: false, currentUser: { id: 1 }, boardUsers: [], view: 'board',
			onEmoji: noop, onStartRename: noop, onRename: noop, onViewChange: noop
		});
	}

	it('says nothing of a delivery board, as before, and marks an ideas board', () => {
		expect(drawHeader().querySelector('.board-kind-badge')).toBeNull();
		expect(drawHeader('delivery').querySelector('.board-kind-badge')).toBeNull();
		const badge = drawHeader('ideas').querySelector('.board-kind-badge');
		expect(text(badge)).toBe('Ideas board');
		expect(badge?.getAttribute('title')).toBe('An ideas board: every card on it is an idea, not yet committed to, until it is sent on to a delivery board');
		expect(source(BOARD_PAGE)).toMatch(/<BoardHeader[\s\S]*?boardKind=\{boardState\.board\.kind\}/);
	});
});

describe('the More menu’s kind (card 2463)', () => {
	function drawMore(more: { canManage?: boolean; isSubBoard?: boolean; boardKind?: string } = {}) {
		const calls: string[] = [];
		const target = draw(BoardMoreMenu, {
			open: false, showActivityPanel: false, showStatsPanel: false, showArchivePanel: false, selectionMode: false,
			canManage: more.canManage ?? true, isSubBoard: more.isSubBoard ?? false, boardId: 7,
			...(more.boardKind ? { boardKind: more.boardKind } : {}),
			onAddColumn: noop, onToggleActivity: noop, onToggleStats: noop, onToggleArchive: noop,
			onManageCategories: noop, onToggleSelection: noop, onShare: noop, onDeleteSubBoard: noop,
			onMakeIdeas: () => calls.push('ideas'), onMakeDelivery: () => calls.push('delivery')
		});
		return { target, calls };
	}

	async function items(target: HTMLElement) {
		target.querySelector<HTMLButtonElement>('.more-menu-trigger')!.click();
		await settle();
		return [...document.querySelectorAll<HTMLElement>('[role="menu"][aria-label="More"] [role="menuitem"]')];
	}

	const named = (list: HTMLElement[], name: string) => list.find((item) => text(item) === name);

	it('offers the owner of a delivery board "Make this an ideas board…", the label the server’s refusal names, with Burndown as before', async () => {
		const { target, calls } = drawMore();
		const list = await items(target);
		expect(named(list, '📉 Burndown')?.getAttribute('href')).toBe('/burndown?boardIds=7');
		const item = named(list, '💡 Make this an ideas board…')!;
		expect(item).toBeTruthy();
		expect(named(list, '🚚 Make this a delivery board…')).toBeUndefined();
		item.click();
		flushSync();
		expect(calls).toEqual(['ideas']);
		// The server's 409 for a board holding cards names that item.
		expect(source('src/lib/server/boards.ts')).toContain(`'"Make this an ideas board…" in its More menu'`);
	});

	it('offers it to nobody who does not manage the board, and not on a sub-board, a delivery board always', async () => {
		for (const more of [{ canManage: false }, { isSubBoard: true }]) {
			const { target } = drawMore(more);
			const list = await items(target);
			expect(list.map(text).filter((name) => name?.includes('Make this')), JSON.stringify(more)).toEqual([]);
			document.body.click();
			flushSync();
		}
	});

	it('offers the owner of an ideas board the way back, and no burndown', async () => {
		const { target, calls } = drawMore({ boardKind: 'ideas' });
		const list = await items(target);
		expect(named(list, '📉 Burndown')).toBeUndefined();
		expect(named(list, '💡 Make this an ideas board…')).toBeUndefined();
		const back = named(list, '🚚 Make this a delivery board…')!;
		expect(back.getAttribute('title')).toBe('Only an ideas board holding no cards can be made a delivery board');
		back.click();
		flushSync();
		expect(calls).toEqual(['delivery']);
	});

	it('is wired on the board page to the conversion and the empty switch, each decided and sent by $lib/board/ideas-board', () => {
		const page = source(BOARD_PAGE);
		expect(page).toMatch(/<BoardMoreMenu[\s\S]*?boardKind=\{boardState\.board\.kind\}[\s\S]*?onMakeIdeas=\{makeIdeasBoard\}[\s\S]*?onMakeDelivery=\{makeDeliveryBoard\}/);
		const fn = (name: string) => {
			const at = page.indexOf(`async function ${name}(`);
			return page.slice(at, page.indexOf('\n\t}\r\n', at));
		};
		const ideas = fn('makeIdeasBoard');
		expect(ideas).toContain('const archived = await archivedByColumn();');
		expect(ideas).toContain('ideasBoard.ideasConversion(boardName, boardState.columns, archived)');
		expect(ideas).toContain('ideasBoard.convertBoardAndRead(boardState, data.board.id, asked.cards, KIND_WORDS)');
		const delivery = fn('makeDeliveryBoard');
		expect(delivery).toContain('ideasBoard.deliverySwitch(boardName, boardState.columns, archived)');
		expect(delivery).toContain("ideasBoard.switchBoardKindAndRead(boardState, data.board.id, 'delivery', KIND_WORDS)");
	});
});

// ─── What the page decides and sends, run (the S5b review's P3) ──────────────

/** A column as the board page draws it, holding cards with these ids. */
function boardColumn(id: number, title: string, cardIds: number[], role: 'options' | null = null, more: Partial<CardType> = {}): ColumnType {
	return {
		id, boardId: 1, title, position: id, color: '#6366f1', wipLimit: 0, showAddCard: false, role,
		cards: cardIds.map((cardId) => ({ id: cardId, title: `Card ${cardId}`, columnId: id, subBoards: [], ...more }) as unknown as CardType)
	} as unknown as ColumnType;
}

function contentsOf(kind: 'delivery' | 'ideas', columns: ColumnType[]): BoardContentsData {
	return {
		board: { id: 1, name: 'Roadmap', emoji: '📋', parentCardId: null, kind },
		breadcrumbs: [], columns, categories: [], labels: [], linkableBoards: [], canEdit: true, canManage: true,
		userBoardRole: 'owner', boardUsers: [], blockedState: {}, cardTokens: {}, boardTokenSummary: null, milestones: []
	};
}

const json = (status: number, body: unknown) => new Response(JSON.stringify(body), { status, headers: { 'content-type': 'application/json' } });
const WORDS = { refused: 'Not changed.', noAnswer: 'No answer.' };

let states: BoardState[] = [];
afterEach(() => {
	for (const state of states) state.dispose();
	states = [];
});

/** A board state on `start`, whose re-reads of the contents answer `next`, and the page's own writes (the global fetch) answered by `write`. */
function stateOn(start: BoardContentsData, next: BoardContentsData, write: (url: string, init?: RequestInit) => Response) {
	const reads: string[] = [];
	const written: { url: string; body: unknown }[] = [];
	const state = new BoardState(start, {
		invalidate: async () => {},
		fetch: async (input) => {
			reads.push(String(input));
			return json(200, next);
		}
	});
	states.push(state);
	vi.stubGlobal('fetch', async (url: string, init?: RequestInit) => {
		written.push({ url, body: init?.body ? JSON.parse(String(init.body)) : null });
		return write(url, init);
	});
	return { state, reads, written };
}

describe('the board’s kind, decided and sent (card 2463)', () => {
	const none = new Map<number, number>();

	it('refuses a conversion the server would refuse, in its words, before asking: a live card with a sub-board, then a titled column holding cards, live or archived', () => {
		const withSubBoard = [boardColumn(1, 'Backlog', [1], null, { subBoards: [{ id: 9 }] } as unknown as Partial<CardType>), boardColumn(2, 'To Do', [2])];
		expect(ideasConversion('Roadmap', withSubBoard, none)).toEqual({ refused: ideasBoardSubBoardRefusal('Card 1') });
		expect(ideasConversion('Roadmap', [boardColumn(1, 'Backlog', [1]), boardColumn(2, 'To Do', [2])], none)).toEqual({ refused: ideasBoardColumnRefusal('To Do', 1, 'todo') });
		// Archived cards count: a Complete column holding only archived ones.
		expect(ideasConversion('Roadmap', [boardColumn(1, 'Backlog', [1]), boardColumn(4, 'Complete', [])], new Map([[4, 2]]))).toEqual({
			refused: '"Complete" holds 2 cards, and an ideas board has no Complete column: move them to a delivery board, or delete them, first.'
		});
	});

	it('asks with the count to send, the empty titled columns that go, or, on an empty board, the columns replaced', () => {
		const asked = ideasConversion('Roadmap', [boardColumn(1, 'Backlog', [1, 2]), boardColumn(2, 'On Hold', []), boardColumn(3, 'Complete', [])], new Map([[1, 1]]));
		expect(asked).toEqual({ question: ideasBoardWarning('Roadmap', 2, 1, ['Backlog', 'On Hold', 'Complete'], ['On Hold', 'Complete']), cards: 3 });
		const empty = ideasConversion('Roadmap', [boardColumn(1, 'To Do', []), boardColumn(2, 'Complete', [])], none);
		expect(empty).toEqual({ question: ideasBoardWarning('Roadmap', 0, 0, ['To Do', 'Complete'], []), cards: 0 });
		// An empty Options column goes too, named in the board's order, as the server removes it (card 2527, R11 and ruling O7);
		// one holding a card, live or archived, stays, an ordinary column of the ideas board.
		const withOptions = [boardColumn(9, 'Options', [], 'options'), boardColumn(1, 'Backlog', [1]), boardColumn(3, 'Complete', [])];
		expect(ideasConversion('Roadmap', withOptions, none)).toEqual({
			question: ideasBoardWarning('Roadmap', 1, 0, ['Options', 'Backlog', 'Complete'], ['Options', 'Complete'], true),
			cards: 1
		});
		expect((ideasConversion('Roadmap', withOptions, none) as { question: string }).question).toContain(
			'Its empty columns Options and Complete are removed: an ideas board has no Options, To Do, On Hold or Complete column.'
		);
		// The Options column kept, holding an archived card: Options is not named among what an ideas board lacks (P4).
		expect((ideasConversion('Roadmap', withOptions, new Map([[9, 1]])) as { question: string }).question).toContain(
			'Its empty column Complete is removed: an ideas board has no To Do, On Hold or Complete column.'
		);
		expect(ideasConversion('Roadmap', withOptions, new Map([[9, 1]]))).toEqual({
			question: ideasBoardWarning('Roadmap', 1, 1, ['Options', 'Backlog', 'Complete'], ['Complete']),
			cards: 2
		});
		const holding = [boardColumn(9, 'Options', [2], 'options'), boardColumn(1, 'Backlog', [1])];
		expect(ideasConversion('Roadmap', holding, none)).toEqual({ question: ideasBoardWarning('Roadmap', 2, 0, ['Options', 'Backlog'], []), cards: 2 });
		expect(deliverySwitch('Ideas', [boardColumn(1, 'Shaping', [1])], none)).toEqual({ refused: deliveryBoardRefusal(1) });
		expect(deliverySwitch('Ideas', [boardColumn(1, 'Shaping', [])], new Map([[1, 2]]))).toEqual({ refused: deliveryBoardRefusal(2) });
		expect(deliverySwitch('Ideas', [boardColumn(1, 'Shaping', [])], none)).toEqual({ question: deliveryBoardWarning('Ideas', ['Shaping']), cards: 0 });
	});

	it('converts, then reads the board again, so its kind and columns flip with no reload', async () => {
		const ideas = contentsOf('ideas', [boardColumn(11, 'Backlog', [1])]);
		const { state, reads, written } = stateOn(contentsOf('delivery', [boardColumn(1, 'Backlog', [1]), boardColumn(2, 'Complete', [])]), ideas, () => json(200, { id: 1, kind: 'ideas', columns: [] }));
		const result = await convertBoardAndRead(state, 1, 1, WORDS);
		expect(result.ok).toBe(true);
		expect(written).toEqual([{ url: '/api/boards/1/convert', body: { kind: 'ideas', cards: 1 } }]);
		expect(reads).toEqual(['/api/boards/1/contents']);
		expect(state.board.kind).toBe('ideas');
		expect(state.columns.map((c) => c.title)).toEqual(['Backlog']);
	});

	it('switches an empty board back, read again; a refusal is the server’s words, and the board stays as it was', async () => {
		const delivery = contentsOf('delivery', ['To Do', 'On Hold', 'In Progress', 'Complete'].map((t, i) => boardColumn(20 + i, t, [])));
		const { state, written } = stateOn(contentsOf('ideas', [boardColumn(1, 'Shaping', [])]), delivery, () => json(200, { id: 1, kind: 'delivery' }));
		expect((await switchBoardKindAndRead(state, 1, 'delivery', WORDS)).ok).toBe(true);
		expect(written).toEqual([{ url: '/api/boards/1', body: { kind: 'delivery' } }]);
		expect(state.board.kind).toBe('delivery');
		expect(state.columns.map((c) => c.title)).toEqual(['To Do', 'On Hold', 'In Progress', 'Complete']);

		const refused = stateOn(contentsOf('delivery', [boardColumn(1, 'Backlog', [1])]), contentsOf('ideas', []), () => json(409, { message: 'The board now holds 2 cards; look again.' }));
		expect(await convertBoardAndRead(refused.state, 1, 1, WORDS)).toEqual({ ok: false, failure: 'The board now holds 2 cards; look again.' });
		expect(refused.state.board.kind).toBe('delivery');
	});

	it('says at once why a column holding ideas is not deleted, in the server’s words, and nothing for any other (L2)', () => {
		const columns = [boardColumn(1, 'Options', [1], 'options'), boardColumn(2, 'To Do', [2, 3]), boardColumn(3, 'Shaping', [4, 5]), boardColumn(4, 'Empty', [])];
		// The Options column is never offered a delete (card 2527, R9): the page has nothing of its own to say of it.
		expect(columnDeleteRefusal(columns, 1, 'delivery')).toBeNull();
		expect(source('src/lib/board/ideas-board.ts')).not.toContain('This Options column still holds');
		expect(columnDeleteRefusal(columns, 2, 'delivery')).toBeNull();
		expect(columnDeleteRefusal(columns, 3, 'ideas')).toBe('This column of an ideas board still holds 2 ideas: move them out, or archive them to discard them, first.');
		expect(columnDeleteRefusal([boardColumn(3, 'Shaping', [4])], 3, 'ideas')).toBe('This column of an ideas board still holds 1 idea: move it out, or archive it to discard it, first.');
		expect(columnDeleteRefusal(columns, 4, 'ideas')).toBeNull();
		// The server says the same.
		expect(source('src/lib/server/columns.ts')).toContain('This column of an ideas board still holds');
		expect(source(BOARD_PAGE)).toContain('const refused = ideasBoard.columnDeleteRefusal(boardState.columns, colId, boardState.board.kind);');
	});
});

// ─── An ideas board's columns ────────────────────────────────────────────────

describe('an ideas board’s columns (card 2463)', () => {
	function drawColumn(title: string, boardKind: string, more: Record<string, unknown> = {}) {
		const column = { id: 1, boardId: 1, title, position: 0, color: '#6366f1', wipLimit: 3, showAddCard: false, role: null, cards: [] } as unknown as ColumnType;
		return draw(KanbanColumnHeader, {
			column, canManage: true, boardKind, editing: false, editTitle: '', editingWip: false, wipLimitInput: 0,
			sort: undefined, visibleCount: null, colorOpen: false, menuOpen: true,
			onStartRename: noop, onFinishRename: noop, onSort: noop, onAddCard: noop, onToggleDropdown: noop,
			onColor: noop, onToggleAddCard: noop, onStartWip: noop, onSaveWip: noop, onCancelWip: noop,
			onDelete: noop, onCloseDropdowns: noop, ...more
		});
	}
	const menu = (target: HTMLElement) => [...target.querySelectorAll('.column-menu-item')].map(text);

	it('draws a delivery board’s column as before: no Add Task off its switch, Show Add Task and the WIP limit in its menu, no aging', () => {
		const target = drawColumn('Shaping', 'delivery');
		expect(target.querySelector('.add-card-badge')).toBeNull();
		expect(menu(target)).toContain('○ Show Add Task');
		expect(menu(target)).toContain('📊 WIP Limit (3)');
		expect(target.querySelector('.aging-chip')).toBeNull();
	});

	it('offers "Add idea" on every column of an ideas board, with no Show Add Task switch, and keeps its WIP limit (M22-13)', () => {
		for (const title of ['New Ideas', 'Shaping', 'Ready for Replenishment']) {
			const target = drawColumn(title, 'ideas');
			expect(text(target.querySelector('.add-card-badge')), title).toBe('Add idea');
			expect(menu(target).some((item) => item?.includes('Show Add Task')), title).toBe(false);
			expect(menu(target), title).toContain('📊 WIP Limit (3)');
			// Not the Options column's suffix or collapse: an ideas board has none.
			expect(target.querySelector('.options-suffix'), title).toBeNull();
			expect(target.querySelector('.options-collapse'), title).toBeNull();
			expect(menu(target).some((item) => item?.includes('Options column')), title).toBe(false);
		}
	});

	it('shows its options aging, the oldest idea and those older than 30 days, as the Options strip does (ruling g)', () => {
		const target = drawColumn('Shaping', 'ideas', { aging: { oldestDays: 45, over: 2 } });
		expect([...target.querySelectorAll('.aging-chip')].map((chip) => [text(chip), chip.getAttribute('title')])).toEqual([
			['2 >30d', '2 ideas are older than 30 days'],
			['oldest 45d', "The oldest idea's age"]
		]);
		const one = drawColumn('Shaping', 'ideas', { aging: { oldestDays: 31, over: 1 } });
		expect(one.querySelector('.aging-over')?.getAttribute('title')).toBe('1 idea is older than 30 days');
		const young = drawColumn('Shaping', 'ideas', { aging: { oldestDays: 3, over: 0 } });
		expect([...young.querySelectorAll('.aging-chip')].map(text)).toEqual(['oldest 3d']);
		expect(drawColumn('Shaping', 'ideas', { aging: { oldestDays: null, over: 0 } }).querySelector('.aging-chip')).toBeNull();
	});

	it('is handed its aging by the board page on an ideas board only, from every card’s optionSince, with no Options strip', () => {
		const page = source(BOARD_PAGE);
		expect(page).toContain('aging={isIdeasBoard ? agingOf(column) : null}');
		expect(page).toContain("const isIdeasBoard = $derived(boardState.board.kind === 'ideas');");
		expect(page).toMatch(/function agingOf\(column: ColumnType\) \{\r?\n\t\tvoid tick;\r?\n\t\treturn optionsAging\(column\.cards\);/);
		// The strip is the Options column's, by its role: an ideas board has none (S5a clears the role on conversion).
		expect(page).toContain('{@const collapsed = isOptionsColumn(column) && !optionsOpen}');
		// The empty column says "No ideas yet" on every upstream column, and double-click adds one.
		expect(page).toContain("<span class=\"empty-text\">{isUpstreamColumn(column, boardState.board.kind) ? 'No ideas yet' : 'No cards yet'}</span>");
	});
});

// ─── All Tasks ───────────────────────────────────────────────────────────────

describe('All Tasks on an ideas board (card 2463; the S3 review’s E6 and the S4b review’s J3)', () => {
	const all = source('src/routes/all/+page.svelte');

	it('says an idea’s archive is a discard on an ideas board too, from the board’s kind its load gives, as on a delivery board’s Options', () => {
		const columns = [
			{ id: 1, boardId: 10, role: 'options' },
			{ id: 2, boardId: 10, role: null },
			{ id: 3, boardId: 20, role: null }
		];
		const boards = [{ id: 10, kind: 'delivery' }, { id: 20, kind: 'ideas' }];
		expect([1, 2, 3, 99, null].map((columnId) => isUpstreamCard(columnId, columns, boards))).toEqual([true, false, true, false, false]);
		// What the question and the toast say of each.
		expect(cardArchiveWarning('Idea', isUpstreamCard(3, columns, boards))).toContain('This idea will be recorded as discarded.');
		expect(cardArchiveWarning('Work', isUpstreamCard(2, columns, boards))).not.toContain('discarded');
		const at = all.indexOf('function archiveFromWindow(');
		const fn = all.slice(at, all.indexOf('\n\t}\n', at));
		expect(fn).toContain('const discards = isUpstreamCard(cardWindow.card?.columnId, data.columns, data.boards);');
		expect(fn).toContain('cardArchiveWarning(title, discards)');
		expect(fn).toContain("toasts.add(cardArchivedMessage(title, discards), 'info');");
	});

	it('hands the Stats panel the chosen board’s kind as loaded, with nothing inferred', () => {
		expect(all).toContain("{@const chosenKind = (chosenBoard && data.boards.find((b) => b.id === chosenBoard)?.kind) || 'delivery'}");
		expect(all).not.toMatch(/holdsOptions|cfdKind/);
	});
});

// ─── Send to board ───────────────────────────────────────────────────────────

const aCard = { id: 5, title: 'An idea', subBoards: [], pinned: false } as unknown as CardType;

describe('"Send to board…" in the card menu (card 2463)', () => {
	function drawMenu(onSend?: (card: CardType) => void) {
		const calls: string[] = [];
		const target = draw(ContextMenu, {
			card: aCard, columnId: 1, x: 0, y: 0, columns: [],
			onClose: () => calls.push('close'), onMove: noop, onPriority: noop, onTogglePin: noop, onDuplicate: noop,
			onCreateSubBoard: noop, onDelete: noop, ...(onSend ? { onSend } : {})
		});
		return { target, calls };
	}
	const names = (target: HTMLElement) => [...target.querySelectorAll('.ctx-item')].map(text);

	it('is not offered where the page gives no onSend, committed work, as before', () => {
		expect(names(drawMenu().target)).not.toContain('📤 Send to board…');
	});

	it('is offered for an option, closes the menu and opens the Send window on the card', () => {
		const sent: CardType[] = [];
		const { target, calls } = drawMenu((card) => sent.push(card));
		const item = [...target.querySelectorAll<HTMLButtonElement>('.ctx-item')].find((b) => text(b) === '📤 Send to board…')!;
		item.click();
		flushSync();
		expect(calls).toEqual(['close']);
		expect(sent).toEqual([aCard]);
	});

	it('is given by the board page, in the card menu and the card window, for an option only, to someone who can edit the board', () => {
		const page = source(BOARD_PAGE);
		expect(page).toMatch(/function sendOffered\(card: CardType \| null\): card is CardType \{\r?\n\t\treturn card !== null && boardState\.canEdit && isOptionOnBoard\(card\.id\);/);
		expect(page).toContain('onSend={sendOffered(contextMenu.card) ? (card) => (sendingCard = card) : undefined}');
		expect(page).toContain('onSend={sendOffered(cardWindow.card) ? openSendFromWindow : undefined}');
		// An option: the Options column, or any column of an ideas board.
		expect(page).toContain('return column !== undefined && isUpstreamColumn(column, boardState.board.kind);');
		const modal = source('src/lib/components/CardModal.svelte');
		expect(modal).toContain('{#if card && onSend}');
		expect(modal).toMatch(/Send to board…\r?\n\t*<\/button>/);
	});

	it('is sent through the board state: the card taken off once sent, its window closed, where it went said, and a commitment', async () => {
		const start = () => contentsOf('ideas', [boardColumn(1, 'New Ideas', [5, 6])]);
		const window = (cardId: number | null) => {
			const closed: number[] = [];
			return { closed, cardId, close: () => closed.push(1) };
		};

		// To Options, from the card menu with the window open on another card.
		const toOptions = stateOn(start(), start(), () => json(200, { id: 5, columnTitle: 'Ideas', boardId: 2, leftMilestone: null, committed: false }));
		const other = window(6);
		expect(await sendOption(toOptions.state, other, { id: 5, title: 'An idea' }, { boardId: 2, boardName: 'Ops', to: 'options' }, WORDS)).toEqual({ ok: true, said: [`Sent "An idea" to Ops's Options`], leftGoal: null });
		expect(toOptions.written).toEqual([{ url: '/api/cards/5/send', body: { boardId: 2, to: 'options' } }]);
		expect(toOptions.state.columns[0].cards.map((c) => c.id)).toEqual([6]);
		expect(other.closed).toEqual([]);
		// Taken off from the answer, with no read.
		expect(toOptions.reads).toEqual([]);

		// To To Do, from its own window, out of a goal: committed, the window closed.
		const toTodo = stateOn(start(), start(), () => json(200, { id: 5, committed: true, leftMilestone: { id: 3, name: 'Launch' } }));
		const own = window(5);
		expect(await sendOption(toTodo.state, own, { id: 5, title: 'An idea' }, { boardId: 2, boardName: 'Ops', to: 'todo' }, WORDS)).toEqual({
			ok: true,
			said: [`Sent "An idea" to Ops's To Do`, 'Committed "An idea"'],
			leftGoal: 'Moved. It left milestone "Launch"; moving it back does not put it back in.'
		});
		expect(own.closed).toEqual([1]);

		// Refused: the server's words, the card stays and its window open.
		const refused = stateOn(start(), start(), () => json(400, { message: 'A committed card is moved, not sent' }));
		const kept = window(5);
		expect(await sendOption(refused.state, kept, { id: 5, title: 'An idea' }, { boardId: 2, boardName: 'Ops', to: 'todo' }, WORDS)).toEqual({ ok: false, failure: 'A committed card is moved, not sent' });
		expect(refused.state.columns[0].cards.map((c) => c.id)).toEqual([5, 6]);
		expect(kept.closed).toEqual([]);
	});

	it('is sent by the page through sendOption, the Send window closed, each message said, and the focus put on the column it left (P5)', () => {
		const page = source(BOARD_PAGE);
		const at = page.indexOf('async function sendToBoard(');
		const fn = page.slice(at, page.indexOf('\n\t}\r\n', at));
		expect(fn).toContain('const written = await ideasBoard.sendOption(boardState, cardWindow, card, target, SEND_WORDS);');
		expect(fn).toContain('for (const message of written.said) toasts.add(message);');
		expect(fn.indexOf('sendingCard = null;')).toBeGreaterThan(fn.indexOf('if (!written.ok)'));
		expect(fn).toContain('if (fromColumnId !== null) focusColumn(fromColumnId);');
		expect(page).toContain('data-column-id={column.id}');
	});

	it('asks first from a card window with changes not saved, which the Send would close and lose (P5)', () => {
		const page = source(BOARD_PAGE);
		const at = page.indexOf('function openSendFromWindow(');
		const fn = page.slice(at, page.indexOf('\n\t}\r\n', at));
		expect(fn).toContain('if ((cardWindow.edits?.touched.size ?? 0) === 0) {');
		expect(fn).toContain("'Send without saving'");
	});
});

describe('the Send window (card 2463)', () => {
	type Target = { id: number; name: string; emoji: string | null; options: boolean; todo: string | null };
	const OPS: Target = { id: 2, name: 'Ops', emoji: '⚙️', options: true, todo: 'To Do' };
	const WEB: Target = { id: 3, name: 'Web', emoji: null, options: false, todo: 'Backlog' };
	const BARE: Target = { id: 4, name: 'Bare', emoji: null, options: false, todo: null };

	let asked: Mock<(url: string) => Promise<Response>>;

	async function drawSend(boards: Target[] | 'refused' | 'no answer', more: { hasSubBoards?: boolean } = {}) {
		asked = vi.fn(async () => {
			if (boards === 'no answer') throw new TypeError('Failed to fetch');
			if (boards === 'refused') return { ok: false, status: 403, json: async () => ({ message: 'Forbidden: you cannot edit this board' }) } as Response;
			return { ok: true, status: 200, json: async () => ({ boards }) } as Response;
		});
		vi.stubGlobal('fetch', asked);
		const sends: { boardId: number; boardName: string; to: string }[] = [];
		const closes: number[] = [];
		const answer = { sent: true };
		const target = draw(SendToBoardModal, {
			card: { id: 5, title: 'An idea', hasSubBoards: more.hasSubBoards ?? false },
			onSend: async (choice: { boardId: number; boardName: string; to: string }) => {
				sends.push(choice);
				return answer.sent;
			},
			onClose: () => closes.push(1)
		});
		await settle();
		return { target, sends, closes, answer };
	}

	const choices = (target: HTMLElement) =>
		[...target.querySelectorAll<HTMLInputElement>('input[name="send-to"]')].map((input) => ({
			value: input.value,
			checked: input.checked,
			disabled: input.disabled,
			note: text(input.closest('label')!.querySelector('.send-choice-note'))
		}));
	const sendButton = (target: HTMLElement) => [...target.querySelectorAll<HTMLButtonElement>('.send-actions button')].find((b) => text(b) === 'Send')!;
	const pick = (target: HTMLElement, boardId: number) => {
		const list = target.querySelector<HTMLSelectElement>('#send-board')!;
		list.value = String(boardId);
		list.dispatchEvent(new Event('change', { bubbles: true }));
		flushSync();
	};

	it('lists the delivery boards the server offers, and sends the first to its Options by default', async () => {
		const { target, sends } = await drawSend([OPS, WEB]);
		expect(asked.mock.calls.map(([url]) => url)).toEqual(['/api/cards/5/send']);
		expect(text(target.querySelector('#send-heading'))).toBe('Send "An idea" to another board');
		expect([...target.querySelectorAll('#send-board option')].map(text)).toEqual(['⚙️ Ops', '📋 Web']);
		expect(choices(target)).toEqual([
			{ value: 'options', checked: true, disabled: false, note: 'Still an idea, not yet committed to' },
			{ value: 'todo', checked: false, disabled: false, note: 'Committed to, ready to be started' }
		]);
		// The list takes the focus once it is drawn.
		expect(document.activeElement?.id).toBe('send-board');
		sendButton(target).click();
		await settle();
		expect(sends).toEqual([{ boardId: 2, boardName: 'Ops', to: 'options' }]);
	});

	it('offers To Do alone on a board with no Options column, naming the column it commits into', async () => {
		const { target, sends } = await drawSend([OPS, WEB]);
		pick(target, 3);
		expect(choices(target)).toEqual([
			{ value: 'options', checked: false, disabled: true, note: '"Web" has no Options column' },
			{ value: 'todo', checked: true, disabled: false, note: 'Committed into its "Backlog" column' }
		]);
		sendButton(target).click();
		await settle();
		expect(sends).toEqual([{ boardId: 3, boardName: 'Web', to: 'todo' }]);
	});

	it('offers nothing on a board with neither, and says why', async () => {
		const { target } = await drawSend([BARE]);
		// Neither greyed choice is shown chosen (the S5b review's P5).
		expect(choices(target).map((c) => [c.checked, c.disabled, c.note])).toEqual([
			[false, true, '"Bare" has no Options column'],
			[false, true, '"Bare" has no column to commit into: add a To Do column']
		]);
		expect(sendButton(target).disabled).toBe(true);
	});

	it('chooses again as the board changes: from neither back to Options where the next board takes it', async () => {
		const { target } = await drawSend([BARE, OPS]);
		expect(choices(target).map((c) => c.checked)).toEqual([false, false]);
		pick(target, 2);
		expect(choices(target).map((c) => c.checked)).toEqual([true, false]);
		expect(sendButton(target).disabled).toBe(false);
	});

	it('never offers another board’s Options for a card with a sub-board (L6): To Do only', async () => {
		const { target } = await drawSend([OPS], { hasSubBoards: true });
		expect(choices(target)).toEqual([
			{ value: 'options', checked: false, disabled: true, note: 'A card with a sub-board is committed work: it can only be committed to a To Do' },
			{ value: 'todo', checked: true, disabled: false, note: 'Committed to, ready to be started' }
		]);
	});

	it('says so when there is no board to send it to, or the boards cannot be read', async () => {
		expect(text((await drawSend([])).target.querySelector('.send-note'))).toBe('There is no other delivery board you can edit to send it to.');
		expect(text((await drawSend('refused')).target.querySelector('.send-failure'))).toBe('Forbidden: you cannot edit this board');
		expect(text((await drawSend('no answer')).target.querySelector('.send-failure'))).toBe('No answer from the server. The boards it can be sent to could not be read.');
	});

	it('stays open when the page says it was not sent, and closes on Cancel and on Escape', async () => {
		const { target, sends, closes, answer } = await drawSend([OPS]);
		answer.sent = false;
		sendButton(target).click();
		await settle();
		expect(sends).toHaveLength(1);
		expect(target.querySelector('.send-modal')).not.toBeNull();
		expect(sendButton(target).disabled).toBe(false);
		[...target.querySelectorAll<HTMLButtonElement>('.send-actions button')].find((b) => text(b) === 'Cancel')!.click();
		window.dispatchEvent(new KeyboardEvent('keydown', { key: 'Escape', bubbles: true }));
		flushSync();
		expect(closes).toEqual([1, 1]);
	});
});

// ─── No sub-board where the server refuses one (the S5b review's P1) ─────────

describe('no sub-board offered for an option or an idea (P1)', () => {
	it('offers the card menu’s Add Sub-board for committed work as before, and not for an option; its existing sub-boards still open', () => {
		const withOne = { ...aCard, subBoards: [{ id: 9, name: 'Plan', emoji: '🗂️' }] } as unknown as CardType;
		const draws = (canAddSubBoard?: boolean) =>
			[...draw(ContextMenu, {
				card: withOne, columnId: 1, x: 0, y: 0, columns: [],
				onClose: noop, onMove: noop, onPriority: noop, onTogglePin: noop, onDuplicate: noop, onCreateSubBoard: noop, onDelete: noop,
				...(canAddSubBoard === undefined ? {} : { canAddSubBoard })
			}).querySelectorAll('.ctx-item')].map(text);
		expect(draws()).toContain('🗂️ Add Sub-board');
		const option = draws(false);
		expect(option).not.toContain('🗂️ Add Sub-board');
		expect(option).toContain('→ 🗂️ Plan');
	});

	function drawSection(card: CardType | null, canAdd?: boolean) {
		return draw(CardSubBoards, {
			card, availableBoards: [{ id: 4, name: 'Spare', emoji: '📋' }], onCreateSubBoard: noop, onDeleteSubBoard: noop, onLinkSubBoard: noop,
			newSubBoardName: '', showLinkPicker: false, pendingSubBoardNames: [], newPendingSubBoardName: '',
			...(canAdd === undefined ? {} : { canAdd })
		});
	}

	it('offers the card window’s create, link and queue for committed work as before, and none for an option, saved or new, its sub-boards kept', () => {
		const saved = { ...aCard, subBoards: [{ id: 9, name: 'Plan', emoji: '🗂️', done: 1, total: 2 }] } as unknown as CardType;
		const before = drawSection(saved);
		expect(before.querySelector('.subboard-add-btn')).not.toBeNull();
		expect(before.querySelector('.subboard-link-btn')).not.toBeNull();
		expect(before.querySelector('.subboard-none')).toBeNull();
		expect(drawSection(null).querySelector('.subboard-add-btn')).not.toBeNull();

		const option = drawSection(saved, false);
		expect(option.querySelector('.subboard-add-btn')).toBeNull();
		expect(option.querySelector('.subboard-link-btn')).toBeNull();
		expect(option.querySelector('.subboard-link-name')?.textContent).toBe('Plan');
		expect(option.querySelector('.subboard-delete-btn')).not.toBeNull();
		expect(text(option.querySelector('.subboard-none'))).toBe('An idea has no sub-boards: commit it, or send it to a delivery board, first.');
		const fresh = drawSection(null, false);
		expect(fresh.querySelector('.subboard-name-input')).toBeNull();
		expect(fresh.querySelector('.subboard-none')).not.toBeNull();
	});

	it('is told by the board page for the card menu and the card window, saved or new, by the card’s column', () => {
		const page = source(BOARD_PAGE);
		expect(page).toContain('canAddSubBoard={!isOptionOnBoard(contextMenu.card.id)}');
		expect(page).toContain('subBoardsAllowed={!windowUpstream}');
		expect(page).toMatch(/const windowUpstream = \$derived\.by\(\(\) => \{\r?\n\t\tconst column = boardState\.columns\.find\(\(c\) => c\.id === cardWindow\.columnId\);/);
		expect(source('src/lib/components/CardModal.svelte')).toContain('canAdd={subBoardsAllowed}');
	});

	it('offers the dashboard’s New Sub-board on a delivery board as before, and not on an ideas board', () => {
		const data = { allCategories: [], boards: [{ id: 1, name: 'Work', kind: 'delivery' }, { id: 2, name: 'Ideas', kind: 'ideas' }] };
		const target = document.createElement('div');
		document.body.appendChild(target);
		const menu = mount(BoardContextMenu, { target, props: { data, confirmDeleteBoard: noop, expandedBoards: new Set(), collapsedCategories: new Set() } as never }) as unknown as {
			openBoardContextMenu: (e: MouseEvent, boardId: number, boardName: string) => void;
		};
		drawn.push({ component: menu as never, target });
		const items = (boardId: number, name: string) => {
			menu.openBoardContextMenu(new MouseEvent('contextmenu'), boardId, name);
			flushSync();
			return [...target.querySelectorAll('.ctx-item')].map(text);
		};
		expect(items(1, 'Work')).toContain('🗂️ New Sub-board');
		expect(items(2, 'Ideas')).not.toContain('🗂️ New Sub-board');
		expect(items(2, 'Ideas')).toContain('📝 Open Board');
	});
});
