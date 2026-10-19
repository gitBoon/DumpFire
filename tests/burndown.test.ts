/**
 * One answer to "when does it finish" on a burndown that spans boards
 * (card 1968).
 *
 *   - The pooled net forecast was worked over every card in scope, while Time
 *     to deliver dates each board at its own pace once the cards sit on more
 *     than one board. On two boards the page said "Clears 17 Nov" beside "about
 *     3 months, likely 1 Jan" for the same work.
 *   - Now the forecast carries `spansBoards`, decided on the cards that pass
 *     the filters by the same helper the delivery estimate splits on. Across
 *     boards the pace is worded as a direction and a rate with no date, and the
 *     target verdict never falls back to the pooled date.
 *   - The API keeps every field and value it answered and gains the flag.
 *
 * The wording functions are pure and called directly; the wiring goes through
 * `api()` with cards given past timestamps and a fixed past `to`, so nothing
 * depends on today's date. What the page and the chart draw from the flag is
 * not run here (no DOM).
 *
 * The plan is `docs/planning/card-1968-burndown-forecast.md` (section 6).
 */
import { beforeEach, describe, expect, it, vi } from 'vitest';
import { readFileSync } from 'node:fs';
import { join } from 'node:path';
import type { SessionUser } from '$lib/server/auth';
import {
	addDays,
	assessTarget,
	buildSeries,
	estimateDelivery,
	estimateDeliveryByParts,
	forecast,
	forecastBasis,
	type BurndownForecast,
	type CardLifeline,
	type Day,
	type DeliveryEstimate
} from '$lib/burndown';
import { paceText, targetVerdict } from '$lib/burndown-text';
import { BURNDOWN_PARAMS, parseBurndownQuery } from '$lib/server/burndown';
import { load as loadBurndownPage } from '../src/routes/burndown/+page.server';
import { pageLoad } from './helpers/actions';
import { api } from './helpers/api';
import { makeBoard, makeCard, makeUser, resetDb, type BoardFixture } from './helpers/fixtures';

// ─── The worked example ─────────────────────────────────────────────────────

/** The last day of the 28-day basis: 17 Sep to 14 Oct 2026. */
const AS_OF: Day = '2026-10-14';
const FIRST: Day = addDays(AS_OF, -27);
const BEFORE: Day = '2026-09-01';

/**
 * Board A: 10 open at the end, 2 finished every day, 1 arriving every day.
 * Board B: `openB` open at the end, 1 finished every other day from the first,
 * none arriving. The simulation is seeded from the days, so these give the
 * plan's figures exactly.
 */
function workedExample(openB = 40): { a: CardLifeline[]; b: CardLifeline[] } {
	const a: CardLifeline[] = [];
	// 10 open + 56 finished - 28 arrived were there before the basis began.
	const before = Array.from({ length: 38 }, () => ({ start: BEFORE, done: null as Day | null, removed: null }));
	const arrived = Array.from({ length: 28 }, (_, i) => ({ start: addDays(FIRST, i), done: null as Day | null, removed: null }));
	// Two finished a day: the older cards first, then the earliest arrivals.
	const queue = [...before, ...arrived];
	for (let i = 0; i < 28; i++) {
		queue[2 * i].done = addDays(FIRST, i);
		queue[2 * i + 1].done = addDays(FIRST, i);
	}
	a.push(...queue);

	const b: CardLifeline[] = Array.from({ length: openB + 14 }, () => ({ start: BEFORE, done: null as Day | null, removed: null }));
	for (let i = 0; i < 14; i++) b[i].done = addDays(FIRST, 2 * i);
	return { a, b };
}

/** What getBurndown works out for two boards, from the same functions. */
function figures(openB = 40, target: Day | null = null) {
	const { a, b } = workedExample(openB);
	const all = [...a, ...b];
	const basis = forecastBasis(all, AS_OF);
	const pooled = estimateDelivery(basis, { target });
	const delivery = estimateDeliveryByParts(
		[
			{ key: 'board:1', name: 'Board A', basis: forecastBasis(a, AS_OF) },
			{ key: 'board:2', name: 'Board B', basis: forecastBasis(b, AS_OF) }
		],
		pooled,
		{ target }
	);
	const series = buildSeries(all, FIRST, AS_OF);
	return {
		flagged: forecast(basis, { spansBoards: true }),
		unflagged: forecast(basis),
		delivery,
		series
	};
}

