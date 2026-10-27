// @vitest-environment jsdom
/**
 * The header bars' menus (card 2466), mounted with Svelte's client runtime as
 * `tests/xp-leaderboard.svelte.test.ts` is. The dashboard's and the board's
 * bars were tidied with progressive disclosure: what is used every minute
 * stays in view, the rest moves one click deeper into a menu drawn by
 * `src/lib/components/HeaderMenu.svelte`.
 *
 *   - The dashboard (`DashboardHeader.svelte`): All Tasks, Inbox, Planning and
 *     New Board in view; All To Do, Reports, Burndown and Graph in Views; the
 *     theme in More. Under 640 px All Tasks, Inbox and Planning are listed in
 *     Views too.
 *   - Your Boards (`BoardsTable.svelte`): the done-board and done-sub switches
 *     and Manage Categories in Display, whose button has a dot while a switch
 *     is off its default.
 *   - The board (`BoardHeader.svelte`, `BoardMoreMenu.svelte`): the assignee
 *     filter and Hide blocked in Filter, whose button counts those on; Planning,
 *     All To Do, Add Column and the theme in More. The XP bars are gone from
 *     the board (the owner, 2026-10-26).
 *
 * Each moved control is found in its new home and still does what it did;
 * and each menu is worked from the keyboard: opened with Enter, Space or
 * ArrowDown (ArrowUp on the last item), the arrows between its items, Escape
 * closing it with the focus back on its button, Tab leaving it, and a click
 * outside closing it. It is named `.svelte.test.ts` so that the props handed
 * to a component can be `$state`, and a bound prop's change read back.
 */
import { readFileSync } from 'node:fs';
import { join } from 'node:path';
import { pathToFileURL } from 'node:url';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import type * as Svelte from 'svelte';
import { get } from 'svelte/store';
import { compile } from 'svelte/compiler';

import DashboardHeader from '$lib/components/dashboard/DashboardHeader.svelte';
import BoardsTable from '$lib/components/dashboard/BoardsTable.svelte';
import BoardHeader from '$lib/components/board/BoardHeader.svelte';
import BoardMoreMenu from '$lib/components/board/BoardMoreMenu.svelte';
import { theme } from '$lib/stores/theme';

// The dashboard's header reads who is signed in from the page store, which only a running SvelteKit app has.
const signedIn = vi.hoisted(() => ({ role: 'user' }));
vi.mock('$app/stores', () => {
	const value = () => ({ data: { user: { id: 1, username: 'alice', role: signedIn.role } } });
	return { page: { subscribe: (run: (v: ReturnType<typeof value>) => void) => { run(value()); return () => {}; } } };
});
// A bare 'svelte' gives the server's runtime, whose tick and onDestroy the components cannot use in a browser: the client's, by its path.
vi.mock('svelte', async () => {
	const { join } = await import('node:path');
	const { pathToFileURL } = await import('node:url');
	return await import(/* @vite-ignore */ pathToFileURL(join(process.cwd(), 'node_modules/svelte/src/index-client.js')).href);
});

// The browser's `mount`, loaded by its path (see the XP bars' file).
const clientEntry = pathToFileURL(join(process.cwd(), 'node_modules/svelte/src/index-client.js')).href;
const { flushSync, mount, unmount }: typeof Svelte = await import(/* @vite-ignore */ clientEntry);

const ROOT = process.cwd();
const read = (file: string) => readFileSync(join(ROOT, file), 'utf8');

const DASHBOARD_HEADER = 'src/lib/components/dashboard/DashboardHeader.svelte';

/**
 * A component's compiled CSS as a browser `width` px wide takes it: each
 * `@media (max-width: Npx)` block whose N is at least `width` unwrapped, every
 * other `@media` block left out. Its scoping class is put to the one `drawn`
 * carries, and it is added to the page; the caller removes it.
 */
function sheetAt(file: string, width: number, drawn: Element): HTMLStyleElement {
	const css = compile(read(file), { filename: join(ROOT, file), css: 'external' }).css!.code;
	let out = '';
	let i = 0;
	while (i < css.length) {
		const at = css.indexOf('@media', i);
		if (at < 0) {
			out += css.slice(i);
			break;
		}
		out += css.slice(i, at);
		const open = css.indexOf('{', at);
		let depth = 1;
		let j = open + 1;
		for (; depth > 0; j++) {
			if (css[j] === '{') depth++;
			else if (css[j] === '}') depth--;
		}
		const max = /max-width:\s*(\d+)px/.exec(css.slice(at, open));
		if (max && width <= Number(max[1])) out += css.slice(open + 1, j - 1);
		i = j;
	}
	const compiled = /\.(svelte-[\w-]+)/.exec(css)![1];
	const scoped = /\bsvelte-[\w-]+/.exec(drawn.getAttribute('class') ?? '')![0];
	const style = document.createElement('style');
	style.textContent = out.replaceAll(compiled, scoped);
	document.head.appendChild(style);
	return style;
}

let drawn: { component: ReturnType<typeof mount>; target: HTMLElement }[] = [];

/** A link pressed in a test is not followed: jsdom cannot navigate, and says so on the console. */
function noNavigation(e: MouseEvent) {
	if ((e.target as Element | null)?.closest?.('a[href]')) e.preventDefault();
}

beforeEach(() => {
	window.addEventListener('click', noNavigation, true);
});

afterEach(() => {
	for (const { component, target } of drawn) {
		unmount(component);
		target.remove();
	}
	drawn = [];
	window.removeEventListener('click', noNavigation, true);
	vi.unstubAllGlobals();
	signedIn.role = 'user';
	theme.set('light');
});

function draw(component: unknown, props: Record<string, unknown>): HTMLElement {
	const target = document.createElement('div');
	document.body.appendChild(target);
	drawn.push({ component: mount(component as never, { target, props: props as never }), target });
	flushSync();
	return target;
}

