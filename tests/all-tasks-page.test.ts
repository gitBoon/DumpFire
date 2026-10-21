// @vitest-environment jsdom
/**
 * All Tasks (card 2281, slice C3a-2 of card 2012's part C), mounted with
 * Svelte's client runtime as the dashboard's file does, so that what the
 * page joins up between its components is run by Svelte itself: a card's
 * face opening the page's card window; its Move button opening the Move
 * window (through `bind:this`) and the move reaching its request; the
 * header's More menu opening and closing the Activity Log and Archived
 * Cards (each reached through `bind:this`, its open flag bound through the
 * page) and each reading its list, kept while it is shut; Archived Cards'
 * delete asking through the page's confirm dialog; the header's search,
 * board filter and Hide blocked filtering the page's cards (bound through
 * the page); and an event of the page's live stream reaching the live
 * toasts, the fireworks and the open Activity Log. `fetch`, the live stream
 * and `invalidateAll` are stand-ins; what each request sent is kept.
 *
 * The card window itself is held in `tests/card-window-pages.test.ts`; the
 * source pins of the same code are in `tests/page-failures.test.ts`,
 * `tests/all-tasks.test.ts`, `tests/activity-twins.test.ts`,
 * `tests/timestamps.test.ts` and `tests/todo-page.test.ts`.
 */
import { join } from 'node:path';
import { pathToFileURL } from 'node:url';
import { afterEach, beforeEach, describe, expect, it, onTestFinished, vi } from 'vitest';
import type * as Svelte from 'svelte';

import AllTasksPage from '../src/routes/all/+page.svelte';
import TasksActivityPanel from '$lib/components/tasks/TasksActivityPanel.svelte';
import { toasts } from '$lib/stores/toast';

// The page's data is read again after a write; here it is only counted.
const navigation = vi.hoisted(() => ({ invalidateAll: vi.fn(async () => {}), goto: vi.fn(async () => {}) }));
vi.mock('$app/navigation', () => ({
	invalidateAll: navigation.invalidateAll,
	goto: navigation.goto,
	afterNavigate: vi.fn(),
	beforeNavigate: vi.fn(),
	onNavigate: vi.fn()
}));
// The card window reads who is signed in from the page store, which only a running SvelteKit app has.
vi.mock('$app/stores', () => {
	const value = { data: { user: { id: 1, username: 'alice', role: 'user' } } };
	return { page: { subscribe: (run: (v: typeof value) => void) => { run(value); return () => {}; } } };
});
// In a browser: the page opens its live stream and reads whether the Activity Log was left open only there.
vi.mock('$app/environment', () => ({ dev: false, building: false, browser: true, version: 'test' }));
// The page's live stream would open an EventSource, which jsdom has not got: the listeners the page puts on it are kept, to be handed events.
const stream = vi.hoisted(() => ({ listen: null as null | ((source: EventSource) => void), reopened: null as null | (() => void) }));
vi.mock('$lib/live-stream', () => ({
	keepStreamOpen: vi.fn((_url: string, listen: (source: EventSource) => void, reopened: () => void) => {
		stream.listen = listen;
		stream.reopened = reopened;
		return () => {};
	})
}));
// A bare 'svelte' gives the server's runtime, whose onDestroy the page's Toast cannot use in a browser: the client's, by its path.
vi.mock('svelte', async () => {
	const { join } = await import('node:path');
	const { pathToFileURL } = await import('node:url');
	return await import(/* @vite-ignore */ pathToFileURL(join(process.cwd(), 'node_modules/svelte/src/index-client.js')).href);
});

// The browser's `mount`, loaded by its path: a bare 'svelte' gives the server's (see the XP bars' file).
const clientEntry = pathToFileURL(join(process.cwd(), 'node_modules/svelte/src/index-client.js')).href;
const { flushSync, mount, unmount, tick }: typeof Svelte = await import(/* @vite-ignore */ clientEntry);

/** Each request the page sent, as `METHOD url`, with its body read as JSON where it had one. */
let sent: { what: string; body: unknown }[] = [];
let drawn: { component: ReturnType<typeof mount>; target: HTMLElement } | null = null;
/** The archived cards, as `/api/cards/archived` answers them. */
let archived: { id: number; title: string; boardName: string }[] = [];
/** The activity, as `/api/activity` answers it. */
let activity: { id: number; action: string; userName: string; userEmoji: string; detail: string | null; boardName: string; createdAt: string }[] = [];