/** A day written as the page writes one: "17 Nov", "1 Jan". */
const DATE_WORDS = /\d{1,2} [A-Z][a-z]{2}/;

describe('the forecast is marked, never changed', () => {
	it('answers every figure the same with and without spansBoards', () => {
		const { flagged, unflagged } = figures();
		expect(flagged.spansBoards).toBe(true);
		expect(unflagged.spansBoards).toBe(false);
		const { spansBoards: _a, ...withFlag } = flagged;
		const { spansBoards: _b, ...withoutFlag } = unflagged;
		expect(withFlag).toEqual(withoutFlag);
	});
});

describe('the worked example: two boards', () => {
	it('pools to 17 Nov while the slowest board is likely 1 Jan', () => {
		const { flagged, delivery } = figures();
		expect(flagged.status).toBe('converging');
		expect(flagged.projectedDate).toBe('2026-11-17');
		expect(flagged.projectedDateNoNewScope).toBe('2026-11-03');
		expect(delivery.method).toBe('slowest-board');
		expect(delivery.bottleneck?.name).toBe('Board B');
		expect(delivery.p50?.date).toBe('2027-01-01');
		expect(delivery.p85?.date).toBe('2027-01-11');
	});

	it('words a shrinking pile across boards with no date', () => {
		const pace = paceText(figures().flagged);
		expect(pace.value).toBe('Shrinking');
		expect(pace.sub).toBe('About 11 more a week get finished than arrive');
		expect(pace.tone).toBe('good');
		expect(pace.value).not.toMatch(DATE_WORDS);
		expect(pace.sub).not.toMatch(DATE_WORDS);
	});

	it('keeps the date on a single board', () => {
		expect(paceText(figures().unflagged)).toEqual({
			value: 'Clears 17 Nov',
			sub: 'Shrinking by about 11 a week',
			tone: 'good'
		});
	});
});

describe('every other pace reads the same either way', () => {
	const base: BurndownForecast = {
		status: 'not-converging',
		basisDays: 28,
		asOf: AS_OF,
		completionRate: 1,
		scopeRate: 2,
		netBurnRate: -1,
		projectedDate: null,
		projectedDateNoNewScope: '2026-11-01',
		spansBoards: false
	};
	const cases: [string, Partial<BurndownForecast>, string][] = [
		['growing', {}, 'Growing'],
		['holding steady', { scopeRate: 1, netBurnRate: 0 }, 'Holding steady'],
		['stalled', { completionRate: 0, scopeRate: 0, netBurnRate: 0, projectedDateNoNewScope: null }, 'Stalled'],
		['too early', { status: 'insufficient-data', basisDays: 3, projectedDateNoNewScope: null }, 'Too early'],
		['done', { status: 'done', projectedDateNoNewScope: null }, 'All done']
	];
	for (const [name, change, value] of cases) {
		it(name, () => {
			const single = paceText({ ...base, ...change });
			const several = paceText({ ...base, ...change, spansBoards: true });
			expect(single.value).toBe(value);
			expect(several).toEqual(single);
		});
	}
});