/** Lets HeaderMenu's open (which waits a tick before it moves the focus) finish, and the page draw. */
async function settle() {
	for (let i = 0; i < 3; i++) {
		await new Promise((resolve) => setTimeout(resolve, 0));
		flushSync();
	}
}

/** A key pressed where the focus is (or on `on`), bubbling as a real one does; gives back the event. */
function press(key: string, on: Element | null = document.activeElement, options: KeyboardEventInit = {}): KeyboardEvent {
	const event = new KeyboardEvent('keydown', { key, bubbles: true, cancelable: true, ...options });
	(on ?? document.body).dispatchEvent(event);
	flushSync();
	return event;
}

/** A key let go where the focus is, bubbling; gives back the event. */
function release(key: string): KeyboardEvent {
	const event = new KeyboardEvent('keyup', { key, bubbles: true, cancelable: true });
	(document.activeElement ?? document.body).dispatchEvent(event);
	flushSync();
	return event;
}

const menuNamed = (label: string) => document.querySelector<HTMLElement>(`[role="menu"][aria-label="${label}"]`);
const itemsOf = (menu: HTMLElement) => [...menu.querySelectorAll<HTMLElement>('[role="menuitem"], [role="menuitemcheckbox"], [role="menuitemradio"]')];
const textOf = (el: Element) => el.textContent!.replace(/\s+/g, ' ').trim();
const itemNamed = (menu: HTMLElement, text: string) => itemsOf(menu).find((item) => textOf(item) === text || item.getAttribute('aria-label') === text)!;
/** A theme's item in a More menu's Theme group, by its name: its icon, the name, and ✓ when chosen. */
const themeNamed = (menu: HTMLElement, label: string) =>
	itemsOf(themeGroup(menu)).find((item) => textOf(item).replace(/ ✓$/, '').split(' ').slice(1).join(' ') === label)!;
const themeGroup = (menu: HTMLElement) => groupNamed(menu, 'Theme');
/** A menu's section: the role="group" its heading names through aria-labelledby. */
function groupNamed(menu: HTMLElement, heading: string): HTMLElement {
	const label = [...menu.querySelectorAll<HTMLElement>('.hm-label')].find((el) => textOf(el) === heading)!;
	expect(label, heading).toBeTruthy();
	expect(label.id, heading).not.toBe('');
	return menu.querySelector<HTMLElement>(`[role="group"][aria-labelledby="${label.id}"]`)!;
}
/** Every control in `within` that is not inside one of its menus: what the bar shows with the menus shut. */
const shown = (within: HTMLElement) =>
	[...within.querySelectorAll<HTMLElement>('a, button, select, input')].filter((el) => !el.closest('[role="menu"]'));
const shownNamed = (within: HTMLElement, text: string) => shown(within).filter((el) => textOf(el) === text || el.getAttribute('aria-label') === text);

// ─── What each mounts ───────────────────────────────────────────────────────

function drawDashboardHeader(inboxCount = 0) {
	const props = $state({ inboxCount, showCreate: false });
	const target = draw(DashboardHeader, props);
	return { target, props };
}

const tableBoard = (id: number, name: string, totalCards: number, completedCards: number, subBoards: unknown[] = []) => ({
	id, name, emoji: '📋', categoryId: null, categoryName: null, categoryColor: null,
	totalCards, completedCards, lastActivity: '2026-10-20 09:00:00', tokenTotal: null, costUsd: null, subBoards
});

function drawBoardsTable() {
	const data = {
		boards: [
			tableBoard(1, 'Website', 4, 1, [{ id: 5, name: 'Launch', emoji: '🗂️', parentCardTitle: 'Go live', total: 2, done: 2, tokenTotal: null, costUsd: null }]),
			tableBoard(2, 'Finished', 3, 3)
		],
		analytics: { totalBoards: 2, totalSubBoards: 1 },
		allTasksTotals: { cards: 7, completedCards: 4, tasks: 7, subtasks: 0, tokenTotal: null, costUsd: null, unpricedTokens: 0 },
		favouriteBoardIds: []
	};
	const props = $state({
		data,
		deleting: null,
		confirmDeleteBoard: () => {},
		openBoardContextMenu: () => {},
		showCreate: false,
		expandedBoards: new Set([1]),
		collapsedCategories: new Set<string>(),
		showCategoryManager: false
	});
	const target = draw(BoardsTable, props);
	return { target, props };
}

function drawBoardHeader(canRename = true) {
	const props = $state({
		boardId: 7,
		boardName: 'Website',
		boardEmoji: '📋',
		breadcrumbs: [],
		tokenSummary: { total: 12000, entries: 1, costUsd: 1.5, unpricedTokens: 0 },
		editingName: false,
		canRename,
		nameDraft: '',
		searchQuery: '',
		filterAssigneeId: null as number | null,
		hideBlocked: false,
		currentUser: { id: 1 },
		boardUsers: [
			{ id: 1, username: 'alice', emoji: '🦊' },
			{ id: 2, username: 'bob', emoji: null }
		],
		view: 'board',
		onEmoji: () => {},
		onStartRename: () => {},
		onRename: () => {},
		onViewChange: () => {}
	});
	const target = draw(BoardHeader, props);
	return { target, props };
}

function drawBoardMoreMenu(canManage = true, isSubBoard = false) {
	const calls: string[] = [];
	const props = $state({
		open: false,
		showActivityPanel: false,
		showStatsPanel: false,
		showArchivePanel: false,
		selectionMode: false,
		canManage,
		isSubBoard,
		boardId: 7,
		onAddColumn: () => calls.push('addColumn'),
		onToggleActivity: () => calls.push('activity'),
		onToggleStats: () => calls.push('stats'),
		onToggleArchive: () => calls.push('archive'),
		onManageCategories: () => calls.push('categories'),
		onToggleSelection: () => calls.push('selection'),
		onShare: () => calls.push('share'),
		onDeleteSubBoard: () => calls.push('deleteSubBoard')
	});
	const target = draw(BoardMoreMenu, props);
	return { target, props, calls };
}

