// @vitest-environment jsdom
/**
 * The dashboard's side pane in its Display menu (card 2526), mounted with
 * Svelte's client runtime as `tests/header-menus.svelte.test.ts` is.
 *
 *   - `src/lib/dashboard/side-pane.ts`: the panels, in the pane's order; one
 *     viewer's Display choice (the hidden panels, the whole pane, the
 *     done-board and done-sub switches) in a cookie per user, parsed with no
 *     browser, with its defaults, a key it does not know and JSON it cannot
 *     read; the cookie written from the browser, and cookies that cannot be
 *     written; and which panels have anything to draw.
 *   - The dashboard's load (`src/routes/+page.server.ts`): the choice from
 *     the caller's own cookie, and the defaults with none or a bad one.
 *   - `BoardsTable.svelte`: Display's Side pane section, its switch for the
 *     whole pane and one per panel, greyed, skipped and taking no focus while
 *     the pane is off; the button's dot and title.
 *   - `AnalyticsSidebar.svelte`: a panel switched off, or with nothing to
 *     draw, is not drawn.
 *   - The page (`src/routes/+page.svelte`): the choice from the load on its
 *     first render, the cookie written as it changes, the load's choice taken
 *     again when the signed-in user changes and not on a live refresh, and no
 *     sidebar column, the boards at the full width, with the pane off or no
 *     panel switched on with anything to draw.
 *
 * It is named `.svelte.test.ts` so that the props handed to a component can
 * be `$state`, and a bound prop's change read back.
 */
import { join } from 'node:path';
import { pathToFileURL } from 'node:url';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import type * as Svelte from 'svelte';

import BoardsTable from '$lib/components/dashboard/BoardsTable.svelte';
import AnalyticsSidebar from '$lib/components/dashboard/AnalyticsSidebar.svelte';
import DashboardPage from '../src/routes/+page.svelte';
import {
	DASHBOARD_DISPLAY,
	SIDE_PANE_PANELS,
	dashboardDisplayCookie,
	dashboardDisplayCookieText,
	defaultDisplay,
	displayChanged,
	panelHasContent,
	parseDashboardDisplay,
	sidePaneShown,
	withPanel,
	writeDashboardDisplay,
	type DashboardDisplay,
	type SidePaneContent
} from '$lib/dashboard/side-pane';
import { pageLoad } from './helpers/actions';
import { makeUser, resetDb } from './helpers/fixtures';

// Who is signed in, from the page store, which only a running SvelteKit app has. The id can change between and within cases.
const signedIn = vi.hoisted(() => ({ id: 1, set: (_id: number) => {} }));
vi.mock('$app/stores', async () => {
	const { writable } = await import('svelte/store');
	const page = writable({ data: { user: { id: signedIn.id, username: 'alice', role: 'user' } } });
	signedIn.set = (id: number) => {
		signedIn.id = id;
		page.set({ data: { user: { id, username: id === 1 ? 'alice' : 'bob', role: 'user' } } });
	};
	return { page };
});
vi.mock('$app/navigation', () => ({
	invalidateAll: vi.fn(async () => {}),
	goto: vi.fn(async () => {}),
	afterNavigate: vi.fn(),
	beforeNavigate: vi.fn(),
	onNavigate: vi.fn()
}));
// The page's live stream would open an EventSource, which jsdom has not got.
vi.mock('$lib/live-refresh', () => ({ connectLiveRefresh: vi.fn(() => () => {}) }));
// A bare 'svelte' gives the server's runtime, whose tick and onDestroy the components cannot use in a browser: the client's, by its path.
vi.mock('svelte', async () => {
	const { join } = await import('node:path');
	const { pathToFileURL } = await import('node:url');
	return await import(/* @vite-ignore */ pathToFileURL(join(process.cwd(), 'node_modules/svelte/src/index-client.js')).href);
});

const clientEntry = pathToFileURL(join(process.cwd(), 'node_modules/svelte/src/index-client.js')).href;
const { flushSync, mount, unmount }: typeof Svelte = await import(/* @vite-ignore */ clientEntry);

let drawn: { component: ReturnType<typeof mount>; target: HTMLElement }[] = [];
/** What GET /api/xp answers. */
let xp: { name: string; xp: number; emoji: string }[] = [];

