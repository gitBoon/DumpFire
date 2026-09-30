/**
 * burndown.ts — the burndown series, rebuilt from each card's own timestamps.
 *
 * Shared by the server (which loads the cards) and the chart (which draws the
 * result), so everything here is pure: no database, no `$lib/server`, no DOM.
 *
 * Why timestamps and not `daily_snapshots`. Snapshots are per-column card
 * counts, so they cannot be filtered to a category, a label, an assignee or a
 * milestone — the questions a burndown is usually asked. They also only exist
 * for days the server happened to be running: the development database holds
 * 18 snapshot days across five months. Every card already records when it
 * arrived, when it was completed and when it was archived, which is enough to
 * say how much work was open on any day for any subset of cards.
 *
 * Every date is a UTC calendar day (`YYYY-MM-DD`) and every count is a count
 * of cards at the END of that day — the same basis as the snapshots and the
 * activity report, so the figures agree with the rest of the product.
 */

/** A UTC calendar day, `YYYY-MM-DD`. */
export type Day = string;

/**
 * One card's life as the burndown sees it.
 *
 * `done` and `removed` are exclusive: completed work stays completed even if
 * the card is later archived, and `removed` only ever describes open work
 * that was dropped. Archiving a finished card is housekeeping, and counting
 * it as scope removed would make a burn-up chart show delivered work going
 * backwards.
 */
export interface CardLifeline {
	/** Day the card entered scope. */
	start: Day;
	/** Day it was completed, or null while it is open. */
	done: Day | null;
	/** Day open work left scope (archived without completing), or null. */
	removed: Day | null;
}

/** The state at the end of one day, and what changed during it. */
export interface BurndownPoint {
	date: Day;
	/** Cards in scope: arrived and not dropped. */
	scope: number;
	/** Of which completed. */
	done: number;
	/** scope - done: the work still to do. */
	remaining: number;
	/** Cards that arrived this day. */
	added: number;
	/** Cards completed this day. */
	completed: number;
	/** Open cards dropped this day. */
	removed: number;
}

/**
 * Totals over a window. `*Start` is the state at the START of the first day,
 * before any of its changes, so the identity
 * `remainingNow = remainingStart + added - completed - removed` always holds.
 */
export interface BurndownSummary {
	scopeStart: number;
	scopeNow: number;
	doneStart: number;
	doneNow: number;
	remainingStart: number;
	remainingNow: number;
	added: number;
	completed: number;
	removed: number;
}

export type ForecastStatus = 'done' | 'converging' | 'not-converging' | 'insufficient-data';

export interface BurndownForecast {
	status: ForecastStatus;
	/** How many days the rates below were measured over. */
	basisDays: number;
	/** Last day of the basis window — the day the projection starts from. */
	asOf: Day;
	/** Cards completed per day. */
	completionRate: number;
	/** Net scope change per day: added minus dropped. */
	scopeRate: number;
	/** Remaining work lost per day: completionRate - scopeRate. */
	netBurnRate: number;
	/** When remaining reaches zero at the net rate. Null unless converging. */
	projectedDate: Day | null;
	/** When it would reach zero if nothing more were added. */
	projectedDateNoNewScope: Day | null;
}

/** Trailing window the forecast is measured over. */
export const FORECAST_BASIS_DAYS = 28;

/** Below this many days of history a rate is noise, not a forecast. */
export const FORECAST_MIN_DAYS = 7;

/**
 * Projections further out than this are reported as not converging. A date
 * eleven years away is not a forecast anyone can act on, and printing one
 * suggests a precision that is not there.
 */
const FORECAST_HORIZON_DAYS = 5 * 365;

// ─── Day arithmetic ─────────────────────────────────────────────────────────

const DAY_MS = 86_400_000;
const DAY_RE = /^\d{4}-\d{2}-\d{2}$/;