/** An answer of the test's own for a request, ahead of the ones below (thrown, if it likes, for no answer); undefined for those. */
let answer: ((what: string) => Response | undefined) | null = null;

const json = (body: unknown, status = 200) => new Response(JSON.stringify(body), { status, headers: { 'content-type': 'application/json' } });

/** A card, as All Tasks' load gives it. */
const card = (id: number, title: string, extra: Record<string, unknown> = {}) => ({
	id, columnId: 11, boardId: 3, boardName: 'Website', boardEmoji: '📋', columnTitle: 'To Do', bucket: 'To Do',
	title, description: '', priority: 'low', categoryId: null, dueDate: null, colorTag: null,
	position: 0, createdAt: '2026-10-01 09:00:00', updatedAt: '2026-10-01 09:00:00', pinned: false,
	onHoldNote: null, businessValue: null, summary: null, theme: null, customerImpact: null, closeReason: null, releaseState: null,
	subtasks: [], labelIds: [], assignees: [], subBoards: [], milestoneId: null, archivedAt: null, coverUrl: null,
	...extra
});

/** All Tasks' load: two boards, the second with a Complete column; Plan on Website, Ship on Mobile and blocked by Plan. */
const data = () => ({
	user: { id: 1, username: 'alice', role: 'user' },
	cardTokens: {}, allTokenSummary: null,
	boards: [
		{ id: 3, name: 'Website', emoji: '📋', parentId: null, hiddenAbove: false, filterCategoryId: null },
		{ id: 4, name: 'Mobile', emoji: '📱', parentId: null, hiddenAbove: false, filterCategoryId: null }
	],
	buckets: [
		{ title: 'To Do', cards: [card(7, 'Plan'), card(8, 'Ship', { boardId: 4, boardName: 'Mobile', columnId: 21 })] },
		{ title: 'Complete', cards: [] }
	],
	blockedState: { 8: [{ id: 7, title: 'Plan', columnTitle: 'To Do', boardName: 'Website', boardId: 3, withheld: false }] },
	milestoneNames: {}, categories: [], boardCategories: [], labels: [],
	columns: [
		{ id: 11, boardId: 3, title: 'To Do', position: 0 },
		{ id: 21, boardId: 4, title: 'To Do', position: 0 },
		{ id: 22, boardId: 4, title: 'Complete', position: 1 }
	],
	allUsers: [], totalCards: 2, completedCards: 0, hasMoreCompleted: false, totalCompletedCount: 0, completedLimit: 50
});

beforeEach(() => {
	sent = [];
	stream.listen = null;
	stream.reopened = null;
	navigation.invalidateAll.mockClear();
	answer = null;
	archived = [{ id: 9, title: 'Old idea', boardName: 'Website' }];
	activity = [{ id: 1, action: 'card_created', userName: 'bob', userEmoji: '🐻', detail: 'Plan', boardName: 'Website', createdAt: '2026-10-20 09:00:00' }];
	window.localStorage.clear();
	vi.stubGlobal(
		'fetch',
		vi.fn(async (url: string, init?: RequestInit) => {
			const method = init?.method ?? 'GET';
			sent.push({ what: `${method} ${url}`, body: typeof init?.body === 'string' ? JSON.parse(init.body) : undefined });
			const own = answer?.(`${method} ${url}`);
			if (own) return own;
			if (url === '/api/activity') return json(activity);
			if (url === '/api/cards/archived') return json(archived);
			if (url === '/api/cards/9/restore' && method === 'POST') return json({ success: true });
			if (url === '/api/cards/9?permanent=true' && method === 'DELETE') return json({ success: true });
			if (url === '/api/cards/8' && method === 'PUT') return json({ id: 8, leftMilestone: null });
			// The card's context, which the page reads as the window opens, and the window's own reads.
			if (/^\/api\/cards\/\d+\/context$/.test(url)) return json({ boardUsers: [] });
			if (url.includes('/dependencies')) return json({ blockedBy: [], blocks: [] });
			if (url.includes('/tokens')) return json(null);
			return json([]);
		})
	);
});

afterEach(() => {
	if (drawn) {
		unmount(drawn.component);
		drawn.target.remove();
		drawn = null;
	}
	vi.unstubAllGlobals();
	document.body.innerHTML = '';
	window.localStorage.clear();
	// The toasts are the app's, not the page's: each case starts with none.
	let shown: { id: number }[] = [];
	toasts.subscribe((list) => (shown = list))();
	for (const toast of shown) toasts.dismiss(toast.id);
});

