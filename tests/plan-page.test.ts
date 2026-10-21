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
 * are stand-ins; what each request sent is kept. The work table's ✕ is
 * checked against the component's compiled CSS: what shows it must match the
 * table as drawn (card 2320). The picker's cases run on fake timers, so no
 * search one of them leaves waiting reaches a later case (card 2328).
 *
 * Each read and change the page sends is also answered with a refusal and
 * with no answer (cards 2314, 2319, 2322): said in the server's words or as
 * no answer, never as nothing; the picker shows only its latest search's
 * answer, and the burndown marks a chart no longer current. The ✕ asks first
 * (card 2335). The unordered cards' box is read from the graph's compiled CSS
 * as the browser weighs it (card 2321), and the rules the split left for
 * markup no longer drawn are pinned gone (card 2323).
 *
 * The card window's saves are held in `tests/card-window-pages.test.ts`; the
 * source pins of the same code are in `tests/plan-table.test.ts`,
 * `tests/page-failures.test.ts`, `tests/subtask-order.test.ts` and
 * `tests/timestamps.test.ts`.
 */
import { readFileSync } from 'node:fs';
import { join } from 'node:path';
import { pathToFileURL } from 'node:url';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import type * as Svelte from 'svelte';
import { compile } from 'svelte/compiler';

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
/** How the card picker's search for `q` is answered (card 2319). */
let answerSearch: (q: string) => Response | Promise<Response>;
/** How the burndown's read is answered (card 2322). */
let answerBurndown: () => Response | Promise<Response>;
/** How a card's context, read as its window opens, is answered (card 2314). */
let answerContext: (id: number) => Response | Promise<Response>;

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
	answerSearch = () => json([{ id: 21, title: 'Write the notes', boardName: 'Website', boardEmoji: '📋', columnName: 'To Do', milestoneId: null }]);
	answerBurndown = () => json(burndownDone);
	answerContext = (id) => json({ card: cardRow(id, TITLES[id]), boardId: 3, categories: [], labels: [], boardUsers: [], milestones: [] });
	// The burndown's chart watches its own width, which jsdom does not lay out.
	vi.stubGlobal('ResizeObserver', class { observe() {} unobserve() {} disconnect() {} });
	vi.stubGlobal(
		'fetch',
		vi.fn(async (url: string, init?: RequestInit) => {
			const method = init?.method ?? 'GET';
			sent.push({ what: `${method} ${url}`, body: typeof init?.body === 'string' ? JSON.parse(init.body) : undefined });
			if (url === '/api/milestones/4' && method === 'PATCH') return answerPatch();
			if (url.startsWith('/api/burndown')) return answerBurndown();
			if (url.startsWith('/api/cards/search')) return answerSearch(new URL(url, 'http://plan.test').searchParams.get('q') ?? '');
			// The card's context, which the page reads as the window opens, and the window's own reads.
			const contextOf = /^\/api\/cards\/(\d+)\/context$/.exec(url);
			if (contextOf) return answerContext(Number(contextOf[1]));
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
	// After the unmount, so a fake timer is cleared by the component as a fake one, and none outlives its case.
	vi.useRealTimers();
	vi.unstubAllGlobals();
	document.body.innerHTML = '';
	// The toasts are the app's, not the page's: each case starts with none.
	let shown: { id: number }[] = [];
	toasts.subscribe((list) => (shown = list))();
	for (const toast of shown) toasts.dismiss(toast.id);
});

/** Lets the stand-in answers and what they set off settle; on fake timers, by moving them on by nothing. */
async function settle() {
	for (let i = 0; i < 10; i++) {
		if (vi.isFakeTimers()) await vi.advanceTimersByTimeAsync(0);
		else await new Promise((resolve) => setTimeout(resolve, 0));
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

/** Leaves the page: unmounts it as `afterEach` does, within the case. */
function leave() {
	unmount(drawn!.component);
	drawn!.target.remove();
	drawn = null;
}

/**
 * What gives the work table's ✕ a style (card 2320). Each rule of
 * WorkTable.svelte's compiled CSS whose declarations `wanted` accepts and
 * which, with Svelte's scoping class and the states `:hover`,
 * `:has(:focus-visible)`, `:focus-within` and `:focus-visible` taken off,
 * matches `button` in the page as drawn: named by the state and the element
 * it is on (`tr:hover`; `self:focus-visible` for the button's own), or by its
 * media condition. A rule written for markup the table has not got names
 * nothing. `revealsOf` asks for `opacity: 1`. Another of the plan's
 * components is read by naming its file.
 */
const revealsOf = (button: Element) => stylesOf(button, (style) => style.opacity === '1');

/** A component of the plan page's compiled CSS, as the browser is given it. */
function cssOf(name: string): string {
	const file = join(process.cwd(), 'src/lib/components/plan', name);
	return compile(readFileSync(file, 'utf8'), { filename: file, css: 'external' }).css!.code;
}

/**
 * The style in force on `element` from its component's compiled CSS alone
 * (card 2321): the sheet added with its scoping class put to the one the
 * drawn element carries, and read with `getComputedStyle`, which in jsdom
 * weighs each rule's specificity as a browser does. What a rule written
 * before another of the same weight sets is overruled by it; one that
 * outweighs it is not.
 */
function computedOf(element: Element, name: string, properties: string[]): Record<string, string> {
	const css = cssOf(name);
	const compiled = /\.(svelte-[\w-]+)/.exec(css)![1];
	const drawn = /\bsvelte-[\w-]+/.exec(element.getAttribute('class') ?? '')![0];
	const style = document.createElement('style');
	style.textContent = css.replaceAll(compiled, drawn);
	document.head.appendChild(style);
	try {
		// Read while the sheet is in: the declaration is live, and worked out again without it once it goes.
		const computed = getComputedStyle(element);
		return Object.fromEntries(properties.map((property) => [property, computed.getPropertyValue(property)]));
	} finally {
		style.remove();
	}
}

function stylesOf(button: Element, wanted: (style: CSSStyleDeclaration) => boolean, name = 'WorkTable.svelte') {
	const style = document.createElement('style');
	style.textContent = cssOf(name);
	document.head.appendChild(style);
	const found: string[] = [];
	const walk = (rules: CSSRuleList, media: string | null) => {
		for (const rule of [...rules]) {
			if ('media' in rule) walk((rule as CSSMediaRule).cssRules, (rule as CSSMediaRule).media.mediaText);
			if (!('selectorText' in rule) || !wanted((rule as CSSStyleRule).style)) continue;
			for (const selector of (rule as CSSStyleRule).selectorText.split(',')) {
				const parts = selector.replace(/:where\(\.svelte-[\w-]+\)/g, '').replace(/\.svelte-[\w-]+/g, '').trim().split(/\s+/);
				const states = /:has\(:focus-visible\)|:hover|:focus-within|:focus-visible/g;
				if (!button.matches(parts.map((part) => part.replace(states, '')).join(' '))) continue;
				if (media) found.push(media);
				parts.forEach((part, i) => {
					for (const [state] of part.matchAll(states)) found.push(i === parts.length - 1 ? `self${state}` : `${part.replace(states, '')}${state}`);
				});
			}
		}
	};
	try {
		walk(style.sheet!.cssRules, null);
	} finally {
		style.remove();
	}
	return found;
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

	// Card 2314: a read that got no answer said nothing, and a refusal said "Could not open that card" whatever the server said.
	it.each([
		['gets no answer', () => Promise.reject(new TypeError('Failed to fetch')), 'No answer from the server. The card could not be opened.'],
		['is refused', () => json({ message: 'You do not have access to this board' }, 403), 'You do not have access to this board'],
		['is refused with no words of its own', () => json({ message: 'Internal Error' }, 500), 'That card could not be opened.'],
		['is answered with something that is not its context', () => new Response('<html>proxy</html>', { status: 200 }), "The server's answer could not be read. The card could not be opened."]
	])('says so in a toast when the card’s read %s, and opens no window (card 2314)', async (_, answer, said) => {
		answerContext = answer;
		await draw();
		click($('.work-table .title-link'));
		await settle();
		expect(sent.map((s) => s.what)).toContain('GET /api/cards/7/context');
		expect(titleBox()).toBeNull();
		expect($$('.toast-error .toast-msg').map(textOf)).toEqual([said]);
	});

	// Card 2350: whichever card's read answered last was opened, the one clicked first if it was slower.
	it.each([
		['its context', () => json({ card: cardRow(7, 'Plan'), boardId: 3, categories: [], labels: [], boardUsers: [], milestones: [] })],
		['no answer', () => Promise.reject(new TypeError('Failed to fetch'))]
	])('keeps the window on the card opened last when an earlier card’s read answers after it with %s, and says nothing of it (card 2350)', async (_, late) => {
		let answerFirst!: () => void;
		answerContext = (id) =>
			id === 7
				? new Promise<Response>((resolve, reject) => (answerFirst = () => Promise.resolve().then(late).then(resolve, reject)))
				: json({ card: cardRow(id, TITLES[id]), boardId: 3, categories: [], labels: [], boardUsers: [], milestones: [] });
		await draw();
		click($('.work-table .title-link'));
		click($$('.work-table .id-link')[1]);
		await settle();
		expect(titleBox()?.value).toBe('Ship');

		answerFirst();
		await settle();
		expect(sent.map((s) => s.what)).toEqual(expect.arrayContaining(['GET /api/cards/7/context', 'GET /api/cards/8/context']));
		expect(titleBox()?.value).toBe('Ship');
		expect($$('.toast-error .toast-msg')).toEqual([]);
	});
});

describe('the plan page’s card picker (card 2281, slice C3a-3)', () => {
	// The picker waits 250 ms before it searches: on fake timers, so a search a case leaves waiting goes with it (card 2328).
	beforeEach(() => {
		vi.useFakeTimers({ toFake: ['setTimeout', 'clearTimeout'] });
	});

	it('opens from the header’s Add cards, searches, and adds the card chosen through the page’s one PATCH path', async () => {
		await draw();
		expect($('.picker-input')).toBeNull();
		const add = $$('.hdr-btn.primary')[0];
		click(add);
		expect($('.picker-input')).not.toBeNull();
		expect(add.classList.contains('is-on')).toBe(true);

		type($<HTMLInputElement>('.picker-input')!, 'notes');
		await vi.advanceTimersByTimeAsync(300);
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

	it('sends no search once the page is left with one still waiting (card 2328)', async () => {
		await draw();
		click($$('.hdr-btn.primary')[0]);
		type($<HTMLInputElement>('.picker-input')!, 'notes');
		leave();
		await vi.advanceTimersByTimeAsync(300);
		expect(sent.map((s) => s.what)).not.toContain('GET /api/cards/search?q=notes');
	});

	/** What the picker says under its box, beside the results. */
	const pickerSays = () => $$('.picker-panel .muted, .picker-panel .picker-error').map(textOf);
	const searches = () => sent.filter((s) => s.what.startsWith('GET /api/cards/search')).map((s) => s.what);
	const result = (id: number, title: string) => ({ id, title, boardName: 'Website', boardEmoji: '📋', columnName: 'To Do', milestoneId: null });

	it('says nothing and sends nothing once the box is emptied before its search goes out (card 2319)', async () => {
		await draw();
		click($$('.hdr-btn.primary')[0]);
		const box = $<HTMLInputElement>('.picker-input')!;
		type(box, 'notes');
		expect(pickerSays()).toEqual(['Searching…']);
		await vi.advanceTimersByTimeAsync(100);
		type(box, '');
		await vi.advanceTimersByTimeAsync(300);
		await settle();
		expect(pickerSays()).toEqual([]);
		expect(searches()).toEqual([]);
	});

	it('shows the latest search’s answer, not an older one that answers after it (card 2319)', async () => {
		let answerOlder!: () => void;
		answerSearch = (q) =>
			q === 'no'
				? new Promise<Response>((resolve) => (answerOlder = () => resolve(json([result(31, 'Nobody ordered this')]))))
				: json([result(21, 'Write the notes')]);
		await draw();
		click($$('.hdr-btn.primary')[0]);
		const box = $<HTMLInputElement>('.picker-input')!;
		type(box, 'no');
		await vi.advanceTimersByTimeAsync(300);
		type(box, 'notes');
		await vi.advanceTimersByTimeAsync(300);
		await settle();
		expect(searches()).toEqual(['GET /api/cards/search?q=no', 'GET /api/cards/search?q=notes']);
		expect($$('.picker-result .card-title').map(textOf)).toEqual(['Write the notes']);
		// The older search answers last: not shown, and the picker is not put back to searching or done.
		answerOlder();
		await settle();
		expect($$('.picker-result .card-title').map(textOf)).toEqual(['Write the notes']);
		expect(pickerSays()).toEqual([]);
	});

	it.each([
		['gets no answer', () => Promise.reject(new TypeError('Failed to fetch')), 'No answer from the server. The search could not be run.'],
		['is refused', () => json({ message: 'Too many searches, wait a moment' }, 429), 'Too many searches, wait a moment'],
		['is answered with something that is not a list', () => new Response('<html>proxy</html>', { status: 200 }), "The server's answer could not be read. The search could not be run."]
	])('says so when a search %s, and takes the older results away (card 2319)', async (_, answer, said) => {
		await draw();
		click($$('.hdr-btn.primary')[0]);
		const box = $<HTMLInputElement>('.picker-input')!;
		type(box, 'notes');
		await vi.advanceTimersByTimeAsync(300);
		await settle();
		expect($$('.picker-result')).toHaveLength(1);
		answerSearch = answer;
		type(box, 'notes 2');
		await vi.advanceTimersByTimeAsync(300);
		await settle();
		expect(searches()).toContain('GET /api/cards/search?q=notes%202');
		expect($$('.picker-result')).toEqual([]);
		expect(pickerSays()).toEqual([said]);
	});

	it('is not filled again by a search still out when Done clears it (card 2319)', async () => {
		let answer!: () => void;
		answerSearch = () => new Promise<Response>((resolve) => (answer = () => resolve(json([result(21, 'Write the notes')]))));
		await draw();
		const add = $$('.hdr-btn.primary')[0];
		click(add);
		type($<HTMLInputElement>('.picker-input')!, 'notes');
		await vi.advanceTimersByTimeAsync(300);
		click($$('.picker-row .btn-ghost')[0]);
		answer();
		await settle();
		click(add);
		expect($<HTMLInputElement>('.picker-input')!.value).toBe('');
		expect($$('.picker-result')).toEqual([]);
		expect(pickerSays()).toEqual([]);
	});

	// Card 2351: the box and the results were cleared whether or not the card was added.
	it.each([
		['is refused', () => json({ message: 'That card is on a board you cannot change' }, 403)],
		['gets no answer', () => Promise.reject(new TypeError('Failed to fetch'))]
	])('keeps what was typed and the results when adding a card %s (card 2351)', async (_, answer) => {
		answerPatch = answer;
		await draw();
		click($$('.hdr-btn.primary')[0]);
		const box = $<HTMLInputElement>('.picker-input')!;
		type(box, 'notes');
		await vi.advanceTimersByTimeAsync(300);
		await settle();
		click($('.picker-result'));
		await settle();
		expect(patches()).toEqual([{ cardId: 21, attach: true }]);
		expect(box.value).toBe('notes');
		expect($$('.picker-result .card-title').map(textOf)).toEqual(['Write the notes']);
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
		expect($('.name-input')).toBeNull();
	});

	// Card 2351: the box closed whether or not the name was saved, and the next double-click started from the old name.
	it.each([
		['is refused', () => json({ message: 'Viewers cannot change goals' }, 403)],
		['gets no answer', () => Promise.reject(new TypeError('Failed to fetch'))]
	])('keeps the name box open with what was typed when a rename %s (card 2351)', async (_, answer) => {
		answerPatch = answer;
		await draw();
		$('.plan-header h1')!.dispatchEvent(new MouseEvent('dblclick', { bubbles: true }));
		flushSync();
		const box = $<HTMLInputElement>('.name-input')!;
		type(box, 'Launch v2');
		box.dispatchEvent(new KeyboardEvent('keydown', { key: 'Enter', bubbles: true }));
		await settle();
		expect(patches()).toEqual([{ name: 'Launch v2' }]);
		expect($<HTMLInputElement>('.name-input')?.value).toBe('Launch v2');
	});

	// Card 2363: the box saved on Enter and on blur with nothing kept while the first was out.
	it('sends a rename once when Enter is followed by a click away while it is out (card 2363)', async () => {
		let answer!: () => void;
		answerPatch = () => new Promise<Response>((resolve) => (answer = () => resolve(json({ id: 4 }))));
		await draw();
		$('.plan-header h1')!.dispatchEvent(new MouseEvent('dblclick', { bubbles: true }));
		flushSync();
		const box = $<HTMLInputElement>('.name-input')!;
		type(box, 'Launch v2');
		box.dispatchEvent(new KeyboardEvent('keydown', { key: 'Enter', bubbles: true }));
		box.dispatchEvent(new FocusEvent('blur'));
		await settle();
		expect(patches()).toEqual([{ name: 'Launch v2' }]);

		answer();
		await settle();
		expect(patches()).toEqual([{ name: 'Launch v2' }]);
		expect($('.name-input')).toBeNull();
	});

	it('sends nothing more on the blur after a refused rename, and Enter sends it again (card 2363)', async () => {
		answerPatch = () => json({ message: 'Viewers cannot change goals' }, 403);
		await draw();
		$('.plan-header h1')!.dispatchEvent(new MouseEvent('dblclick', { bubbles: true }));
		flushSync();
		const box = $<HTMLInputElement>('.name-input')!;
		type(box, 'Launch v2');
		box.dispatchEvent(new KeyboardEvent('keydown', { key: 'Enter', bubbles: true }));
		await settle();
		box.dispatchEvent(new FocusEvent('blur'));
		await settle();
		expect(patches()).toEqual([{ name: 'Launch v2' }]);
		expect($<HTMLInputElement>('.name-input')?.value).toBe('Launch v2');

		box.dispatchEvent(new KeyboardEvent('keydown', { key: 'Enter', bubbles: true }));
		await settle();
		expect(patches()).toEqual([{ name: 'Launch v2' }, { name: 'Launch v2' }]);
		// A name typed after it is sent by the blur.
		type(box, 'Launch v3');
		box.dispatchEvent(new FocusEvent('blur'));
		await settle();
		expect(patches()).toEqual([{ name: 'Launch v2' }, { name: 'Launch v2' }, { name: 'Launch v3' }]);
	});

	// Card 2363's review: a name typed while a rename was out was lost when the box closed on its answer.
	it('keeps the box open with a name typed while a rename was out, sending it only on Enter (card 2363’s review)', async () => {
		let answer!: () => void;
		answerPatch = () => new Promise<Response>((resolve) => (answer = () => resolve(json({ id: 4 }))));
		await draw();
		$('.plan-header h1')!.dispatchEvent(new MouseEvent('dblclick', { bubbles: true }));
		flushSync();
		const box = $<HTMLInputElement>('.name-input')!;
		type(box, 'Launch v2');
		box.dispatchEvent(new KeyboardEvent('keydown', { key: 'Enter', bubbles: true }));
		await settle();
		type(box, 'Launch v3');

		answer();
		await settle();
		expect(patches()).toEqual([{ name: 'Launch v2' }]);
		expect($<HTMLInputElement>('.name-input')?.value).toBe('Launch v3');

		answerPatch = () => json({ id: 4 });
		box.dispatchEvent(new KeyboardEvent('keydown', { key: 'Enter', bubbles: true }));
		await settle();
		expect(patches()).toEqual([{ name: 'Launch v2' }, { name: 'Launch v3' }]);
		expect($('.name-input')).toBeNull();
	});

	// Card 2363's build: a blur after the box was closed (a browser may blur a focused box as it is removed) saved what Escape had thrown away.
	it('sends nothing for a blur that comes once Escape has closed the box (card 2363)', async () => {
		await draw();
		$('.plan-header h1')!.dispatchEvent(new MouseEvent('dblclick', { bubbles: true }));
		flushSync();
		const box = $<HTMLInputElement>('.name-input')!;
		type(box, 'Launch v2');
		box.dispatchEvent(new KeyboardEvent('keydown', { key: 'Escape', bubbles: true }));
		box.dispatchEvent(new FocusEvent('blur'));
		await settle();
		expect(patches()).toEqual([]);
		expect($('.name-input')).toBeNull();
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

	it('takes a card out of the goal from the work table, once Remove is chosen in the dialog it asks first (card 2335)', async () => {
		await draw();
		click($('.work-table .detach'));
		await settle();
		expect(patches()).toEqual([]);
		expect(textOf($('.confirm-modal h3'))).toBe('Remove From Goal');
		expect($('.work-table .detach')!.getAttribute('title')).toBe('Remove from this goal');
		expect(textOf($('.confirm-message'))).toBe('#7 “Plan” leaves “Launch”. The card itself stays on its board as it is, and can be added back with + Add cards.');
		click($$('.confirm-actions button').find((b) => textOf(b) === 'Remove')!);
		await settle();
		expect(patches()).toEqual([{ cardId: 7, attach: false }]);
		expect($('.confirm-modal')).toBeNull();
	});

	it('sends nothing when the dialog the work table’s ✕ opens is cancelled, by Cancel or by Escape (card 2335)', async () => {
		await draw();
		click($('.work-table .detach'));
		click($$('.confirm-actions button').find((b) => textOf(b) === 'Cancel')!);
		expect($('.confirm-modal')).toBeNull();
		click($$('.work-table .detach')[1]);
		expect(textOf($('.confirm-message'))).toContain('#8 “Ship”');
		window.dispatchEvent(new KeyboardEvent('keydown', { key: 'Escape' }));
		flushSync();
		expect($('.confirm-modal')).toBeNull();
		await settle();
		expect(patches()).toEqual([]);
	});

	it('shows the work table’s ✕ on its row’s hover and keyboard focus, on its own keyboard focus with a ring of its own, and always on a touch screen (card 2320)', async () => {
		await draw();
		const detach = $('.work-table .detach')!;
		expect(revealsOf(detach)).toEqual(expect.arrayContaining(['tr:hover', 'tr:has(:focus-visible)', 'self:focus-visible', '(hover: none)']));
		// app.css takes every button's outline away: the ✕'s keyboard focus draws a ring of its own.
		expect(stylesOf(detach, (style) => style.getPropertyValue('outline-style') === 'solid' || /\bsolid\b/.test(style.getPropertyValue('outline')))).toContain(
			'self:focus-visible'
		);
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

	// Card 2314: no answer said nothing; SvelteKit's bare "Internal Error" was shown as the server's words.
	it.each([
		['gets no answer', () => Promise.reject(new TypeError('Failed to fetch')), 'No answer from the server. It is not known whether that change was saved.'],
		['is refused with no words of its own', () => json({ message: 'Internal Error' }, 500), 'That change could not be saved']
	])('says so in the page and in a toast when a change %s, and frees Close again (card 2314)', async (_, answer, said) => {
		answerPatch = answer;
		await draw();
		const close = $$('.hdr-btn').find((b) => textOf(b) === 'Close') as HTMLButtonElement;
		click(close);
		await settle();
		expect(patches()).toEqual([{ status: 'closed' }]);
		expect(textOf($('.plan-body > .action-error'))).toBe(said);
		expect($$('.toast-error .toast-msg').map(textOf)).toEqual([said]);
		expect(close.disabled).toBe(false);
		expect(navigation.invalidateAll).not.toHaveBeenCalled();
	});

	// The ✕ may be far down the page, out of sight of the words above the blocks: a toast stays on screen.
	it('says a Remove that gets no answer in a toast as well as above the blocks (card 2335)', async () => {
		answerPatch = () => Promise.reject(new TypeError('Failed to fetch'));
		await draw();
		click($('.work-table .detach'));
		click($$('.confirm-actions button').find((b) => textOf(b) === 'Remove')!);
		await settle();
		expect(patches()).toEqual([{ cardId: 7, attach: false }]);
		const said = 'No answer from the server. It is not known whether that change was saved.';
		expect($$('.toast-error .toast-msg').map(textOf)).toEqual([said]);
		expect(textOf($('.plan-body > .action-error'))).toBe(said);
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

	/** The burndown's panel, and what it says. */
	const burndownPanel = () => $$('section.panel').find((s) => textOf(s.querySelector('h2')) === 'Burndown')!;
	const burndownSays = () => [...burndownPanel().querySelectorAll(':scope > .muted, :scope > .bd-stale')].map(textOf);

	// Card 2322: a read that got no answer left "Loading the burndown…" for good.
	it.each([
		['gets no answer', () => Promise.reject(new TypeError('Failed to fetch')), 'No answer from the server. The burndown could not be loaded.'],
		['is refused', () => json({ message: 'You cannot see this goal' }, 403), 'You cannot see this goal'],
		['is answered with something that is not the burndown', () => new Response('<html>proxy</html>', { status: 200 }), "The server's answer could not be read. The burndown could not be loaded."]
	])('says so in place of the chart when its first read %s (card 2322)', async (_, answer, said) => {
		answerBurndown = answer;
		await draw();
		expect(burndownSays()).toEqual([said]);
		expect($('.bd-status')).toBeNull();
	});

	it('keeps the chart drawn when a later read fails, says it may no longer be current, and clears that on the next good read (card 2322)', async () => {
		const props = await draw();
		expect(textOf($('.bd-status'))).toBe('✓Done — nothing remaining');
		expect(burndownSays()).toEqual([]);

		answerBurndown = () => Promise.reject(new TypeError('Failed to fetch'));
		props.data = planData({}, true);
		await settle();
		expect(textOf($('.bd-status'))).toBe('✓Done — nothing remaining');
		expect(burndownSays()).toEqual([
			'No answer from the server. The burndown could not be loaded. What is shown is from an earlier read and may no longer be current.'
		]);

		answerBurndown = () => json(burndownDone);
		props.data = planData();
		await settle();
		expect(burndownSays()).toEqual([]);
	});

	it('ends the server’s words with a full stop before the note only when they end without one, a ? or a ! (card 2322)', async () => {
		const props = await draw();
		const note = ' What is shown is from an earlier read and may no longer be current.';
		const cases: [string, string][] = [
			['The burndown is paused for maintenance', 'The burndown is paused for maintenance.'],
			['Is this goal still yours?', 'Is this goal still yours?'],
			['Slow down!', 'Slow down!']
		];
		let shipDone = false;
		for (const [words, said] of cases) {
			answerBurndown = () => json({ message: words }, 503);
			shipDone = !shipDone;
			props.data = planData({}, shipDone);
			await settle();
			expect(burndownSays()).toEqual([said + note]);
		}
	});

	it('says Loading again while a read after a failed first one is out (card 2322)', async () => {
		answerBurndown = () => Promise.reject(new TypeError('Failed to fetch'));
		const props = await draw();
		expect(burndownSays()).toEqual(['No answer from the server. The burndown could not be loaded.']);
		let answer!: () => void;
		answerBurndown = () => new Promise<Response>((resolve) => (answer = () => resolve(json(burndownDone))));
		props.data = planData({}, true);
		await settle();
		expect(burndownSays()).toEqual(['Loading the burndown…']);
		answer();
		await settle();
		expect(burndownSays()).toEqual([]);
		expect(textOf($('.bd-status'))).toBe('✓Done — nothing remaining');
	});

	/** Every read of the burndown from here on, each answered when the case says, in the order they were sent. */
	function holdBurndownReads() {
		const out: ((answer: Response) => void)[] = [];
		answerBurndown = () => new Promise<Response>((resolve) => out.push(resolve));
		return out;
	}

	// Card 2350: whichever read answered last was shown, the older one if it was slower.
	it('keeps the latest read’s chart when an older read answers after it (card 2350)', async () => {
		const props = await draw();
		const out = holdBurndownReads();
		props.data = planData({}, true);
		await settle();
		props.data = planData();
		await settle();
		expect(out).toHaveLength(2);

		out[1](json(burndownDone));
		await settle();
		expect(burndownSays()).toEqual([]);
		out[0](json({ message: 'The burndown is paused for maintenance' }, 503));
		await settle();
		expect(burndownSays()).toEqual([]);
		expect(textOf($('.bd-status'))).toBe('✓Done — nothing remaining');
	});

	// Card 2350: and the first read to answer put Loading back while the latest was still out.
	it('says Loading until the latest read answers when an older one answers first (card 2350)', async () => {
		answerBurndown = () => Promise.reject(new TypeError('Failed to fetch'));
		const props = await draw();
		const out = holdBurndownReads();
		props.data = planData({}, true);
		await settle();
		props.data = planData();
		await settle();
		expect(out).toHaveLength(2);

		out[0](json(burndownDone));
		await settle();
		expect(burndownSays()).toEqual(['Loading the burndown…']);
		expect($('.bd-status')).toBeNull();
		out[1](json(burndownDone));
		await settle();
		expect(burndownSays()).toEqual([]);
		expect(textOf($('.bd-status'))).toBe('✓Done — nothing remaining');
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

	// Card 2321: the button reset, `button.list-card`, outweighed the card style, `.list-card`, and took its box away.
	it('draws each card nobody sequenced in its card’s box, the button’s defaults still undone (card 2321)', async () => {
		await draw();
		const card = $('.list-card')!;
		// The card's box is its padding, background and border, all in one rule; jsdom keeps no `border`
		// shorthand built on `var()`, so the rule is read by the other two, which the reset also undid.
		expect(computedOf(card, 'DependencyGraph.svelte', ['padding-top', 'background', 'cursor', 'text-align', 'display'])).toEqual({
			'padding-top': '7px',
			background: 'var(--bg-surface)',
			cursor: 'pointer',
			'text-align': 'left',
			display: 'flex'
		});
	});

	// Card 2323: left by the split, for markup the blocks no longer draw (`npm run check` cannot say: see the testing guide).
	it.each([
		['DependencyGraph.svelte', '.list-card.on-critical'],
		['WorkTable.svelte', '.blocked-group'],
		['WorkTable.svelte', '.col-id a']
	])('keeps no rule in %s for markup it no longer draws: %s (card 2323)', (name, selector) => {
		const selectors = selectorsOf(name);
		expect(selectors.length).toBeGreaterThan(10);
		expect(selectors.filter((s) => s === selector || s.startsWith(`${selector}:`))).toEqual([]);
	});

	// Card 2352: written twice, the same each time; the one beside the element's own style is kept.
	it.each([
		['WorkTable.svelte', '.blocker:hover'],
		['CriticalPathPanel.svelte', '.chain-card:hover']
	])('writes the rule in %s for %s once (card 2352)', (name, selector) => {
		expect(selectorsOf(name).filter((s) => s === selector)).toEqual([selector]);
	});
});

/** Every selector of a plan component's compiled CSS, its scoping class taken off. */
function selectorsOf(name: string): string[] {
	return cssOf(name)
		.replace(/\/\*[\s\S]*?\*\//g, '')
		.split('}')
		.flatMap((rule) => (rule.includes('{') ? rule.slice(0, rule.lastIndexOf('{')).split(',') : []))
		.map((s) => s.replace(/:where\(\.svelte-[\w-]+\)|\.svelte-[\w-]+/g, '').replace(/\s+/g, ' ').trim());
}