export function isDay(value: string): boolean {
	if (!DAY_RE.test(value)) return false;
	const t = Date.parse(`${value}T00:00:00Z`);
	// Date.parse accepts 2026-02-31 and rolls it over; a round trip catches that.
	return Number.isFinite(t) && new Date(t).toISOString().slice(0, 10) === value;
}

/**
 * The UTC day of any timestamp this database holds.
 *
 * `created_at` defaults are SQLite's `2026-09-14 09:00:00` and values set from
 * JavaScript are `2026-09-14T09:00:00.000Z`. Both are UTC and both start with
 * the date, so the first ten characters are the day either way — which avoids
 * the space-versus-`T` ordering trap documented in activity-report.ts.
 */
export function toDay(timestamp: string): Day {
	return timestamp.slice(0, 10);
}

export function todayUtc(now: Date = new Date()): Day {
	return now.toISOString().slice(0, 10);
}

export function addDays(day: Day, n: number): Day {
	return new Date(Date.parse(`${day}T00:00:00Z`) + n * DAY_MS).toISOString().slice(0, 10);
}

/** Whole days from `a` to `b`; negative when `b` is earlier. */
export function daysBetween(a: Day, b: Day): number {
	return Math.round((Date.parse(`${b}T00:00:00Z`) - Date.parse(`${a}T00:00:00Z`)) / DAY_MS);
}

// ─── The series ─────────────────────────────────────────────────────────────

/**
 * Daily points from `from` to `to` inclusive.
 *
 * One pass over the cards builds a per-day delta map and the state before the
 * window, then one pass over the days accumulates it — O(cards + days)
 * whatever the window, so a two-year view costs the same as a fortnight.
 */
export function buildSeries(cards: CardLifeline[], from: Day, to: Day): BurndownPoint[] {
	if (from > to) return [];

	const deltas = new Map<Day, { added: number; completed: number; removed: number }>();
	const bump = (day: Day) => {
		let d = deltas.get(day);
		if (!d) deltas.set(day, (d = { added: 0, completed: 0, removed: 0 }));
		return d;
	};

	let scope = 0;
	let done = 0;

	for (const card of cards) {
		const start = effectiveStart(card);
		if (start > to) continue;

		if (start < from) scope++;
		else bump(start).added++;

		if (card.done !== null) {
			if (card.done > to) continue;
			if (card.done < from) done++;
			else bump(card.done).completed++;
		} else if (card.removed !== null) {
			// Never before it arrived, or scope would dip below zero for a day.
			const removed = card.removed < start ? start : card.removed;
			if (removed > to) continue;
			if (removed < from) scope--;
			else bump(removed).removed++;
		}
	}

	const points: BurndownPoint[] = [];
	for (let day = from; day <= to; day = addDays(day, 1)) {
		const d = deltas.get(day);
		const added = d?.added ?? 0;
		const completed = d?.completed ?? 0;
		const removed = d?.removed ?? 0;
		scope += added - removed;
		done += completed;
		points.push({ date: day, scope, done, remaining: scope - done, added, completed, removed });
	}
	return points;
}

/**
 * A card completed before the day it was created (an import, a clock fix)
 * is treated as arriving on its completion day, so it never counts as done
 * while not in scope.
 */
function effectiveStart(card: CardLifeline): Day {
	return card.done !== null && card.done < card.start ? card.done : card.start;
}

/** The earliest day any of these cards was in scope, or null for none. */
export function firstDay(cards: CardLifeline[]): Day | null {
	let min: Day | null = null;
	for (const c of cards) {
		const s = effectiveStart(c);
		if (min === null || s < min) min = s;
	}
	return min;
}