/** Draws the page with the load above, `over` laid over it. */
function draw(over: Record<string, unknown> = {}) {
	const target = document.createElement('div');
	document.body.appendChild(target);
	drawn = { component: mount(AllTasksPage as never, { target, props: { data: { ...data(), ...over } } as never }), target };
	flushSync();
	return target;
}

/** Lets the stand-in answers and what they set off settle. */
async function settle() {
	for (let i = 0; i < 10; i++) {
		await new Promise((resolve) => setTimeout(resolve, 0));
		await tick();
	}
	flushSync();
}

const asked = (what: string) => sent.filter((request) => request.what === what);
const buttonNamed = (within: ParentNode, text: string) =>
	[...within.querySelectorAll('button')].find((button) => button.textContent!.replace(/\s+/g, ' ').trim() === text) as HTMLButtonElement;
const cardTitles = (target: HTMLElement) => [...target.querySelectorAll('.card .card-title')].map((title) => title.textContent!.trim());
const cardNamed = (target: HTMLElement, title: string) =>
	[...target.querySelectorAll<HTMLElement>('.card')].find((each) => each.querySelector('.card-title')!.textContent!.includes(title))!;
const toastsSaid = () => [...document.querySelectorAll('.toast-msg')].map((toast) => toast.textContent!.trim());

/** Opens the header's More menu and picks one of its panels. */
function fromMoreMenu(target: HTMLElement, panel: string) {
	buttonNamed(target, 'More').click();
	flushSync();
	buttonNamed(target.querySelector('.more-dropdown')!, panel).click();
	flushSync();
}

/** What the header's More menu shows ticked, as it opens. */
function ticked(target: HTMLElement) {
	buttonNamed(target, 'More').click();
	flushSync();
	const items = [...target.querySelectorAll('.more-dropdown-item')].filter((item) => item.querySelector('.more-check')).map((item) => item.textContent!.replace('✓', '').trim());
	// A click anywhere on the page closes it again.
	target.querySelector<HTMLElement>('.all-page-wrapper')!.click();
	flushSync();
	return items;
}

/** Hands the page's live stream an event, as the server sends one. */
function streamSends(type: 'update' | 'celebrate', body: unknown) {
	const listeners: Record<string, (e: MessageEvent) => void> = {};
	stream.listen!({ addEventListener: (name: string, run: (e: MessageEvent) => void) => (listeners[name] = run) } as unknown as EventSource);
	listeners[type](new MessageEvent(type, { data: JSON.stringify(body) }));
	flushSync();
}