/** Every cookie this document holds, gone. */
function clearCookies() {
	for (const pair of document.cookie.split(';')) {
		const name = pair.split('=')[0].trim();
		if (name) document.cookie = `${name}=; Path=/; Max-Age=0`;
	}
}

/** A cookie's value, decoded as SvelteKit's `cookies.get` decodes it; undefined with none. */
function cookie(name: string): string | undefined {
	const pair = document.cookie.split('; ').find((p) => p.startsWith(`${name}=`));
	return pair ? decodeURIComponent(pair.slice(name.length + 1)) : undefined;
}

/** Cookies that cannot be written, as a browser that blocks them throws; taken off in `afterEach`. */
function blockCookies() {
	Object.defineProperty(document, 'cookie', {
		configurable: true,
		get: () => '',
		set: () => {
			throw new Error('blocked');
		}
	});
}

beforeEach(() => {
	clearCookies();
	signedIn.set(1);
	xp = [{ name: 'alice', xp: 120, emoji: '🦊' }];
	vi.stubGlobal(
		'fetch',
		vi.fn(async (url: string) => {
			if (url === '/api/requests') return Response.json([]);
			if (url === '/api/xp') return Response.json(xp);
			return Response.json({ message: 'Not found' }, { status: 404 });
		})
	);
});

afterEach(() => {
	for (const { component, target } of drawn) {
		unmount(component);
		target.remove();
	}
	drawn = [];
	vi.unstubAllGlobals();
	// The blocked cookie is the document's own property; the real one is Document.prototype's.
	delete (document as unknown as Record<string, unknown>).cookie;
	vi.restoreAllMocks();
	clearCookies();
});

function draw(component: unknown, props: Record<string, unknown>): HTMLElement {
	const target = document.createElement('div');
	document.body.appendChild(target);
	drawn.push({ component: mount(component as never, { target, props: props as never }), target });
	flushSync();
	return target;
}

/** Unmounts the last thing drawn: the viewer leaves the page, as a reload would. */
function leave() {
	const last = drawn.pop()!;
	unmount(last.component);
	last.target.remove();
}

/** Lets HeaderMenu's open, and the page's reads, finish and draw. */
async function settle() {
	for (let i = 0; i < 4; i++) {
		await new Promise((resolve) => setTimeout(resolve, 0));
		flushSync();
	}
}

const textOf = (el: Element) => el.textContent!.replace(/\s+/g, ' ').trim();
const menuNamed = (label: string) => document.querySelector<HTMLElement>(`[role="menu"][aria-label="${label}"]`);
const itemsOf = (menu: HTMLElement) => [...menu.querySelectorAll<HTMLElement>('[role="menuitem"], [role="menuitemcheckbox"]')];
const panelItem = (menu: HTMLElement, key: string) => menu.querySelector<HTMLElement>(`[data-panel="${key}"]`)!;
const paneItem = (menu: HTMLElement) =>
	itemsOf(menu).find((item) => /Show(ing)? the side pane$/.test(textOf(item)))!;
const titles = (target: HTMLElement) => [...target.querySelectorAll('.panel-title')].map(textOf);

async function openDisplay(target: HTMLElement): Promise<HTMLElement> {
	target.querySelector<HTMLButtonElement>('#display-menu-btn')!.click();
	await settle();
	return menuNamed('Display')!;
}

/** Analytics with nothing in any panel that can be empty. */
const emptyAnalytics = {
	active: 0,
	boardHealth: [],
	weeklyTrend: [{ count: 0 }],
	categoryDistribution: [{ count: 0 }],
	teamLeaderboard: [],
	recentActivity: []
};
const nothing: SidePaneContent = { analytics: emptyAnalytics, xpCount: 0, upcomingCount: 0 };

// ─── The helper ─────────────────────────────────────────────────────────────

