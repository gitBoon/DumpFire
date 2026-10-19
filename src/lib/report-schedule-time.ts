/**
 * report-schedule-time.ts — when a report schedule is next sent (cards 2144
 * and 2159).
 *
 * A schedule holds a wall-clock time (`time_of_day`, `HH:MM`) and the zone it
 * is read in (`time_zone`, an IANA name such as `Europe/London`). Neither is a
 * moment. "Weekly on Monday at 09:00 Europe/London" is 08:00 UTC in summer and
 * 09:00 UTC in winter, so the next run is worked out afresh each time from now,
 * never by adding seven days to the last one. The time used to be set with
 * `setHours` on the server's own clock, so a server on UTC sent a UK schedule
 * an hour late all summer.
 *
 * - `canonicalTimeZone(value)` is a zone this server knows, by the name it
 *   gives it (`europe/london` is `Europe/London`, `Etc/UTC` is `UTC`), or null.
 * - `readTimeOfDay(text)` is `HH:MM` from 00:00 to 23:59 as hours and minutes,
 *   empty text as 09:00, or null.
 * - `nextRunAfter(timing, after)` is the schedule's first run strictly after
 *   `after`, or the fault that stops one being worked out, worded to follow
 *   "its" in a sentence: `its time of day "9" is not a time from 00:00 to
 *   23:59`. The scheduler switches a schedule with a fault off, the routes
 *   refuse one, and the Reports page shows it in place of the next run.
 * - `sameTimeDaysBefore(at, days, zone)` is the moment `zone`'s clock showed
 *   the same time `days` dates before `at`: where a scheduled report's days
 *   begin.
 *
 * A time that does not exist on the day the clocks go forward (01:30 in the UK
 * on the last Sunday in March) is sent an hour later by the clock: 02:30 BST,
 * the moment 01:30 GMT would have been. A time that happens twice on the day
 * the clocks go back is sent once, at the first. That is the rule `Temporal`
 * calls "compatible". No library: `Intl.DateTimeFormat` reads a moment's wall
 * clock in any zone, and Node carries the zone rules itself.
 *
 * Plain functions with no imports, so pages and the server use the same ones.
 */

/**
 * The zone a schedule's time is read in when none is sent, and the zone the
 * migration gave every schedule made before there was one (0058). The same
 * literal is in three places, which must agree: here, the column's DEFAULT in
 * drizzle/0058_add_report_schedule_time_zone.sql, and `.default()` in
 * src/lib/server/db/schema.ts. tests/report-schedules.test.ts holds them to it.
 */
export const DEFAULT_SCHEDULE_TIME_ZONE = 'UTC';

/** What `nextRunAfter` reads of a schedule. Each is `unknown`: a restored or hand-made row may hold anything. */
export interface ScheduleTiming {
	frequency: unknown;
	dayOfWeek: unknown;
	dayOfMonth: unknown;
	timeOfDay: unknown;
	timeZone: unknown;
}

/** The next run, or why there is none. */
export type NextRun = { at: Date } | { fault: string };

/** The longest zone name accepted. The longest Node knows is 32 characters. */
const LONGEST_ZONE = 64;

/** The most characters of a stored value a fault names. */
const LONGEST_SHOWN = 80;

/** A leading sign: an offset such as `+01:00`, `-0100`, or `−01` with the minus sign U+2212. */
const OFFSET_SIGN = /^[+\-\u2212]/;

const TIME_OF_DAY = /^([01]\d|2[0-3]):([0-5]\d)$/;
const MINUTE = 60_000;
const DAY = 24 * 60 * MINUTE;

/**
 * `value` as the zone name this server gives it, or null when it is not one.
 *
 * An offset (`+01:00`) is refused although Node accepts it: it is not a zone
 * name, it does not follow a country's clock changes, and an older browser
 * cannot read it. `Etc/GMT+1` and the like are names, and are accepted. The
 * name Node gives back is checked as well as the one sent: Node reads
 * `−01:00`, with the minus sign U+2212, as the offset `-01:00` (the review's
 * S-S2).
 *
 * Nothing is cached here: every spelling of a zone (`europe/london`,
 * `EUROPE/london`) would be a new entry. The formatters `nextRunAfter` keeps
 * are keyed by the name given back, of which there are a few hundred.
 */
