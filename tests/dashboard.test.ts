// @vitest-environment jsdom
/**
 * The dashboard (card 2281, slice C2 of card 2012's part C), mounted with
 * Svelte's client runtime as the admin page's file does, so that what the
 * page joins up between its components is run by Svelte itself: a board
 * row's right-click reaching the context menu through `bind:this`, and the
 * menu's actions reaching their requests, the page's confirm dialog and the
 * boards table's expanded rows (bound through the page); New Board in the
 * header opening the create window (bound through the page); the request
 * toasts' inbox count reaching the header, their poll and toast timers ending
 * with the page and a failed first read still starting the poll (card 2312);
 * and the sidebar's tiles opening
 * Active Tasks (through `bind:this`), Velocity and Spend, and the boards
 * table's Manage Categories (in its Display menu since card 2466, whose
 * menus are tested in `tests/header-menus.svelte.test.ts`). `fetch`, the page's live stream and
 * `invalidateAll` are stand-ins; what each request sent is kept.
 *
 * The source pins of the same code are in `tests/page-failures.test.ts`,
 * `tests/timestamps.test.ts`, `tests/card-completion.test.ts`,
 * `tests/request-body.test.ts` and `tests/todo-page.test.ts`.
 */
import { readdirSync, readFileSync } from 'node:fs';
import { join } from 'node:path';
import { pathToFileURL } from 'node:url';
import { afterEach, beforeEach, describe, expect, it, onTestFinished, vi } from 'vitest';
import type * as Svelte from 'svelte';

import DashboardPage from '../src/routes/+page.svelte';

// The page's data is read again after a write, and a new board is opened: here each is only counted.
const navigation = vi.hoisted(() => ({ invalidateAll: vi.fn(async () => {}), goto: vi.fn(async () => {}) }));
vi.mock('$app/navigation', () => ({
	invalidateAll: navigation.invalidateAll,
	goto: navigation.goto,
	afterNavigate: vi.fn(),
	beforeNavigate: vi.fn(),
	onNavigate: vi.fn()
}));
// The header reads who is signed in from the page store, which only a running SvelteKit app has.
vi.mock('$app/stores', () => {
	const value = { data: { user: { id: 1, username: 'alice', role: 'user' } } };
	return { page: { subscribe: (run: (v: typeof value) => void) => { run(value); return () => {}; } } };
});
// The page's live stream would open an EventSource, which jsdom has not got.
vi.mock('$lib/live-refresh', () => ({ connectLiveRefresh: vi.fn(() => () => {}) }));
// A bare 'svelte' gives the server's runtime, whose onDestroy the page's Toast cannot use in a browser: the client's, by its path.
vi.mock('svelte', async () => {
	const { join } = await import('node:path');
	const { pathToFileURL } = await import('node:url');
	return await import(/* @vite-ignore */ pathToFileURL(join(process.cwd(), 'node_modules/svelte/src/index-client.js')).href);
});

// The browser's `mount`, loaded by its path: a bare 'svelte' gives the server's (see the XP bars' file).
const clientEntry = pathToFileURL(join(process.cwd(), 'node_modules/svelte/src/index-client.js')).href;
const { flushSync, mount, unmount }: typeof Svelte = await import(/* @vite-ignore */ clientEntry);

/** Each request the page sent, as `METHOD url`, with its body read as JSON where it had one. */
let sent: { what: string; body: unknown }[] = [];
let drawn: { component: ReturnType<typeof mount>; target: HTMLElement } | null = null;
/** The requests waiting in the inbox, as `/api/requests` answers them. */
let requests: { id: number; title: string; requesterName: string; priority: string; status: string }[] = [];

/**
 * The viewer's today, as a stored due date: what Active Tasks calls "Today".
 * Read when it is asked (card 2409): read once as the file loaded, a run that
 * crossed midnight before the page drew gave yesterday's date.
 */
const now = new Date();
function today(): string {
	const at = new Date();
	return `${at.getFullYear()}-${String(at.getMonth() + 1).padStart(2, '0')}-${String(at.getDate()).padStart(2, '0')}`;
}

const board = (id: number, name: string, extra: Record<string, unknown> = {}) => ({
	id,
	name,
	emoji: '📋',
	categoryId: 2,
	categoryName: 'Clients',
	categoryColor: '#6366f1',
	totalCards: 4,
	completedCards: 1,
	lastActivity: '2026-10-20 09:00:00',
	tokenTotal: null,
	costUsd: null,
	subBoards: [],
	...extra
});

