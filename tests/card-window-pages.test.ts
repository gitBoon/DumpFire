// @vitest-environment jsdom
/**
 * The card window of All Tasks, All To Do and the plan page, saved through
 * the board page's controller (card 2281, slice C3a-1 of card 2012's part
 * C), mounted with Svelte's client runtime as the dashboard's file does, so
 * that the page, its window and the controller are run by Svelte itself.
 * For each page: a save sends only the field changed in the window (and the
 * card's board), so a change someone else made to another field meanwhile
 * is not sent back; a save with nothing changed sends nothing and closes the
 * window, saying nothing; a refused save says the server's words, keeps the
 * window open with what was typed, and leaves the page's list showing the
 * card as it was. On All Tasks the change shows on the card's face while it
 * is out. `fetch`, the pages' live streams and `invalidateAll` are
 * stand-ins; what each request sent is kept.
 *
 * The adapter the three pages share is run on its own in
 * `tests/page-card-window.test.ts`; the source pins of the same code are in
 * `tests/page-failures.test.ts`.
 */
import { join } from 'node:path';
import { pathToFileURL } from 'node:url';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import type * as Svelte from 'svelte';

import AllTasksPage from '../src/routes/all/+page.svelte';
import TodoPage from '../src/routes/todo/+page.svelte';
import PlanPage from '../src/routes/plan/[id]/+page.svelte';
import { toasts } from '$lib/stores/toast';

// The page's data is read again after a save; here it is only counted.
const navigation = vi.hoisted(() => ({ invalidateAll: vi.fn(async () => {}), goto: vi.fn(async () => {}) }));
vi.mock('$app/navigation', () => ({
	invalidateAll: navigation.invalidateAll,
	goto: navigation.goto,
	afterNavigate: vi.fn(),
	beforeNavigate: vi.fn(),
	onNavigate: vi.fn()
}));
// The window reads who is signed in from the page store, which only a running SvelteKit app has.
vi.mock('$app/stores', () => {
	const value = { data: { user: { id: 1, username: 'alice', role: 'user' } } };
	return { page: { subscribe: (run: (v: typeof value) => void) => { run(value); return () => {}; } } };
});
// All To Do reads its filters from the address.
vi.mock('$app/state', () => ({ page: { url: new URL('http://localhost/todo') } }));
// The pages' live streams would open an EventSource, which jsdom has not got.
vi.mock('$lib/live-stream', () => ({ keepStreamOpen: vi.fn(() => () => {}) }));
vi.mock('$lib/live-refresh', () => ({ connectLiveRefresh: vi.fn(() => () => {}) }));
// A bare 'svelte' gives the server's runtime, whose onDestroy the page's Toast cannot use in a browser: the client's, by its path.
vi.mock('svelte', async () => {
	const { join } = await import('node:path');
	const { pathToFileURL } = await import('node:url');
	return await import(/* @vite-ignore */ pathToFileURL(join(process.cwd(), 'node_modules/svelte/src/index-client.js')).href);
});

// The browser's `mount`, loaded by its path: a bare 'svelte' gives the server's (see the XP bars' file).
const clientEntry = pathToFileURL(join(process.cwd(), 'node_modules/svelte/src/index-client.js')).href;
const { flushSync, mount, unmount, tick }: typeof Svelte = await import(/* @vite-ignore */ clientEntry);
// The proxy SvelteKit puts a page's props in, so that a new `data` is drawn as a re-read is.
// Named through a variable: the package declares no types for its internal entry.
const internalEntry = 'svelte/internal/client';
const { proxy } = (await import(/* @vite-ignore */ internalEntry)) as { proxy: <T>(value: T) => T };

/** Each write the page sent, as `METHOD url`, with its body read as JSON. */
let sent: { what: string; body: unknown }[] = [];
let drawn: { component: ReturnType<typeof mount>; target: HTMLElement } | null = null;
/** How the next save of the card is answered; a promise holds it until the test lets it go. */
let answerSave: () => Response | Promise<Response>;
/** How an archive of the card is answered. */
let answerArchive: () => Response | Promise<Response>;
/** How each card's context is answered, by card id: at once unless a case holds it. */
let answerContext: Record<number, () => Response | Promise<Response>>;