/** Opens a menu by a click on its button, and gives back the menu. */
async function openByClick(button: HTMLButtonElement, label: string) {
	button.click();
	await settle();
	return menuNamed(label)!;
}

// ─── The dashboard ──────────────────────────────────────────────────────────

describe('the dashboard header (card 2466)', () => {
	it('keeps All Tasks, Inbox with its count, Planning and New Board in view, and nothing it moved', () => {
		const { target } = drawDashboardHeader(3);
		const bar = target.querySelector<HTMLElement>('.header-nav')!;
		// "Views 3": the count on Views, which the CSS shows only where the Inbox pill is hidden (jsdom applies no CSS).
		expect(shown(bar).map(textOf)).toEqual(['All Tasks', 'Inbox 3', 'Planning', 'Views 3', 'More', 'New Board']);
		expect(bar.querySelector('a[href="/all"]')).not.toBeNull();
		expect(bar.querySelector('a[href="/inbox"] .inbox-count-badge')!.textContent).toBe('3');
		expect(bar.querySelector('#plan-link')!.getAttribute('href')).toBe('/plan');
		for (const gone of ['/todo', '/reports', '/burndown', '/graph']) expect(bar.querySelector(`a[href="${gone}"]`), gone).toBeNull();
		// The theme picker is in More now, not the bar.
		expect(target.querySelector('.theme-picker')).toBeNull();
	});

	it('opens the create window from New Board, as before', () => {
		const { target, props } = drawDashboardHeader();
		target.querySelector<HTMLButtonElement>('#create-board-btn')!.click();
		flushSync();
		expect(props.showCreate).toBe(true);
	});

	it('has All To Do, Reports, Burndown and Graph in Views, each its link with its id, and a pick closes it', async () => {
		const { target } = drawDashboardHeader();
		const button = target.querySelector<HTMLButtonElement>('#nav-views-btn')!;
		expect(button.getAttribute('aria-haspopup')).toBe('menu');
		expect(button.getAttribute('aria-expanded')).toBe('false');
		const menu = await openByClick(button, 'Views');
		expect(button.getAttribute('aria-expanded')).toBe('true');
		expect(button.getAttribute('aria-controls')).toBe(menu.id);
		expect(itemsOf(menu).map((item) => [textOf(item), item.getAttribute('href'), item.id])).toEqual([
			['All To Do', '/todo', 'todo-link'],
			['Reports', '/reports', 'reports-link'],
			['Burndown', '/burndown', 'burndown-link'],
			['Graph', '/graph', 'graph-link']
		]);
		itemNamed(menu, 'Reports').click();
		flushSync();
		expect(menuNamed('Views')).toBeNull();
		expect(document.activeElement).toBe(button);
	});

	it('lists All Tasks, Inbox (with its count) and Planning first in Views on a narrow screen, and says so in its title', async () => {
		vi.stubGlobal('matchMedia', (query: string) => ({ matches: query === '(max-width: 640px)', media: query, addEventListener() {}, removeEventListener() {} }));
		const { target } = drawDashboardHeader(2);
		expect(read('src/lib/components/dashboard/DashboardHeader.svelte')).toContain("const NARROW = '(max-width: 640px)';");
		const button = target.querySelector<HTMLButtonElement>('#nav-views-btn')!;
		expect(button.title).toBe('All Tasks, Inbox, Planning, All To Do, Reports, Burndown and Graph');
		// Its count rides on the Views button where the Inbox pill is hidden.
		expect(target.querySelector('#nav-views-btn .inbox-count-badge.narrow-only')!.textContent).toBe('2');

		const menu = await openByClick(button, 'Views');
		expect(itemsOf(menu).map((item) => [textOf(item), item.getAttribute('href')])).toEqual([
			['All Tasks', '/all'],
			['Inbox 2', '/inbox'],
			['Planning', '/plan'],
			['All To Do', '/todo'],
			['Reports', '/reports'],
			['Burndown', '/burndown'],
			['Graph', '/graph']
		]);
	});

	it('titles Views with its own four on a wide screen, and opens its panel from the button’s left edge', async () => {
		const { target } = drawDashboardHeader();
		const button = target.querySelector<HTMLButtonElement>('#nav-views-btn')!;
		expect(button.title).toBe('All To Do, Reports, Burndown and Graph');
		const menu = await openByClick(button, 'Views');
		expect(menu.classList.contains('hm-start')).toBe(true);
	});

	/**
	 * The fold, through the cascade (the code review: `.header-nav .nav-pill`
	 * outweighed a bare `.wide-only`, and `.inbox-count-badge` a bare
	 * `.narrow-only`, so the pills stayed and the count showed twice). The
	 * header's compiled CSS is put in the page as a browser at that width
	 * would take it: the `max-width` blocks it falls under unwrapped, the
	 * others left out; jsdom then weighs the rules by specificity and order.
	 */
	it.each([
		[1024, 'inline-flex', 'none'],
		[375, 'none', 'inline-flex']
	])('at %i px shows the pills as %s and the count on Views as %s, through the compiled CSS', (width, pills, badge) => {
		const { target } = drawDashboardHeader(2);
		const nav = target.querySelector<HTMLElement>('.header-nav')!;
		const style = sheetAt(DASHBOARD_HEADER, width, nav);
		try {
			const shownPills = [...nav.querySelectorAll<HTMLElement>(':scope > a.nav-pill')];
			expect(shownPills.map(textOf)).toEqual(['All Tasks', 'Inbox 2', 'Planning']);
			for (const pill of shownPills) expect(getComputedStyle(pill).display, textOf(pill)).toBe(pills);
			expect(getComputedStyle(nav.querySelector('#nav-views-btn .inbox-count-badge')!).display).toBe(badge);
			// The Inbox pill's own count is drawn with its pill.
			expect(getComputedStyle(nav.querySelector(':scope > a[href="/inbox"] .inbox-count-badge')!).display).toBe('inline-flex');
		} finally {
			style.remove();
		}
	});

	it('keeps Teams, Archived, Request and API Docs in More (Admin and Audit for an administrator), with the theme', async () => {
		const { target } = drawDashboardHeader();
		const menu = await openByClick(target.querySelector<HTMLButtonElement>('#nav-more-btn')!, 'More');
		const links = itemsOf(menu).filter((item) => item.tagName === 'A').map((item) => [textOf(item), item.getAttribute('href')]);
		expect(links).toEqual([
			['Teams', '/teams'],
			['Archived', '/archived'],
			['Request', '/request'],
			['API Docs', '/docs']
		]);
		// The themes are a named list in a group named Theme (the code review: a grid of bare icons).
		const themes = itemsOf(themeGroup(menu));
		expect(themes).toHaveLength(17);
		expect(themes.every((item) => item.getAttribute('role') === 'menuitemradio')).toBe(true);
		expect(themes.slice(0, 3).map(textOf)).toEqual(['☀️ Light ✓', '🌙 Dark', '🌅 Solarized']);
		expect(themeNamed(menu, 'Light').getAttribute('aria-checked')).toBe('true');
	});

	it('shows Admin and Audit & Logs in More to an administrator', async () => {
		signedIn.role = 'admin';
		const { target } = drawDashboardHeader();
		const menu = await openByClick(target.querySelector<HTMLButtonElement>('#nav-more-btn')!, 'More');
		expect(itemsOf(menu).filter((item) => item.tagName === 'A').map(textOf)).toEqual(['Teams', 'Archived', 'Admin', 'Audit & Logs', 'Request', 'API Docs']);
	});

	it('sets the theme from More, which closes with the focus on its button', async () => {
		const { target } = drawDashboardHeader();
		const button = target.querySelector<HTMLButtonElement>('#nav-more-btn')!;
		const menu = await openByClick(button, 'More');
		themeNamed(menu, 'Dark').click();
		flushSync();
		expect(get(theme)).toBe('dark');
		expect(menuNamed('More')).toBeNull();
		expect(document.activeElement).toBe(button);
		const again = await openByClick(button, 'More');
		expect(themeNamed(again, 'Dark').getAttribute('aria-checked')).toBe('true');
		expect(themeNamed(again, 'Light').getAttribute('aria-checked')).toBe('false');
	});
});