describe('the target verdict', () => {
	it('with a 1 Dec target is Behind at 0% on one board or several', () => {
		const { flagged, unflagged, delivery, series } = figures(40, '2026-12-01');
		const target = assessTarget('2026-12-01', 'query', series, flagged);
		for (const f of [flagged, unflagged]) {
			expect(targetVerdict(target, delivery, f)).toMatchObject({ value: 'Behind', detail: '0% chance by 1 Dec' });
		}
	});

	it('across boards, a slowest board beyond two years is Behind, never the pooled date', () => {
		// Variant B: 400 open on board B. B alone needs 800 days; the pooled pile
		// clears on 15 Jul 2027, well before a target of 31 Dec 2027.
		const { flagged, unflagged, delivery, series } = figures(400, '2027-12-31');
		expect(delivery.status).toBe('beyond-horizon');
		expect(flagged.status).toBe('converging');
		expect(flagged.projectedDate).toBe('2027-07-15');
		const target = assessTarget('2027-12-31', 'query', series, flagged);
		expect(target.daysLate).toBeLessThan(0);

		const verdict = targetVerdict(target, delivery, flagged);
		expect(verdict).toMatchObject({
			tone: 'bad',
			value: 'Behind',
			// A target more than a year out is written with its year.
			detail: 'Board B alone would take over two years; target 31 Dec 2027'
		});
		expect(verdict.detail).not.toContain('Clears');

		// One board keeps the verdict it had: the net date before the target.
		expect(targetVerdict(target, delivery, unflagged)).toMatchObject({
			value: 'On track',
			detail: 'Clears 15 Jul, before 31 Dec 2027'
		});
	});

	it('across boards, a target beyond the two-year horizon is Too early to say, not Behind', () => {
		// Board B alone needs about 800 days; a target of 30 Jun 2029 is 990 days
		// out, past what the estimate can see, so it cannot be called behind.
		const { flagged, delivery, series } = figures(400, '2029-06-30');
		expect(delivery.status).toBe('beyond-horizon');
		const target = assessTarget('2029-06-30', 'query', series, flagged);
		expect(targetVerdict(target, delivery, flagged)).toMatchObject({
			tone: 'neutral',
			value: 'Too early to say',
			detail: 'Board B alone would take over two years; target 30 Jun 2029'
		});
	});

	it('across boards, open work on a board too new to have a pace is Too early to say', () => {
		// Board A finished all its work in the basis; board B's five cards arrived
		// three days ago. The pooled pile converges on A's pace, but the only open
		// work is B's, which has no week of history.
		const a: CardLifeline[] = Array.from({ length: 20 }, (_, i) => ({ start: BEFORE, done: addDays(FIRST, i), removed: null }));
		const b: CardLifeline[] = Array.from({ length: 5 }, () => ({ start: addDays(AS_OF, -2), done: null, removed: null }));
		const basis = forecastBasis([...a, ...b], AS_OF);
		const target = '2026-12-31';
		const delivery = estimateDeliveryByParts(
			[
				{ key: 'board:1', name: 'Board A', basis: forecastBasis(a, AS_OF) },
				{ key: 'board:2', name: 'Board B', basis: forecastBasis(b, AS_OF) }
			],
			estimateDelivery(basis, { target }),
			{ target }
		);
		const flagged = forecast(basis, { spansBoards: true });
		expect(delivery.status).toBe('insufficient-data');
		expect(flagged.status).toBe('converging');

		const assessed = assessTarget(target, 'query', buildSeries([...a, ...b], FIRST, AS_OF), flagged);
		const verdict = targetVerdict(assessed, delivery, flagged);
		expect(verdict).toMatchObject({ value: 'Too early to say', detail: 'Target 31 Dec' });
		// On one board the same figures would read as the net date.
		expect(targetVerdict(assessed, delivery, { ...flagged, spansBoards: false }).detail).toMatch(/^Clears /);
	});

	it('across boards, no board with open work having a pace is At risk', () => {
		// Nothing finished on either board, but open work being dropped on A:
		// the pooled pile shrinks, so the pooled forecast converges.
		const a: CardLifeline[] = Array.from({ length: 20 }, (_, i) => ({
			start: BEFORE,
			done: null,
			removed: i < 7 ? addDays(FIRST, i * 3) : null
		}));
		const b: CardLifeline[] = Array.from({ length: 10 }, () => ({ start: BEFORE, done: null, removed: null }));
		const basis = forecastBasis([...a, ...b], AS_OF);
		const target = '2026-12-31';
		const delivery = estimateDeliveryByParts(
			[
				{ key: 'board:1', name: 'Board A', basis: forecastBasis(a, AS_OF) },
				{ key: 'board:2', name: 'Board B', basis: forecastBasis(b, AS_OF) }
			],
			estimateDelivery(basis, { target }),
			{ target }
		);
		const flagged = forecast(basis, { spansBoards: true });
		expect(delivery.status).toBe('no-pace');
		expect(flagged.status).toBe('converging');

		const assessed = assessTarget(target, 'query', buildSeries([...a, ...b], FIRST, AS_OF), flagged);
		expect(targetVerdict(assessed, delivery, flagged)).toMatchObject({
			tone: 'bad',
			value: 'At risk',
			detail: 'Nothing finished lately on the boards with open work; target 31 Dec'
		});
		// The pile shrinks only by dropped work: the pace is not worded as good news.
		expect(paceText(flagged, delivery)).toMatchObject({ value: 'Shrinking', tone: 'neutral' });
		expect(paceText(flagged).tone).toBe('good');
	});
});