export function summarise(series: BurndownPoint[]): BurndownSummary {
	if (series.length === 0) {
		return {
			scopeStart: 0, scopeNow: 0, doneStart: 0, doneNow: 0,
			remainingStart: 0, remainingNow: 0, added: 0, completed: 0, removed: 0
		};
	}
	const first = series[0];
	const last = series[series.length - 1];
	let added = 0;
	let completed = 0;
	let removed = 0;
	for (const p of series) {
		added += p.added;
		completed += p.completed;
		removed += p.removed;
	}
	const scopeStart = first.scope - first.added + first.removed;
	const doneStart = first.done - first.completed;
	return {
		scopeStart,
		scopeNow: last.scope,
		doneStart,
		doneNow: last.done,
		remainingStart: scopeStart - doneStart,
		remainingNow: last.remaining,
		added,
		completed,
		removed
	};
}

// ─── The window's own view ──────────────────────────────────────────────────

/**
 * Work in play on each day: what was open when the window began, plus every
 * card added since, less every card dropped since. Equivalently, remaining
 * plus what has been finished since the start — so the gap between this line
 * and remaining is exactly the work finished in the window.
 *
 * This is what the chart plots instead of `scope`. Scope counts every card that
 * has ever existed, finished or not, and on a board with a few years of history
 * it dwarfs the work actually open: 1,812 cards against 194 remaining squashed
 * the line people care about into the bottom tenth of the chart. Work in play
 * starts at the remaining work, so both lines share one scale.
 */
export function workInPlay(series: BurndownPoint[]): number[] {
	let v = summarise(series).remainingStart;
	return series.map((p) => (v += p.added - p.removed));
}

/** Cards finished since the window began, per day — the burn-up's rising line. */
export function finishedSinceStart(series: BurndownPoint[]): number[] {
	let v = 0;
	return series.map((p) => (v += p.completed));
}

// ─── The forecast ───────────────────────────────────────────────────────────

/**
 * Where remaining is heading, from the pace over the trailing basis window.
 *
 * `basis` is a series ending on the day to project from. It should start no
 * earlier than the first card in scope — a goal carded a week ago measured
 * over 28 days would be diluted by three weeks in which nothing could have
 * happened.
 *
 * Two dates, because a Kanban board is rarely a fixed scope. The net date
 * assumes work keeps arriving at the pace it has been; the other assumes
 * nothing more is added. A board where work arrives as fast as it is finished
 * has no net date at all, and saying so is the honest answer — it is the
 * question a burndown exists to raise.
 */
export function forecast(basis: BurndownPoint[]): BurndownForecast {
	const last = basis[basis.length - 1];
	const asOf = last?.date ?? '';
	const basisDays = basis.length;

	let added = 0;
	let completed = 0;
	let removed = 0;
	for (const p of basis) {
		added += p.added;
		completed += p.completed;
		removed += p.removed;
	}

	const completionRate = basisDays > 0 ? completed / basisDays : 0;
	const scopeRate = basisDays > 0 ? (added - removed) / basisDays : 0;
	const netBurnRate = completionRate - scopeRate;
	const remaining = last?.remaining ?? 0;

	const result: BurndownForecast = {
		status: 'insufficient-data',
		basisDays,
		asOf,
		completionRate: round3(completionRate),
		scopeRate: round3(scopeRate),
		netBurnRate: round3(netBurnRate),
		projectedDate: null,
		projectedDateNoNewScope: null
	};

	// Nothing in scope is not the same as everything finished.
	if (!last || last.scope === 0) return result;
	if (remaining <= 0) return { ...result, status: 'done' };
	if (basisDays < FORECAST_MIN_DAYS) return result;

	const at = (rate: number): Day | null => {
		if (rate <= 0) return null;
		const days = Math.ceil(remaining / rate);
		return days > FORECAST_HORIZON_DAYS ? null : addDays(asOf, days);
	};

	const projectedDate = at(netBurnRate);
	return {
		...result,
		status: projectedDate ? 'converging' : 'not-converging',
		projectedDate,
		projectedDateNoNewScope: at(completionRate)
	};
}

/**
 * The forecast for a set of cards as of `to`, over the trailing basis window.
 *
 * A scope younger than the window is measured from the day AFTER its first
 * cards arrived, with that day's end state as the baseline. A goal is usually
 * carded in one burst, and counting the burst as scope growth projected
 * remaining work climbing steeply for a milestone that had not changed since
 * the day it was written down.
 */
