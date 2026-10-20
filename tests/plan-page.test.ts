// @vitest-environment jsdom
/**
 * The plan page (card 2281, slice C3a-3 of card 2012's part C), mounted with
 * Svelte's client runtime as All Tasks' and the dashboard's files do, so that
 * what the page joins up between its blocks is run by Svelte itself: a card
 * opened from the work table, the critical path, the graph (a card, one of
 * its subtasks once opened, and the cards nobody sequenced) opening the
 * page's card window; the header's Add cards opening the card picker (whose
 * open flag is the page's, bound into both), the picker's choice reaching the
 * page's `mutate` and its request, and what was typed kept while it is shut;
 * the header's rename, Close and target date, and the work table's ✕, each
 * reaching its request through `mutate`, a refusal said by the page and a
 * change in flight holding Close; the progress block and the burndown drawn
 * from the page's load and following a re-read of it (the burndown fetched
 * again only when the work it charts changed); and the graph drawn with each
 * node's box and each edge as HEAD's page drew them (`tests/plan-graph.test.ts`
 * pins the same numbers on `$lib/plan-graph`). `fetch` and `invalidateAll`
 * are stand-ins; what each request sent is kept.
 *
 * The card window's saves are held in `tests/card-window-pages.test.ts`; the
 * source pins of the same code are in `tests/plan-table.test.ts`,
 * `tests/page-failures.test.ts`, `tests/subtask-order.test.ts` and
 * `tests/timestamps.test.ts`.
 */
import { join } from 'node:path';
import { pathToFileURL } from 'node:url';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import type * as Svelte from 'svelte';

import PlanPage from '../src/routes/plan/[id]/+page.svelte';
import { toasts } from '$lib/stores/toast';

// The page's data is read again after a change; here it is only counted.
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

/** Each request the page sent, as `METHOD url`, with its body read as JSON where it had one. */
let sent: { what: string; body: unknown }[] = [];
let drawn: { component: ReturnType<typeof mount>; target: HTMLElement } | null = null;
/** How the next change to the goal is answered; a promise holds it until the test lets it go. */
let answerPatch: () => Response | Promise<Response>;

const json = (body: unknown, status = 200) => new Response(JSON.stringify(body), { status, headers: { 'content-type': 'application/json' } });

/** A card, as its context gives it to the window. */
const cardRow = (id: number, title: string) => ({
	id, columnId: 11, boardId: 3, title, description: '', priority: 'low', categoryId: null, dueDate: null, colorTag: null,
	position: 0, createdAt: '2026-10-01 09:00:00', updatedAt: '2026-10-01 09:00:00', pinned: false,
	onHoldNote: null, businessValue: null, summary: null, theme: null, customerImpact: null, closeReason: null, releaseState: null,
	subtasks: [], labelIds: [], assignees: [], subBoards: [], milestoneId: 4, archivedAt: null, coverUrl: null
});
const TITLES: Record<number, string> = { 7: 'Plan', 8: 'Ship', 9: 'Docs', 10: 'Card 10', 11: 'Card 11', 12: 'Card 12' };

/** A node of the plan's graph. */
const node = (id: number, extra: Record<string, unknown> = {}) => ({
	kind: 'card', id, title: TITLES[id] ?? `Card ${id}`, priority: 'low', columnTitle: 'To Do', boardId: 3, boardName: 'Website', isComplete: false,
	withheld: false, layer: 0, blockedBy: [], blocks: [], openBlockers: [], downstreamCount: 0, onCriticalPath: false, ...extra
});
const ref = (kind: string, id: number) => ({ kind, id });

/**
 * The plan page's load: the goal Launch, Plan then Ship on its critical path
 * (Ship waits on Plan), Docs unordered; two of five done.
 */