// ─── Through the API ────────────────────────────────────────────────────────

describe('GET /api/v1/burndown', () => {
	let owner: SessionUser;
	let A: BoardFixture;
	let B: BoardFixture;
	const TO = '2026-03-31';

	/** A card that was there before the basis began, open or finished in March. */
	function card(board: BoardFixture, priority: string, finished: string | null = null) {
		makeCard(board.cols[finished ? 'Complete' : 'To Do'], {
			priority,
			createdAt: '2026-02-01 09:00:00',
			updatedAt: finished ?? '2026-02-01 09:00:00',
			completedAt: finished
		});
	}

	beforeEach(() => {
		resetDb();
		owner = makeUser();
		A = makeBoard({ owner, name: 'A' });
		B = makeBoard({ owner, name: 'B' });
		for (let i = 0; i < 3; i++) card(A, 'high');
		for (let i = 0; i < 2; i++) card(A, 'medium');
		for (let i = 0; i < 4; i++) card(A, 'high', `2026-03-${10 + i} 12:00:00`);
		for (let i = 0; i < 3; i++) card(B, 'low');
		card(B, 'medium');
		for (let i = 0; i < 2; i++) card(B, 'low', `2026-03-${20 + i} 12:00:00`);
	});

	async function burndown(query: string) {
		const res = await api('GET', `/api/v1/burndown?${query}&to=${TO}`, { user: owner });
		expect(res.status).toBe(200);
		return res.body;
	}

	it('marks a forecast over two boards, and still answers its dates', async () => {
		const body = await burndown(`boardIds=${A.board.id},${B.board.id}`);
		expect(body.forecast.spansBoards).toBe(true);
		expect(body.delivery.method).toBe('slowest-board');
		expect(body.forecast).toHaveProperty('projectedDate');
		expect(body.forecast).toHaveProperty('projectedDateNoNewScope');
	});

	it('does not mark one board', async () => {
		const body = await burndown(`boardIds=${A.board.id}`);
		expect(body.forecast.spansBoards).toBe(false);
		expect(body.delivery.method).toBe('pooled');
	});

	it('decides on the cards the filters leave, as the delivery estimate does', async () => {
		// Two boards in scope, but only board A has a high-priority card.
		const body = await burndown(`boardIds=${A.board.id},${B.board.id}&priorities=high`);
		expect(body.forecast.spansBoards).toBe(false);
		expect(body.delivery.method).toBe('pooled');
	});

	it('judges each breakdown row on its own cards', async () => {
		const byBoard = await burndown(`boardIds=${A.board.id},${B.board.id}&groupBy=board`);
		expect(byBoard.groups.map((g: { forecast: BurndownForecast }) => g.forecast.spansBoards)).toEqual([false, false]);

		const byPriority = await burndown(`boardIds=${A.board.id},${B.board.id}&groupBy=priority`);
		const spans = Object.fromEntries(
			byPriority.groups.map((g: { id: string; forecast: BurndownForecast; delivery: DeliveryEstimate }) => [
				g.id,
				[g.forecast.spansBoards, g.delivery.method]
			])
		);
		expect(spans).toEqual({
			high: [false, 'pooled'],
			medium: [true, 'slowest-board'],
			low: [false, 'pooled']
		});
	});
});

// ─── The page's address (card 2242) ─────────────────────────────────────────

/**
 * A URL tracked as SvelteKit tracks a server load's `url`
 * (`make_trackable`, `node_modules/@sveltejs/kit/src/utils/url.js`): `get`,
 * `getAll` and `has` on `searchParams` make the one name read a dependency;
 * any other use of `searchParams` (iterating it, copying it, `toString`), or
 * `href`, `search` or `toString` on the URL, makes the whole address one.
 */