describe('the dashboard display choice in its cookie (card 2526)', () => {
	it('names the eleven panels in the pane’s order, each with a label', () => {
		expect(SIDE_PANE_PANELS.map((p) => p.key)).toEqual([
			'figures', 'priority', 'health', 'trend', 'categories', 'aging', 'team', 'xp', 'deadlines', 'quick', 'activity'
		]);
		expect(SIDE_PANE_PANELS.every((p) => p.label.length > 0)).toBe(true);
	});

	it('gives the defaults with no cookie', () => {
		const defaults = { hiddenPanels: [], paneHidden: false, showCompletedBoards: true, showCompletedSubs: false };
		expect(DASHBOARD_DISPLAY).toEqual(defaults);
		expect(parseDashboardDisplay(undefined)).toEqual(defaults);
		expect(parseDashboardDisplay(null)).toEqual(defaults);
		expect(parseDashboardDisplay('')).toEqual(defaults);
		expect(displayChanged(parseDashboardDisplay(undefined))).toBe(false);
	});

	it('parses with no browser to read: the server’s load uses it', () => {
		vi.stubGlobal('document', undefined);
		vi.stubGlobal('localStorage', undefined);
		vi.stubGlobal('window', undefined);
		const choice: DashboardDisplay = { hiddenPanels: ['health', 'xp'], paneHidden: true, showCompletedBoards: false, showCompletedSubs: true };
		expect(parseDashboardDisplay(JSON.stringify(choice))).toEqual(choice);
		// And a write with no document says nothing.
		expect(() => writeDashboardDisplay(1, choice)).not.toThrow();
	});

	it('ignores a panel or field it does not know, and a field of the wrong kind falls back on its own', () => {
		const raw = JSON.stringify({ hiddenPanels: ['xp', 'weather', 7, 'health', 'xp'], paneHidden: 'yes', showCompletedBoards: false, showCompletedSubs: 1, colour: 'red' });
		expect(parseDashboardDisplay(raw)).toEqual({ hiddenPanels: ['health', 'xp'], paneHidden: false, showCompletedBoards: false, showCompletedSubs: false });
		expect(parseDashboardDisplay(JSON.stringify({ hiddenPanels: 'health' }))).toEqual(DASHBOARD_DISPLAY);
	});

	it('gives the defaults for JSON it cannot read, or that is not an object', () => {
		for (const raw of ['{not json', 'null', '42', '"text"', '["health"]', '%7B']) {
			expect(parseDashboardDisplay(raw), raw).toEqual(DASHBOARD_DISPLAY);
		}
	});

	it('writes the cookie from the browser, per user: URI-encoded JSON, for the whole site, a year, Lax, not HttpOnly', () => {
		const choice: DashboardDisplay = { hiddenPanels: ['health', 'xp'], paneHidden: true, showCompletedBoards: false, showCompletedSubs: true };
		expect(dashboardDisplayCookie(1)).toBe('dumpfire-dashboard-display-1');
		expect(dashboardDisplayCookieText(1, choice)).toBe(
			`dumpfire-dashboard-display-1=${encodeURIComponent(JSON.stringify(choice))}; Path=/; Max-Age=31536000; SameSite=Lax`
		);
		expect(dashboardDisplayCookieText(1, choice)).not.toMatch(/HttpOnly/i);
		writeDashboardDisplay(1, choice);
		expect(parseDashboardDisplay(cookie('dumpfire-dashboard-display-1'))).toEqual(choice);
		// Another viewer on the same browser has their own.
		expect(cookie('dumpfire-dashboard-display-2')).toBeUndefined();
		// With no viewer nothing is written.
		writeDashboardDisplay(null, defaultDisplay());
		expect(document.cookie.split('; ')).toHaveLength(1);
	});

	it('says nothing when the cookie cannot be written', () => {
		blockCookies();
		expect(() => writeDashboardDisplay(1, { ...defaultDisplay(), paneHidden: true })).not.toThrow();
	});

	it('switches one panel, keeps the pane’s order, and hands out copies of the defaults', () => {
		let d = withPanel(defaultDisplay(), 'xp', false);
		d = withPanel(d, 'figures', false);
		expect(d.hiddenPanels).toEqual(['figures', 'xp']);
		expect(displayChanged(d)).toBe(true);
		expect(withPanel(d, 'xp', true).hiddenPanels).toEqual(['figures']);
		defaultDisplay().hiddenPanels.push('xp');
		expect(DASHBOARD_DISPLAY.hiddenPanels).toEqual([]);
	});

	it('says which panels have anything to draw: the tiles and the quick figures always, each other only with something in it', () => {
		const empty = SIDE_PANE_PANELS.map((p) => p.key).filter((k) => panelHasContent(k, nothing));
		expect(empty).toEqual(['figures', 'quick']);
		const full: SidePaneContent = {
			analytics: {
				active: 1,
				boardHealth: [{}],
				weeklyTrend: [{ count: 0 }, { count: 2 }],
				categoryDistribution: [{ count: 0 }, { count: 1 }],
				teamLeaderboard: [{}],
				recentActivity: [{}]
			},
			xpCount: 1,
			upcomingCount: 1
		};
		expect(SIDE_PANE_PANELS.every((p) => panelHasContent(p.key, full))).toBe(true);
	});

	it('counts the pane as shown only while a panel switched on has something to draw', () => {
		expect(sidePaneShown(defaultDisplay(), nothing)).toBe(true);
		expect(sidePaneShown({ ...defaultDisplay(), paneHidden: true }, nothing)).toBe(false);
		// The reviewer's case: the tiles and the quick figures off, nothing else to draw.
		expect(sidePaneShown({ ...defaultDisplay(), hiddenPanels: ['figures', 'quick'] }, nothing)).toBe(false);
		expect(sidePaneShown({ ...defaultDisplay(), hiddenPanels: ['figures', 'quick'] }, { ...nothing, upcomingCount: 1 })).toBe(true);
		let all = defaultDisplay();
		for (const p of SIDE_PANE_PANELS) all = withPanel(all, p.key, false);
		expect(sidePaneShown(all, { ...nothing, xpCount: 3 })).toBe(false);
	});
});