// ─── Your Boards' Display menu ──────────────────────────────────────────────

describe('the Display menu above Your Boards (card 2466)', () => {
	const rowNames = (target: HTMLElement) => [...target.querySelectorAll('.board-row-name')].map((el) => textOf(el));

	it('holds Manage Categories, which opens the window as its button did, and the bar has no button of its own for it', async () => {
		const { target, props } = drawBoardsTable();
		const actions = target.querySelector<HTMLElement>('.header-actions')!;
		expect(shown(actions).map(textOf)).toEqual(['Display']);
		const menu = await openByClick(target.querySelector<HTMLButtonElement>('#display-menu-btn')!, 'Display');
		const item = itemNamed(menu, '🏷️ Manage Categories');
		expect(item.getAttribute('title')).toBe('Manage Categories');
		item.click();
		flushSync();
		expect(props.showCategoryManager).toBe(true);
		expect(menuNamed('Display')).toBeNull();
	});

	it('switches done boards and done subs as the buttons did, stays open, and its dot shows only while one is off its default', async () => {
		const { target } = drawBoardsTable();
		const button = target.querySelector<HTMLButtonElement>('#display-menu-btn')!;
		const dot = () => button.querySelector('.display-dot');
		expect(dot()).toBeNull();
		expect(button.classList.contains('hm-on')).toBe(false);
		expect(rowNames(target).some((name) => name.startsWith('Finished'))).toBe(true);
		expect(rowNames(target).some((name) => name.startsWith('Launch'))).toBe(false);

		const menu = await openByClick(button, 'Display');
		const doneBoards = itemNamed(menu, '✅ Showing done boards');
		expect(doneBoards.getAttribute('aria-checked')).toBe('true');
		doneBoards.click();
		flushSync();
		// A switch leaves the menu open, so the other can be changed too.
		expect(menuNamed('Display')).not.toBeNull();
		expect(textOf(doneBoards)).toBe('👁️ Show done boards');
		expect(doneBoards.getAttribute('aria-checked')).toBe('false');
		expect(rowNames(target).some((name) => name.startsWith('Finished'))).toBe(false);
		expect(dot()).not.toBeNull();
		expect(button.classList.contains('hm-on')).toBe(true);

		doneBoards.click();
		flushSync();
		expect(dot()).toBeNull();

		const doneSubs = itemNamed(menuNamed('Display')!, '👁️ Show done subs');
		doneSubs.click();
		flushSync();
		expect(textOf(doneSubs)).toBe('✅ Showing done subs');
		expect(rowNames(target).some((name) => name.startsWith('Launch'))).toBe(true);
		expect(dot()).not.toBeNull();
		expect(button.getAttribute('title')).toBe('Display: a setting is changed from its default');
	});
});

// ─── The board header ───────────────────────────────────────────────────────