describe('All Tasks, its components joined up through the page (card 2281, slice C3a-2)', () => {
	it('opens the page’s card window from a card’s face', async () => {
		const target = draw();
		expect(document.querySelector('#card-title')).toBeNull();

		cardNamed(target, 'Plan').click();
		await settle();

		expect(document.querySelector<HTMLInputElement>('#card-title')!.value).toBe('Plan');
		expect(asked('GET /api/cards/7/context')).toHaveLength(1);
	});

	// Card 2282: the open card window reads its comments again when the page's
	// stream says they changed, and after a gap in which it may have missed
	// that: a reconnect, and a return to the tab, each with its own handler here.
	it('tells the open card window to read its comments again for its card’s comment event, a reconnect and a return to the tab, and not for another card’s', async () => {
		const target = draw();
		cardNamed(target, 'Plan').click();
		await settle();
		const commentReads = () => asked('GET /api/cards/7/comments').length;
		expect(commentReads()).toBe(1);
		vi.useFakeTimers({ toFake: ['setTimeout', 'clearTimeout'] });
		try {
			const afterTheWait = async () => {
				await vi.advanceTimersByTimeAsync(300);
				flushSync();
				return commentReads();
			};

			streamSends('update', { type: 'comment', cardId: 8 });
			expect(await afterTheWait()).toBe(1);
			streamSends('update', { type: 'comment', cardId: 7 });
			expect(await afterTheWait()).toBe(2);
			stream.reopened!();
			flushSync();
			expect(await afterTheWait()).toBe(3);
			Object.defineProperty(document, 'visibilityState', { value: 'visible', configurable: true });
			document.dispatchEvent(new Event('visibilitychange'));
			flushSync();
			expect(await afterTheWait()).toBe(4);
		} finally {
			vi.useRealTimers();
		}
	});

	// Card 2337: and its files, once it has read them, for its card's
	// attachment event and the same two gaps, each with its handler here.
	it('tells the open card window to read its files again for its card’s attachment event, a reconnect and a return to the tab, and not for another card’s or a comment', async () => {
		const target = draw();
		cardNamed(target, 'Plan').click();
		await settle();
		buttonNamed(document.body, 'Files').click();
		await settle();
		const fileReads = () => asked('GET /api/cards/7/attachments').length;
		expect(fileReads()).toBe(1);
		vi.useFakeTimers({ toFake: ['setTimeout', 'clearTimeout'] });
		try {
			const afterTheWait = async () => {
				await vi.advanceTimersByTimeAsync(300);
				flushSync();
				return fileReads();
			};

			streamSends('update', { type: 'attachment', cardId: 8 });
			expect(await afterTheWait()).toBe(1);
			streamSends('update', { type: 'comment', cardId: 7 });
			expect(await afterTheWait()).toBe(1);
			streamSends('update', { type: 'attachment', cardId: 7 });
			expect(await afterTheWait()).toBe(2);
			stream.reopened!();
			flushSync();
			expect(await afterTheWait()).toBe(3);
			Object.defineProperty(document, 'visibilityState', { value: 'visible', configurable: true });
			document.dispatchEvent(new Event('visibilitychange'));
			flushSync();
			expect(await afterTheWait()).toBe(4);
		} finally {
			vi.useRealTimers();
		}
	});

	it('opens the Move window from a card’s Move button, without its card window, and the move reaches its request', async () => {
		const target = draw();
		expect(target.querySelector('.move-modal')).toBeNull();

		cardNamed(target, 'Ship').querySelector<HTMLButtonElement>('.move-btn')!.click();
		flushSync();

		const modal = target.querySelector('.move-modal')!;
		expect(modal.querySelector('h3')!.textContent).toBe('Move "Ship"');
		expect(document.querySelector('#card-title')).toBeNull();
		// The card's own board and column, chosen as it opens; Move is offered once a column is.
		expect(modal.querySelector<HTMLSelectElement>('#move-board')!.value).toBe('4');
		const column = modal.querySelector<HTMLSelectElement>('#move-col')!;
		column.value = [...column.options].find((option) => option.textContent === 'Complete')!.value;
		column.dispatchEvent(new Event('change', { bubbles: true }));
		flushSync();
		buttonNamed(modal, 'Move Card').click();
		await settle();

		expect(asked('PUT /api/cards/8').map((request) => request.body)).toEqual([{ columnId: 22, boardId: 4 }]);
		expect(target.querySelector('.move-modal')).toBeNull();
		expect(navigation.invalidateAll).toHaveBeenCalledTimes(1);
	});

	it('opens and closes the Activity Log from the More menu, reads it as it first opens, and keeps it while it is shut', async () => {
		const target = draw();
		expect(target.querySelector('.activity-panel')).toBeNull();

		fromMoreMenu(target, '📋 Activity Log');
		await settle();

		const panel = target.querySelector('.activity-panel')!;
		expect(panel.querySelector('h3')!.textContent!.trim()).toBe('Activity');
		expect(panel.querySelector('.activity-action-line')!.textContent!.replace(/\s+/g, ' ').trim()).toBe('bob Created card');
		expect(asked('GET /api/activity')).toHaveLength(1);
		expect(window.localStorage.getItem('df-activity-open')).toBe('true');
		expect(ticked(target)).toEqual(['📋 Activity Log']);

		panel.querySelector<HTMLButtonElement>('button[title="Close"]')!.click();
		flushSync();
		expect(target.querySelector('.activity-panel')).toBeNull();
		expect(ticked(target)).toEqual([]);

		// Opened again: what was read is still there, and is not read again.
		fromMoreMenu(target, '📋 Activity Log');
		await settle();
		expect(target.querySelector('.activity-item')).not.toBeNull();
		expect(asked('GET /api/activity')).toHaveLength(1);
	});

	it('opens the Activity Log as the page opens when it was left open, and reads it', async () => {
		window.localStorage.setItem('df-activity-open', 'true');
		const target = draw();
		await settle();

		expect(target.querySelector('.activity-panel')).not.toBeNull();
		expect(asked('GET /api/activity')).toHaveLength(1);
		expect(target.querySelector('.activity-item')).not.toBeNull();
		// Read as a first read: what was there before is not marked new.
		expect(target.querySelector('.activity-new')).toBeNull();
	});

	it('opens and closes Archived Cards from the More menu, reads it as it first opens, restores a card, and keeps the list while it is shut', async () => {
		const target = draw();
		fromMoreMenu(target, '🗄️ Archived Cards');
		await settle();

		const panel = target.querySelector('.activity-panel')!;
		expect(panel.querySelector('h3')!.textContent!.trim()).toBe('🗄️ Archived Cards');
		expect(panel.querySelector('.archive-card-title')!.textContent).toBe('Old idea');
		expect(asked('GET /api/cards/archived')).toHaveLength(1);
		expect(ticked(target)).toEqual(['🗄️ Archived Cards']);

		panel.querySelector<HTMLButtonElement>('button[title="Close"]')!.click();
		flushSync();
		expect(target.querySelector('.activity-panel')).toBeNull();
		expect(ticked(target)).toEqual([]);
		fromMoreMenu(target, '🗄️ Archived Cards');
		await settle();
		expect(asked('GET /api/cards/archived')).toHaveLength(1);

		buttonNamed(target.querySelector('.activity-panel')!, '↩️ Restore').click();
		await settle();
		expect(asked('POST /api/cards/9/restore')).toHaveLength(1);
		expect(target.querySelector('.archive-card-item')).toBeNull();
		expect(toastsSaid()).toContain('Card restored');
		expect(navigation.invalidateAll).toHaveBeenCalledTimes(1);
	});

	it('asks through the page’s confirm dialog before deleting an archived card for good', async () => {
		const target = draw();
		fromMoreMenu(target, '🗄️ Archived Cards');
		await settle();

		target.querySelector<HTMLButtonElement>('.activity-panel button[title="Delete permanently"]')!.click();
		flushSync();
		const confirm = document.querySelector('.confirm-modal')!;
		expect(confirm.textContent).toContain('Delete Permanently');
		expect(asked('DELETE /api/cards/9?permanent=true')).toHaveLength(0);

		buttonNamed(confirm, 'Delete Forever').click();
		await settle();
		expect(asked('DELETE /api/cards/9?permanent=true')).toHaveLength(1);
		expect(document.querySelector('.confirm-modal')).toBeNull();
		expect(target.querySelector('.archive-card-item')).toBeNull();
		expect(toastsSaid()).toContain('Card permanently deleted');
	});

	// Card 2317: each panel said there was nothing when its read failed: no
	// answer (in Archived Cards an unhandled rejection too), and a refusal dropped.
	describe('Archived Cards and the Activity Log, when their read fails (card 2317)', () => {
		const PANELS = [
			{ panel: '🗄️ Archived Cards', url: '/api/cards/archived', noun: 'The archived cards', none: 'No archived cards' },
			{ panel: '📋 Activity Log', url: '/api/activity', noun: 'The activity', none: 'No activity yet' }
		];
		const FAILURES: [how: string, give: () => Response, words: (noun: string) => string][] = [
			[
				'gets no answer',
				() => {
					throw new TypeError('Failed to fetch');
				},
				(noun) => `No answer from the server. ${noun} could not be loaded.`
			],
			['is refused', () => json({ message: 'Database is locked' }, 503), () => 'Database is locked'],
			['is answered with what is not JSON', () => new Response('<html>Bad gateway</html>', { status: 200 }), (noun) => `The server's answer could not be read. ${noun} could not be loaded.`]
		];

		it.each(PANELS.flatMap((p) => FAILURES.map(([how, give, words]) => [p.panel, how, p, give, words] as const)))(
			'%s says so when its read %s, in place of saying there is nothing',
			async (_panel, _how, p, give, words) => {
				answer = (what) => (what === `GET ${p.url}` ? give() : undefined);
				const target = draw();
				fromMoreMenu(target, p.panel);
				await settle();

				const panel = target.querySelector('.activity-panel')!;
				expect(panel.querySelector('[role="alert"]')!.textContent!.trim()).toBe(words(p.noun));
				expect(panel.textContent).not.toContain(p.none);
			}
		);

		it.each(PANELS)('$panel takes back what it said once a read is answered', async (p) => {
			let failing = true;
			answer = (what) => {
				if (what === `GET ${p.url}` && failing) throw new TypeError('Failed to fetch');
				return undefined;
			};
			const target = draw();
			fromMoreMenu(target, p.panel);
			await settle();
			expect(target.querySelector('.activity-panel [role="alert"]')).not.toBeNull();

			failing = false;
			target.querySelector<HTMLButtonElement>('.activity-panel button[title="Refresh"]')!.click();
			await settle();

			expect(target.querySelector('.activity-panel [role="alert"]')).toBeNull();
			expect(target.querySelectorAll('.activity-panel .archive-card-item, .activity-panel .activity-item')).toHaveLength(1);
		});

		it.each(PANELS)('$panel keeps the list it read under what it says of a Refresh that fails (the card 2317 review)', async (p) => {
			let failing = false;
			answer = (what) => {
				if (what === `GET ${p.url}` && failing) throw new TypeError('Failed to fetch');
				return undefined;
			};
			const target = draw();
			fromMoreMenu(target, p.panel);
			await settle();
			const rows = () => target.querySelectorAll('.activity-panel .archive-card-item, .activity-panel .activity-item');
			expect(rows()).toHaveLength(1);

			failing = true;
			target.querySelector<HTMLButtonElement>('.activity-panel button[title="Refresh"]')!.click();
			await settle();

			expect(target.querySelector('.activity-panel [role="alert"]')!.textContent!.trim()).toBe(`No answer from the server. ${p.noun} could not be loaded.`);
			expect(rows()).toHaveLength(1);
		});
	});

	// Card 2356: what was seen was seeded by the first read sent, so when it failed every item of the next read pulsed as new.
	it('marks nothing new in the Activity Log on the first read answered after a failed one, and what comes after that as new', async () => {
		let failing = true;
		answer = (what) => {
			if (what === 'GET /api/activity' && failing) throw new TypeError('Failed to fetch');
			return undefined;
		};
		const target = draw();
		fromMoreMenu(target, '📋 Activity Log');
		await settle();
		expect(target.querySelector('.activity-panel [role="alert"]')).not.toBeNull();

		failing = false;
		const refresh = () => target.querySelector<HTMLButtonElement>('.activity-panel button[title="Refresh"]')!.click();
		refresh();
		await settle();
		expect(target.querySelectorAll('.activity-panel .activity-item')).toHaveLength(1);
		expect(target.querySelector('.activity-new')).toBeNull();

		activity = [{ id: 2, action: 'card_moved', userName: 'eve', userEmoji: '🦊', detail: 'Plan', boardName: 'Website', createdAt: '2026-10-20 09:05:00' }, ...activity];
		refresh();
		await settle();
		expect([...target.querySelectorAll('.activity-panel .activity-item')].map((item) => item.classList.contains('activity-new'))).toEqual([true, false]);
	});

	it('closes the header’s More menu on a click anywhere on the page', () => {
		const target = draw();
		buttonNamed(target, 'More').click();
		flushSync();
		expect(target.querySelector('.more-dropdown')).not.toBeNull();

		target.querySelector<HTMLElement>('.kanban-scroll')!.click();
		flushSync();
		expect(target.querySelector('.more-dropdown')).toBeNull();
	});

	it('opens and closes Statistics from the More menu, drawn by the page', async () => {
		const target = draw();
		const heading = () => [...target.querySelectorAll('h3')].find((h3) => h3.textContent!.trim() === '📊 Board Stats');
		expect(heading()).toBeUndefined();

		fromMoreMenu(target, '📊 Statistics');
		await settle();
		expect(heading()).not.toBeUndefined();
		expect(ticked(target)).toEqual(['📊 Statistics']);

		// Picked again, ticked as it is: closed.
		fromMoreMenu(target, '📊 Statistics ✓');
		await settle();
		expect(heading()).toBeUndefined();
	});

	it('filters the page’s cards by the header’s search, board filter and Hide blocked', () => {
		const target = draw();
		expect(cardTitles(target)).toEqual(['#7 Plan', '#8 Ship']);

		const search = target.querySelector<HTMLInputElement>('.search-input')!;
		search.value = 'ship';
		search.dispatchEvent(new Event('input', { bubbles: true }));
		flushSync();
		expect(cardTitles(target)).toEqual(['#8 Ship']);
		search.value = '';
		search.dispatchEvent(new Event('input', { bubbles: true }));
		flushSync();

		const filter = target.querySelector<HTMLSelectElement>('.board-filter')!;
		filter.value = '3';
		filter.dispatchEvent(new Event('change', { bubbles: true }));
		flushSync();
		expect(cardTitles(target)).toEqual(['#7 Plan']);
		// The links that carry the filter follow it.
		expect(target.querySelector<HTMLAnchorElement>('a[href^="/plan"]')!.getAttribute('href')).toBe('/plan?board=3');
		filter.value = 'all';
		filter.dispatchEvent(new Event('change', { bubbles: true }));
		flushSync();

		buttonNamed(target, 'Hide blocked').click();
		flushSync();
		expect(cardTitles(target)).toEqual(['#7 Plan']);
	});

	it('shows a live event of the page’s stream in the live toasts, a completion in the fireworks, and reads the open Activity Log again', async () => {
		const target = draw();
		fromMoreMenu(target, '📋 Activity Log');
		await settle();
		expect(asked('GET /api/activity')).toHaveLength(1);

		streamSends('update', { action: 'created', cardTitle: 'New one', userName: 'bob', userEmoji: '🐻' });
		const toast = document.querySelector('.live-toast')!;
		expect(toast.querySelector('.live-toast-body')!.textContent!.replace(/\s+/g, ' ').trim()).toBe('bob created "New one"');

		// The page reads itself and the open Activity Log again a moment after.
		await new Promise((resolve) => setTimeout(resolve, 300));
		await settle();
		expect(navigation.invalidateAll).toHaveBeenCalled();
		expect(asked('GET /api/activity')).toHaveLength(2);

		streamSends('celebrate', { cardTitle: 'Plan', userName: 'bob', userEmoji: '🐻', xpGained: 10 });
		await new Promise((resolve) => setTimeout(resolve, 50));
		flushSync();
		expect(document.querySelector('.firework-card-title')!.textContent).toBe('"Plan"');
	});

	// Card 2281, slice C3b: the re-read a live event sets off is the burst's,
	// not the event's (`src/lib/board/refresh-schedule.ts`); its notice is still
	// the event's own.
	describe('the re-read after live events (card 2281, slice C3b)', () => {
		/** What was read again since the Activity Log's first read: the page, and the Activity Log. */
		const reReads = () => ({ page: navigation.invalidateAll.mock.calls.length, activity: asked('GET /api/activity').length - 1 });
		const newestToast = () => document.querySelector('.live-toast .live-toast-body')!.textContent!.replace(/\s+/g, ' ').trim();

		async function withTheActivityLogOpen() {
			const target = draw();
			fromMoreMenu(target, '📋 Activity Log');
			await settle();
			expect(reReads()).toEqual({ page: 0, activity: 0 });
			// The schedule's waits run on the page's timers and its clock.
			vi.useFakeTimers({ toFake: ['setTimeout', 'clearTimeout', 'Date'] });
		}

		afterEach(() => {
			vi.useRealTimers();
		});

		it('shows each of 20 events within a second, and reads the page and the Activity Log again at most twice', async () => {
			await withTheActivityLogOpen();

			for (let n = 1; n <= 20; n++) {
				streamSends('update', { action: 'created', cardTitle: `Card ${n}`, userName: 'bob', userEmoji: '🐻' });
				expect(newestToast()).toBe(`bob created "Card ${n}"`);
				await vi.advanceTimersByTimeAsync(45);
			}
			await vi.advanceTimersByTimeAsync(2000);

			const { page, activity } = reReads();
			expect(page).toBeGreaterThanOrEqual(1);
			expect(page).toBeLessThanOrEqual(2);
			expect(activity).toBe(page);
		});

		it('reads the page and the Activity Log again about 250 ms after a lone event', async () => {
			await withTheActivityLogOpen();

			streamSends('update', { action: 'moved', cardTitle: 'Plan', userName: 'bob', userEmoji: '🐻', fromColumn: 'To Do', toColumn: 'Doing' });
			expect(newestToast()).toContain('Plan');
			await vi.advanceTimersByTimeAsync(200);
			expect(reReads()).toEqual({ page: 0, activity: 0 });

			await vi.advanceTimersByTimeAsync(60);
			expect(reReads()).toEqual({ page: 1, activity: 1 });
			await vi.advanceTimersByTimeAsync(2000);
			expect(reReads()).toEqual({ page: 1, activity: 1 });
		});
	});

	it('plays two completions that arrive together one after the other, in order, the second once the first has played', () => {
		draw();
		vi.useFakeTimers({ toFake: ['setTimeout', 'clearTimeout', 'requestAnimationFrame', 'cancelAnimationFrame'] });
		try {
			const shown = () => document.querySelector('.firework-card-title')?.textContent ?? null;
			streamSends('celebrate', { cardTitle: 'First', userName: 'bob', userEmoji: '🐻', xpGained: 10 });
			streamSends('celebrate', { cardTitle: 'Second', userName: 'eve', userEmoji: '🦊', xpGained: 10 });

			// The first, on the next frame, for 3 seconds.
			vi.advanceTimersByTime(20);
			flushSync();
			expect(shown()).toBe('"First"');
			vi.advanceTimersByTime(2900);
			flushSync();
			expect(shown()).toBe('"First"');
			// Then nothing for 300 ms.
			vi.advanceTimersByTime(200);
			flushSync();
			expect(shown()).toBeNull();
			// Then the second, about 3.3 seconds after the first began.
			vi.advanceTimersByTime(250);
			flushSync();
			expect(shown()).toBe('"Second"');
			vi.advanceTimersByTime(3400);
			flushSync();
			expect(shown()).toBeNull();
		} finally {
			vi.useRealTimers();
		}
	});

	// Card 2300: Load more wrote the address with the browser's own
	// `history.replaceState({}, …)`, which threw away SvelteKit's state in the
	// history entry, and then re-read the page, which SvelteKit does at the
	// address it holds, not the browser's: the load got the old limit, and the
	// list stayed as it was. Now it is a navigation in place of this entry,
	// which runs the load at the new address and keeps the state.
	it('loads 50 more completed cards with a navigation in place of this history entry, never the browser’s history (card 2300)', async () => {
		navigation.goto.mockClear();
		const browsers = vi.spyOn(window.history, 'replaceState');
		const target = draw({ hasMoreCompleted: true, totalCompletedCount: 120, completedLimit: 50 });

		target.querySelector<HTMLButtonElement>('#load-more-completed')!.click();
		await settle();

		expect(navigation.goto).toHaveBeenCalledTimes(1);
		const [to, how] = navigation.goto.mock.calls[0] as unknown as [URL, Record<string, unknown>];
		expect(new URL(String(to)).searchParams.get('completedLimit')).toBe('100');
		expect(how).toEqual({ replaceState: true, keepFocus: true, noScroll: true });
		expect(browsers).not.toHaveBeenCalled();
		// The navigation runs the load: nothing is re-read on top of it.
		expect(navigation.invalidateAll).not.toHaveBeenCalled();
		// And the button is pressed again once it is done.
		expect(target.querySelector<HTMLButtonElement>('#load-more-completed')!.disabled).toBe(false);
	});
});