export function canonicalTimeZone(value: unknown): string | null {
	if (typeof value !== 'string' || value === '' || value.length > LONGEST_ZONE) return null;
	if (OFFSET_SIGN.test(value)) return null;
	try {
		const zone = new Intl.DateTimeFormat('en-US', { timeZone: value }).resolvedOptions().timeZone;
		return OFFSET_SIGN.test(zone) ? null : zone;
	} catch {
		return null;
	}
}

/** `HH:MM` from 00:00 to 23:59 as hours and minutes, empty text as 09:00, or null for anything else. */
export function readTimeOfDay(text: unknown): { hours: number; minutes: number } | null {
	if (text === '') return { hours: 9, minutes: 0 };
	if (typeof text !== 'string') return null;
	const m = TIME_OF_DAY.exec(text);
	return m ? { hours: Number(m[1]), minutes: Number(m[2]) } : null;
}

/**
 * A stored value as a fault names it: text in quotes, anything else as it is,
 * cut to its first 80 characters with `…` after them (the review's S-N5). A
 * fault is written in an ERROR line, a 400 and on the Reports page, and a
 * restored row may hold text of any length.
 */
function shown(value: unknown): string {
	const text = typeof value === 'string' ? value : String(value);
	const characters = Array.from(text);
	const cut = characters.length > LONGEST_SHOWN ? `${characters.slice(0, LONGEST_SHOWN).join('')}…` : text;
	return typeof value === 'string' ? `"${cut}"` : cut;
}

/**
 * The first run of `timing` strictly after `after`, or the fault that stops
 * one being worked out.
 *
 * For each date, in the schedule's zone, from the day before `after`'s, the
 * schedule's time on that date is resolved to one moment by the compatible
 * rule, and the answer is the first of those moments after `after`. Each date
 * is resolved once, so a time that happens twice is never sent at its second
 * happening (the review's R2).
 *
 * What it reads (decision 6):
 *   - the frequency is `weekly` or `monthly`;
 *   - the time is empty (09:00), or `HH:MM` from 00:00 to 23:59;
 *   - a weekly day is a whole number from 0 (Sunday) to 6 (Saturday);
 *   - a monthly day is a whole number of 1 or more, and one above 28 is read
 *     as 28, so that every month has the day;
 *   - the zone is one this server knows.
 */
export function nextRunAfter(timing: ScheduleTiming, after: Date): NextRun {
	const { frequency, dayOfWeek, dayOfMonth, timeOfDay, timeZone } = timing;
	if (frequency !== 'weekly' && frequency !== 'monthly') {
		return { fault: `its frequency ${shown(frequency)} is not weekly or monthly` };
	}
	const time = readTimeOfDay(timeOfDay);
	if (!time) return { fault: `its time of day ${shown(timeOfDay)} is not a time from 00:00 to 23:59` };
	if (frequency === 'weekly' && !(Number.isInteger(dayOfWeek) && (dayOfWeek as number) >= 0 && (dayOfWeek as number) <= 6)) {
		return { fault: `its day of the week ${shown(dayOfWeek)} is not a whole number from 0 (Sunday) to 6 (Saturday)` };
	}
	if (frequency === 'monthly' && !(Number.isInteger(dayOfMonth) && (dayOfMonth as number) >= 1)) {
		return { fault: `its day of the month ${shown(dayOfMonth)} is not a whole number of 1 or more` };
	}
	const zone = canonicalTimeZone(timeZone);
	if (!zone) return { fault: `its time zone ${shown(timeZone)} is not one this server knows` };

	const from = wallClock(after.getTime(), zone);
	const runs: number[] = [];
	if (frequency === 'weekly') {
		// Fifteen dates hold two of every weekday, whatever the day before was.
		for (let k = -1; k <= 14; k++) {
			const date = new Date(Date.UTC(from.year, from.month - 1, from.day + k));
			if (date.getUTCDay() !== dayOfWeek) continue;
			runs.push(resolve(date, time.hours, time.minutes, zone));
		}
	} else {
		const day = Math.min(dayOfMonth as number, 28);
		for (let k = -1; k <= 2; k++) {
			runs.push(resolve(new Date(Date.UTC(from.year, from.month - 1 + k, day)), time.hours, time.minutes, zone));
		}
	}
	const next = runs.find((run) => run > after.getTime());
	return next === undefined ? { fault: `no run after ${after.toISOString()} could be found` } : { at: new Date(next) };
}