/** What the dashboard's load gives the page, as much of it as its parts read. */
const data = {
	boards: [
		board(1, 'Website', {
			subBoards: [{ id: 5, name: 'Launch', emoji: '🗂️', parentCardTitle: 'Go live', total: 2, done: 0, tokenTotal: null, costUsd: null }]
		}),
		board(3, 'Mobile', {
			subBoards: [{ id: 8, name: 'App store', emoji: '🗂️', parentCardTitle: 'Ship it', total: 1, done: 0, tokenTotal: null, costUsd: null }]
		}),
		board(6, 'Intranet', { categoryId: 4, categoryName: 'Internal', categoryColor: '#22c55e' })
	],
	analytics: {
		totalBoards: 2,
		totalSubBoards: 1,
		active: 3,
		totalAssigned: 5,
		completed: 2,
		completionRate: 40,
		completedThisWeek: 1,
		completedThisMonth: 2,
		weeklyActivity: [{ day: 'Mon', count: 1 }],
		pendingRequests: 0,
		priorityCounts: { critical: 0, high: 1, medium: 1, low: 1 },
		boardHealth: [],
		weeklyTrend: [],
		categoryDistribution: [],
		agingBuckets: { fresh: 1, week: 1, fortnight: 1, month: 0, stale: 0 },
		teamLeaderboard: [],
		onHoldCount: 0,
		recentActivity: [],
		dueCards: [] as { title: string; dueDate: string; priority: string }[],
		longOverdue: 0,
		asOf: now.toISOString()
	},
	allCategories: [
		{ id: 2, name: 'Clients', color: '#6366f1' },
		{ id: 4, name: 'Internal', color: '#22c55e' }
	],
	favouriteBoardIds: [],
	allTasksTotals: { cards: 8, completedCards: 2, tasks: 10, subtasks: 2, tokenTotal: 1000, costUsd: 0.5, unpricedTokens: 0 },
	spendByUser: { today: [], week: [], month: [], year: [], all: [] }
};

/** An answer of the test's own for a request, ahead of the ones below (held, or thrown, if it likes); undefined for those. */
let answer: ((what: string) => Response | Promise<Response> | undefined) | null = null;

beforeEach(() => {
	sent = [];
	answer = null;
	requests = [];
	navigation.invalidateAll.mockClear();
	navigation.goto.mockClear();
	vi.stubGlobal(
		'fetch',
		vi.fn(async (url: string, init?: RequestInit) => {
			const method = init?.method ?? 'GET';
			sent.push({ what: `${method} ${url}`, body: typeof init?.body === 'string' ? JSON.parse(init.body) : undefined });
			const own = answer?.(`${method} ${url}`);
			if (own) return own;
			if (url === '/api/requests') return Response.json(requests);
			if (url === '/api/my-tasks')
				return Response.json([
					{
						boardId: 1,
						boardName: 'Website',
						boardEmoji: '📋',
						cards: [{ id: 41, title: 'Fix the footer', priority: 'high', dueDate: today(), columnName: 'To Do', createdAt: '2026-10-19 09:00:00' }]
					}
				]);
			if (url === '/api/boards/1/cards' && method === 'GET')
				return Response.json({ cards: [], columns: [{ id: 7, title: 'To Do', position: 0 }, { id: 8, title: 'Complete', position: 1 }] });
			if (url === '/api/cards' && method === 'POST') return Response.json({ id: 50 });
			if (url === '/api/boards' && method === 'POST') return Response.json({ id: 9 });
			if (url === '/api/boards/1' && method === 'PUT') return Response.json({ id: 1 });
			if (url === '/api/board-categories' && method === 'POST') return Response.json({ id: 9, name: 'Ops', color: '#6366f1' });
			if (url === '/api/boards/1' && method === 'DELETE') return Response.json({ ok: true });
			return Response.json({ message: 'Not found' }, { status: 404 });
		})
	);
});

afterEach(() => {
	if (drawn) {
		unmount(drawn.component);
		drawn.target.remove();
		drawn = null;
	}
	vi.useRealTimers();
	vi.unstubAllGlobals();
});

function draw(given: typeof data = data) {
	const target = document.createElement('div');
	document.body.appendChild(target);
	drawn = { component: mount(DashboardPage as never, { target, props: { data: given } as never }), target };
	flushSync();
	return target;
}

/** Leaves the dashboard: unmounts it as `afterEach` does, within the case. */
function leave() {
	unmount(drawn!.component);
	drawn!.target.remove();
	drawn = null;
}

/** Lets every answer on its way come in, and the page draw what it changed. */
async function settle() {
	for (let i = 0; i < 5; i++) {
		await new Promise((resolve) => setTimeout(resolve, 0));
		flushSync();
	}
}

const buttonNamed = (within: ParentNode, text: string) =>
	[...within.querySelectorAll('button')].find((button) => button.textContent!.trim() === text) as HTMLButtonElement;
const asked = (what: string) => sent.filter((request) => request.what === what);

/**
 * Opens the boards table's Display menu, where Manage Categories has been
 * since card 2466 (it was a button of its own beside the title), and gives
 * back its Manage Categories item and the Display button.
 */
function manageCategoriesItem(target: HTMLElement) {
	const display = target.querySelector<HTMLButtonElement>('#display-menu-btn')!;
	display.click();
	flushSync();
	return { item: buttonNamed(target.querySelector('[role="menu"][aria-label="Display"]')!, '🏷️ Manage Categories'), display };
}
const headings = (target: HTMLElement) => [...target.querySelectorAll('h2')].map((heading) => heading.textContent!.trim());

/** Types `text` into a box, as `bind:value` hears it. */
function type(box: HTMLInputElement, text: string) {
	box.value = text;
	box.dispatchEvent(new Event('input', { bubbles: true }));
	flushSync();
}

/** Right-clicks a board's row in its grouping, as the boards table hears it. */
function rightClick(target: HTMLElement, name: string) {
	const row = [...target.querySelectorAll<HTMLElement>('.board-row-group > .board-row')].find((each) =>
		each.querySelector('.board-row-name')!.textContent!.startsWith(name)
	)!;
	row.dispatchEvent(new MouseEvent('contextmenu', { bubbles: true, cancelable: true, clientX: 40, clientY: 60 }));
	flushSync();
}

