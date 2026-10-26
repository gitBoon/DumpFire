// @vitest-environment jsdom
/**
 * Options on the screens (milestone 22, card 2462, slice S4b): the board's
 * Stats panel and its flow diagram, the dashboard's board rows, All Tasks'
 * Options bucket, a goal's progress and plan, and the reports form. The
 * server side, every figure, is slice S4a's, in
 * `tests/upstream-measures.test.ts`.
 *
 * Mounted with Svelte's client runtime, as `tests/kanban-column-header.svelte.test.ts`
 * is, where a component can be drawn on its own; read from the source where
 * it is a page, as the board-list-view and header-menus tests read theirs.
 * Each block first draws a board with no Options column and shows that it
 * looks as it did: no options line, no upstream figures, no toggle and no
 * commitment point, and the flow diagram asked for as before.
 *
 * The plan is `docs/planning/milestone-22-upstream-kanban.md`, card D and
 * section 7 (rulings d, e, g and h, and the S4a review's "For S4b").
 */
import { readFileSync } from 'node:fs';
import { join } from 'node:path';
import { pathToFileURL } from 'node:url';
import { afterEach, beforeEach, describe, expect, it, vi, type Mock } from 'vitest';
import type * as Svelte from 'svelte';
import StatsPanel from '$lib/components/board/StatsPanel.svelte';
import CfdChart from '$lib/components/board/CfdChart.svelte';
import BoardsTable from '$lib/components/dashboard/BoardsTable.svelte';
import PlanProgress from '$lib/components/plan/PlanProgress.svelte';
import { boardRowCount, boardRowSize, boardRowTitle, drawsCompletion } from '$lib/dashboard/format';
import DependencyGraph from '$lib/components/plan/DependencyGraph.svelte';
import WorkTable from '$lib/components/plan/WorkTable.svelte';
import { discardRateText, optionsLine, showsUpstream, type UpstreamFiguresShown } from '$lib/board/board-stats';
import { goalOptionsNote, goalProgressText, readyToCloseTitle } from '$lib/progress';
import { cardGroups, stateCounts, tableRows, type TableNode } from '$lib/plan-table';
import { nodeState } from '$lib/plan-graph';
import type { ColumnType } from '$lib/types';

// A bare 'svelte' is the server's (see the XP bars' file), whose `onMount`
// never runs: the Stats panel reads its metrics and its flow diagram in one.
// So every import of it here, the components' too, is the browser's.
vi.mock('svelte', async () => {
	const { join: joinPath } = await import('node:path');
	const { pathToFileURL: toUrl } = await import('node:url');
	return await import(/* @vite-ignore */ toUrl(joinPath(process.cwd(), 'node_modules/svelte/src/index-client.js')).href);
});

// The browser's `mount`, loaded by its path: a bare 'svelte' gives the server's (see the XP bars' file).
const clientEntry = pathToFileURL(join(process.cwd(), 'node_modules/svelte/src/index-client.js')).href;
const { flushSync, mount, unmount }: typeof Svelte = await import(/* @vite-ignore */ clientEntry);

const source = (path: string) => readFileSync(join(process.cwd(), path), 'utf8');

let drawn: { component: ReturnType<typeof mount>; target: HTMLElement } | null = null;

/** Mounts `component` with `props`, which each test gives as loosely as the page's own data. */
function draw(component: unknown, props: Record<string, unknown>): HTMLElement {
	const target = document.createElement('div');
	document.body.appendChild(target);
	drawn = { component: mount(component as Parameters<typeof mount>[0], { target, props } as never), target };
	flushSync();
	return target;
}

function undraw() {
	if (drawn) {
		unmount(drawn.component);
		drawn.target.remove();
		drawn = null;
	}
}

afterEach(() => {
	undraw();
	vi.unstubAllGlobals();
	try {
		localStorage.clear();
	} catch {
		// A test that took storage away.
	}
});

/** Every fetch the page made, settled, and the page drawn again. */
async function settle() {
	for (let i = 0; i < 5; i++) await new Promise((resolve) => setTimeout(resolve, 0));
	flushSync();
}

const text = (el: Element | null | undefined) => el?.textContent?.replace(/\s+/g, ' ').trim() ?? null;

// ─── The Stats panel ─────────────────────────────────────────────────────────

const card = (id: number, more: Record<string, unknown> = {}) => ({ id, createdAt: '2026-06-01 09:00:00', dueDate: null, categoryId: null, ...more });

function column(id: number, title: string, cards: unknown[], role: 'options' | null = null): ColumnType {
	return { id, boardId: 1, title, position: id, color: '#6366f1', wipLimit: 0, showAddCard: false, role, cards } as unknown as ColumnType;
}

const ORDINARY = [
	column(1, 'To Do', [card(1), card(2)]),
	column(2, 'In Progress', [card(3)]),
	column(3, 'Complete', [card(4)])
];

const WITH_OPTIONS = [column(9, 'Ideas', [card(11), card(12, { dueDate: '2020-01-01' })], 'options'), ...ORDINARY];

const NOTHING_UPSTREAM: UpstreamFiguresShown = {
	options: 0,
	committedFromOptions: 0,
	returnedToOptions: 0,
	discarded: 0,
	sentOn: 0,
	abandoned: 0,
	discardRate: null,
	oldestOptionDays: null,
	agingOptions: 0
};

