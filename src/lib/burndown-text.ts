/**
 * burndown-text.ts — the plain-English wording for burndown figures.
 *
 * The full page, the board stats panel and the milestone panel all describe
 * the same forecast and delivery estimate; wording them in one place means a
 * figure never reads one way on the board and another on the page.
 */

import { LOW_EVIDENCE_FINISHED, type BurndownForecast, type DeliveryEstimate, type DeliveryPart, type Day } from './burndown';

export function formatDay(day: Day, year = false): string {
	return new Date(`${day}T00:00:00Z`).toLocaleDateString('en-GB', {
		day: 'numeric',
		month: 'short',
		...(year ? { year: 'numeric' } : {}),
		timeZone: 'UTC'
	});
}

export function plural(n: number, one: string, many = `${one}s`): string {
	return `${n.toLocaleString('en-GB')} ${n === 1 ? one : many}`;
}

/** A per-day rate as a readable per-week figure: "84", "3.5", "0.5". */
export function perWeek(ratePerDay: number): string {
	const w = ratePerDay * 7;
	return w >= 10 ? Math.round(w).toLocaleString('en-GB') : w.toFixed(1).replace(/\.0$/, '');
}

const UNIT = (days: number) => (days <= 13 ? 'day' : days < 70 ? 'week' : 'month');
const UNIT_DAYS: Record<string, number> = { day: 1, week: 7, month: 30.4 };

/** "10 days", "about 3 weeks", "about 4 months". */
export function durationText(days: number): string {
	const u = UNIT(days);
	const n = Math.max(1, Math.round(days / UNIT_DAYS[u]));
	return u === 'day' ? plural(n, 'day') : `about ${plural(n, u)}`;
}

/** A range in the unit of its upper end: "10–12 days", "2–3 weeks", "about 3 weeks". */
export function durationRange(from: number, to: number): string {
	const u = UNIT(to);
	const a = Math.max(1, Math.round(from / UNIT_DAYS[u]));
	const b = Math.max(1, Math.round(to / UNIT_DAYS[u]));
	if (a === b) return u === 'day' ? plural(a, 'day') : `about ${plural(a, u)}`;
	return `${a}–${b} ${u}s`;
}

export type Tone = 'good' | 'bad' | 'neutral';

/**
 * Where the open pile is heading at the recent pace — the plain-English
 * replacement for "converging" / "not converging".
 */
export function paceText(f: BurndownForecast): { value: string; sub: string; tone: Tone } {
	const days = plural(f.basisDays, 'day');
	switch (f.status) {
		case 'done':
			return { value: 'All done', sub: 'Nothing is open', tone: 'good' };
		case 'insufficient-data':
			return { value: 'Too early', sub: `Needs a week of history — has ${days}`, tone: 'neutral' };
		case 'converging':
			return {
				value: `Clears ${formatDay(f.projectedDate!)}`,
				sub: `Shrinking by about ${perWeek(f.netBurnRate)} a week`,
				tone: 'good'
			};
		case 'not-converging':
			if (f.completionRate === 0) {
				return { value: 'Stalled', sub: `Nothing finished in the last ${days}`, tone: 'bad' };
			}
			if (f.netBurnRate === 0) {
				return { value: 'Holding steady', sub: 'As much arrives as gets finished', tone: 'neutral' };
			}
			return {
				value: 'Growing',
				sub: `About ${perWeek(-f.netBurnRate)} more a week arrive than get finished`,
				tone: 'bad'
			};
	}
}

/** "How long will it take to finish what is open now?" */
export function deliveryText(d: DeliveryEstimate): { value: string; sub: string } {
	switch (d.status) {
		case 'done':
			return { value: 'Done', sub: 'Nothing left to deliver' };
		case 'estimated': {
			const value = d.p85 ? durationRange(d.p50!.days, d.p85.days) : `${durationText(d.p50!.days)}+`;
			const sub = d.p85
				? `Likely ${formatDay(d.p50!.date)} · 85% sure by ${formatDay(d.p85.date)}`
				: `Likely ${formatDay(d.p50!.date)} · the cautious end is beyond two years`;
			return { value, sub };
		}
		case 'no-pace':
			return d.method === 'slowest-board'
				? { value: 'Unknown', sub: `No board with open work has finished anything in ${plural(d.basisDays, 'day')}` }
				: { value: 'Unknown', sub: `Nothing finished in the last ${plural(d.basisDays, 'day')} to go on` };
		case 'beyond-horizon':
			return d.method === 'slowest-board' && d.bottleneck
				? { value: 'Over 2 years', sub: `${d.bottleneck.name} alone would take that long at its pace` }
				: { value: 'Over 2 years', sub: `At ${perWeek(d.throughputPerWeek / 7)} finished a week` };
		case 'insufficient-data':
			return { value: 'Too early', sub: 'Needs a week of history' };
	}
}