const planData = (progress: Record<string, unknown> = {}, shipDone = false) => ({
	user: { id: 1, username: 'alice', role: 'user' },
	subtasks: {},
	summary: {
		milestone: { id: 4, name: 'Launch', status: 'open', targetDate: null, boardId: 3 },
		progress: {
			total: 5, done: 2, percent: 40, openSubtasks: 1, totalSubtasks: 3,
			byColumn: [{ columnTitle: 'To Do', count: 3 }], boards: [{ id: 3, name: 'Website', cardCount: 3 }], ...progress
		},
		nextActionable: [ref('card', 7), ref('card', 9)],
		blocked: [{ card: ref('card', 8), blockers: [{ kind: 'card', id: 7, title: 'Plan', boardName: 'Website', columnTitle: 'To Do', boardId: 3, withheld: false }] }],
		criticalPathNodes: [ref('card', 7), ref('card', 8)],
		graph: {
			nodes: [
				node(7, { downstreamCount: 1, onCriticalPath: true, blocks: [ref('card', 8)] }),
				node(8, { onCriticalPath: true, blockedBy: [ref('card', 7)], openBlockers: shipDone ? [] : [ref('card', 7)], isComplete: shipDone }),
				node(9)
			],
			edges: [{ from: ref('card', 7), to: ref('card', 8) }],
			unordered: [9]
		}
	}
});

/** A card whose subtasks block and wait on other cards: the graph `tests/plan-graph.test.ts` pins, drawn as HEAD's page drew it. */
const subtaskGraphData = () => {
	const sub = (id: number) => ({ ...node(id), kind: 'subtask', title: `Sub ${id}`, parentCardId: 10 });
	const data = planData();
	data.summary.graph = {
		nodes: [node(10), sub(101), sub(102), node(11), node(12)] as never,
		edges: [
			{ from: ref('subtask', 101), to: ref('card', 11) },
			{ from: ref('card', 11), to: ref('subtask', 102) },
			{ from: ref('subtask', 102), to: ref('card', 12) },
			{ from: ref('subtask', 101), to: ref('card', 12) },
			{ from: ref('subtask', 101), to: ref('subtask', 102) }
		],
		unordered: []
	};
	data.summary.criticalPathNodes = [ref('subtask', 101), ref('card', 11), ref('subtask', 102), ref('card', 12)];
	data.summary.blocked = [];
	return data;
};

/** A goal finished: what the burndown answers for it. */
const burndownDone = {
	series: [], target: null,
	forecast: { status: 'done', basisDays: 28, asOf: '2026-10-20', completionRate: 0, scopeRate: 0, netBurnRate: 0, projectedDate: null, projectedDateNoNewScope: null, spansBoards: false },
	delivery: {
		status: 'done', method: 'pooled', remaining: 0, asOf: '2026-10-20', basisDays: 28, basisFinished: 5, throughputPerWeek: 1, arrivalPerWeek: 0,
		trials: 2000, p50: null, p85: null, p95: null, chanceByTarget: null, bottleneck: null, parts: [], pooled: null
	}
};