const times = (avg: string, median: string) => ({ avgHours: 1, medianHours: 1, avgFormatted: avg, medianFormatted: median });

type Answers = { metrics?: unknown; cfd?: unknown };

let fetched: Mock<(url: string) => Promise<Response>>;

/** The panel's three reads answered: the metrics and the flow diagram as given, the burndown refused. */
function answer(answers: Answers) {
	fetched = vi.fn(async (url: string) => {
		const body = url.includes('/metrics') ? answers.metrics : url.includes('/cfd') ? answers.cfd : undefined;
		return { ok: body !== undefined, status: body === undefined ? 404 : 200, json: async () => body } as Response;
	});
	vi.stubGlobal('fetch', fetched);
}

const metricsOf = (upstream: UpstreamFiguresShown, more: Record<string, unknown> = {}) => ({
	days: 30,
	completed: 3,
	committed: 5,
	leadTime: times('4d', '3d'),
	cycleTime: times('2d', '1d 12h'),
	timeInOptions: null,
	upstream,
	cards: [],
	...more
});

const cfdOf = (more: Record<string, unknown> = {}) => ({
	days: 30,
	kind: 'delivery',
	hasUpstream: false,
	upstreamShown: false,
	columns: [{ id: 1, title: 'To Do', color: '#6366f1', upstream: false }],
	data: [{ date: '2026-06-20', columns: [{ columnId: 1, count: 2 }] }],
	...more
});

/** A day of the flow diagram: To Do alone, or with the Options band (column 9) under it. */
const day2 = (date: string, banded = false) => ({ date, columns: banded ? [{ columnId: 9, count: 2 }, { columnId: 1, count: 1 }] : [{ columnId: 1, count: 2 }] });

async function drawPanel(columns: ColumnType[], boardKind = 'delivery', boardId = 1) {
	const target = draw(StatsPanel, { boardColumns: columns, boardCategories: [], boardId, boardKind, onClose: () => {} });
	await settle();
	return target;
}

const tiles = (target: HTMLElement) =>
	[...target.querySelectorAll('.stat-card')].map((t) => [text(t.querySelector('.stat-value')), text(t.querySelector('.stat-label'))]);

const cfdRequests = () => fetched.mock.calls.map(([url]) => url).filter((url) => url.includes('/cfd'));