describe('the dashboard, mounted with its parts', () => {
	it('opens the context menu from a board’s row, and its Set Category reaches its request', async () => {
		const target = draw();
		await settle();
		expect(target.querySelector('.ctx-menu')).toBeNull();

		rightClick(target, 'Website');
		const menu = target.querySelector<HTMLElement>('.ctx-menu')!;
		expect(menu).not.toBeNull();
		expect(menu.querySelector('.ctx-header')!.textContent).toBe('Website');
		expect(menu.style.left).toBe('40px');

		buttonNamed(menu, '🏷️ Set Category').click();
		flushSync();
		buttonNamed(target.querySelector('.ctx-menu')!, 'Internal').click();
		await settle();

		expect(asked('PUT /api/boards/1').map((request) => request.body)).toEqual([{ categoryId: 4 }]);
		expect(navigation.invalidateAll).toHaveBeenCalledTimes(1);
		expect(target.querySelector('.ctx-menu')).toBeNull();
	});

	it('asks the page’s confirm from the menu’s Delete Board, whose Confirm sends the delete', async () => {
		const target = draw();
		await settle();

		rightClick(target, 'Website');
		buttonNamed(target.querySelector('.ctx-menu')!, '🗑️ Delete Board').click();
		flushSync();
		expect(target.querySelector('.ctx-menu')).toBeNull();
		const confirm = target.querySelector<HTMLElement>('[role="dialog"][aria-label="Delete Board"]')!;
		expect(confirm).not.toBeNull();
		expect(confirm.textContent).toContain('Website');

		buttonNamed(confirm, 'Delete Board').click();
		await settle();

		expect(asked('DELETE /api/boards/1')).toHaveLength(1);
		expect(navigation.invalidateAll).toHaveBeenCalledTimes(1);
	});

	it('shows the new sub-board’s parent opened out in the boards table, once the menu has made it', async () => {
		const target = draw();
		await settle();
		const subRows = () => target.querySelectorAll('.sub-row').length;
		expect(subRows()).toBe(0);

		rightClick(target, 'Website');
		buttonNamed(target.querySelector('.ctx-menu')!, '🗂️ New Sub-board').click();
		await settle();
		type(target.querySelector<HTMLInputElement>('.ctx-menu input[placeholder="Sub-board name..."]')!, 'Launch');
		buttonNamed(target.querySelector('.ctx-menu')!, 'Create').click();
		await settle();

		expect(asked('POST /api/cards').map((request) => request.body)).toEqual([{ columnId: 7, boardId: 1, title: 'Launch' }]);
		expect(asked('POST /api/boards').map((request) => request.body)).toEqual([{ name: 'Launch', emoji: '🗂️', parentCardId: 50 }]);
		// The menu writes the page's expanded boards, which the boards table draws.
		expect(subRows()).toBe(1);
		expect(target.querySelector('.ctx-menu')).toBeNull();
	});

	it('opens Create New Board from the header’s New Board, and its Create Board posts and opens the board', async () => {
		const target = draw();
		await settle();
		expect(headings(target)).not.toContain('Create New Board');

		target.querySelector<HTMLButtonElement>('#create-board-btn')!.click();
		flushSync();
		expect(headings(target)).toContain('Create New Board');

		type(target.querySelector<HTMLInputElement>('#board-name')!, 'Roadmap');
		buttonNamed(target.querySelector('.modal-content')!, 'Create Board').click();
		await settle();

		expect(asked('POST /api/boards').map((request) => request.body)).toEqual([{ name: 'Roadmap', emoji: '📋', categoryId: null }]);
		expect(navigation.goto).toHaveBeenCalledWith('/board/9');
		expect(headings(target)).not.toContain('Create New Board');
	});

	it('shows the request toasts’ inbox count in the header, and a toast and the new count when the poll finds more', async () => {
		vi.useFakeTimers({ toFake: ['setInterval', 'clearInterval'] });
		requests = [
			{ id: 11, title: 'First', requesterName: 'Bo', priority: 'low', status: 'pending' },
			{ id: 12, title: 'Second', requesterName: 'Cy', priority: 'low', status: 'pending' },
			{ id: 10, title: 'Old', requesterName: 'Di', priority: 'low', status: 'done' }
		];
		const target = draw();
		await settle();
		const badge = () => target.querySelector('.header-nav .inbox-count-badge')?.textContent;
		expect(badge()).toBe('2');
		expect(target.querySelector('.toast-container')).toBeNull();

		requests = [{ id: 13, title: 'Newest', requesterName: 'Ed', priority: 'high', status: 'pending' }, ...requests];
		vi.advanceTimersByTime(30_000);
		await settle();

		expect(badge()).toBe('3');
		expect(target.querySelector('.toast-container .toast-title')!.textContent).toBe('Newest');
	});

	// Card 2336: the poll compared counts, so a request handled and a new one
	// arriving between two reads raised no toast. Each pending request is now
	// known by its id.
	it('raises a toast for a new request when another was handled since the last read, the count unchanged', async () => {
		vi.useFakeTimers({ toFake: ['setInterval', 'clearInterval'] });
		requests = [
			{ id: 11, title: 'First', requesterName: 'Bo', priority: 'low', status: 'pending' },
			{ id: 12, title: 'Second', requesterName: 'Cy', priority: 'low', status: 'pending' }
		];
		const target = draw();
		await settle();
		const badge = () => target.querySelector('.header-nav .inbox-count-badge')?.textContent;
		const toastTitles = () => [...target.querySelectorAll('.toast-container .toast-title')].map((title) => title.textContent);
		expect(badge()).toBe('2');

		// First handled, Newest arrived: still two waiting.
		requests = [
			{ id: 13, title: 'Newest', requesterName: 'Ed', priority: 'high', status: 'pending' },
			{ id: 12, title: 'Second', requesterName: 'Cy', priority: 'low', status: 'pending' },
			{ id: 11, title: 'First', requesterName: 'Bo', priority: 'low', status: 'done' }
		];
		vi.advanceTimersByTime(30_000);
		await settle();
		expect(badge()).toBe('2');
		expect(toastTitles()).toEqual(['Newest']);

		// A request made earlier and listed after the others, waiting now (its requester confirmed it): toasted by its id, not by its place.
		requests = [...requests, { id: 9, title: 'Confirmed', requesterName: 'Fi', priority: 'low', status: 'pending' }];
		vi.advanceTimersByTime(30_000);
		await settle();
		expect(badge()).toBe('3');
		expect(toastTitles()).toEqual(['Newest', 'Confirmed']);

		// Read again with nothing new: no toast.
		vi.advanceTimersByTime(30_000);
		await settle();
		expect(toastTitles()).toEqual(['Newest', 'Confirmed']);
	});

	// Card 2312: the request toasts' poll and timers end with the page, and a failed first read still starts the poll.
	it('starts no poll when the dashboard is left before the inbox’s first answer', async () => {
		vi.useFakeTimers({ toFake: ['setInterval', 'clearInterval'] });
		let release!: () => void;
		answer = (what) =>
			what === 'GET /api/requests' ? new Promise<Response>((resolve) => (release = () => resolve(Response.json(requests)))) : undefined;
		draw();
		await settle();
		expect(asked('GET /api/requests')).toHaveLength(1);

		leave();
		release();
		await settle();
		vi.advanceTimersByTime(60_000);
		await settle();

		expect(asked('GET /api/requests')).toHaveLength(1);
		expect(vi.getTimerCount()).toBe(0);
	});

	it('starts the poll when the inbox’s first read fails, and raises no toast for a request already waiting', async () => {
		vi.useFakeTimers({ toFake: ['setInterval', 'clearInterval'] });
		requests = [{ id: 11, title: 'Waiting', requesterName: 'Bo', priority: 'low', status: 'pending' }];
		let failed = false;
		answer = (what) => {
			if (what !== 'GET /api/requests' || failed) return undefined;
			failed = true;
			throw new TypeError('Failed to fetch');
		};
		const target = draw();
		await settle();
		expect(asked('GET /api/requests')).toHaveLength(1);

		vi.advanceTimersByTime(30_000);
		await settle();

		expect(asked('GET /api/requests')).toHaveLength(2);
		expect(target.querySelector('.header-nav .inbox-count-badge')?.textContent).toBe('1');
		expect(target.querySelector('.toast-container')).toBeNull();
	});

	it('clears a toast’s timer when the dashboard is left', async () => {
		vi.useFakeTimers({ toFake: ['setInterval', 'clearInterval'] });
		const timeouts = vi.spyOn(globalThis, 'setTimeout');
		const cleared = vi.spyOn(globalThis, 'clearTimeout');
		onTestFinished(() => {
			timeouts.mockRestore();
			cleared.mockRestore();
		});
		const target = draw();
		await settle();
		requests = [{ id: 13, title: 'Newest', requesterName: 'Ed', priority: 'high', status: 'pending' }];
		vi.advanceTimersByTime(30_000);
		await settle();
		expect(target.querySelector('.toast-container .toast-title')!.textContent).toBe('Newest');
		const toastTimer = timeouts.mock.results[timeouts.mock.calls.findIndex(([, ms]) => ms === 6000)].value;

		leave();

		expect(cleared).toHaveBeenCalledWith(toastTimer);
	});

	it('raises no toast from a poll whose answer is still being read when the dashboard is left', async () => {
		vi.useFakeTimers({ toFake: ['setInterval', 'clearInterval'] });
		let reads = 0;
		let readBody!: () => void;
		const newest = { id: 13, title: 'Newest', requesterName: 'Ed', priority: 'high', status: 'pending' };
		answer = (what) => {
			if (what !== 'GET /api/requests') return undefined;
			reads += 1;
			if (reads === 1) return Response.json([]);
			// The poll's answer has come, and its body is still being read.
			return { ok: true, json: () => new Promise((resolve) => (readBody = () => resolve([newest]))) } as Response;
		};
		draw();
		await settle();
		vi.advanceTimersByTime(30_000);
		await settle();
		expect(reads).toBe(2);

		const timeouts = vi.spyOn(globalThis, 'setTimeout');
		onTestFinished(() => timeouts.mockRestore());
		leave();
		readBody();
		await settle();

		expect(timeouts.mock.calls.filter(([, ms]) => ms === 6000)).toEqual([]);
	});

	it('opens Active Tasks from the sidebar’s tile, which reads its list and words its due dates on the page’s clock', async () => {
		// Pinned a tenth of a second before midnight, on purpose (card 2409): the
		// clock does not move while the page draws. `afterEach` puts it back.
		vi.useFakeTimers({ toFake: ['Date'], now: new Date(2026, 9, 20, 23, 59, 59, 900) });
		const target = draw();
		await settle();
		expect(headings(target)).not.toContain('Active Tasks');
		expect(asked('GET /api/my-tasks')).toHaveLength(0);

		target.querySelector<HTMLElement>('#active-tasks-card')!.click();
		await settle();

		expect(asked('GET /api/my-tasks')).toHaveLength(1);
		expect(headings(target)).toContain('Active Tasks');
		expect(target.querySelector('.atm-card-title')!.textContent).toBe('Fix the footer');
		expect(target.querySelector('.atm-card-due')!.textContent!.trim()).toBe('📅 Today');
	});

	it('opens the windows the sidebar’s Velocity and Spend tiles and the boards table’s Manage Categories ask the page for', async () => {
		const target = draw();
		await settle();

		target.querySelector<HTMLElement>('#velocity-card')!.click();
		flushSync();
		expect(headings(target)).toContain('Velocity');

		target.querySelector<HTMLElement>('#spend-card')!.click();
		flushSync();
		expect(headings(target)).toContain('Notional spend by person');

		manageCategoriesItem(target).item.click();
		flushSync();
		expect(headings(target)).toContain('Manage Categories');
	});

	// Card 2281, slice C2's review: what the page's bindings keep between its parts.
	it('reopens Create New Board with what was typed after Cancel, as one window the page and the header both open', async () => {
		const target = draw();
		await settle();

		target.querySelector<HTMLButtonElement>('#create-board-btn')!.click();
		flushSync();
		type(target.querySelector<HTMLInputElement>('#board-name')!, 'Roadmap');
		buttonNamed(target.querySelector('.modal-content')!, 'Cancel').click();
		flushSync();
		expect(headings(target)).not.toContain('Create New Board');

		target.querySelector<HTMLButtonElement>('#create-board-btn')!.click();
		flushSync();
		expect(headings(target)).toContain('Create New Board');
		expect(target.querySelector<HTMLInputElement>('#board-name')!.value).toBe('Roadmap');
	});

	it('keeps a grouping folded and a board opened out in the boards table while the menu files a board and makes a sub-board', async () => {
		const target = draw();
		await settle();
		const names = () => [...target.querySelectorAll('.board-row-name')].map((name) => name.textContent!.trim());
		const intranetShown = () => names().some((name) => name.startsWith('Intranet'));
		const appStoreShown = () => names().some((name) => name.startsWith('App store'));

		// Fold Internal and open out Mobile, in the boards table.
		[...target.querySelectorAll<HTMLButtonElement>('button.category-group-header')]
			.find((header) => header.textContent!.includes('Internal'))!
			.click();
		flushSync();
		[...target.querySelectorAll<HTMLElement>('.board-row-group > .board-row')]
			.find((row) => row.querySelector('.board-row-name')!.textContent!.startsWith('Mobile'))!
			.querySelector<HTMLButtonElement>('button.expand-toggle')!
			.click();
		flushSync();
		expect(intranetShown()).toBe(false);
		expect(appStoreShown()).toBe(true);

		// A new grouping from the menu opens that grouping out, and no other.
		rightClick(target, 'Website');
		buttonNamed(target.querySelector('.ctx-menu')!, '🏷️ Set Category').click();
		flushSync();
		buttonNamed(target.querySelector('.ctx-menu')!, '+ New Category').click();
		flushSync();
		type(target.querySelector<HTMLInputElement>('.ctx-menu input[placeholder="Category name..."]')!, 'Ops');
		buttonNamed(target.querySelector('.ctx-menu')!, 'Create').click();
		await settle();
		expect(asked('POST /api/board-categories')).toHaveLength(1);
		expect(asked('PUT /api/boards/1').map((request) => request.body)).toEqual([{ categoryId: 9 }]);
		expect(intranetShown()).toBe(false);

		// A sub-board from the menu opens its parent out, and keeps Mobile open.
		rightClick(target, 'Website');
		buttonNamed(target.querySelector('.ctx-menu')!, '🗂️ New Sub-board').click();
		await settle();
		type(target.querySelector<HTMLInputElement>('.ctx-menu input[placeholder="Sub-board name..."]')!, 'Launch');
		buttonNamed(target.querySelector('.ctx-menu')!, 'Create').click();
		await settle();
		expect(names().some((name) => name.startsWith('Launch'))).toBe(true);
		expect(appStoreShown()).toBe(true);
	});

	it('moves the due figures and Active Tasks’ due words on at midnight, on the page’s clock', async () => {
		vi.useFakeTimers({ toFake: ['Date', 'setInterval', 'clearInterval'], now: new Date(2026, 9, 20, 23, 59, 50) });
		answer = (what) =>
			what === 'GET /api/my-tasks'
				? Response.json([
						{
							boardId: 1,
							boardName: 'Website',
							boardEmoji: '📋',
							cards: [{ id: 42, title: 'Send the invoice', priority: 'low', dueDate: '2026-10-21', columnName: 'To Do', createdAt: '2026-10-19 09:00:00' }]
						}
					])
				: undefined;
		const target = draw({
			...data,
			analytics: { ...data.analytics, dueCards: [{ title: 'Renew the domain', dueDate: '2026-10-20', priority: 'high' }], asOf: new Date().toISOString() }
		});
		await settle();
		const attention = () =>
			[...target.querySelectorAll('.stat-card')]
				.find((card) => card.querySelector('.stat-label')!.textContent === 'Attention')!
				.querySelector('.stat-value')!
				.textContent!.replace(/\s+/g, ' ')
				.trim();
		target.querySelector<HTMLElement>('#active-tasks-card')!.click();
		await settle();
		const dueWords = () => target.querySelector('.atm-card-due')!.textContent!.trim();
		expect(attention()).toBe('0 overdue');
		expect(dueWords()).toBe('📅 Tomorrow');

		// Past midnight, and the page's 15-second tick.
		vi.setSystemTime(new Date(2026, 9, 21, 0, 0, 1));
		vi.advanceTimersByTime(15_000);
		await settle();

		expect(attention()).toBe('1 overdue');
		expect(dueWords()).toBe('📅 Today');
	});
});