export function forecastCards(cards: CardLifeline[], to: Day): BurndownForecast {
	return forecast(forecastBasis(cards, to));
}

/**
 * The days a pace is measured over — shared by the forecast and the delivery
 * estimate so the two can never disagree about what "recently" means. When
 * everything arrived today there is no pace yet, and the single day returned
 * still lets "done" be recognised.
 */
export function forecastBasis(cards: CardLifeline[], to: Day): BurndownPoint[] {
	const earliest = firstDay(cards);
	const trailing = addDays(to, -(FORECAST_BASIS_DAYS - 1));
	const from = earliest !== null && earliest >= trailing ? addDays(earliest, 1) : trailing;
	return buildSeries(cards, from > to ? to : from, to);
}

function round3(n: number): number {
	return Math.round(n * 1000) / 1000;
}

// ─── Time to deliver ────────────────────────────────────────────────────────

export type DeliveryStatus = 'done' | 'estimated' | 'no-pace' | 'beyond-horizon' | 'insufficient-data';

export interface DeliveryPoint {
	/** Days from `asOf`. */
	days: number;
	date: Day;
}

/**
 * "How long will it take to finish what is open now?" — as a range with
 * confidence levels, because a single date sounds more certain than any
 * forecast is.
 */
export interface DeliveryEstimate {
	status: DeliveryStatus;
	/** The open work being estimated, as of `asOf`. */
	remaining: number;
	asOf: Day;
	basisDays: number;
	/** Average finished per week over the basis. */
	throughputPerWeek: number;
	/** New work arriving per week over the basis — deliberately not in the estimate. */
	arrivalPerWeek: number;
	trials: number;
	/** Half of the simulated futures finish by here: the likely date. */
	p50: DeliveryPoint | null;
	/** 85% of them do: a date to commit to. */
	p85: DeliveryPoint | null;
	/** 95% of them do: the cautious date. */
	p95: DeliveryPoint | null;
	/** Share of simulated futures finished by the target date (0–1), when there is one. */
	chanceByTarget: number | null;
}

export const DELIVERY_TRIALS = 2000;
/** Beyond two years an estimate is not something anyone can plan around. */
const DELIVERY_HORIZON_DAYS = 730;

/**
 * Monte Carlo estimate of when the work open now will be finished.
 *
 * Each trial walks forward a day at a time, and for each future day draws the
 * number of cards finished on a randomly chosen past day of the basis, until
 * the open work is used up. Sampling real calendar days carries weekends,
 * holidays and bursty weeks into the estimate without modelling any of them.
 * The percentiles of the trials give the range.
 *
 * It estimates the work open NOW and assumes nothing new is added — that is
 * the question "how long will this take?" asks. Arrivals are reported
 * alongside so the page can say how much that assumption is carrying.
 *
 * The generator is seeded from the inputs, so the same data always gives the
 * same answer: an estimate that shifted on every refresh would not be trusted.
 */
