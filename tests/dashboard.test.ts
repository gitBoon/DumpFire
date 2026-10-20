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
 * table's Manage Categories. `fetch`, the page's live stream and
 * `invalidateAll` are stand-ins; what each request sent is kept.
 *
 * The source pins of the same code are in `tests/page-failures.test.ts`,
 * `tests/timestamps.test.ts`, `tests/card-completion.test.ts`,
 * `tests/request-body.test.ts` and `tests/todo-page.test.ts`.
 */
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
let requests: { title: string; requesterName: string; priority: string; status: string }[] = [];

/** The viewer's today, as a stored due date: what Active Tasks calls "Today". */
const now = new Date();
const today = `${now.getFullYear()}-${String(now.getMonth() + 1).padStart(2, '0')}-${String(now.getDate()).padStart(2, '0')}`;

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
						cards: [{ id: 41, title: 'Fix the footer', priority: 'high', dueDate: today, columnName: 'To Do', createdAt: '2026-10-19 09:00:00' }]
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
			{ title: 'First', requesterName: 'Bo', priority: 'low', status: 'pending' },
			{ title: 'Second', requesterName: 'Cy', priority: 'low', status: 'pending' },
			{ title: 'Old', requesterName: 'Di', priority: 'low', status: 'done' }
		];
		const target = draw();
		await settle();
		const badge = () => target.querySelector('.header-nav .inbox-count-badge')?.textContent;
		expect(badge()).toBe('2');
		expect(target.querySelector('.toast-container')).toBeNull();

		requests = [{ title: 'Newest', requesterName: 'Ed', priority: 'high', status: 'pending' }, ...requests];
		vi.advanceTimersByTime(30_000);
		await settle();

		expect(badge()).toBe('3');
		expect(target.querySelector('.toast-container .toast-title')!.textContent).toBe('Newest');
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
		requests = [{ title: 'Waiting', requesterName: 'Bo', priority: 'low', status: 'pending' }];
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
		requests = [{ title: 'Newest', requesterName: 'Ed', priority: 'high', status: 'pending' }];
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
		const newest = { title: 'Newest', requesterName: 'Ed', priority: 'high', status: 'pending' };
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

		buttonNamed(target, '🏷️ Manage Categories').click();
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