// Card 2466: the owner, "We can show XP on the dashboard otherwise naaah". The XP bars left the board header
// and are the sidebar's XP leaderboard, read from GET /api/xp and again on each live refresh.
describe('the XP leaderboard on the dashboard (card 2466)', () => {
	let xp: { name: string; xp: number; emoji: string }[] = [];
	beforeEach(() => {
		xp = [
			{ name: 'bob', xp: 250, emoji: '🐻' },
			{ name: 'alice', xp: 1200, emoji: '🦊' }
		];
		answer = (what) => (what === 'GET /api/xp' ? Response.json(xp) : undefined);
	});
	const rows = (target: HTMLElement) =>
		[...target.querySelectorAll('#xp-leaderboard-panel .xp-entry')].map((entry) => entry.textContent!.replace(/\s+/g, ' ').trim());

	it('shows each person’s level and XP in the sidebar, highest first, and not in the header', async () => {
		const target = draw();
		await settle();
		expect(asked('GET /api/xp')).toHaveLength(1);
		const panel = target.querySelector<HTMLElement>('.sidebar-column #xp-leaderboard-panel')!;
		expect(panel.querySelector('.panel-title')!.textContent).toBe('XP Leaderboard');
		expect(rows(target)).toEqual(['🦊 alice 1200 XP Lv.3', '🐻 bob 250 XP Lv.1']);
		expect(panel.querySelector('.xp-entry')!.getAttribute('title')).toBe('alice: 1200 XP (Level 3)');
		expect(target.querySelector('.dashboard-header .xp-entry')).toBeNull();
	});

	it('reads it again on a live refresh, which the stream’s xp-update schedules', async () => {
		const { connectLiveRefresh } = await import('$lib/live-refresh');
		const live = vi.mocked(connectLiveRefresh);
		live.mockClear();
		const target = draw();
		await settle();
		xp = [...xp, { name: 'carol', xp: 600, emoji: '🐱' }];
		live.mock.calls[0][0]();
		await settle();
		expect(asked('GET /api/xp')).toHaveLength(2);
		expect(rows(target).map((row) => row.split(' ')[1])).toEqual(['alice', 'carol', 'bob']);
		// The source of the schedule: live-refresh re-reads on xp-update as on update.
		expect(readFileSync(join(process.cwd(), 'src/lib/live-refresh.ts'), 'utf8')).toContain("eventSource.addEventListener('xp-update', () => scheduleRefresh());");
	});

	it('draws no panel when nobody has XP, or the read fails', async () => {
		xp = [];
		let target = draw();
		await settle();
		expect(target.querySelector('#xp-leaderboard-panel')).toBeNull();
		leave();
		answer = (what) => (what === 'GET /api/xp' ? Response.json({ message: 'nope' }, { status: 500 }) : undefined);
		target = draw();
		await settle();
		expect(target.querySelector('#xp-leaderboard-panel')).toBeNull();
	});

	it('is read nowhere else: no other page or component asks for /api/xp', () => {
		const callers: string[] = [];
		const walk = (dir: string) => {
			for (const entry of readdirSync(join(process.cwd(), dir), { withFileTypes: true })) {
				const path = `${dir}/${entry.name}`;
				if (entry.isDirectory()) walk(path);
				else if (/\.(svelte|ts)$/.test(entry.name) && /\bloadXp\b|fetchXp\(|['"`]\/api\/xp['"`]/.test(readFileSync(join(process.cwd(), path), 'utf8'))) callers.push(path);
			}
		};
		walk('src/routes');
		walk('src/lib/components');
		expect(callers.sort()).toEqual(['src/routes/+page.svelte']);
	});
});

// Card 2358: each of the window's writes acted only on an answer that was ok; a refusal said nothing,
// no answer was an unhandled rejection that left every button dead, and the delete asked with the browser's confirm().
describe('Manage Categories says a refusal or no answer, and asks before a delete in the app’s dialog (card 2358)', () => {
	async function openManager() {
		const target = draw();
		await settle();
		manageCategoriesItem(target).item.click();
		flushSync();
		return target.querySelector<HTMLElement>('.cat-mgr')!;
	}
	const said = (manager: HTMLElement) => manager.querySelector('[role="alert"]')?.textContent?.trim() ?? null;

	it.each([
		['is refused', () => Response.json({ message: 'Category name must be 200 characters or fewer' }, { status: 400 }), 'Category name must be 200 characters or fewer'],
		[
			'gets no answer',
			() => {
				throw new TypeError('Failed to fetch');
			},
			'No answer from the server. The category may not have been created.'
		]
	])('says so when making one %s, keeps the name typed, and Add works again', async (_, give, words) => {
		let failing = true;
		answer = (what) => (what === 'POST /api/board-categories' && failing ? give() : undefined);
		const manager = await openManager();
		const box = manager.querySelector<HTMLInputElement>('.create-input')!;
		type(box, 'Ops');
		buttonNamed(manager, 'Add').click();
		await settle();
		expect(said(manager)).toBe(words);
		expect(box.value).toBe('Ops');
		expect(navigation.invalidateAll).not.toHaveBeenCalled();

		failing = false;
		expect(buttonNamed(manager, 'Add').disabled).toBe(false);
		buttonNamed(manager, 'Add').click();
		await settle();
		expect(asked('POST /api/board-categories')).toHaveLength(2);
		expect(said(manager)).toBeNull();
		expect(navigation.invalidateAll).toHaveBeenCalledTimes(1);
	});

	it('says so when a rename is refused, and keeps the edit box open with what was typed', async () => {
		answer = (what) => (what === 'PUT /api/board-categories/2' ? Response.json({ message: 'You can only change your own categories' }, { status: 403 }) : undefined);
		const manager = await openManager();
		manager.querySelector<HTMLButtonElement>('button[title="Edit category"]')!.click();
		flushSync();
		type(manager.querySelector<HTMLInputElement>('.edit-input')!, 'Customers');
		buttonNamed(manager, 'Save').click();
		await settle();
		expect(asked('PUT /api/board-categories/2')).toHaveLength(1);
		expect(said(manager)).toBe('You can only change your own categories');
		expect(manager.querySelector<HTMLInputElement>('.edit-input')?.value).toBe('Customers');
	});

	it('asks in the app’s confirm dialog before a delete, not the browser’s; Cancel sends nothing; a refused delete says so, and one done reads the page again', async () => {
		const browserConfirm = vi.fn(() => true);
		vi.stubGlobal('confirm', browserConfirm);
		let refusing = true;
		answer = (what) =>
			what === 'DELETE /api/board-categories/2' ? (refusing ? Response.json({ message: 'Category not found' }, { status: 404 }) : Response.json({ success: true })) : undefined;
		const manager = await openManager();
		const deleteButton = () => manager.querySelector<HTMLButtonElement>('button[title="Delete category"]')!;
		const dialog = () => document.querySelector<HTMLElement>('.confirm-modal');

		deleteButton().click();
		await settle();
		expect(browserConfirm).not.toHaveBeenCalled();
		expect(asked('DELETE /api/board-categories/2')).toHaveLength(0);
		expect(dialog()!.querySelector('h3')!.textContent).toBe('Delete Category');
		expect(dialog()!.querySelector('.confirm-message')!.textContent).toBe('"Clients" will be deleted. Boards using it will become uncategorised.');
		buttonNamed(dialog()!, 'Cancel').click();
		flushSync();
		expect(dialog()).toBeNull();
		expect(asked('DELETE /api/board-categories/2')).toHaveLength(0);

		deleteButton().click();
		flushSync();
		buttonNamed(dialog()!, 'Delete').click();
		await settle();
		expect(dialog()).toBeNull();
		expect(asked('DELETE /api/board-categories/2')).toHaveLength(1);
		expect(said(manager)).toBe('Category not found');
		expect(navigation.invalidateAll).not.toHaveBeenCalled();

		refusing = false;
		deleteButton().click();
		flushSync();
		buttonNamed(dialog()!, 'Delete').click();
		await settle();
		expect(said(manager)).toBeNull();
		expect(navigation.invalidateAll).toHaveBeenCalledTimes(1);
	});

	// Card 2365: the window took no focus, had no name, let Tab walk the page behind and answered no Escape.
	describe('from the keyboard (card 2365)', () => {
		/** A Tab (or Shift+Tab) pressed where the focus is, bubbling as a real one does; gives back whether its default was taken. */
		function tab(shiftKey = false): boolean {
			const key = new KeyboardEvent('keydown', { key: 'Tab', shiftKey, bubbles: true, cancelable: true });
			(document.activeElement ?? document.body).dispatchEvent(key);
			flushSync();
			return key.defaultPrevented;
		}
		function escape() {
			window.dispatchEvent(new KeyboardEvent('keydown', { key: 'Escape', bubbles: true }));
			flushSync();
		}
		/**
		 * Opens it from the Display menu (card 2466). The item gives the focus to
		 * the Display button as the menu closes, before the window opens, so the
		 * window takes it from there and gives it back there: `opener` is it.
		 */
		async function openFromItsButton() {
			const target = draw();
			await settle();
			const { item, display } = manageCategoriesItem(target);
			item.focus();
			item.click();
			flushSync();
			return { target, opener: display, manager: target.querySelector<HTMLElement>('.cat-mgr')! };
		}

		it('is named, gives its name box the focus, keeps Tab in it, closes on Escape and gives the focus back', async () => {
			const { target, opener, manager } = await openFromItsButton();
			expect(document.querySelector('[role="dialog"][aria-label="Manage Categories"]')).not.toBeNull();
			expect(manager.querySelector('.close-btn')!.getAttribute('aria-label')).toBe('Close');
			const nameBox = manager.querySelector<HTMLInputElement>('.create-input')!;
			expect(document.activeElement).toBe(nameBox);

			// From its last stop round to its first (×), and back with Shift.
			const stops = [...manager.querySelectorAll<HTMLElement>('button, input')].filter((el) => !(el as HTMLButtonElement).disabled);
			stops.at(-1)!.focus();
			expect(tab()).toBe(true);
			expect(document.activeElement).toBe(stops[0]);
			expect(tab(true)).toBe(true);
			expect(document.activeElement).toBe(stops.at(-1));
			// From the page behind, back to the name box.
			opener.focus();
			expect(tab()).toBe(true);
			expect(document.activeElement).toBe(nameBox);

			escape();
			expect(target.querySelector('.cat-mgr')).toBeNull();
			await settle();
			expect(document.activeElement).toBe(opener);
		});

		it('stays open on Escape while a change is out, and closes on Escape once it is answered', async () => {
			let release!: () => void;
			answer = (what) =>
				what === 'POST /api/board-categories' ? new Promise<Response>((resolve) => (release = () => resolve(Response.json({ message: 'Category name taken' }, { status: 400 })))) : undefined;
			const { target, manager } = await openFromItsButton();
			type(manager.querySelector<HTMLInputElement>('.create-input')!, 'Ops');
			buttonNamed(manager, 'Add').click();
			await settle();
			escape();
			expect(target.querySelector('.cat-mgr')).not.toBeNull();

			release();
			await settle();
			expect(said(manager)).toBe('Category name taken');
			escape();
			expect(target.querySelector('.cat-mgr')).toBeNull();
		});

		// Card 2375: × closed the window while a change was out, and its answer was said to nobody.
		it('stays open on × while a change is out, × marked aria-disabled meanwhile, and closes on × once it is answered', async () => {
			let release!: () => void;
			answer = (what) =>
				what === 'POST /api/board-categories' ? new Promise<Response>((resolve) => (release = () => resolve(Response.json({ message: 'Category name taken' }, { status: 400 })))) : undefined;
			const { target, manager } = await openFromItsButton();
			const close = manager.querySelector<HTMLButtonElement>('.close-btn')!;
			expect(close.hasAttribute('aria-disabled')).toBe(false);
			type(manager.querySelector<HTMLInputElement>('.create-input')!, 'Ops');
			buttonNamed(manager, 'Add').click();
			await settle();
			expect(close.getAttribute('aria-disabled')).toBe('true');
			expect(close.disabled).toBe(false);
			close.click();
			flushSync();
			expect(target.querySelector('.cat-mgr')).not.toBeNull();

			release();
			await settle();
			expect(said(manager)).toBe('Category name taken');
			expect(close.hasAttribute('aria-disabled')).toBe(false);
			close.click();
			flushSync();
			expect(target.querySelector('.cat-mgr')).toBeNull();
		});

		// Card 2365's review: Escape with a category's edit open closed the whole window, and the edit with it.
		it('cancels an open edit on Escape, giving the focus back to its row’s ✎, and closes the window on the next Escape', async () => {
			const { target, manager } = await openFromItsButton();
			manager.querySelector<HTMLButtonElement>('button[title="Edit category"]')!.click();
			flushSync();
			type(manager.querySelector<HTMLInputElement>('.edit-input')!, 'Customers');

			escape();
			expect(target.querySelector('.cat-mgr')).not.toBeNull();
			expect(manager.querySelector('.edit-input')).toBeNull();
			await settle();
			expect(document.activeElement).toBe(manager.querySelector('button[title="Edit category"]'));
			expect(asked('PUT /api/board-categories/2')).toHaveLength(0);

			escape();
			expect(target.querySelector('.cat-mgr')).toBeNull();
		});

		it('leaves the delete’s confirm the keys while it is up: Escape closes the confirm alone, and Tab stays in it', async () => {
			const { target, manager } = await openFromItsButton();
			manager.querySelector<HTMLButtonElement>('button[title="Delete category"]')!.click();
			flushSync();
			const dialog = document.querySelector<HTMLElement>('.confirm-modal')!;
			const cancel = buttonNamed(dialog, 'Cancel');
			expect(document.activeElement).toBe(cancel);
			expect(tab()).toBe(false);
			expect(document.activeElement).toBe(cancel);

			escape();
			expect(document.querySelector('.confirm-modal')).toBeNull();
			expect(target.querySelector('.cat-mgr')).not.toBeNull();
			expect(asked('DELETE /api/board-categories/2')).toHaveLength(0);
		});
	});

	// The card 2358 review: a dialog opened while another change was out had a dead Delete.
	it('holds a category’s delete off while another change is on its way', async () => {
		let release!: () => void;
		answer = (what) =>
			what === 'POST /api/board-categories' ? new Promise<Response>((resolve) => (release = () => resolve(Response.json({ id: 9, name: 'Ops', color: '#6366f1' })))) : undefined;
		const manager = await openManager();
		const deleteButton = () => manager.querySelector<HTMLButtonElement>('button[title="Delete category"]')!;
		expect(deleteButton().disabled).toBe(false);
		type(manager.querySelector<HTMLInputElement>('.create-input')!, 'Ops');
		buttonNamed(manager, 'Add').click();
		await settle();
		expect(deleteButton().disabled).toBe(true);
		deleteButton().click();
		flushSync();
		expect(document.querySelector('.confirm-modal')).toBeNull();

		release();
		await settle();
		expect(deleteButton().disabled).toBe(false);
	});
});