beforeEach(() => {
	sent = [];
	navigation.invalidateAll.mockClear();
	answerPatch = () => json({ id: 4 });
	// The burndown's chart watches its own width, which jsdom does not lay out.
	vi.stubGlobal('ResizeObserver', class { observe() {} unobserve() {} disconnect() {} });
	vi.stubGlobal(
		'fetch',
		vi.fn(async (url: string, init?: RequestInit) => {
			const method = init?.method ?? 'GET';
			sent.push({ what: `${method} ${url}`, body: typeof init?.body === 'string' ? JSON.parse(init.body) : undefined });
			if (url === '/api/milestones/4' && method === 'PATCH') return answerPatch();
			if (url.startsWith('/api/burndown')) return json(burndownDone);
			if (url.startsWith('/api/cards/search')) return json([{ id: 21, title: 'Write the notes', boardName: 'Website', boardEmoji: '📋', columnName: 'To Do', milestoneId: null }]);
			// The card's context, which the page reads as the window opens, and the window's own reads.
			const contextOf = /^\/api\/cards\/(\d+)\/context$/.exec(url);
			if (contextOf) {
				const id = Number(contextOf[1]);
				return json({ card: cardRow(id, TITLES[id]), boardId: 3, categories: [], labels: [], boardUsers: [], milestones: [] });
			}
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

/** Mounts the page with its props in a Svelte proxy, as SvelteKit hands them, and gives them back: setting `data` is a re-read. */
async function draw(data: unknown = planData()) {
	const props = proxy({ data });
	const target = document.createElement('div');
	document.body.appendChild(target);
	drawn = { component: mount(PlanPage as never, { target, props: props as never }), target };
	flushSync();
	await settle();
	return props;
}

const $ = <T extends Element = HTMLElement>(selector: string) => document.querySelector<T>(selector);
const $$ = (selector: string) => [...document.querySelectorAll(selector)];
const click = (el: Element | null) => {
	expect(el).not.toBeNull();
	el!.dispatchEvent(new MouseEvent('click', { bubbles: true }));
	flushSync();
};
const titleBox = () => $<HTMLInputElement>('#card-title');
const textOf = (el: Element | null) => el?.textContent?.replace(/\s+/g, ' ').trim();
const patches = () => sent.filter((s) => s.what === 'PATCH /api/milestones/4').map((s) => s.body);

/** Types `text` into a box, as `bind:value` hears it. */
function type(el: HTMLInputElement, text: string) {
	el.value = text;
	el.dispatchEvent(new Event('input', { bubbles: true }));
	flushSync();
}

describe('the plan page opens its card window from each block (card 2281, slice C3a-3)', () => {
	it.each([
		['the work table, by a title', () => $('.work-table .title-link'), 'Plan', 7],
		['the work table, by an id', () => $$('.work-table .id-link')[1], 'Ship', 8],
		['the critical path', () => $$('.chain-card')[1], 'Ship', 8],
		['the graph', () => $$('g.node-link')[0], 'Plan', 7],
		['the cards nobody sequenced', () => $('.list-card'), 'Docs', 9]
	])('from %s', async (_, opener, title, id) => {
		await draw();
		expect(titleBox()).toBeNull();
		click(opener());
		await settle();
		expect(sent.map((s) => s.what)).toContain(`GET /api/cards/${id}/context`);
		expect(titleBox()?.value).toBe(title);
	});

	it('from a blocker the work table lists under a row', async () => {
		await draw();
		click($('.work-table .expander'));
		click($('.blocker'));
		await settle();
		expect(titleBox()?.value).toBe('Plan');
	});

	it('from a subtask of a card opened in the graph: the card it belongs to', async () => {
		await draw(subtaskGraphData());
		click($('.sub-toggle'));
		const subtask = $$('g.node-link').find((g) => textOf(g) === '↳ Sub 101');
		click(subtask!);
		await settle();
		expect(sent.map((s) => s.what)).toContain('GET /api/cards/10/context');
		expect(titleBox()?.value).toBe('Card 10');
	});
});

describe('the plan page’s card picker (card 2281, slice C3a-3)', () => {
	it('opens from the header’s Add cards, searches, and adds the card chosen through the page’s one PATCH path', async () => {
		await draw();
		expect($('.picker-input')).toBeNull();
		const add = $$('.hdr-btn.primary')[0];
		click(add);
		expect($('.picker-input')).not.toBeNull();
		expect(add.classList.contains('is-on')).toBe(true);

		type($<HTMLInputElement>('.picker-input')!, 'notes');
		await new Promise((resolve) => setTimeout(resolve, 300));
		await settle();
		expect(sent.map((s) => s.what)).toContain('GET /api/cards/search?q=notes');
		expect(textOf($('.picker-result'))).toBe('#21 Write the notes 📋 Website / To Do');

		click($('.picker-result'));
		await settle();
		expect(patches()).toEqual([{ cardId: 21, attach: true }]);
		expect(navigation.invalidateAll).toHaveBeenCalledTimes(1);
		expect($<HTMLInputElement>('.picker-input')!.value).toBe('');
	});

	it('keeps what was typed while Add cards shuts it, and Done shuts it and clears it, the header following', async () => {
		await draw();
		const add = $$('.hdr-btn.primary')[0];
		click(add);
		type($<HTMLInputElement>('.picker-input')!, 'notes');
		click(add);
		expect($('.picker-input')).toBeNull();
		click(add);
		expect($<HTMLInputElement>('.picker-input')!.value).toBe('notes');

		click($$('.picker-row .btn-ghost')[0]);
		expect($('.picker-input')).toBeNull();
		expect(add.classList.contains('is-on')).toBe(false);
		click(add);
		expect($<HTMLInputElement>('.picker-input')!.value).toBe('');
	});
});

describe('the plan page’s changes to the goal go through its one PATCH path (card 2281, slice C3a-3)', () => {
	it('renames the goal from the header', async () => {
		await draw();
		$('.plan-header h1')!.dispatchEvent(new MouseEvent('dblclick', { bubbles: true }));
		flushSync();
		const box = $<HTMLInputElement>('.name-input')!;
		expect(box.value).toBe('Launch');
		type(box, 'Launch v2');
		box.dispatchEvent(new KeyboardEvent('keydown', { key: 'Enter', bubbles: true }));
		await settle();
		expect(patches()).toContainEqual({ name: 'Launch v2' });
		expect(navigation.invalidateAll).toHaveBeenCalled();
	});

	it('closes the goal from the header, holding Close while the change is out', async () => {
		let answer!: () => void;
		answerPatch = () => new Promise<Response>((resolve) => (answer = () => resolve(json({ id: 4 }))));
		await draw();
		const close = $$('.hdr-btn').find((b) => textOf(b) === 'Close') as HTMLButtonElement;
		click(close);
		await settle();
		expect(patches()).toEqual([{ status: 'closed' }]);
		expect(close.disabled).toBe(true);
		answer();
		await settle();
		expect(close.disabled).toBe(false);
	});

	it('sets the target date from the header', async () => {
		await draw();
		click($('.target-btn'));
		const box = $<HTMLInputElement>('.target-input')!;
		box.value = '2026-12-01';
		box.dispatchEvent(new Event('change', { bubbles: true }));
		await settle();
		expect(patches()).toEqual([{ targetDate: '2026-12-01' }]);
	});

	it('follows a re-read in the header: every card done, the chip says Ready to close and Close steps forward', async () => {
		const props = await draw(planData({ done: 4, percent: 80 }));
		const close = () => $$('.hdr-btn').find((b) => textOf(b) === 'Close')!;
		expect(textOf($('.status-chip'))).toBe('Open');
		expect(close().classList.contains('ready')).toBe(false);
		props.data = planData({ done: 5, percent: 100 });
		await settle();
		expect(textOf($('.status-chip'))).toBe('Ready to close');
		expect(close().classList.contains('ready')).toBe(true);
	});

	it('takes a card out of the goal from the work table', async () => {
		await draw();
		click($('.work-table .detach'));
		await settle();
		expect(patches()).toEqual([{ cardId: 7, attach: false }]);
	});

	it('says a refusal in the page, above the blocks', async () => {
		answerPatch = () => json({ message: 'Viewers cannot change goals' }, 403);
		await draw();
		const close = $$('.hdr-btn').find((b) => textOf(b) === 'Close')!;
		click(close);
		await settle();
		expect(textOf($('.plan-body > .action-error'))).toBe('Viewers cannot change goals');
		expect(navigation.invalidateAll).not.toHaveBeenCalled();
	});
});

describe('the plan page’s progress and burndown draw from its load (card 2281, slice C3a-3)', () => {
	it('draws the progress from the plan, and again from a re-read', async () => {
		const props = await draw();
		expect(textOf($('.progress-big'))).toBe('40%');
		expect($$('.stat-value').map(textOf)).toEqual(['2/5', '2', '1', '1/3']);
		props.data = planData({ done: 3, percent: 60 });
		await settle();
		expect(textOf($('.progress-big'))).toBe('60%');
		expect(textOf($('.stat-value'))).toBe('3/5');
	});

	it('reads the burndown for the goal, again only when the work it charts changes', async () => {
		const props = await draw();
		const reads = () => sent.filter((s) => s.what.startsWith('GET /api/burndown')).map((s) => s.what);
		expect(reads()).toEqual(['GET /api/burndown?milestoneId=4']);
		expect(textOf($('.bd-status'))).toBe('✓Done — nothing remaining');
		expect(textOf($('.bd-eta strong'))).toBe('Done');
		expect($<HTMLAnchorElement>('.panel-link')!.getAttribute('href')).toBe('/burndown?milestoneId=4');

		// A re-read that changes nothing it charts: not read again.
		props.data = planData();
		await settle();
		expect(reads()).toHaveLength(1);
		// Ship done: read again.
		props.data = planData({}, true);
		await settle();
		expect(reads()).toEqual(['GET /api/burndown?milestoneId=4', 'GET /api/burndown?milestoneId=4']);
	});
});

describe('the plan page draws its graph as HEAD’s page drew it (card 2281, slice C3a-3)', () => {
	/** The SVG's size, each node's box as `first text, x, y, height`, each edge as `crit|plain` and its path. */
	function graph() {
		const svg = $('.graph-scroll svg')!;
		return {
			width: Number(svg.getAttribute('width')),
			height: Number(svg.getAttribute('height')),
			nodes: [...svg.querySelectorAll('g.node')].map((g) => {
				const box = g.querySelector(':scope > rect')!;
				return [textOf(g.querySelector('text')), box.getAttribute('x'), box.getAttribute('y'), box.getAttribute('height')].join(' ');
			}),
			edges: [...svg.querySelectorAll(':scope > path')].map((p) => `${p.getAttribute('stroke') === '#f43f5e' ? 'crit' : 'plain'} ${p.getAttribute('d')}`)
		};
	}

	it('a card whose subtasks block and wait on other cards, collapsed and then opened', async () => {
		await draw(subtaskGraphData());
		expect(graph()).toEqual({
			width: 238,
			height: 254,
			nodes: ['#10 24 24 58', '#11 24 98 58', '#12 24 172 58'],
			edges: ['crit M 214 53 C 119 53, 119 127, 24 127', 'crit M 214 127 C 119 127, 119 53, 24 53', 'crit M 214 53 C 119 53, 119 201, 24 201']
		});
		expect($('.sub-toggle')!.getAttribute('aria-label')).toBe('Show 2 ordered subtasks');

		click($('.sub-toggle'));
		expect(graph()).toEqual({
			width: 1030,
			height: 214,
			nodes: ['#10 24 24 124', '↳ Sub 101 24 164 26', '↳ Sub 102 552 24 26', '#11 288 24 58', '#12 816 24 58'],
			edges: [
				'crit M 214 177 C 251 177, 251 53, 288 53',
				'crit M 478 53 C 515 53, 515 37, 552 37',
				'crit M 742 37 C 779 37, 779 53, 816 53',
				'plain M 214 177 C 515 177, 515 53, 816 53',
				'plain M 214 177 C 383 177, 383 37, 552 37'
			]
		});
		expect($('.sub-toggle')!.getAttribute('aria-label')).toBe('Hide 2 ordered subtasks');
	});

	it('the page’s own plan: Plan before Ship on the critical path, Docs listed as unordered', async () => {
		await draw();
		expect(graph()).toEqual({
			width: 502,
			height: 180,
			nodes: ['#7 24 24 58', '#8 288 24 58', '#9 24 98 58'],
			edges: ['crit M 214 53 C 251 53, 251 53, 288 53']
		});
		expect($$('.list-card').map(textOf)).toEqual(['#9 Docs Website / To Do']);
	});
});