// ─── The dashboard's load ───────────────────────────────────────────────────

describe('the dashboard’s load reads the choice from the caller’s cookie (card 2526)', () => {
	beforeEach(resetDb);

	const displayOf = (page: Awaited<ReturnType<typeof pageLoad>>) => (page as { data: { dashboardDisplay: unknown } }).data.dashboardDisplay;

	it('answers the parsed choice of the caller’s own cookie', async () => {
		const user = makeUser();
		const other = makeUser();
		const choice: DashboardDisplay = { hiddenPanels: ['trend'], paneHidden: true, showCompletedBoards: false, showCompletedSubs: true };
		const page = await pageLoad('/', {
			user,
			cookies: {
				[dashboardDisplayCookie(user.id)]: JSON.stringify(choice),
				[dashboardDisplayCookie(other.id)]: JSON.stringify({ ...choice, hiddenPanels: ['xp'] })
			}
		});
		expect(page.type).toBe('data');
		expect(displayOf(page)).toEqual(choice);
	});

	it('answers the defaults with no cookie, another user’s only, or one that cannot be read', async () => {
		const user = makeUser();
		const other = makeUser();
		for (const cookies of [
			undefined,
			{ [dashboardDisplayCookie(other.id)]: JSON.stringify({ paneHidden: true }) },
			{ [dashboardDisplayCookie(user.id)]: '{not json' },
			{ [dashboardDisplayCookie(user.id)]: '["health"]' }
		]) {
			expect(displayOf(await pageLoad('/', { user, cookies })), JSON.stringify(cookies)).toEqual(DASHBOARD_DISPLAY);
		}
	});
});

// ─── The Display menu ───────────────────────────────────────────────────────

const tableBoard = (id: number, name: string, totalCards: number, completedCards: number) => ({
	id, name, emoji: '📋', categoryId: null, categoryName: null, categoryColor: null,
	totalCards, completedCards, lastActivity: '2026-10-20 09:00:00', tokenTotal: null, costUsd: null, subBoards: []
});

function drawBoardsTable(display: DashboardDisplay = defaultDisplay()) {
	const props = $state({
		data: {
			boards: [tableBoard(1, 'Website', 4, 1), tableBoard(2, 'Finished', 3, 3)],
			analytics: { totalBoards: 2, totalSubBoards: 0 },
			allTasksTotals: { cards: 7, completedCards: 4, tasks: 7, subtasks: 0, tokenTotal: null, costUsd: null, unpricedTokens: 0 },
			favouriteBoardIds: []
		},
		deleting: null,
		confirmDeleteBoard: () => {},
		openBoardContextMenu: () => {},
		showCreate: false,
		expandedBoards: new Set<number>(),
		collapsedCategories: new Set<string>(),
		showCategoryManager: false,
		display
	});
	const target = draw(BoardsTable, props);
	return { target, props };
}