function trackedUrl(href: string) {
	const real = new URL(href, 'http://localhost');
	const tracked = { names: new Set<string>(), whole: [] as string[] };
	const url = new URL(real);
	Object.defineProperty(url, 'searchParams', {
		value: new Proxy(real.searchParams, {
			get(params, key) {
				if (key === 'get' || key === 'getAll' || key === 'has') {
					return (name: string, ...rest: unknown[]) => {
						tracked.names.add(name);
						return (params[key] as (...a: unknown[]) => unknown)(name, ...rest);
					};
				}
				tracked.whole.push(`searchParams.${String(key)}`);
				const value = Reflect.get(params, key);
				return typeof value === 'function' ? value.bind(params) : value;
			}
		})
	});
	for (const property of ['href', 'pathname', 'search', 'toString', 'toJSON'] as const) {
		Object.defineProperty(url, property, {
			get() {
				tracked.whole.push(property);
				return real[property];
			}
		});
	}
	return { url, tracked };
}

describe('the burndown page keeps its view in the address (card 2242)', () => {
	let owner: SessionUser;
	let A: BoardFixture;

	beforeEach(() => {
		resetDb();
		owner = makeUser();
		A = makeBoard({ owner, name: 'A' });
		makeCard(A.cols['To Do'], { createdAt: '2026-02-01 09:00:00', updatedAt: '2026-02-01 09:00:00' });
	});

	it('the load reads its parameters by name, so the burndown / burn-up switch is not a dependency', async () => {
		// Copying the whole query made the whole address a dependency, so a
		// switch written with goto would have recomputed the chart.
		const { url, tracked } = trackedUrl(`/burndown?view=burnup&boardIds=${A.board.id}&groupBy=label`);
		const data = (await loadBurndownPage({ locals: { user: owner }, url } as never)) as { result: unknown };
		expect(data.result).not.toBeNull();
		expect(tracked.whole).toEqual([]);
		expect(tracked.names.has('view')).toBe(false);
		expect([...tracked.names].filter((name) => !BURNDOWN_PARAMS.includes(name))).toEqual([]);
	});

	it('BURNDOWN_PARAMS is exactly the names parseBurndownQuery reads, set or not', () => {
		const query =
			`boardIds=${A.board.id}&milestoneId=2&categoryIds=none&labelIds=3&assigneeIds=me&priorities=high` +
			'&days=30&to=2026-03-31&target=none&groupBy=label&options=true&view=burnup&other=1';
		for (const href of [`/burndown?${query}`, '/burndown']) {
			const { url, tracked } = trackedUrl(href);
			parseBurndownQuery(url.searchParams, owner);
			expect(tracked.whole, href).toEqual([]);
			expect([...tracked.names].sort(), href).toEqual([...BURNDOWN_PARAMS].sort());
		}
	});

	it('gives the same chart with or without view in the address', async () => {
		const query = `boardIds=${A.board.id}&groupBy=label&to=2026-03-31`;
		// One moment for both, as the result carries the time it was made.
		vi.useFakeTimers({ toFake: ['Date'] });
		vi.setSystemTime(new Date('2026-10-19T12:00:00Z'));
		const [plain, burnup] = await (async () => {
			try {
				return [await pageLoad(`/burndown?${query}`, { user: owner }), await pageLoad(`/burndown?view=burnup&${query}`, { user: owner })];
			} finally {
				vi.useRealTimers();
			}
		})();
		expect(plain.type).toBe('data');
		expect((burnup as { data: { result: unknown } }).data.result).toEqual((plain as { data: { result: unknown } }).data.result);
	});

	it('the switch is written with goto and replaceState, never a shallow replaceState, and view is read from the address', () => {
		// A shallow replaceState never changes page.url and keeps the arrival
		// address in the history entry, so Back to the page showed burndown,
		// and the next nav() dropped view (card 2240's fault, on this page).
		const script = /<script lang="ts">([\s\S]*?)<\/script>/.exec(readFileSync(join(process.cwd(), 'src/routes/burndown/+page.svelte'), 'utf8'))![1];
		expect(script).not.toMatch(/import \{[^}]*\breplaceState\b[^}]*\} from '\$app\/navigation';/);
		expect(script).not.toMatch(/(?<![.\w])replaceState\(/);
		expect(script).toContain('goto(url, { replaceState: true, keepFocus: true, noScroll: true })');
		expect(script).toContain("const view = $derived($page.url.searchParams.get('view') === 'burnup' ? 'burnup' : 'burndown');");
		expect(script).not.toMatch(/\bview = v\b/);
	});
});