export interface TargetVerdict {
	tone: Tone | 'warn';
	icon: string;
	/** "On track", "Tight", "Behind", "12 days late"... */
	value: string;
	/** The one line that says why. */
	detail: string;
}

/**
 * Will it land by the target? One verdict, shared by the page and the
 * milestone panel.
 *
 * When there is a delivery estimate it leads, because "what are the odds of
 * finishing what is open by then?" is the question a target date asks. The
 * net forecast answers a different one — does the pile clear at all while
 * work keeps arriving — and showing both as separate verdicts produced "At
 * risk" beside "79% chance" for the same date. So the net view only qualifies
 * the verdict: when the pile is growing, the chance is stated as holding only
 * if nothing new is added.
 */
export function targetVerdict(
	target: { date: Day; daysLate: number | null },
	delivery: DeliveryEstimate,
	f: BurndownForecast
): TargetVerdict {
	const date = formatDay(target.date);
	if (delivery.status === 'done' || f.status === 'done') {
		return { tone: 'good', icon: '✓', value: 'Done', detail: 'Everything is finished' };
	}
	if (delivery.status === 'estimated' && delivery.chanceByTarget !== null) {
		const c = delivery.chanceByTarget;
		const growing = f.status === 'not-converging' && f.netBurnRate < 0;
		const out = leftOut(delivery).length;
		const detail =
			`${chancePercent(c)} chance by ${date}${growing ? ' if nothing new is added' : ''}` +
			(out ? `, not counting ${plural(out, 'stalled board')}` : '');
		if (c >= 0.85) return { tone: 'good', icon: '✓', value: 'On track', detail };
		if (c >= 0.5) return { tone: 'warn', icon: '~', value: 'Tight', detail };
		return { tone: 'bad', icon: '!', value: 'Behind', detail };
	}
	if (f.status === 'converging' && target.daysLate !== null) {
		return target.daysLate <= 0
			? { tone: 'good', icon: '✓', value: 'On track', detail: `Clears ${formatDay(f.projectedDate!)}, before ${date}` }
			: { tone: 'bad', icon: '!', value: `${plural(target.daysLate, 'day')} late`, detail: `Clears ${formatDay(f.projectedDate!)}, after ${date}` };
	}
	if (f.status === 'not-converging') {
		return {
			tone: 'bad',
			icon: '!',
			value: 'At risk',
			detail: f.completionRate === 0 ? `Nothing finished recently; target ${date}` : `Not clearing at the recent pace; target ${date}`
		};
	}
	return { tone: 'neutral', icon: '?', value: 'Too early to say', detail: `Target ${date}` };
}

/** "A", "A and B", "A, B and 3 more". */
export function nameList(names: string[], max = 2): string {
	if (names.length <= max) return names.length < 2 ? names.join('') : `${names.slice(0, -1).join(', ')} and ${names[names.length - 1]}`;
	return `${names.slice(0, max).join(', ')} and ${names.length - max} more`;
}

/** A pace resting on so few finished cards that it is closer to a guess. */
export function isThin(finished: number): boolean {
	return finished < LOW_EVIDENCE_FINISHED;
}

/** Boards with open work that the dates leave out, because they have no recent pace. */
export function leftOut(d: DeliveryEstimate): DeliveryPart[] {
	return d.parts.filter((p) => p.status === 'no-pace' || p.status === 'insufficient-data');
}

/**
 * The short lines that qualify a delivery estimate: which board sets the
 * date, whether that rests on thin evidence, and which boards are left out.
 */
export function deliveryNotes(d: DeliveryEstimate): string[] {
	const notes: string[] = [];
	if (d.method === 'slowest-board' && d.bottleneck && (d.status === 'estimated' || d.status === 'beyond-horizon')) {
		const b = d.bottleneck;
		notes.push(`Slowest board: ${b.name}${isThin(b.basisFinished) ? `, from only ${plural(b.basisFinished, 'finished card')}` : ''}`);
	} else if (d.status === 'estimated' && isThin(d.basisFinished)) {
		notes.push(`From only ${plural(d.basisFinished, 'finished card')}`);
	}
	const out = leftOut(d);
	if (out.length && d.status === 'estimated') {
		notes.push(`Leaves out ${nameList(out.map((p) => p.name))}: no recent pace`);
	}
	return notes;
}

/** A 0–1 chance as a whole percentage, never claiming certainty it does not have. */
export function chancePercent(chance: number): string {
	const pct = Math.round(chance * 100);
	if (chance > 0 && pct === 0) return 'under 1%';
	if (chance < 1 && pct === 100) return 'over 99%';
	return `${pct}%`;
}