describe('the side pane in the Display menu (card 2526)', () => {
	it('lists, after the done switches and a divider, a Side pane section: the pane’s switch, then one per panel; Manage Categories last', async () => {
		const { target } = drawBoardsTable();
		const menu = await openDisplay(target);
		const labels = itemsOf(menu).map(textOf);
		expect(labels).toEqual([
			'✅ Showing done boards',
			'👁️ Show done subs',
			'✅ Showing the side pane',
			...SIDE_PANE_PANELS.map((p) => `✅ ${p.label}`),
			'🏷️ Manage Categories'
		]);
		// The heading names its section, as a group, and is not an item.
		const heading = [...menu.querySelectorAll<HTMLElement>('.hm-label')].find((el) => textOf(el) === 'Side pane')!;
		expect(heading).toBeTruthy();
		const group = menu.querySelector<HTMLElement>(`[role="group"][aria-labelledby="${heading.id}"]`)!;
		expect(group.querySelectorAll('[role="menuitemcheckbox"]')).toHaveLength(SIDE_PANE_PANELS.length + 1);
		// A divider before the section and one before Manage Categories.
		expect(heading.previousElementSibling?.getAttribute('role')).toBe('separator');
		expect(group.nextElementSibling?.getAttribute('role')).toBe('separator');
		for (const item of group.querySelectorAll('[role="menuitemcheckbox"]')) expect(item.getAttribute('aria-checked')).toBe('true');
	});

	it('switches a panel off and on, staying open, handing the page a new choice, and lights the dot', async () => {
		const { target, props } = drawBoardsTable();
		const button = target.querySelector<HTMLButtonElement>('#display-menu-btn')!;
		const dot = () => button.querySelector('.display-dot');
		const before = props.display;
		expect(dot()).toBeNull();
		expect(button.getAttribute('title')).toBe('Display: done boards, done sub-boards, categories and the side pane');

		const menu = await openDisplay(target);
		const health = panelItem(menu, 'health');
		health.click();
		flushSync();
		expect(menuNamed('Display')).not.toBeNull();
		expect(props.display.hiddenPanels).toEqual(['health']);
		expect(props.display).not.toBe(before);
		expect(health.getAttribute('aria-checked')).toBe('false');
		expect(textOf(health)).toBe('👁️ Board Health Overview');
		expect(dot()).not.toBeNull();
		expect(button.classList.contains('hm-on')).toBe(true);
		expect(button.getAttribute('title')).toBe('Display: 1 side pane panel is hidden');

		health.click();
		flushSync();
		expect(props.display.hiddenPanels).toEqual([]);
		expect(dot()).toBeNull();
	});

	it('greys and skips the panels’ switches while the pane is off, keeps their ticks, and gives them back as they were', async () => {
		const { target, props } = drawBoardsTable({ ...defaultDisplay(), hiddenPanels: ['xp'] });
		const button = target.querySelector<HTMLButtonElement>('#display-menu-btn')!;
		const menu = await openDisplay(target);
		paneItem(menu).click();
		flushSync();
		expect(props.display.paneHidden).toBe(true);
		expect(textOf(paneItem(menu))).toBe('👁️ Show the side pane');
		expect(paneItem(menu).getAttribute('aria-checked')).toBe('false');
		expect(button.querySelector('.display-dot')).not.toBeNull();
		expect(button.getAttribute('title')).toBe('Display: the side pane is hidden');
		for (const p of SIDE_PANE_PANELS) expect(panelItem(menu, p.key).getAttribute('aria-disabled')).toBe('true');
		expect(panelItem(menu, 'xp').getAttribute('aria-checked')).toBe('false');
		expect(panelItem(menu, 'health').getAttribute('aria-checked')).toBe('true');

		// A greyed switch does nothing.
		panelItem(menu, 'health').click();
		flushSync();
		expect(props.display.hiddenPanels).toEqual(['xp']);

		// A press of the mouse on a greyed switch takes no focus (its mousedown's default is taken), so ↓ goes on from where the focus was.
		const press = (on: HTMLElement) => {
			const down = new MouseEvent('mousedown', { bubbles: true, cancelable: true });
			on.dispatchEvent(down);
			return down.defaultPrevented;
		};
		expect(press(panelItem(menu, 'health'))).toBe(true);
		expect(press(paneItem(menu))).toBe(false);

		// The keys go from the pane's switch straight to Manage Categories.
		paneItem(menu).focus();
		paneItem(menu).dispatchEvent(new KeyboardEvent('keydown', { key: 'ArrowDown', bubbles: true, cancelable: true }));
		flushSync();
		expect(textOf(document.activeElement!)).toBe('🏷️ Manage Categories');

		paneItem(menu).click();
		flushSync();
		expect(props.display).toEqual({ ...defaultDisplay(), hiddenPanels: ['xp'] });
		expect(panelItem(menu, 'health').hasAttribute('aria-disabled')).toBe(false);
		expect(press(panelItem(menu, 'health'))).toBe(false);
		expect(panelItem(menu, 'xp').getAttribute('aria-checked')).toBe('false');
	});

	it('takes the done switches from the choice and hands them back in it', async () => {
		const { target, props } = drawBoardsTable({ ...defaultDisplay(), showCompletedBoards: false });
		const names = () => [...target.querySelectorAll('.board-row-name')].map(textOf);
		expect(names().some((n) => n.startsWith('Finished'))).toBe(false);
		const menu = await openDisplay(target);
		itemsOf(menu).find((item) => textOf(item) === '👁️ Show done boards')!.click();
		flushSync();
		expect(props.display.showCompletedBoards).toBe(true);
		expect(names().some((n) => n.startsWith('Finished'))).toBe(true);
		itemsOf(menu).find((item) => textOf(item) === '👁️ Show done subs')!.click();
		flushSync();
		expect(props.display.showCompletedSubs).toBe(true);
		expect(target.querySelector('#display-menu-btn')!.getAttribute('title')).toBe('Display: a setting is changed from its default');
	});
});