describe('the board header (card 2466)', () => {
	it('keeps the way back, the emoji, the name, the cost and the search in view; the switch, Filter and More on the right; no XP bars', () => {
		const { target } = drawBoardHeader();
		const header = target.querySelector<HTMLElement>('.board-header')!;
		expect(header.querySelector('#back-to-dashboard')).not.toBeNull();
		expect(textOf(header.querySelector('.board-name')!)).toBe('Website #7');
		expect(header.querySelector('.hdr-cost')).not.toBeNull();
		expect(header.querySelector<HTMLInputElement>('.search-input')!.placeholder).toBe('Search tasks or #id...');
		const right = header.querySelector<HTMLElement>('.board-header-right')!;
		expect(shown(right).map((el) => el.getAttribute('aria-label') ?? textOf(el))).toEqual(['Board', 'List', 'Filter']);
		// Moved out of the bar: the assignee select, Hide blocked, Planning, All To Do, Add Column, the theme.
		expect(header.querySelector('select')).toBeNull();
		expect(shownNamed(header, 'Hide blocked')).toHaveLength(0);
		expect(header.querySelector('a[href^="/plan"], a[href^="/todo"], button[title="Add column"], .theme-picker')).toBeNull();
		// The XP bars are not drawn on the board (the owner, 2026-10-26).
		expect(header.querySelector('.xp-bar-container')).toBeNull();
	});

	it('draws no XP bars and reads no XP on the board page', () => {
		const page = read('src/routes/board/[id]/+page.svelte');
		expect(page).not.toMatch(/XpLeaderboard|loadXp|fetchXpData|refreshXp|onXpUpdate:/);
		expect(read('src/lib/components/board/BoardHeader.svelte')).not.toMatch(/\bxp\b/);
		// Add Column opens the window; there is no Add Options Column, as every delivery board has its Options column (card 2527).
		expect(page).toMatch(/<BoardMoreMenu[\s\S]*?onAddColumn=\{\(\) => \(showAddColumnModal = true\)\}/);
		expect(page).not.toMatch(/onAddOptionsColumn|canAddOptions|openAddColumn/);
		expect(read('src/lib/components/board/BoardMoreMenu.svelte')).not.toContain('Add Options Column');
	});

	it('filters by assignee from Filter, as the select did, and its button counts the filters on', async () => {
		const { target, props } = drawBoardHeader();
		const button = target.querySelector<HTMLButtonElement>('#board-filter-btn')!;
		expect(textOf(button)).toBe('Filter');
		expect(button.classList.contains('hm-on')).toBe(false);

		let menu = await openByClick(button, 'Filter');
		expect(itemsOf(menu).map(textOf)).toEqual(['All assignees ✓', '👤 My Cards', '👤 bob', 'Hide blocked']);
		itemNamed(menu, '👤 My Cards').click();
		flushSync();
		expect(props.filterAssigneeId).toBe(1);
		// A radio item closes it, the focus back on its button.
		expect(menuNamed('Filter')).toBeNull();
		expect(document.activeElement).toBe(button);
		expect(textOf(button)).toBe('Filter · 1');
		expect(button.classList.contains('hm-on')).toBe(true);

		menu = await openByClick(button, 'Filter');
		expect(itemNamed(menu, '👤 My Cards ✓').getAttribute('aria-checked')).toBe('true');
		itemNamed(menu, '👤 bob').click();
		flushSync();
		expect(props.filterAssigneeId).toBe(2);
		expect(textOf(button)).toBe('Filter · 1');
	});

	it('hides blocked cards from Filter, as the button did, staying open, and counts it', async () => {
		const { target, props } = drawBoardHeader();
		const button = target.querySelector<HTMLButtonElement>('#board-filter-btn')!;
		const menu = await openByClick(button, 'Filter');
		const hide = itemNamed(menu, 'Hide blocked');
		expect(hide.getAttribute('title')).toBe('Hide cards that are still waiting on another card');
		expect(hide.getAttribute('aria-checked')).toBe('false');
		hide.click();
		flushSync();
		expect(props.hideBlocked).toBe(true);
		expect(menuNamed('Filter')).not.toBeNull();
		expect(hide.getAttribute('aria-checked')).toBe('true');
		expect(textOf(button)).toBe('Filter · 1');

		itemNamed(menu, '👤 bob').click();
		flushSync();
		expect(textOf(button)).toBe('Filter · 2');
		expect(button.getAttribute('title')).toBe('2 filters on');

		const again = await openByClick(button, 'Filter');
		itemNamed(again, 'All assignees').click();
		flushSync();
		expect(props.filterAssigneeId).toBeNull();
		expect(textOf(button)).toBe('Filter · 1');
	});

	it('counts filters set from outside the menu too (the page’s own state, bound)', () => {
		const { target, props } = drawBoardHeader();
		props.hideBlocked = true;
		props.filterAssigneeId = 2;
		flushSync();
		expect(textOf(target.querySelector('#board-filter-btn')!)).toBe('Filter · 2');
	});
});