const json = (body: unknown, status = 200) => new Response(JSON.stringify(body), { status, headers: { 'content-type': 'application/json' } });

/** The card, as the pages' loads give it. */
const row = {
	id: 7, columnId: 11, boardId: 3, boardName: 'Website', boardEmoji: '📋', columnTitle: 'To Do', bucket: 'To Do',
	title: 'Plan', description: 'Old notes', priority: 'low', categoryId: null, dueDate: null, colorTag: null,
	position: 0, createdAt: '2026-10-01 09:00:00', updatedAt: '2026-10-01 09:00:00', pinned: false,
	onHoldNote: null, businessValue: null, summary: null, theme: null, customerImpact: null, closeReason: null, releaseState: null,
	subtasks: [], labelIds: [], assignees: [], subBoards: [], milestoneId: null, archivedAt: null, coverUrl: null
};
/** A second card, on the plan page's critical path after the first. */
const second = { ...row, id: 8, title: 'Ship', description: 'Ship notes', position: 1 };

const context = (card: typeof row) => json({ card: { ...card }, boardId: 3, categories: [], labels: [], boardUsers: [], milestones: [] });

beforeEach(() => {
	sent = [];
	navigation.invalidateAll.mockClear();
	answerSave = () => json({ ...row });
	answerArchive = () => json({ success: true });
	answerContext = { 7: () => context(row), 8: () => context(second) };
	vi.stubGlobal(
		'fetch',
		vi.fn(async (url: string, init?: RequestInit) => {
			const method = init?.method ?? 'GET';
			if (method !== 'GET') {
				sent.push({ what: `${method} ${url}`, body: init?.body ? JSON.parse(String(init.body)) : null });
				if (method === 'PUT' && url === '/api/cards/7') return answerSave();
				if (method === 'DELETE' && url === '/api/cards/7') return answerArchive();
				return json({});
			}
			// The card's context, which the pages read as the window opens.
			const contextOf = /^\/api\/cards\/(\d+)\/context$/.exec(url);
			if (contextOf) return answerContext[Number(contextOf[1])]();
			// The window's own reads on open: empty lists.
			if (url.includes('/dependencies')) return json({ blockedBy: [], blocks: [] });
			if (url.includes('/tokens')) return json(null);
			// The plan page's burndown, which is not drawn here.
			if (url.startsWith('/api/burndown')) return json({ message: 'Not drawn here' }, 404);
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
	// The toasts are the app's, not the page's: each case starts with none.
	let shown: { id: number }[] = [];
	toasts.subscribe((list) => (shown = list))();
	for (const toast of shown) toasts.dismiss(toast.id);
});

/** Lets the stand-in answers and what they set off settle. */
async function settle() {
	for (let i = 0; i < 10; i++) {
		await new Promise((resolve) => setTimeout(resolve, 0));
		await tick();
	}
	flushSync();
}

function draw(component: unknown, data: unknown) {
	const target = document.createElement('div');
	document.body.appendChild(target);
	drawn = { component: mount(component as never, { target, props: { data } as never }), target };
	flushSync();
	return target;
}

/**
 * Mounts the page with its props in a Svelte proxy, as SvelteKit hands them,
 * and gives them back: setting `data` is a re-read of the page.
 */
function drawLive(component: unknown, data: unknown) {
	const props = proxy({ data });
	const target = document.createElement('div');
	document.body.appendChild(target);
	drawn = { component: mount(component as never, { target, props: props as never }), target };
	flushSync();
	return props;
}

const titleBox = () => document.querySelector<HTMLInputElement>('#card-title');
const toastsSaid = () => [...document.querySelectorAll('.toast-msg')].map((toast) => toast.textContent!.trim());

/** Types `text` into a box, as `bind:value` hears it. */
function type(el: HTMLInputElement | HTMLTextAreaElement, text: string) {
	el.value = text;
	el.dispatchEvent(new Event('input', { bubbles: true }));
	flushSync();
}

async function save() {
	document.querySelector<HTMLButtonElement>('.btn-create')!.click();
	await settle();
}

const writes = () => sent.filter((s) => s.what === 'PUT /api/cards/7');

/** All Tasks' load, with the one card in its To Do bucket, as `card` has it. */
const allTasksData = (card: typeof row = row) => ({
	user: { id: 1, username: 'alice', role: 'user' },
	cardTokens: {}, allTokenSummary: null,
	boards: [{ id: 3, name: 'Website', emoji: '📋', parentCardId: null, parentBoardId: null, categoryId: null }],
	buckets: [{ title: 'To Do', cards: [{ ...card }] }, { title: 'Complete', cards: [] }],
	blockedState: {}, milestoneNames: {}, categories: [], boardCategories: [], labels: [],
	columns: [{ id: 11, boardId: 3, title: 'To Do', position: 0 }],
	allUsers: [], totalCards: 1, completedCards: 0, hasMoreCompleted: false, totalCompletedCount: 0, completedLimit: 50
});

/** All To Do's load, with the one card, as `card` has it. */
const todoData = (card: typeof row = row) => ({
	user: { id: 1, username: 'alice', role: 'user' },
	boards: [{ id: 3, name: 'Website', emoji: '📋', parentCardId: null, parentBoardId: null, categoryId: null, hasTodo: true }],
	cards: [{ ...card }],
	blockedState: {}, milestoneNames: {}, categories: [], boardCategories: [], labels: [], allUsers: []
});

/** A card as the plan's graph has it. */
const node = (card: typeof row, layer: number) => ({
	kind: 'card', id: card.id, title: card.title, priority: card.priority, columnTitle: 'To Do', boardId: 3, boardName: 'Website', isComplete: false,
	withheld: false, layer, blockedBy: [], blocks: [], openBlockers: [], downstreamCount: 0, onCriticalPath: true
});

/** The plan page's load: a milestone whose cards are its critical path, the first card alone unless both are asked for. */
const planData = (cards: (typeof row)[] = [row]) => ({
	user: { id: 1, username: 'alice', role: 'user' },
	subtasks: {},
	summary: {
		milestone: { id: 4, name: 'Launch', status: 'open', targetDate: null, boardId: 3 },
		progress: { total: cards.length, done: 0, percent: 0, openSubtasks: 0, totalSubtasks: 0, byColumn: [], boards: [] },
		nextActionable: [], blocked: [], criticalPathNodes: cards.map((card) => ({ kind: 'card', id: card.id })),
		graph: { nodes: cards.map(node), edges: [], unordered: [] }
	}
});

/**
 * `shown` is the card as the page's list draws it. The plan page has none of
 * its own to show it in (its tables are the plan's, read again as the window
 * closes), so what it shows is held through the window alone.
 */
type Page = { name: string; component: unknown; data: (card?: typeof row) => unknown; open: () => void; shown: (() => string) | null };

const PAGES: Page[] = [
	{
		name: 'All Tasks',
		component: AllTasksPage,
		data: allTasksData,
		open: () => document.querySelector<HTMLElement>('.card')!.click(),
		shown: () => document.querySelector('.card .card-title')!.textContent!.replace(/\s+/g, ' ').trim()
	},
	{
		name: 'All To Do',
		component: TodoPage,
		data: todoData,
		open: () => document.querySelector<HTMLElement>('.row-title')!.click(),
		shown: () => document.querySelector('.row-title')!.textContent!.replace(/\s+/g, ' ').trim()
	},
	{
		name: 'the plan page',
		component: PlanPage,
		data: () => planData(),
		open: () => document.querySelector<HTMLElement>('.chain-card')!.click(),
		shown: null
	}
];

describe.each(PAGES)('the card window on $name saves through the controller (card 2281, slice C3a-1)', (page) => {
	async function opened() {
		draw(page.component, page.data());
		page.open();
		await settle();
		expect(titleBox(), 'the window opened').not.toBeNull();
	}

	it('sends only the field changed in the window, with the card’s board', async () => {
		await opened();
		type(titleBox()!, 'Plan the launch');
		await save();

		expect(writes()).toEqual([{ what: 'PUT /api/cards/7', body: { title: 'Plan the launch', boardId: 3 } }]);
		expect(titleBox()).toBeNull();
		expect(toastsSaid()).toContain('Card updated');
	});

	it('sends nothing for a save with nothing changed, closes the window and says nothing', async () => {
		await opened();
		await save();

		expect(writes()).toEqual([]);
		expect(titleBox()).toBeNull();
		expect(toastsSaid()).toEqual([]);
	});

	it('says the server’s words for a refused save, keeps the window open with what was typed, and the page shows the card as it was', async () => {
		answerSave = () => json({ message: 'Viewers cannot change cards' }, 403);
		await opened();
		type(titleBox()!, 'Plan the launch');
		await save();

		expect(writes()).toEqual([{ what: 'PUT /api/cards/7', body: { title: 'Plan the launch', boardId: 3 } }]);
		expect(toastsSaid()).toEqual(['Viewers cannot change cards']);
		expect(toastsSaid()).not.toContain('Card updated');
		expect(titleBox()?.value).toBe('Plan the launch');
		if (page.shown) expect(page.shown()).toBe('#7 Plan');
	});

	it('says that no answer came for a save that got none, and keeps the window open', async () => {
		answerSave = () => {
			throw new TypeError('Failed to fetch');
		};
		await opened();
		type(titleBox()!, 'Plan the launch');
		await save();

		expect(toastsSaid()).toEqual(['No answer from the server. The card may not have been saved.']);
		expect(titleBox()?.value).toBe('Plan the launch');
		if (page.shown) expect(page.shown()).toBe('#7 Plan');
	});
});

describe('All Tasks shows a save on the card at once, and takes it back alone when refused (card 2281, slice C3a-1)', () => {
	it('shows the new title on the card’s face while the save is out, and the old one once it is refused', async () => {
		let refuse: (res: Response) => void = () => {};
		answerSave = () => new Promise<Response>((resolve) => (refuse = resolve));
		draw(AllTasksPage, allTasksData());
		document.querySelector<HTMLElement>('.card')!.click();
		await settle();
		type(titleBox()!, 'Plan the launch');
		document.querySelector<HTMLButtonElement>('.btn-create')!.click();
		await settle();

		expect(document.querySelector('.card .card-title')!.textContent!.replace(/\s+/g, ' ').trim()).toBe('#7 Plan the launch');
		refuse(json({ message: 'Viewers cannot change cards' }, 403));
		await settle();
		expect(document.querySelector('.card .card-title')!.textContent!.replace(/\s+/g, ' ').trim()).toBe('#7 Plan');
		expect(titleBox()?.value).toBe('Plan the launch');
	});
});

// Milestone 22, the S3 review's E6: a card in an Options column is an idea,
// and archiving it discards it, which All Tasks says before and after.
describe('archiving an idea from All Tasks’ card window', () => {
	it('asks with "This idea will be recorded as discarded." and says it was discarded', async () => {
		const data = allTasksData();
		draw(AllTasksPage, { ...data, columns: [{ ...data.columns[0], title: 'Ideas', role: 'options' }] });
		document.querySelector<HTMLElement>('.card')!.click();
		await settle();
		document.querySelector<HTMLButtonElement>('.btn-danger')!.click();
		flushSync();
		expect(document.querySelector('.confirm-message')!.textContent).toBe(
			'Archive "Plan"? It is taken off the board and nothing on it is deleted. It can be restored from Archived Cards, in the More menu. This idea will be recorded as discarded.'
		);
		document.querySelector<HTMLButtonElement>('.confirm-actions button:last-child')!.click();
		await settle();

		expect(sent).toEqual([{ what: 'DELETE /api/cards/7', body: { boardId: 3 } }]);
		expect(toastsSaid()).toEqual(['Discarded "Plan". Restore it from Archived Cards.']);
	});
});

describe.each(PAGES.slice(0, 2))('archiving from the card window on $name goes through the controller (card 2281, slice C3a-1)', (page) => {
	async function archive() {
		draw(page.component, page.data());
		page.open();
		await settle();
		document.querySelector<HTMLButtonElement>('.btn-danger')!.click();
		flushSync();
		expect(document.querySelector('.confirm-message')!.textContent).toBe(
			'Archive "Plan"? It is taken off the board and nothing on it is deleted. It can be restored from Archived Cards, in the More menu.'
		);
		document.querySelector<HTMLButtonElement>('.confirm-actions button:last-child')!.click();
		await settle();
	}

	it('asks first, archives the card on its board, closes the window, says so and reads the page again', async () => {
		await archive();

		expect(sent).toEqual([{ what: 'DELETE /api/cards/7', body: { boardId: 3 } }]);
		expect(titleBox()).toBeNull();
		expect(toastsSaid()).toEqual(['Card archived. Restore it from Archived Cards.']);
		expect(navigation.invalidateAll).toHaveBeenCalled();
	});

	it('says the server’s words for a refused archive and keeps the window open', async () => {
		answerArchive = () => json({ message: 'Viewers cannot archive cards' }, 403);
		await archive();

		expect(sent).toEqual([{ what: 'DELETE /api/cards/7', body: { boardId: 3 } }]);
		expect(titleBox()).not.toBeNull();
		expect(toastsSaid()).toEqual(['Viewers cannot archive cards']);
		expect(page.shown!()).toBe('#7 Plan');
	});
});

/** Leaves the box that has the focus, so that the window's follow may set it (the B5d review). */
function leave(el: HTMLElement) {
	el.blur();
	el.dispatchEvent(new FocusEvent('focusout', { bubbles: true }));
	flushSync();
}

const descriptionBox = () => document.querySelector<HTMLTextAreaElement>('#card-desc');

// The C3a-1 review: the page's list is read again while the window is open
// (a live update, or the page's own read after a save), as SvelteKit hands a
// page a new `data`.
describe.each(PAGES.slice(0, 2))('a re-read of $name while its card window is open (card 2281, slice C3a-1 review)', (page) => {
	async function openedLive() {
		const props = drawLive(page.component, page.data()) as { data: unknown };
		page.open();
		await settle();
		expect(titleBox(), 'the window opened').not.toBeNull();
		return props;
	}

	it('draws the list as the re-read gives it', async () => {
		const props = await openedLive();
		props.data = page.data({ ...row, title: 'Theirs' });
		await settle();

		expect(page.shown!()).toBe('#7 Theirs');
	});

	it('keeps the re-read’s value when a save sent before it is refused after it, and the window keeps what was typed', async () => {
		let refuse: (res: Response) => void = () => {};
		answerSave = () => new Promise<Response>((resolve) => (refuse = resolve));
		const props = await openedLive();
		type(titleBox()!, 'Mine');
		document.querySelector<HTMLButtonElement>('.btn-create')!.click();
		await settle();
		expect(page.shown!()).toBe('#7 Mine');

		props.data = page.data({ ...row, title: 'Theirs' });
		await settle();
		refuse(json({ message: 'Viewers cannot change cards' }, 403));
		await settle();

		expect(page.shown!()).toBe('#7 Theirs');
		expect(titleBox()?.value).toBe('Mine');
		expect(toastsSaid()).toEqual(['Viewers cannot change cards']);
	});

	// The review's (c): the window showed what it opened with, after a colleague's change had replaced it.
	it('shows in the window a field nobody typed in as the re-read gives it, and keeps one typed in', async () => {
		const props = await openedLive();
		type(titleBox()!, 'Mine');
		props.data = page.data({ ...row, title: 'Theirs', description: 'Their notes' });
		await settle();

		expect(descriptionBox()?.value).toBe('Their notes');
		expect(titleBox()?.value).toBe('Mine');
	});

	// The review's (b): a field typed in, then set back to what it started from, while a re-read moved it.
	it('saves a field typed back to its first value after a re-read moved it: what the window shows is the user’s choice', async () => {
		const props = await openedLive();
		type(titleBox()!, 'Mine');
		type(titleBox()!, 'Plan');
		props.data = page.data({ ...row, title: 'Theirs' });
		await settle();
		await save();

		expect(writes()).toEqual([{ what: 'PUT /api/cards/7', body: { title: 'Plan', boardId: 3 } }]);
	});
});

// The review's (a): a card reopened while its own save was out showed the
// value being saved; refused, the page put the card back, the window kept
// showing it, and Save sent nothing, as it equalled what the window opened on.
describe.each(PAGES.slice(0, 2))('$name: a card reopened while its own save is out, then refused (card 2281, slice C3a-1 review)', (page) => {
	it('shows the card as put back, and a save of the value then sends it', async () => {
		let refuse: (res: Response) => void = () => {};
		answerSave = () => new Promise<Response>((resolve) => (refuse = resolve));
		draw(page.component, page.data());
		page.open();
		await settle();
		type(titleBox()!, 'Mine');
		document.querySelector<HTMLButtonElement>('.btn-create')!.click();
		await settle();
		// Cancel closes the window while the save is out.
		document.querySelector<HTMLButtonElement>('.btn-cancel')!.click();
		await settle();
		expect(titleBox()).toBeNull();

		page.open();
		await settle();
		expect(titleBox()?.value).toBe('Mine');
		leave(titleBox()!);
		refuse(json({ message: 'Viewers cannot change cards' }, 403));
		await settle();

		expect(page.shown!()).toBe('#7 Plan');
		expect(titleBox()?.value).toBe('Plan');
		answerSave = () => json({ ...row, title: 'Mine' });
		type(titleBox()!, 'Mine');
		await save();
		expect(writes().map((write) => write.body)).toEqual([
			{ title: 'Mine', boardId: 3 },
			{ title: 'Mine', boardId: 3 }
		]);
	});
});

describe('the plan page’s card window, opened and saved in turn (card 2281, slice C3a-1 review)', () => {
	const chainCard = (id: number) =>
		[...document.querySelectorAll<HTMLButtonElement>('.chain-card')].find((button) => button.textContent!.includes(`#${id}`))!;

	// The review's (d): the window drawn for the first card was kept for the second, with the first's fields.
	it('shows the second card’s fields when two cards are opened in turn and the second’s context answers last', async () => {
		let answerSecond: () => void = () => {};
		answerContext[8] = () => new Promise<Response>((resolve) => (answerSecond = () => resolve(context(second))));
		draw(PlanPage, planData([row, second]));
		chainCard(7).click();
		chainCard(8).click();
		await settle();
		// The first card, overtaken by the second before its context came, opens nothing (card 2350).
		expect(titleBox()).toBeNull();

		answerSecond();
		await settle();
		expect(titleBox()?.value).toBe('Ship');
		expect(descriptionBox()?.value).toBe('Ship notes');
	});

	// The review's note 5: a save answered after its window was closed and another card's opened closed that one too.
	it('leaves another card’s window open, with what was typed in it, when a save of the first is answered after it was closed', async () => {
		let answerFirst: () => void = () => {};
		answerSave = () => new Promise<Response>((resolve) => (answerFirst = () => resolve(json({ ...row, title: 'Plan the launch' }))));
		draw(PlanPage, planData([row, second]));
		chainCard(7).click();
		await settle();
		type(titleBox()!, 'Plan the launch');
		document.querySelector<HTMLButtonElement>('.btn-create')!.click();
		await settle();
		document.querySelector<HTMLButtonElement>('.close-btn')!.click();
		await settle();
		chainCard(8).click();
		await settle();
		type(titleBox()!, 'Ship it now');
		navigation.invalidateAll.mockClear();

		answerFirst();
		await settle();

		expect(titleBox()?.value).toBe('Ship it now');
		expect(toastsSaid()).toContain('Card updated');
		// The plan is read again for the card saved.
		expect(navigation.invalidateAll).toHaveBeenCalledTimes(1);
	});

	// The re-check's note: the same card reopened is another window, which the late save must not close either.
	it('leaves the same card’s window, reopened, open with what was typed in it, when its earlier save is answered after it was closed', async () => {
		let answerFirst: () => void = () => {};
		answerSave = () => new Promise<Response>((resolve) => (answerFirst = () => resolve(json({ ...row, title: 'Plan the launch' }))));
		draw(PlanPage, planData([row, second]));
		chainCard(7).click();
		await settle();
		type(titleBox()!, 'Plan the launch');
		document.querySelector<HTMLButtonElement>('.btn-create')!.click();
		await settle();
		document.querySelector<HTMLButtonElement>('.close-btn')!.click();
		await settle();
		chainCard(7).click();
		await settle();
		type(titleBox()!, 'Plan it again');
		navigation.invalidateAll.mockClear();

		answerFirst();
		await settle();

		expect(titleBox()?.value).toBe('Plan it again');
		expect(toastsSaid()).toContain('Card updated');
		expect(navigation.invalidateAll).toHaveBeenCalledTimes(1);
	});
});