// ─── The sidebar and the page ───────────────────────────────────────────────

const now = new Date();
const inDays = (n: number) => {
	const at = new Date(now.getFullYear(), now.getMonth(), now.getDate() + n);
	return `${at.getFullYear()}-${String(at.getMonth() + 1).padStart(2, '0')}-${String(at.getDate()).padStart(2, '0')}`;
};

/** What the dashboard's load gives the page, with something in every panel, and the defaults for the Display choice. */
const data = {
	boards: [tableBoard(1, 'Website', 4, 1)],
	analytics: {
		totalBoards: 1,
		totalSubBoards: 0,
		active: 3,
		totalAssigned: 5,
		completed: 2,
		completionRate: 40,
		completedThisWeek: 1,
		completedThisMonth: 2,
		weeklyActivity: [{ day: 'Mon', count: 1 }],
		pendingRequests: 0,
		priorityCounts: { critical: 0, high: 1, medium: 1, low: 1 },
		boardHealth: [{ emoji: '📋', name: 'Website', pct: 25 }],
		weeklyTrend: [{ label: 'W1', count: 2 }],
		categoryDistribution: [{ name: 'Clients', color: '#6366f1', count: 3 }],
		agingBuckets: { fresh: 1, week: 1, fortnight: 1, month: 0, stale: 0 },
		teamLeaderboard: [{ username: 'alice', emoji: '🦊', completed: 2, active: 1 }],
		onHoldCount: 0,
		recentActivity: [{ userEmoji: '🦊', detail: 'Moved a card', action: 'move', createdAt: '2026-10-20 09:00:00' }],
		dueCards: [{ title: 'Fix the footer', dueDate: inDays(5), priority: 'high' }],
		longOverdue: 0,
		asOf: now.toISOString()
	},
	allCategories: [],
	favouriteBoardIds: [],
	allTasksTotals: { cards: 4, completedCards: 1, tasks: 4, subtasks: 0, tokenTotal: null, costUsd: null, unpricedTokens: 0 },
	spendByUser: { today: [], week: [], month: [], year: [], all: [] },
	dashboardDisplay: defaultDisplay()
};