// Card 2470: the name was an <h1 role="button" tabindex="0"> with a click alone, the
// a11y warning silenced: Enter and Space on it did nothing.
describe('renaming the board from the keyboard (card 2470)', () => {
	/** The header as the page draws it: the rename box opened and closed by the page's own state. */
	function drawRenamable(canRename = true) {
		const { target, props } = drawBoardHeader(canRename);
		const renames: string[] = [];
		const calls = { rename: 0, cancel: 0 };
		props.onStartRename = () => {
			props.nameDraft = props.boardName;
			props.editingName = true;
		};
		// The page's saveBoardName: it closes the box, and sends the name trimmed when it is not empty and not the stored one.
		props.onRename = () => {
			calls.rename++;
			props.editingName = false;
			const name = props.nameDraft.trim();
			if (name && name !== props.boardName) renames.push(name);
		};
		Object.assign(props, {
			onCancelRename: () => {
				calls.cancel++;
				props.editingName = false;
			}
		});
		flushSync();
		return { target, props, renames, calls };
	}
	const nameButton = (target: HTMLElement) => target.querySelector<HTMLButtonElement>('h1.board-name > button');
	const nameBox = (target: HTMLElement) => target.querySelector<HTMLInputElement>('.board-name-input');
	function type(box: HTMLInputElement, value: string) {
		box.value = value;
		box.dispatchEvent(new Event('input', { bubbles: true }));
		flushSync();
	}

	it('draws the name as a real button inside the heading, named "Rename board <name> #<id>", which starts the rename', () => {
		const { target } = drawRenamable();
		const button = nameButton(target)!;
		// A <button type="button">: the browser presses it on Enter and on Space (jsdom does not, so the press is a click here).
		expect([button.tagName, button.type, button.disabled, button.tabIndex]).toEqual(['BUTTON', 'button', false, 0]);
		expect(button.getAttribute('aria-label')).toBe('Rename board Website #7');
		expect(textOf(button)).toBe('Website #7');
		const heading = target.querySelector('h1.board-name')!;
		expect([heading.getAttribute('role'), heading.getAttribute('tabindex')]).toEqual([null, null]);

		button.focus();
		button.click();
		flushSync();
		expect(nameBox(target)).not.toBeNull();
		expect(nameBox(target)!.value).toBe('Website');
	});

	it('draws the name as plain text, no button, for someone who cannot rename the board', () => {
		const { target } = drawRenamable(false);
		expect(nameButton(target)).toBeNull();
		expect(target.querySelector('h1.board-name button, h1.board-name [role="button"], h1.board-name [tabindex]')).toBeNull();
		const heading = target.querySelector<HTMLElement>('h1.board-name')!;
		expect(textOf(heading)).toBe('Website #7');
		expect([heading.getAttribute('role'), heading.getAttribute('tabindex')]).toEqual([null, null]);
		heading.click();
		flushSync();
		expect(nameBox(target)).toBeNull();
	});

	it('gives the focus back to the name’s button once Enter sends the name', async () => {
		const { target, renames } = drawRenamable();
		nameButton(target)!.click();
		flushSync();
		type(nameBox(target)!, 'Webshop');
		press('Enter', nameBox(target));
		await settle();
		expect(nameBox(target)).toBeNull();
		expect(renames).toEqual(['Webshop']);
		expect(document.activeElement).toBe(nameButton(target));
	});

	// The review of card 2470: Escape called onRename with the name put back, and the page's
	// check compares the trimmed name with the stored one, so a stored name with spaces round
	// it was sent, trimmed, by Escape and again by the blur that follows.
	it('Escape cancels only: the box closed by onCancelRename, onRename never called, not even by the blur that follows, with spaces round the stored name', async () => {
		const { target, props, renames, calls } = drawRenamable();
		props.boardName = '  Website ';
		flushSync();
		nameButton(target)!.click();
		flushSync();
		const box = nameBox(target)!;
		type(box, 'Webshop');
		const escape = press('Escape', box);
		// As Chromium does, the blur of the box as it is taken away, before the focus is given back.
		box.dispatchEvent(new FocusEvent('blur'));
		await settle();
		expect(escape.defaultPrevented).toBe(true);
		expect(nameBox(target)).toBeNull();
		expect(props.nameDraft).toBe('  Website ');
		expect([calls.rename, calls.cancel, renames]).toEqual([0, 1, []]);
		expect(document.activeElement).toBe(nameButton(target));

		// The next rename's blur sends, as before.
		nameButton(target)!.click();
		flushSync();
		type(nameBox(target)!, 'Webshop');
		nameBox(target)!.dispatchEvent(new FocusEvent('blur'));
		await settle();
		expect([calls.rename, renames]).toEqual([1, ['Webshop']]);
	});

	it('offers the emoji picker only with the same right, and shows the emoji alone without it', () => {
		expect(drawRenamable().target.querySelector('.emoji-trigger')).not.toBeNull();
		const { target } = drawRenamable(false);
		expect(target.querySelector('.emoji-trigger')).toBeNull();
		expect(textOf(target.querySelector('.board-emoji-text')!)).toBe('📋');
	});

	it('hands the page who may rename, and no longer silences the heading’s a11y warning', () => {
		const header = read('src/lib/components/board/BoardHeader.svelte');
		expect(header).not.toContain('svelte-ignore');
		expect(header).not.toMatch(/<h1[^>]*(role=|tabindex=|onclick=)/);
		const page = read('src/routes/board/[id]/+page.svelte');
		expect(page).toMatch(/<BoardHeader[\s\S]*?canRename=\{boardState\.canEdit\}/);
		expect(page).toMatch(/<BoardHeader[\s\S]*?onCancelRename=\{\(\) => \(editingBoardName = false\)\}/);
	});
});