/**
 * The moment `timeZone`'s clock showed the same time as at `at`, `days` dates
 * earlier (card 2159, the review's O-S4): where the days a scheduled report
 * covers begin. Monday 26 October 2026, 09:00 GMT, seven days back in London
 * is Monday 19 October, 09:00 BST, which is 08:00 UTC: 6 days and 23 hours
 * before, not 7 days. A time that did not exist on that date, or happened
 * twice, is resolved as `nextRunAfter` resolves a run. A zone this server does
 * not know is read as UTC.
 */
export function sameTimeDaysBefore(at: Date, days: number, timeZone: unknown): Date {
	const zone = canonicalTimeZone(timeZone) ?? DEFAULT_SCHEDULE_TIME_ZONE;
	const ms = at.getTime();
	const clock = wallClock(ms, zone);
	const date = new Date(Date.UTC(clock.year, clock.month - 1, clock.day - days));
	// The seconds and milliseconds are carried over: the clocks change on a minute.
	const withinMinute = clock.second * 1000 + (((ms % 1000) + 1000) % 1000);
	return new Date(resolve(date, clock.hour, clock.minute, zone) + withinMinute);
}

// ─── Reading a wall clock in a zone ──────────────────────────────────────────

/** One formatter per zone, keyed by the name `canonicalTimeZone` gives. */
const formatters = new Map<string, Intl.DateTimeFormat>();

function formatterFor(zone: string): Intl.DateTimeFormat {
	let formatter = formatters.get(zone);
	if (!formatter) {
		// `h23`: midnight is 00, where `hour12: false` writes 24 in some engines.
		formatter = new Intl.DateTimeFormat('en-US', {
			timeZone: zone,
			hourCycle: 'h23',
			year: 'numeric',
			month: 'numeric',
			day: 'numeric',
			hour: 'numeric',
			minute: 'numeric',
			second: 'numeric'
		});
		formatters.set(zone, formatter);
	}
	return formatter;
}

type WallClock = { year: number; month: number; day: number; hour: number; minute: number; second: number };

/** The date and time a clock in `zone` showed at the moment `ms`. */
function wallClock(ms: number, zone: string): WallClock {
	const parts: Record<string, number> = {};
	for (const part of formatterFor(zone).formatToParts(new Date(ms))) {
		if (part.type !== 'literal') parts[part.type] = Number(part.value);
	}
	return { year: parts.year, month: parts.month, day: parts.day, hour: parts.hour, minute: parts.minute, second: parts.second };
}

/** How far `zone`'s clock is ahead of UTC at the moment `ms`, in milliseconds. */
function offsetAt(ms: number, zone: string): number {
	const c = wallClock(ms, zone);
	return Date.UTC(c.year, c.month - 1, c.day, c.hour, c.minute, c.second) - Math.floor(ms / 1000) * 1000;
}

/**
 * The moment `zone`'s clock shows `hours:minutes` on `date` (its UTC fields
 * are the date), by the compatible rule.
 *
 * The clock time is tried at the offset of the day before and of the day
 * after: whichever the clock really shows at is a moment of that time. Two
 * means the time happened twice, and the first is taken. None means the clocks
 * jumped over it, and it is read at the offset from before the jump, which is
 * the same time later by the clock.
 */
function resolve(date: Date, hours: number, minutes: number, zone: string): number {
	const local = Date.UTC(date.getUTCFullYear(), date.getUTCMonth(), date.getUTCDate(), hours, minutes);
	const before = offsetAt(local - DAY, zone);
	const after = offsetAt(local + DAY, zone);
	const shows = [local - before, local - after]
		.filter((ms) => offsetAt(ms, zone) === local - ms)
		.sort((a, b) => a - b);
	return shows.length > 0 ? shows[0] : local - before;
}