/** The same, with nothing in any panel that can be empty: no work, no deadlines, no activity. */
const bare = {
	...data,
	analytics: {
		...data.analytics,
		active: 0,
		priorityCounts: { critical: 0, high: 0, medium: 0, low: 0 },
		boardHealth: [],
		weeklyTrend: [{ label: 'W1', count: 0 }],
		categoryDistribution: [],
		agingBuckets: { fresh: 0, week: 0, fortnight: 0, month: 0, stale: 0 },
		teamLeaderboard: [],
		recentActivity: [],
		dueCards: []
	}
};

const ALL_TITLES = [
	'Priority Spread', 'Board Health Overview', '4-Week Trend', 'Category Distribution', 'Task Aging',
	'Team Leaderboard', 'XP Leaderboard', 'Upcoming Deadlines', 'Recent Activity'
];

function drawSidebar(hidden: ReadonlySet<string>, given = data, xpEntries = [{ name: 'alice', xp: 120, emoji: '🦊' }]) {
	return draw(AnalyticsSidebar, {
		data: given,
		clock: now,
		xpEntries,
		hidden,
		openActiveTasksModal: () => {},
		showVelocityModal: false,
		showSpendModal: false
	});
}

describe('the side pane draws only the panels switched on with something to draw (card 2526)', () => {
	it('draws every panel with none hidden', () => {
		const target = drawSidebar(new Set());
		expect(titles(target)).toEqual(ALL_TITLES);
		expect(target.querySelector('.metrics-grid')).not.toBeNull();
		expect(target.querySelector('.quick-stats')).not.toBeNull();
	});

	it('leaves out each panel switched off, and only it', () => {
		const target = drawSidebar(new Set(['health', 'figures', 'quick', 'activity']));
		expect(titles(target)).toEqual(ALL_TITLES.filter((t) => t !== 'Board Health Overview' && t !== 'Recent Activity'));
		expect(target.querySelector('.metrics-grid')).toBeNull();
		expect(target.querySelector('#active-tasks-card')).toBeNull();
		expect(target.querySelector('.quick-stats')).toBeNull();
	});

	it('leaves out a panel switched on that has nothing to show, by the test the page uses', () => {
		const target = drawSidebar(new Set(), bare, []);
		expect(titles(target)).toEqual([]);
		expect(target.querySelector('.metrics-grid')).not.toBeNull();
		expect(target.querySelector('.quick-stats')).not.toBeNull();
	});
});