export function estimateDelivery(
	basis: BurndownPoint[],
	opts: { trials?: number; target?: Day | null } = {}
): DeliveryEstimate {
	const trials = opts.trials ?? DELIVERY_TRIALS;
	const last = basis[basis.length - 1];
	const basisDays = basis.length;
	let added = 0;
	let removed = 0;
	let completed = 0;
	for (const p of basis) {
		added += p.added;
		removed += p.removed;
		completed += p.completed;
	}
	const result: DeliveryEstimate = {
		status: 'insufficient-data',
		remaining: last?.remaining ?? 0,
		asOf: last?.date ?? '',
		basisDays,
		throughputPerWeek: basisDays ? round3((completed / basisDays) * 7) : 0,
		arrivalPerWeek: basisDays ? round3(((added - removed) / basisDays) * 7) : 0,
		trials: 0,
		p50: null,
		p85: null,
		p95: null,
		chanceByTarget: null
	};

	if (!last || last.scope === 0) return result;
	if (last.remaining <= 0) {
		const now = { days: 0, date: last.date };
		return { ...result, status: 'done', p50: now, p85: now, p95: now, chanceByTarget: opts.target ? 1 : null };
	}
	if (basisDays < FORECAST_MIN_DAYS) return result;
	if (completed === 0) return { ...result, status: 'no-pace', chanceByTarget: opts.target ? 0 : null };

	// Far enough out on average that no percentile would be usable: skip the work.
	if (last.remaining / (completed / basisDays) > DELIVERY_HORIZON_DAYS) {
		return { ...result, status: 'beyond-horizon', chanceByTarget: opts.target ? 0 : null };
	}

	const samples = basis.map((p) => p.completed);
	const rand = mulberry32(hash(`${last.date}|${last.remaining}|${samples.join(',')}`));
	const finishes = new Float64Array(trials);
	for (let t = 0; t < trials; t++) {
		let open = last.remaining;
		let day = 0;
		while (open > 0 && day <= DELIVERY_HORIZON_DAYS) {
			open -= samples[Math.floor(rand() * samples.length)];
			day++;
		}
		finishes[t] = open > 0 ? Infinity : day;
	}
	finishes.sort();

	const at = (q: number): DeliveryPoint | null => {
		const d = finishes[Math.min(trials - 1, Math.ceil(q * trials) - 1)];
		return Number.isFinite(d) ? { days: d, date: addDays(last.date, d) } : null;
	};
	let chanceByTarget: number | null = null;
	if (opts.target) {
		const by = daysBetween(last.date, opts.target);
		let hits = 0;
		for (let t = 0; t < trials; t++) if (finishes[t] <= by) hits++;
		chanceByTarget = round3(hits / trials);
	}
	const p50 = at(0.5);
	return {
		...result,
		status: p50 ? 'estimated' : 'beyond-horizon',
		trials,
		p50,
		p85: at(0.85),
		p95: at(0.95),
		chanceByTarget
	};
}

/** FNV-1a, 32-bit: a stable seed from the inputs. */
function hash(text: string): number {
	let h = 0x811c9dc5;
	for (let i = 0; i < text.length; i++) {
		h ^= text.charCodeAt(i);
		h = Math.imul(h, 0x01000193);
	}
	return h >>> 0;
}

/** Mulberry32: small, fast and good enough for sampling — and seedable, unlike Math.random. */
function mulberry32(seed: number): () => number {
	let a = seed >>> 0;
	return () => {
		a = (a + 0x6d2b79f5) >>> 0;
		let t = a;
		t = Math.imul(t ^ (t >>> 15), t | 1);
		t ^= t + Math.imul(t ^ (t >>> 7), t | 61);
		return ((t ^ (t >>> 14)) >>> 0) / 4294967296;
	};
}

// ─── The target ─────────────────────────────────────────────────────────────

export interface BurndownTarget {
	date: Day;
	/** Where the date came from: the milestone, or the request. */
	source: 'milestone' | 'query';
	/** The ideal line runs from here to zero on `date`. */
	idealStart: { date: Day; remaining: number };
	/** Forecast lands on or before the target. Null when there is no forecast. */
	onTrack: boolean | null;
	/** Days the forecast lands after the target; negative means early. */
	daysLate: number | null;
}

export function assessTarget(
	date: Day,
	source: BurndownTarget['source'],
	series: BurndownPoint[],
	fc: BurndownForecast
): BurndownTarget {
	let onTrack: boolean | null = null;
	let daysLate: number | null = null;

	if (fc.status === 'done') {
		onTrack = true;
	} else if (fc.status === 'converging' && fc.projectedDate) {
		daysLate = daysBetween(date, fc.projectedDate);
		onTrack = daysLate <= 0;
	} else if (fc.status === 'not-converging') {
		onTrack = false;
	}

	// The plan starts when the work did. A window that opens before any card
	// existed would otherwise draw the ideal from zero to zero along the axis.
	const { remainingStart } = summarise(series);
	let idealStart = { date: series[0]?.date ?? date, remaining: remainingStart };
	if (remainingStart === 0) {
		const firstWork = series.find((p) => p.remaining > 0);
		if (firstWork) idealStart = { date: firstWork.date, remaining: firstWork.remaining };
	}

	return { date, source, idealStart, onTrack, daysLate };
}