describe('the board’s Stats panel (milestone 22)', () => {
	it('draws a board with no Options column as before: no options line, no upstream figures, no toggle', async () => {
		answer({ metrics: metricsOf(NOTHING_UPSTREAM), cfd: cfdOf() });
		const target = await drawPanel(ORDINARY);

		expect(tiles(target).slice(0, 4)).toEqual([
			['4', 'Total Cards'],
			['1', 'Completed'],
			['0', 'Overdue'],
			[expect.stringMatching(/^\d+d$/), 'Avg Age']
		]);
		expect([...target.querySelectorAll('.stats-bar-label')].map(text)).toEqual(['To Do', 'In Progress', 'Complete']);
		expect(target.querySelector('.options-line')).toBeNull();
		expect(target.querySelector('.upstream-figures')).toBeNull();
		expect(target.querySelector('.abandoned-line')).toBeNull();
		expect(target.querySelector('.upstream-toggle')).toBeNull();
		expect(target.querySelector('.commitment-line')).toBeNull();
		// The flow diagram is asked for as it always was.
		expect(cfdRequests()).toEqual(['/api/boards/1/cfd?days=30']);
	});

	it('names lead time from the commitment, cycle time from the start of work, and puts Committed (all) beside throughput', async () => {
		answer({ metrics: metricsOf(NOTHING_UPSTREAM), cfd: cfdOf() });
		const target = await drawPanel(ORDINARY);

		expect([...target.querySelectorAll('.metric-head')].map(text)).toEqual([
			'Lead time (commitment to done)',
			'Cycle time: time from start of work to done'
		]);
		expect(tiles(target).slice(4)).toEqual([
			['4d', 'Avg Lead Time'],
			['3d', 'Median Lead'],
			['2d', 'Avg Cycle Time'],
			['1d 12h', 'Median Cycle'],
			['3', 'Throughput'],
			['5', 'Committed (all)']
		]);
		// The help texts of the hand-off (ruling e; the S4a review's H6).
		const panel = source('src/lib/components/board/StatsPanel.svelte');
		expect(panel).toContain('Complete is the delivery point, so customer lead time and system lead time are the same here.');
		expect(panel).toContain('It is never longer than the lead time.');
		expect(panel).toContain('A card created straight into a working column has no recorded start, so it has no cycle time.');
	});

	it('shows abandoned work on a board with no Options column, and no upstream figures', async () => {
		answer({ metrics: metricsOf({ ...NOTHING_UPSTREAM, abandoned: 2 }), cfd: cfdOf() });
		const target = await drawPanel(ORDINARY);

		expect(text(target.querySelector('.abandoned-line'))).toBe('Abandoned: 2');
		expect(target.querySelector('.upstream-figures')).toBeNull();
		expect(source('src/lib/components/board/StatsPanel.svelte')).toContain('<p>committed work archived before Complete</p>');
	});

	it('leaves the Options column out of every figure and bar, gives it a line of its own, and shows the upstream figures', async () => {
		const upstream = { ...NOTHING_UPSTREAM, options: 2, committedFromOptions: 3, returnedToOptions: 1, discarded: 1, discardRate: 0.25, oldestOptionDays: 40, agingOptions: 1 };
		answer({ metrics: metricsOf(upstream, { timeInOptions: times('6d', '5d') }), cfd: cfdOf({ hasUpstream: true }) });
		const target = await drawPanel(WITH_OPTIONS);

		// The same figures as the board with no Options column: the overdue option is in none.
		expect(tiles(target).slice(0, 3)).toEqual([['4', 'Total Cards'], ['1', 'Completed'], ['0', 'Overdue']]);
		expect([...target.querySelectorAll('.stats-bar-label')].map(text)).toEqual(['To Do', 'In Progress', 'Complete']);
		expect(text(target.querySelector('.options-line'))).toBe('Options 2 · discard rate 25%');
		expect([...target.querySelectorAll('.upstream-figures div')].map((row) => [text(row.querySelector('dt')), text(row.querySelector('dd'))])).toEqual([
			['Committed from options', '3'],
			['Options now', '2'],
			['Returned to options', '1'],
			['Discarded', '1'],
			['Sent to other boards', '0'],
			['Discard rate', '25%'],
			['Oldest option (days)', '40'],
			['Options over 30 days', '1'],
			['Time in options', '6d avg · 5d median']
		]);
		expect(text(target.querySelector('.upstream-title'))).toBe('Upstream');
	});

	it('shows the upstream figures on a board with no upstream column when one is not zero', async () => {
		answer({ metrics: metricsOf({ ...NOTHING_UPSTREAM, committedFromOptions: 1, discardRate: 0 }), cfd: cfdOf() });
		const target = await drawPanel(ORDINARY);
		expect(target.querySelector('.upstream-figures')).not.toBeNull();
		expect(target.querySelector('.options-line')).toBeNull();
	});

	it('offers "Show upstream", off, asks for the band when it is turned on, and remembers it for the next board', async () => {
		answer({ metrics: metricsOf(NOTHING_UPSTREAM), cfd: cfdOf({ hasUpstream: true }) });
		const target = await drawPanel(WITH_OPTIONS);
		const box = target.querySelector<HTMLInputElement>('.upstream-toggle input')!;

		expect(text(target.querySelector('.upstream-toggle'))).toBe('Show upstream');
		expect(box.checked).toBe(false);
		expect(cfdRequests()).toEqual(['/api/boards/1/cfd?days=30']);

		box.click();
		await settle();
		expect(cfdRequests()).toEqual(['/api/boards/1/cfd?days=30', '/api/boards/1/cfd?days=30&upstream=true']);
		expect(localStorage.getItem('df-cfd-show-upstream')).toBe('true');

		// Another board's panel starts with it on: the choice is the viewer's, for every board.
		undraw();
		const again = await drawPanel(WITH_OPTIONS, 'delivery', 2);
		expect(again.querySelector<HTMLInputElement>('.upstream-toggle input')!.checked).toBe(true);
		expect(cfdRequests().at(-1)).toBe('/api/boards/2/cfd?days=30&upstream=true');
		// Help text on a column converted mid-window.
		expect(source('src/lib/components/board/StatsPanel.svelte')).toContain(
			'A column converted to Options during the period is left out with its band, so in this view the committed history it had before the conversion is hidden too.'
		);
	});

	it('works with storage that throws: the toggle starts off and is not kept', async () => {
		vi.stubGlobal('localStorage', {
			getItem: () => {
				throw new Error('blocked');
			},
			setItem: () => {
				throw new Error('blocked');
			},
			clear: () => {}
		});
		answer({ metrics: metricsOf(NOTHING_UPSTREAM), cfd: cfdOf({ hasUpstream: true }) });
		const target = await drawPanel(WITH_OPTIONS);
		const box = target.querySelector<HTMLInputElement>('.upstream-toggle input')!;
		expect(box.checked).toBe(false);
		box.click();
		await settle();
		expect(cfdRequests().at(-1)).toBe('/api/boards/1/cfd?days=30&upstream=true');
	});

	it('shows an ideas board its ideas, the upstream figures and the flow diagram, with no toggle and no delivery figures (J2)', async () => {
		answer({
			metrics: metricsOf({ ...NOTHING_UPSTREAM, options: 2 }, { completed: 0, committed: 0, leadTime: null, cycleTime: null }),
			cfd: cfdOf({ kind: 'ideas', hasUpstream: true, upstreamShown: true, columns: [{ id: 1, title: 'New Ideas', color: '#6366f1', upstream: true }] })
		});
		const ideas = [column(1, 'New Ideas', [card(1)]), column(2, 'Shaping', [card(2)])];
		const target = await drawPanel(ideas, 'ideas');

		expect(text(target.querySelector('.ideas-count'))).toBe('2 ideas');
		expect(target.querySelector('.upstream-toggle')).toBeNull();
		expect(cfdRequests()).toEqual(['/api/boards/1/cfd?days=30']);
		// None of the delivery tiles, bars, metrics or burndown, which would all read nothing.
		expect(tiles(target)).toEqual([]);
		expect(target.querySelector('.stats-bars')).toBeNull();
		expect(target.querySelector('.metric-head')).toBeNull();
		expect(target.querySelector('.metrics-footnote')).toBeNull();
		expect(target.querySelector('.options-line')).toBeNull();
		expect(target.textContent).not.toContain('Burndown');
		expect(fetched.mock.calls.some(([url]) => url.includes('/api/burndown'))).toBe(false);
		expect(target.querySelector('.upstream-figures')).not.toBeNull();
		expect(target.querySelector('.cfd-chart')).not.toBeNull();
	});

	it('takes an ideas board from the flow diagram’s answer where it is handed no kind (All Tasks, an ideas board with no card)', async () => {
		answer({
			metrics: metricsOf(NOTHING_UPSTREAM, { completed: 0, committed: 0, leadTime: null, cycleTime: null }),
			cfd: cfdOf({ kind: 'ideas', hasUpstream: true, upstreamShown: true, columns: [{ id: 1, title: 'New Ideas', color: '#6366f1', upstream: true }] })
		});
		const target = await drawPanel(ORDINARY.map((c) => ({ ...c, cards: [] })) as ColumnType[]);
		expect(text(target.querySelector('.ideas-count'))).toBe('0 ideas');
		expect(tiles(target)).toEqual([]);
		expect(target.querySelector('.upstream-toggle')).toBeNull();
	});

	it('counts All Tasks’ Options stand-in apart, as an options column', async () => {
		answer({ metrics: metricsOf({ ...NOTHING_UPSTREAM, options: 1 }), cfd: cfdOf({ hasUpstream: true }) });
		const standIns = [column(1, 'Options', [card(11)], 'options'), column(2, 'To Do', [card(1)]), column(3, 'Complete', [card(2)])];
		const target = await drawPanel(standIns);
		expect(tiles(target).slice(0, 2)).toEqual([['2', 'Total Cards'], ['1', 'Completed']]);
		expect([...target.querySelectorAll('.stats-bar-label')].map(text)).toEqual(['To Do', 'Complete']);
		expect(text(target.querySelector('.options-line'))).toBe('Options 1 · discard rate —');
	});

	it('says the metrics could not be loaded, with a retry that reads them again (J8)', async () => {
		let fail = true;
		fetched = vi.fn(async (url: string) => {
			if (url.includes('/metrics')) return (fail ? { ok: false, status: 500, json: async () => ({}) } : { ok: true, status: 200, json: async () => metricsOf(NOTHING_UPSTREAM) }) as Response;
			if (url.includes('/cfd')) return { ok: true, status: 200, json: async () => cfdOf() } as Response;
			return { ok: false, status: 404, json: async () => ({}) } as Response;
		});
		vi.stubGlobal('fetch', fetched);
		const target = await drawPanel(ORDINARY);

		expect(text(target.querySelector('.metrics-failed'))).toBe('Metrics could not be loaded Retry');
		expect(target.textContent).not.toContain('No completed cards in this period');
		fail = false;
		target.querySelector<HTMLButtonElement>('.metrics-retry')!.click();
		await settle();
		expect(target.querySelector('.metrics-failed')).toBeNull();
		expect(tiles(target).at(-1)).toEqual(['5', 'Committed (all)']);
	});

	it('asks for a board on All Tasks with none chosen (J8)', async () => {
		answer({ metrics: metricsOf(NOTHING_UPSTREAM), cfd: cfdOf() });
		const target = await drawPanel(ORDINARY, 'delivery', 0);
		expect(text(target.querySelector('.metrics-loading'))).toBe('Choose a board to see its delivery metrics');
		expect(fetched).not.toHaveBeenCalled();
	});

	it('draws only the answer for the box as it stands when the toggle is turned on and off before the first answer comes (J1)', async () => {
		const pending: { url: string; resolve: (body: unknown) => void }[] = [];
		fetched = vi.fn((url: string) => {
			if (url.includes('/metrics')) return Promise.resolve({ ok: true, status: 200, json: async () => metricsOf(NOTHING_UPSTREAM) } as Response);
			if (!url.includes('/cfd')) return Promise.resolve({ ok: false, status: 404, json: async () => ({}) } as Response);
			return new Promise<Response>((resolve) => pending.push({ url, resolve: (body) => resolve({ ok: true, status: 200, json: async () => body } as Response) }));
		});
		vi.stubGlobal('fetch', fetched);
		const plain = cfdOf({ hasUpstream: true, data: [day2('2026-06-20'), day2('2026-06-21')] });
		const banded = cfdOf({
			hasUpstream: true,
			upstreamShown: true,
			columns: [{ id: 9, title: 'Ideas', color: '#888888', upstream: true }, { id: 1, title: 'To Do', color: '#6366f1', upstream: false }],
			data: [day2('2026-06-20', true), day2('2026-06-21', true)]
		});
		const target = draw(StatsPanel, { boardColumns: WITH_OPTIONS, boardCategories: [], boardId: 1, boardKind: 'delivery', onClose: () => {} });
		await settle();
		pending.shift()!.resolve(plain);
		await settle();
		const box = target.querySelector<HTMLInputElement>('.upstream-toggle input')!;

		box.click(); // on: asks with upstream=true
		await settle();
		target.querySelector<HTMLInputElement>('.upstream-toggle input')!.click(); // off again
		await settle();
		expect(pending.map((p) => p.url)).toEqual(['/api/boards/1/cfd?days=30&upstream=true', '/api/boards/1/cfd?days=30']);
		// The old chart stays drawn while they load.
		expect(target.querySelector('.cfd-chart')).not.toBeNull();
		const [on, off] = pending;
		off.resolve(plain);
		await settle();
		on.resolve(banded); // the earlier answer, last
		await settle();

		expect(target.querySelector<HTMLInputElement>('.upstream-toggle input')!.checked).toBe(false);
		expect(target.querySelector('.commitment-line')).toBeNull();
		expect([...target.querySelectorAll('.cfd-legend-item')].map(text)).toEqual(['To Do']);
	});

	it('is handed the board’s kind by the board page, and the Options bucket as an options column by All Tasks', () => {
		expect(source('src/routes/board/[id]/+page.svelte')).toMatch(/<StatsPanel[\s\S]*?boardKind=\{boardState\.board\.kind\}/);
		const all = source('src/routes/all/+page.svelte');
		expect(all).toContain("role: isOptionsBucket(b) ? 'options' : null,");
		expect(all).toContain("return 'upstream' in bucket && bucket.upstream === true;");
		// The chosen board's cards, kind and Options stand-in only (J3), drawn again for another board.
		expect(all).toContain('cards: b.cards.filter((c) => !chosenBoard || c.boardId === chosenBoard) as unknown as CardType[]');
		expect(all).toContain("{@const hasOptionsColumn = data.columns.some((c) => c.boardId === chosenBoard && c.role === 'options')}");
		expect(all).toContain('{@const holdsOptions = buckets.some((b) => isOptionsBucket(b) && b.cards.some((c) => c.boardId === chosenBoard))}');
		expect(all).toContain("{@const chosenKind = chosenBoard && holdsOptions && !hasOptionsColumn ? 'ideas' : 'delivery'}");
		expect(all).toContain('{@const chosenHasUpstream = !chosenBoard || hasOptionsColumn || holdsOptions}');
		expect(all).toContain('buckets.filter((b) => !isOptionsBucket(b) || chosenHasUpstream)');
		expect(all).toMatch(/\{#key chosenBoard\}\s*<StatsPanel[\s\S]*?boardKind=\{chosenKind\}/);
	});

	it('works out its line and when to show the figures', () => {
		expect(optionsLine(0, { discardRate: 0.5 })).toBeNull();
		expect(optionsLine(3, null)).toBe('Options 3');
		expect(optionsLine(1, { discardRate: 1 / 3 })).toBe('Options 1 · discard rate 33%');
		expect(discardRateText(null)).toBe('—');
		expect(discardRateText(0)).toBe('0%');
		expect(showsUpstream(true, NOTHING_UPSTREAM)).toBe(true);
		expect(showsUpstream(false, NOTHING_UPSTREAM)).toBe(false);
		// Abandoned work is committed work: it shows on its own, not the upstream figures.
		expect(showsUpstream(false, { ...NOTHING_UPSTREAM, abandoned: 4 })).toBe(false);
		expect(showsUpstream(false, { ...NOTHING_UPSTREAM, sentOn: 1 })).toBe(true);
		expect(showsUpstream(false, NOTHING_UPSTREAM, times('1d', '1d'))).toBe(true);
	});
});

// ─── The flow diagram ────────────────────────────────────────────────────────

describe('the flow diagram’s commitment point (ruling h)', () => {
	const day = (date: string, counts: [number, number][]) => ({ date, columns: counts.map(([columnId, count]) => ({ columnId, count })) });

	it('draws no commitment point on a board with no upstream band', () => {
		const target = draw(CfdChart, {
			columns: [{ id: 1, title: 'To Do', color: '#6366f1', upstream: false }, { id: 2, title: 'Done', color: '#10b981', upstream: false }],
			data: [day('2026-06-20', [[1, 2], [2, 1]]), day('2026-06-21', [[1, 1], [2, 2]])]
		});
		expect(target.querySelector('.commitment-line')).toBeNull();
		expect(target.querySelector('.commitment-label')).toBeNull();
		expect([...target.querySelectorAll('.cfd-legend-item')].map(text)).toEqual(['To Do', 'Done']);
	});

	it('labels the top edge of the Options band "commitment point", along the options of each day', () => {
		const target = draw(CfdChart, {
			columns: [{ id: 9, title: 'Ideas', color: '#888888', upstream: true }, { id: 1, title: 'To Do', color: '#6366f1', upstream: false }],
			data: [day('2026-06-20', [[9, 3], [1, 1]]), day('2026-06-21', [[9, 1], [1, 3]])]
		});
		const line = target.querySelector('.commitment-line')!;
		expect(text(target.querySelector('.commitment-label'))).toBe('commitment point');
		// The tallest stack is 4: 3 options of 4 is 3/4 of the way up a chart 146 high from 156, 1 of 4 a quarter.
		expect(line.getAttribute('points')).toBe('30,46.5 310,119.5');
		expect([...target.querySelectorAll('.cfd-legend-item')].map(text)).toEqual(['Ideas (Options)', 'To Do']);
	});

	it('draws none on an ideas board, all of whose columns are upstream', () => {
		const target = draw(CfdChart, {
			columns: [{ id: 1, title: 'New Ideas', color: '#888888', upstream: true }, { id: 2, title: 'Shaping', color: '#6366f1', upstream: true }],
			data: [day('2026-06-20', [[1, 2], [2, 1]])]
		});
		expect(target.querySelector('.commitment-line')).toBeNull();
		expect([...target.querySelectorAll('.cfd-legend-item')].map(text)).toEqual(['New Ideas', 'Shaping']);
	});

	it('draws no commitment point with one day of data, whose label would sit on the baseline (J10)', () => {
		const target = draw(CfdChart, {
			columns: [{ id: 9, title: 'Ideas', color: '#888888', upstream: true }, { id: 1, title: 'To Do', color: '#6366f1', upstream: false }],
			data: [day('2026-06-20', [[9, 3], [1, 1]])]
		});
		expect(target.querySelector('.cfd-chart')).not.toBeNull();
		expect(target.querySelector('.commitment-line')).toBeNull();
		expect(target.querySelector('.commitment-label')).toBeNull();
	});
});

// ─── The dashboard ───────────────────────────────────────────────────────────

describe('the dashboard’s board rows', () => {
	const row = (id: number, more: Record<string, unknown>) => ({
		id,
		name: `Board ${id}`,
		emoji: '📋',
		kind: 'delivery',
		totalCards: 4,
		completedCards: 1,
		optionsCount: 0,
		tokenTotal: null,
		costUsd: null,
		lastActivity: '2026-06-01 09:00:00',
		subBoards: [],
		categoryName: null,
		categoryColor: null,
		...more
	});

	function drawTable(boards: unknown[]) {
		return draw(BoardsTable, {
			data: {
				boards,
				favouriteBoardIds: [],
				analytics: { totalBoards: boards.length, totalSubBoards: 0 },
				allTasksTotals: { cards: 4, completedCards: 1, tasks: 4, subtasks: 0, tokenTotal: null, costUsd: null }
			},
			deleting: null,
			confirmDeleteBoard: () => {},
			openBoardContextMenu: () => {},
			showCreate: false,
			expandedBoards: new Set<number>(),
			collapsedCategories: new Set<string>(),
			showCategoryManager: false
		});
	}

	const rows = (target: HTMLElement) =>
		[...target.querySelectorAll('.board-row-group .board-row')].map((r) => ({
			count: text(r.querySelector('.board-row-count')),
			title: r.querySelector('.board-row-count')?.getAttribute('title') ?? null,
			bar: r.querySelector('.progress-track') !== null,
			pct: text(r.querySelector('.progress-pct'))
		}));

	it('draws an ordinary board as before: its cards and its bar, with no title on the count', () => {
		expect(rows(drawTable([row(1, {})]))).toEqual([{ count: '4 cards', title: null, bar: true, pct: '25%' }]);
	});

	it('reads "N ideas" with no completion bar on an ideas board, and says a delivery board’s options are not counted', () => {
		const target = drawTable([row(1, { optionsCount: 2 }), row(2, { name: 'Ideas', kind: 'ideas', totalCards: 0, completedCards: 0, optionsCount: 3 })]);
		expect(rows(target)).toEqual([
			{ count: '4 cards', title: 'Committed cards only: 2 options in its Options column are not counted', bar: true, pct: '25%' },
			{ count: '3 ideas', title: null, bar: false, pct: null }
		]);
	});

	it('words a row’s count', () => {
		expect(boardRowCount({ totalCards: 1 })).toBe('1 card');
		expect(boardRowCount({ kind: 'ideas', totalCards: 0, optionsCount: 1 })).toBe('1 idea');
		expect(boardRowCount({ kind: 'ideas', totalCards: 0 })).toBe('0 ideas');
		expect(boardRowTitle({ totalCards: 3, optionsCount: 1 })).toBe('Committed cards only: 1 option in its Options column is not counted');
		expect(boardRowTitle({ totalCards: 3 })).toBeNull();
		expect([drawsCompletion({ totalCards: 0 }), drawsCompletion({ kind: 'ideas', totalCards: 0 })]).toEqual([true, false]);
		// The favourites draw their rows the same way.
		const table = source('src/lib/components/dashboard/BoardsTable.svelte');
		expect(table.match(/\{boardRowCount\(board\)\}/g)).toHaveLength(2);
		expect(table.match(/\{#if !drawsCompletion\(board\)\}/g)).toHaveLength(2);
	});

	const names = (target: HTMLElement) => [...target.querySelectorAll('.board-row-group .board-row-name')].map((n) => text(n)?.replace(/ #\d+$/, ''));

	it('keeps a board that still holds options when done boards are hidden (J5)', async () => {
		const target = drawTable([
			row(1, { name: 'Done', totalCards: 2, completedCards: 2 }),
			row(2, { name: 'Done but ideas left', totalCards: 2, completedCards: 2, optionsCount: 1 }),
			row(3, { name: 'Open' })
		]);
		target.querySelector<HTMLButtonElement>('#display-menu-btn')!.click();
		flushSync();
		[...target.querySelectorAll<HTMLButtonElement>('.hm-item')].find((b) => b.textContent?.includes('done boards'))!.click();
		flushSync();
		expect(names(target)).toEqual(['Done but ideas left', 'Open']);
	});

	it('sorts an ideas board by its ideas when sorting by Cards (J5)', () => {
		const target = drawTable([row(1, { name: 'Three cards', totalCards: 3 }), row(2, { name: 'Five ideas', kind: 'ideas', totalCards: 0, completedCards: 0, optionsCount: 5 }), row(3, { name: 'One card', totalCards: 1 })]);
		target.querySelector<HTMLButtonElement>('.bch-cards')!.click();
		flushSync();
		expect(names(target)).toEqual(['Five ideas', 'Three cards', 'One card']);
		expect(boardRowSize({ kind: 'ideas', totalCards: 0, optionsCount: 5 })).toBe(5);
	});

	it('says on the All Tasks row that its cards are committed ones, options not counted (J6)', () => {
		const target = drawTable([row(1, {})]);
		expect(target.querySelector('#all-tasks .board-row-count')?.getAttribute('title')).toBe(
			'Cards: every committed, non-archived card across all boards and sub-boards; options are not counted. Tasks: those cards plus their 0 subtasks.'
		);
	});
});

// ─── All Tasks ───────────────────────────────────────────────────────────────

describe('All Tasks’ Options bucket', () => {
	const page = source('src/routes/all/+page.svelte');

	it('is drawn as the load orders it, first, and marked as options', () => {
		expect(page).toContain('{#each buckets as bucket}');
		expect(page).toContain('<div class="column" class:column-options={isOptionsBucket(bucket)}>');
		expect(page).toMatch(/\{#if isOptionsBucket\(bucket\)\}\s*<span class="options-tag"[^>]*>not committed<\/span>/);
	});

	it('keeps its sort apart from an ordinary column called Options', () => {
		expect(page).toContain("return isOptionsBucket(bucket) ? 'options:upstream' : bucket.title;");
		expect(page).toContain('getSortedCards(bucket.cards.filter(matchesFilters), sortKey)');
		expect(page).not.toMatch(/bucketSorts\[bucket\.title\]|setBucketSort\(bucket\.title|openSortDropdown === bucket\.title/);
	});
});

// ─── Goals and the plan ──────────────────────────────────────────────────────

describe('a goal’s options', () => {
	it('follow its progress on the goals list, in neither figure', () => {
		expect(goalProgressText(1, 3)).toBe('1/3');
		expect(goalProgressText(0, 0)).toBe('no cards');
		expect(goalProgressText(1, 3, 1)).toBe('1/3 and 1 option');
		expect(goalProgressText(1, 3, 2)).toBe('1/3 and 2 options');
		expect(goalProgressText(0, 0, 2)).toBe('2 options');
		expect(source('src/routes/plan/+page.svelte')).toContain('{goalProgressText(m.doneCount, m.cardCount, m.optionsCount ?? 0)}');
	});

	function drawProgress(options: number) {
		const summary = {
			progress: { total: 3, done: 1, percent: 33, options, byColumn: [], openSubtasks: 0, totalSubtasks: 0, boards: [] },
			nextActionable: [],
			blocked: []
		};
		return draw(PlanProgress, { summary, milestone: { targetDate: null } });
	}

	it('are noted under the plan’s cards complete, and a goal with none is drawn as before', () => {
		const none = drawProgress(0);
		expect(none.querySelector('.stat-note')).toBeNull();
		expect(text(none.querySelector('.stat'))).toBe('1/3 cards complete');
		undraw();
		const some = drawProgress(2);
		expect(text(some.querySelector('.stat-note'))).toBe('and 2 options');
		expect(goalOptionsNote(undefined)).toBeNull();
		expect(goalOptionsNote(1)).toBe('and 1 option');
	});

	const node = (id: number, more: Partial<TableNode> = {}): TableNode => ({
		kind: 'card',
		id,
		title: `Card ${id}`,
		priority: 'medium',
		columnTitle: 'To Do',
		boardId: 1,
		boardName: 'Board',
		isComplete: false,
		withheld: false,
		openBlockers: [],
		downstreamCount: 0,
		onCriticalPath: false,
		...more
	});

	it('are marked Option in the work table, never Startable or Blocked, and have a filter of their own', () => {
		const plain = cardGroups([node(1), node(2, { openBlockers: [{ kind: 'card', id: 1 }] }), node(3, { isComplete: true })], [], {});
		expect(plain.map((g) => g.card.state)).toEqual(['ready', 'blocked', 'done']);
		expect(stateCounts(plain)).toEqual({ all: 3, ready: 1, blocked: 1, done: 1, option: 0 });

		const groups = cardGroups(
			[node(1), node(4, { isOption: true }), node(5, { isOption: true, openBlockers: [{ kind: 'card', id: 1 }] })],
			[],
			{}
		);
		expect(groups.map((g) => g.card.state)).toEqual(['ready', 'option', 'option']);
		expect(stateCounts(groups)).toMatchObject({ ready: 1, blocked: 0, option: 2 });
		const only = tableRows(groups, { query: '', stateFilter: 'option', sortKey: 'id', sortDir: 'asc', open: new Set() });
		expect(only.map((r) => r.id)).toEqual([4, 5]);
		const byState = tableRows(groups, { query: '', stateFilter: 'all', sortKey: 'state', sortDir: 'asc', open: new Set() });
		expect(byState.map((r) => r.state)).toEqual(['ready', 'option', 'option']);

		const table = source('src/lib/components/plan/WorkTable.svelte');
		expect(table).toContain("option: 'Option' };");
		expect(table).toContain("{#if stateCounts.option > 0 || stateFilter === 'option'}");
	});

	it('are drawn as options in the graph and on the critical path', () => {
		const base = { isComplete: false, external: false, openBlockers: [] as { kind: 'card'; id: number }[] };
		expect(nodeState(base)).toBe('ready');
		expect(nodeState({ ...base, openBlockers: [{ kind: 'card', id: 1 }] })).toBe('blocked');
		expect(nodeState({ ...base, isOption: true, openBlockers: [{ kind: 'card', id: 1 }] })).toBe('option');
		expect(nodeState({ ...base, isOption: true, isComplete: true })).toBe('complete');
		expect(nodeState({ ...base, isOption: true, external: true })).toBe('external');
		const graph = source('src/lib/components/plan/DependencyGraph.svelte');
		expect(graph).toContain('{@const state = nodeState(n)}');
		expect(graph).toContain('Option (not committed)');
		// And in the list of cards nobody has sequenced.
		expect(graph).toContain('{#if n.isOption && !n.isComplete}<span class="option-tag">option</span>{/if}');
		expect(source('src/lib/components/plan/CriticalPathPanel.svelte')).toContain('{#if n.isOption && !n.isComplete}<span class="ext-tag">option</span>{/if}');
	});

	/** A node of the plan's graph as the page hands it to the table and the graph. */
	const graphNode = (id: number, more: Record<string, unknown> = {}) => ({
		...node(id),
		layer: 0,
		blockedBy: [],
		blocks: [],
		isOption: false,
		...more
	});

	it('are marked Option in the work table as drawn, with an Options filter, and a goal with none has no such filter (J12)', () => {
		const props = (nodes: unknown[]) => ({
			data: { subtasks: {} },
			summary: { blocked: [] },
			nodes,
			milestone: { id: 1 },
			milestoneId: 1,
			openCard: () => {},
			mutate: async () => true
		});
		const plain = draw(WorkTable, props([graphNode(1)]));
		expect([...plain.querySelectorAll('.state-filter button')].map(text)).toEqual(['All 1', 'Startable 1', 'Blocked 0', 'Done 0']);
		undraw();

		const target = draw(WorkTable, props([graphNode(1), graphNode(2, { isOption: true, openBlockers: [{ kind: 'card', id: 1 }] })]));
		expect([...target.querySelectorAll('.state-chip')].map(text)).toEqual(['Startable', 'Option']);
		expect([...target.querySelectorAll('.state-filter button')].map(text)).toEqual(['All 2', 'Startable 1', 'Blocked 0', 'Done 0', 'Options 1']);
		[...target.querySelectorAll<HTMLButtonElement>('.state-filter button')].at(-1)!.click();
		flushSync();
		expect([...target.querySelectorAll('.state-chip')].map(text)).toEqual(['Option']);
	});

	it('are drawn dashed in the graph, with the legend, and tagged in the unordered list (J12)', () => {
		const nodes = [graphNode(1), graphNode(2, { isOption: true, layer: 1, blockedBy: [{ kind: 'card', id: 1 }], openBlockers: [{ kind: 'card', id: 1 }] }), graphNode(3, { isOption: true })];
		const target = draw(DependencyGraph, {
			data: { subtasks: {} },
			summary: { graph: { edges: [{ from: { kind: 'card', id: 1 }, to: { kind: 'card', id: 2 } }], unordered: [3] }, criticalPathNodes: [], blocked: [] },
			nodes,
			nodeByKey: new Map(nodes.map((n) => [`card:${n.id}`, n])),
			milestone: { id: 1 },
			openCard: () => {}
		});
		expect(target.querySelectorAll('g.node-option')).toHaveLength(target.querySelectorAll('g.node').length - 1);
		expect(text(target.querySelector('g.node-option .node-sub'))).toBe('option');
		expect([...target.querySelectorAll('.legend-item')].map(text)).toContain('Option (not committed)');
		expect(text(target.querySelector('.unordered .option-tag'))).toBe('option');
	});

	it('leave the goal Ready, and its tooltip names them (J7)', () => {
		expect(readyToCloseTitle(0)).toBe('Every card in this goal is complete — close it when you are satisfied it is delivered');
		expect(readyToCloseTitle(1)).toBe(
			'Every committed card in this goal is complete. It still holds 1 option, not committed to: commit, discard or take it out of the goal before you close it.'
		);
		expect(readyToCloseTitle(3)).toBe(
			'Every committed card in this goal is complete. It still holds 3 options, not committed to: commit, discard or take them out of the goal before you close it.'
		);
		expect(source('src/routes/plan/+page.svelte')).toContain("title={m.readyToClose ? readyToCloseTitle(m.optionsCount ?? 0) : ''}");
		expect(source('src/lib/components/plan/PlanHeader.svelte')).toContain("title={readyToClose ? readyToCloseTitle(summary.progress.options) : ''}");
	});
});

// ─── Reports ─────────────────────────────────────────────────────────────────

describe('the reports form', () => {
	it('says a report about one person leaves the upstream line out, listing what the PDF lists (J9)', () => {
		const list = 'The upstream line (options, commitments from options, discards and abandoned work) is left out';
		expect(source('src/routes/reports/+page.svelte')).toContain(`${list}: those figures describe the boards, not one person’s work.`);
		expect(source('src/lib/server/reports.ts')).toContain(`${list} of a report about one person`);
	});
});

beforeEach(() => {
	vi.unstubAllGlobals();
});