// Card 2356: each read that found new items started a 30-second timer to end their pulse, which nothing ended.
describe('the Activity Log’s pulse timers, the panel mounted alone (card 2356)', () => {
	const later = { id: 2, action: 'card_moved', userName: 'eve', userEmoji: '🦊', detail: 'Plan', boardName: 'Website', createdAt: '2026-10-20 09:05:00' };

	/** Mounts the panel open, on fake timers made before it, and reads its list once as it first opens. */
	async function drawPanel() {
		vi.useFakeTimers({ toFake: ['setTimeout', 'clearTimeout'] });
		const target = document.createElement('div');
		document.body.appendChild(target);
		const panel = mount(TasksActivityPanel, { target, props: { activityOpen: true } }) as unknown as { fetchActivity: (initial?: boolean) => Promise<void> };
		flushSync();
		let mounted = true;
		const leave = () => {
			if (!mounted) return;
			mounted = false;
			unmount(panel as never);
			target.remove();
		};
		// Left, then the real timers back, however the case ends: a failed assertion leaves no pulse pending.
		onTestFinished(() => {
			leave();
			vi.useRealTimers();
		});
		await panel.fetchActivity(true);
		flushSync();
		return { panel, target, leave };
	}

	it('ends the pulse timer of a read that found a new item as the panel goes', async () => {
		const { panel, target, leave } = await drawPanel();
		expect(vi.getTimerCount()).toBe(0);
		activity = [later, ...activity];
		await panel.fetchActivity();
		flushSync();
		expect(target.querySelectorAll('.activity-new')).toHaveLength(1);
		expect(vi.getTimerCount()).toBe(1);

		leave();
		expect(vi.getTimerCount()).toBe(0);
	});

	it('starts no pulse timer for a read answered after the panel has gone', async () => {
		const { panel, leave } = await drawPanel();
		let release!: () => void;
		vi.stubGlobal('fetch', vi.fn(() => new Promise<Response>((resolve) => (release = () => resolve(json([later, ...activity]))))));
		const reading = panel.fetchActivity();
		leave();
		release();
		await reading;
		expect(vi.getTimerCount()).toBe(0);
	});
});