/**
 * The ideal line's value on a given day: a straight line from the remaining
 * work at the start of the window to zero on the target date. Null outside
 * that span, where there is no ideal to draw.
 */
export function idealRemaining(target: BurndownTarget, day: Day): number | null {
	const span = daysBetween(target.idealStart.date, target.date);
	if (span <= 0) return null;
	const t = daysBetween(target.idealStart.date, day);
	if (t < 0 || t > span) return null;
	return target.idealStart.remaining * (1 - t / span);
}

// ─── The response ───────────────────────────────────────────────────────────

export type BurndownScopeKind = 'workspace' | 'boards' | 'boardCategory' | 'milestone';
export type BurndownGroupBy = 'none' | 'board' | 'category' | 'label' | 'assignee' | 'priority';

export const PRIORITIES = ['critical', 'high', 'medium', 'low'] as const;

export interface BurndownBoardRef {
	id: number;
	name: string;
	emoji: string;
}

/**
 * One slice of the scope, for the breakdown table. Series are bare arrays
 * aligned to the top-level series dates — twenty groups of full points over a
 * year would be half a megabyte of JSON to draw sparklines.
 */
export interface BurndownGroup {
	key: string;
	kind: Exclude<BurndownGroupBy, 'none'>;
	/** The value to filter on to drill in; null for "none" buckets. */
	id: number | string | null;
	name: string;
	color: string | null;
	cardCount: number;
	remaining: number[];
	scope: number[];
	summary: BurndownSummary;
	forecast: BurndownForecast;
	delivery: DeliveryEstimate;
}

/** A value offered in a filter, with how many in-scope cards carry it. */
export interface BurndownOption {
	id: number | string;
	name: string;
	color: string | null;
	count: number;
}

export interface BurndownResult {
	scope: {
		kind: BurndownScopeKind;
		label: string;
		boards: BurndownBoardRef[];
		boardCategory: { id: number; name: string; color: string } | null;
		milestone: {
			id: number;
			name: string;
			targetDate: string | null;
			status: string;
			boardId: number | null;
			createdAt: string;
		} | null;
	};
	filters: {
		categoryIds: (number | 'none')[];
		labelIds: number[];
		assigneeIds: (number | 'none')[];
		priorities: string[];
	};
	range: { from: Day; to: Day; days: number };
	series: BurndownPoint[];
	summary: BurndownSummary;
	forecast: BurndownForecast;
	/** How long the work open now will take to finish, as a range. */
	delivery: DeliveryEstimate;
	target: BurndownTarget | null;
	groupBy: BurndownGroupBy;
	groups: BurndownGroup[];
	/** Filter values present in the scope, before filters apply. Only on request. */
	options?: {
		categories: BurndownOption[];
		labels: BurndownOption[];
		assignees: BurndownOption[];
		priorities: BurndownOption[];
	};
	meta: {
		basis: 'card-timestamps';
		timezone: 'UTC';
		/** Cards that pass the scope and filters, whether or not open in range. */
		cardCount: number;
		/** In a Complete column with no completion stamp; last update used. */
		inferredCompletionDates: number;
		/** Of those, how many have that stand-in date inside the window. */
		inferredInWindow: number;
		/** Completed once, since moved out of Complete; charted as open. */
		reopenedCards: number;
		/** Completed and since archived; still counted as done. */
		archivedDoneCards: number;
		/** Plain-English caveats that apply to this particular result. */
		notes: string[];
		generatedAt: string;
	};
}