describe('the board’s More menu (card 2466)', () => {
	it('holds Planning and All To Do for this board, with their titles, first', async () => {
		const { target } = drawBoardMoreMenu();
		const menu = await openByClick(target.querySelector<HTMLButtonElement>('.more-menu-trigger')!, 'More');
		const [planning, todo] = itemsOf(menu);
		expect([textOf(planning), planning.getAttribute('href')]).toEqual(['Planning', '/plan?board=7']);
		expect(planning.getAttribute('title')).toBe('Planning — critical path and what is startable for this board');
		expect([textOf(todo), todo.getAttribute('href')]).toEqual(['All To Do', '/todo?board=7']);
		expect(todo.getAttribute('title')).toBe("This board's To Do column, and its sub-boards', with every other board's a filter away");
	});

	it('runs Add Column, closing first with the focus on More, so the window it opens gives the focus back there', async () => {
		const { target, calls, props } = drawBoardMoreMenu();
		const button = target.querySelector<HTMLButtonElement>('.more-menu-trigger')!;
		const menu = await openByClick(button, 'More');
		expect(props.open).toBe(true);
		const add = itemNamed(menu, 'Add Column');
		expect(add.getAttribute('title')).toBe('Add column');
		add.focus();
		add.click();
		flushSync();
		expect(calls).toEqual(['addColumn']);
		expect(props.open).toBe(false);
		expect(document.activeElement).toBe(button);
	});

	it('keeps every item it had, each doing what it did and closing the menu', async () => {
		const { target, calls } = drawBoardMoreMenu(true, true);
		const button = target.querySelector<HTMLButtonElement>('.more-menu-trigger')!;
		const steps: [string, string][] = [
			['📋 Activity Log', 'activity'],
			['📊 Statistics', 'stats'],
			['🗄️ Archived Cards', 'archive'],
			['🏷️ Manage Categories', 'categories'],
			['☑️ Bulk Select', 'selection'],
			['🔗 Share Board', 'share'],
			['🗑️ Delete Sub-board', 'deleteSubBoard']
		];
		for (const [name, call] of steps) {
			const menu = await openByClick(button, 'More');
			itemNamed(menu, name).click();
			flushSync();
			expect(calls.at(-1), name).toBe(call);
			expect(menuNamed('More'), name).toBeNull();
		}
		const menu = await openByClick(button, 'More');
		expect(itemNamed(menu, '📉 Burndown').getAttribute('href')).toBe('/burndown?boardIds=7');
		expect(itemsOf(menu).filter((item) => item.getAttribute('role') === 'menuitemradio')).toHaveLength(17);
	});

	it('offers Share Board only to someone who manages the board, and Delete Sub-board only on a sub-board', async () => {
		const { target } = drawBoardMoreMenu(false, false);
		const menu = await openByClick(target.querySelector<HTMLButtonElement>('.more-menu-trigger')!, 'More');
		const names = itemsOf(menu).map(textOf);
		expect(names).not.toContain('🔗 Share Board');
		expect(names).not.toContain('🗑️ Delete Sub-board');
	});

	it('shows a panel that is open with its tick, and sets the theme', async () => {
		const { target, props } = drawBoardMoreMenu();
		props.showStatsPanel = true;
		flushSync();
		const menu = await openByClick(target.querySelector<HTMLButtonElement>('.more-menu-trigger')!, 'More');
		expect(itemNamed(menu, '📊 Statistics ✓').getAttribute('aria-checked')).toBe('true');
		themeNamed(menu, 'Nord').click();
		flushSync();
		expect(get(theme)).toBe('nord');
	});
});

// ─── Every menu, from the keyboard ──────────────────────────────────────────

type Case = { name: string; label: string; open: () => HTMLButtonElement };

const cases: Case[] = [
	{ name: 'the dashboard’s Views', label: 'Views', open: () => drawDashboardHeader().target.querySelector<HTMLButtonElement>('#nav-views-btn')! },
	{ name: 'the dashboard’s More', label: 'More', open: () => drawDashboardHeader().target.querySelector<HTMLButtonElement>('#nav-more-btn')! },
	{ name: 'Your Boards’ Display', label: 'Display', open: () => drawBoardsTable().target.querySelector<HTMLButtonElement>('#display-menu-btn')! },
	{ name: 'the board’s Filter', label: 'Filter', open: () => drawBoardHeader().target.querySelector<HTMLButtonElement>('#board-filter-btn')! },
	{ name: 'the board’s More', label: 'More', open: () => drawBoardMoreMenu().target.querySelector<HTMLButtonElement>('.more-menu-trigger')! }
];

describe.each(cases)('$name, from the keyboard (card 2466)', ({ label, open }) => {
	it('opens on Enter with the focus on its first item; the arrows, Home and End move between items, wrapping; Escape closes it and gives the focus back', async () => {
		const button = open();
		button.focus();
		const enter = press('Enter');
		expect(enter.defaultPrevented).toBe(true);
		await settle();
		const menu = menuNamed(label)!;
		expect(menu).not.toBeNull();
		expect(button.getAttribute('aria-expanded')).toBe('true');
		const items = itemsOf(menu);
		expect(items.length).toBeGreaterThan(1);
		for (const item of items) expect(item.tabIndex, textOf(item)).toBe(-1);
		expect(document.activeElement).toBe(items[0]);

		press('ArrowDown');
		expect(document.activeElement).toBe(items[1]);
		press('ArrowUp');
		expect(document.activeElement).toBe(items[0]);
		press('ArrowUp');
		expect(document.activeElement).toBe(items.at(-1));
		press('ArrowDown');
		expect(document.activeElement).toBe(items[0]);
		press('End');
		expect(document.activeElement).toBe(items.at(-1));
		press('Home');
		expect(document.activeElement).toBe(items[0]);

		const escape = press('Escape');
		expect(escape.defaultPrevented).toBe(true);
		expect(menuNamed(label)).toBeNull();
		expect(button.getAttribute('aria-expanded')).toBe('false');
		expect(document.activeElement).toBe(button);
	});

	it('opens on Space and on ArrowDown at its first item, and on ArrowUp at its last; the Space’s keyup does not press that item', async () => {
		const button = open();
		button.focus();
		press(' ');
		await settle();
		const first = itemsOf(menuNamed(label)!)[0];
		expect(document.activeElement).toBe(first);
		// The keyup of the Space that opened it lands on the first item: its default (Firefox's press) is taken.
		expect(release(' ').defaultPrevented).toBe(true);
		expect(menuNamed(label)).not.toBeNull();
		// The next one is the person's own, and left be.
		expect(release(' ').defaultPrevented).toBe(false);
		press('Escape');

		press('ArrowDown');
		await settle();
		expect(document.activeElement).toBe(itemsOf(menuNamed(label)!)[0]);
		press('Escape');

		press('ArrowUp');
		await settle();
		expect(document.activeElement).toBe(itemsOf(menuNamed(label)!).at(-1));
		press('Escape');
		expect(document.activeElement).toBe(button);
	});

	it('closes on Tab, the focus on its button for the browser to move on from, the Tab itself left to the browser', async () => {
		const button = open();
		button.focus();
		press('Enter');
		await settle();
		press('ArrowDown');
		const tab = press('Tab');
		expect(tab.defaultPrevented).toBe(false);
		expect(menuNamed(label)).toBeNull();
		expect(document.activeElement).toBe(button);
	});

	it('closes on a click outside, and on a second click on its button', async () => {
		const button = open();
		await openByClick(button, label);
		document.body.click();
		flushSync();
		expect(menuNamed(label)).toBeNull();

		await openByClick(button, label);
		button.click();
		flushSync();
		expect(menuNamed(label)).toBeNull();
	});
});