describe('the dashboard page with the side pane switched (card 2526)', () => {
	function drawPage(given: Record<string, unknown> = data) {
		const props = $state({ data: given });
		const target = draw(DashboardPage, props);
		return { target, props };
	}
	const sidebarOf = (target: HTMLElement) => target.querySelector<HTMLElement>('.sidebar-column');

	it('draws the choice the load handed it, and writes each change to the cookie the load reads', async () => {
		let { target } = drawPage({ ...data, dashboardDisplay: { ...defaultDisplay(), hiddenPanels: ['health'] } });
		await settle();
		expect(sidebarOf(target)).not.toBeNull();
		expect(titles(sidebarOf(target)!)).not.toContain('Board Health Overview');
		expect(titles(sidebarOf(target)!)).toContain('XP Leaderboard');
		expect(target.querySelector('#display-menu-btn .display-dot')).not.toBeNull();

		const menu = await openDisplay(target);
		panelItem(menu, 'xp').click();
		flushSync();
		expect(titles(sidebarOf(target)!)).not.toContain('XP Leaderboard');
		const stored = parseDashboardDisplay(cookie(dashboardDisplayCookie(1)));
		expect(stored.hiddenPanels).toEqual(['health', 'xp']);

		// A reload: the load reads the cookie back, and the page is drawn as it was left.
		leave();
		({ target } = drawPage({ ...data, dashboardDisplay: stored }));
		await settle();
		expect(titles(sidebarOf(target)!)).not.toContain('XP Leaderboard');
		expect(titles(sidebarOf(target)!)).not.toContain('Board Health Overview');
	});

	it('is drawn as it was left from its first render, before any effect has run', () => {
		const target = document.createElement('div');
		document.body.appendChild(target);
		// No flushSync: what `mount` draws on its own is the first render.
		drawn.push({ component: mount(DashboardPage as never, { target, props: { data: { ...data, dashboardDisplay: { ...defaultDisplay(), paneHidden: true } } } as never }), target });
		expect(target.querySelector('.dashboard-grid')).not.toBeNull();
		expect(target.querySelector('.sidebar-column')).toBeNull();
		expect(target.querySelector('.dashboard-grid')!.classList.contains('no-sidebar')).toBe(true);
	});

	it('draws the defaults with no choice in its data', async () => {
		const { dashboardDisplay: _, ...without } = data;
		const { target } = drawPage(without);
		await settle();
		expect(sidebarOf(target)).not.toBeNull();
		expect(target.querySelector('#display-menu-btn .display-dot')).toBeNull();
	});

	it('draws no sidebar column with the pane off, the boards at the full width, and the pane back as it was', async () => {
		const { target } = drawPage({ ...data, dashboardDisplay: { ...defaultDisplay(), hiddenPanels: ['trend'] } });
		await settle();
		const grid = target.querySelector<HTMLElement>('.dashboard-grid')!;
		expect(grid.classList.contains('no-sidebar')).toBe(false);
		const menu = await openDisplay(target);
		paneItem(menu).click();
		flushSync();
		expect(sidebarOf(target)).toBeNull();
		expect(grid.classList.contains('no-sidebar')).toBe(true);
		expect(parseDashboardDisplay(cookie(dashboardDisplayCookie(1))).paneHidden).toBe(true);

		paneItem(menu).click();
		flushSync();
		expect(sidebarOf(target)).not.toBeNull();
		expect(grid.classList.contains('no-sidebar')).toBe(false);
		expect(titles(sidebarOf(target)!)).not.toContain('4-Week Trend');
	});

	it('draws no sidebar column with every panel off', async () => {
		const { target } = drawPage({ ...data, dashboardDisplay: { ...defaultDisplay(), hiddenPanels: SIDE_PANE_PANELS.map((p) => p.key).filter((k) => k !== 'quick') } });
		await settle();
		expect(sidebarOf(target)).not.toBeNull();
		const menu = await openDisplay(target);
		panelItem(menu, 'quick').click();
		flushSync();
		expect(sidebarOf(target)).toBeNull();
		expect(target.querySelector('.dashboard-grid')!.classList.contains('no-sidebar')).toBe(true);
	});

	it('draws no empty column: the tiles and the quick figures off, and no activity, deadlines or anything else to draw (the review’s F2)', async () => {
		xp = [];
		const { target } = drawPage({ ...bare, dashboardDisplay: { ...defaultDisplay(), hiddenPanels: ['figures'] } });
		await settle();
		expect(sidebarOf(target)).not.toBeNull();
		const menu = await openDisplay(target);
		panelItem(menu, 'quick').click();
		flushSync();
		expect(sidebarOf(target)).toBeNull();
		expect(target.querySelector('.dashboard-grid')!.classList.contains('no-sidebar')).toBe(true);
	});

	it('takes the load’s choice again when the signed-in user changes on the live page, and writes the new user’s cookie', async () => {
		const { target, props } = drawPage({ ...data, dashboardDisplay: { ...defaultDisplay(), paneHidden: true } });
		await settle();
		expect(sidebarOf(target)).toBeNull();
		// Another user signs in: the load runs again with their cookie, and the page store names them.
		props.data = { ...data, dashboardDisplay: { ...defaultDisplay(), hiddenPanels: ['health'] } };
		signedIn.set(2);
		await settle();
		expect(sidebarOf(target)).not.toBeNull();
		expect(titles(sidebarOf(target)!)).not.toContain('Board Health Overview');
		const menu = await openDisplay(target);
		panelItem(menu, 'xp').click();
		flushSync();
		expect(parseDashboardDisplay(cookie(dashboardDisplayCookie(2))).hiddenPanels).toEqual(['health', 'xp']);
		expect(cookie(dashboardDisplayCookie(1))).toBeUndefined();
	});

	it('keeps the choice through a live refresh of the same user, even one that hands back the defaults (cookies blocked)', async () => {
		blockCookies();
		const { target, props } = drawPage();
		await settle();
		const menu = await openDisplay(target);
		paneItem(menu).click();
		flushSync();
		expect(sidebarOf(target)).toBeNull();
		// The live refresh runs the load again: with no cookie written, it answers the defaults.
		props.data = { ...data, dashboardDisplay: defaultDisplay() };
		await settle();
		expect(sidebarOf(target)).toBeNull();
	});
});