// ─── The code review (2026-10-26) ───────────────────────────────────────────

describe('the code review of card 2466', () => {
	it('names each section of the board’s More and of Filter by its heading, as a group', async () => {
		const more = drawBoardMoreMenu(true, true);
		let menu = await openByClick(more.target.querySelector<HTMLButtonElement>('.more-menu-trigger')!, 'More');
		expect(itemsOf(groupNamed(menu, 'Go to')).map(textOf)).toEqual(['Planning', 'All To Do']);
		expect(itemsOf(groupNamed(menu, 'Panels')).map(textOf)).toEqual(['📋 Activity Log', '📊 Statistics', '🗄️ Archived Cards']);
		expect(itemsOf(groupNamed(menu, 'Board')).map(textOf)).toEqual([
			'Add Column',
			'📉 Burndown',
			'🏷️ Manage Categories',
			'☑️ Bulk Select',
			'🔗 Share Board',
			'🗑️ Delete Sub-board'
		]);
		expect(itemsOf(groupNamed(menu, 'Theme'))).toHaveLength(17);
		// Every item is in one of them.
		expect(itemsOf(menu).every((item) => item.closest('[role="group"]'))).toBe(true);
		document.body.click();
		flushSync();

		const header = drawBoardHeader();
		menu = await openByClick(header.target.querySelector<HTMLButtonElement>('#board-filter-btn')!, 'Filter');
		expect(itemsOf(groupNamed(menu, 'Assignee')).map(textOf)).toEqual(['All assignees ✓', '👤 My Cards', '👤 bob']);
		expect(itemNamed(menu, 'Hide blocked').closest('[role="group"]')).toBeNull();
	});

	it('draws Filter as a field, not a flat action (app.css: a filter holds state and looks like a field)', () => {
		const button = drawBoardHeader().target.querySelector<HTMLButtonElement>('#board-filter-btn')!;
		expect(button.classList.contains('hdr-control')).toBe(true);
		expect(button.classList.contains('hdr-action')).toBe(false);
	});

	it('lets the click that opens a menu reach the window, so the page’s own closer shuts its dropdowns, and the bound menu stays open', async () => {
		const heard: string[] = [];
		const hear = () => heard.push('window');
		window.addEventListener('click', hear);
		try {
			const { target, props } = drawBoardMoreMenu();
			// What the board page's closer does now: its own dropdowns, not the header's menus.
			const page = read('src/routes/board/[id]/+page.svelte');
			const closer = /function closeDropdowns\(\) \{([^}]*)\}/.exec(page)![1];
			expect(closer).toContain('openDropdown = null');
			expect(closer).not.toContain('showMoreMenu');

			await openByClick(target.querySelector<HTMLButtonElement>('.more-menu-trigger')!, 'More');
			expect(heard).toEqual(['window']);
			expect(props.open).toBe(true);

			await openByClick(drawBoardHeader().target.querySelector<HTMLButtonElement>('#board-filter-btn')!, 'Filter');
			expect(heard).toEqual(['window', 'window']);
			// Opening Filter shut More (a click outside it).
			expect(props.open).toBe(false);
		} finally {
			window.removeEventListener('click', hear);
		}
	});

	it('takes no keyup when Enter opened it', async () => {
		const button = drawBoardHeader().target.querySelector<HTMLButtonElement>('#board-filter-btn')!;
		button.focus();
		press('Enter');
		await settle();
		expect(release(' ').defaultPrevented).toBe(false);
	});

	describe('a panel that would cross the window’s edge', () => {
		const realWidth = window.innerWidth;
		const box = (left: number, width: number) =>
			({ left, right: left + width, width, top: 0, bottom: 0, height: 0, x: left, y: 0, toJSON() {} }) as DOMRect;
		/** Where the wrapper and the panel are drawn, as a browser would measure them. */
		function measure(wrapper: DOMRect, panel: DOMRect, width = 375) {
			Object.defineProperty(window, 'innerWidth', { value: width, configurable: true });
			vi.spyOn(HTMLElement.prototype, 'getBoundingClientRect').mockImplementation(function (this: HTMLElement) {
				if (this.classList.contains('hm-panel')) return panel;
				if (this.classList.contains('hm')) return wrapper;
				return box(0, 0);
			});
		}
		afterEach(() => {
			vi.restoreAllMocks();
			Object.defineProperty(window, 'innerWidth', { value: realWidth, configurable: true });
		});

		it('is moved in from the left, 8 px from the edge', async () => {
			// Lined up with the right of a button near the left: it would start 110 px off the window.
			measure(box(10, 80), box(-110, 200));
			const menu = await openByClick(drawBoardHeader().target.querySelector<HTMLButtonElement>('#board-filter-btn')!, 'Filter');
			expect(menu.style.left).toBe('-2px');
			expect(menu.style.right).toBe('auto');
		});

		it('is moved in from the right, 8 px from the edge', async () => {
			// Lined up with the left of a button near the right: it would end at 500 in a 375 px window.
			measure(box(290, 80), box(300, 200));
			const menu = await openByClick(drawDashboardHeader().target.querySelector<HTMLButtonElement>('#nav-views-btn')!, 'Views');
			expect(menu.style.left).toBe(`${375 - 8 - 200 - 290}px`);
			expect(menu.style.right).toBe('auto');
		});

		it('is left where it is when it fits', async () => {
			measure(box(200, 80), box(80, 200));
			const menu = await openByClick(drawBoardHeader().target.querySelector<HTMLButtonElement>('#board-filter-btn')!, 'Filter');
			expect(menu.style.left).toBe('');
			expect(menu.style.right).toBe('');
		});
	});
});
