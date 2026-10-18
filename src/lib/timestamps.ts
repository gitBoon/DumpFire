/**
 * timestamps.ts — the one form a moment is stored in, and the three ways to
 * reach it (card 2095).
 *
 * Every timestamp column (`*_at`, and `system_logs.timestamp`) holds
 * `YYYY-MM-DD HH:MM:SS`, in UTC, to the whole second. That is what SQLite's
 * `datetime('now')` writes, and 22 columns take their value from that default,
 * so it is the form the database already had most of. Stored values are
 * compared as text, and text only orders moments correctly when both sides are
 * in the same form: `'2026-10-14 08:00:00' < '2026-10-14T00:00:00.000Z'` is
 * true, because a space sorts before `T`.
 *
 * - `stamp(date)` gives the stored form of a moment. Every write from
 *   JavaScript goes through it, and so does every bound built from "now".
 * - `toStamp(input, edge)` reads what a caller sends: the stored form, ISO 8601
 *   with or without a fraction, a `Z` or an offset, or a bare date, which is
 *   the start of that day as a lower bound and its last second as an upper
 *   one. Anything else is `null`.
 * - `parseStamp(value)` gives the `Date` a stored value names, read as UTC,
 *   from either form, or `null`.
 * - `isStamp(value)` says whether a value is a real moment in the stored form,
 *   which a pattern cannot: `2026-02-30 08:00:00` has the shape.
 * - `toIso(value)` gives the same moment as ISO 8601 with `Z`
 *   (`2026-10-14T08:00:00.000Z`), which is how the v1 API and webhook bodies
 *   answer a stored value (plan R1): a reader's ordinary parser reads the
 *   stored form, which names no zone, in its own zone.
 *
 * Plain functions with no imports, so pages and the server use the same ones.
 */

/** A moment in the stored form: `YYYY-MM-DD HH:MM:SS`, UTC. */
export type Stamp = string;

/** Which end of a range a bare date stands for. */
export type Edge = 'lower' | 'upper';

/**
 * A date, alone or with a time after a `T` or a space: the time to the minute
 * or the second, a fraction of a second of up to nine digits, and a `Z` or an
 * offset. Each part is checked for range after the match.
 */
const READABLE =
	/^(\d{4})-(\d{2})-(\d{2})(?:[T ](\d{2}):(\d{2})(?::(\d{2})(?:\.\d{1,9})?)?(Z|[+-](\d{2}):(\d{2}))?)?$/;

const pad = (n: number, width = 2) => String(n).padStart(width, '0');

/** The stored form of `date`, to the whole second; the fraction is dropped. */
export function stamp(date: Date = new Date()): Stamp {
	return (
		`${pad(date.getUTCFullYear(), 4)}-${pad(date.getUTCMonth() + 1)}-${pad(date.getUTCDate())} ` +
		`${pad(date.getUTCHours())}:${pad(date.getUTCMinutes())}:${pad(date.getUTCSeconds())}`
	);
}

/**
 * A timestamp a caller sent, in the stored form, or `null` when it is not one.
 *
 * A time with an offset is moved to UTC; a time with no zone is UTC already,
 * as the stored form is. A fraction of a second is dropped, as SQLite's
 * `strftime` drops it, so `23:59:59.999Z` is `23:59:59`. A bare date is
 * `00:00:00` that day as the `lower` end of a range and `23:59:59` as the
 * `upper` one, so a range "1 to 14 October" includes the 14th. A date that is
 * not in the calendar (`2026-02-30`) is `null`, never rolled over.
 */
export function toStamp(input: unknown, edge: Edge = 'lower'): Stamp | null {
	if (typeof input !== 'string') return null;
	const m = READABLE.exec(input);
	if (!m) return null;
	const [, y, mo, d, h, mi, s, zone, zh, zm] = m;
	const year = Number(y);
	const month = Number(mo);
	const day = Number(d);
	const dateOnly = h === undefined;
	const hour = dateOnly ? (edge === 'upper' ? 23 : 0) : Number(h);
	const minute = dateOnly ? (edge === 'upper' ? 59 : 0) : Number(mi);
	const second = dateOnly ? (edge === 'upper' ? 59 : 0) : Number(s ?? 0);
	if (month < 1 || month > 12 || day < 1 || day > daysIn(year, month)) return null;
	if (hour > 23 || minute > 59 || second > 59) return null;
	let offsetMinutes = 0;
	if (zone !== undefined && zone !== 'Z') {
		if (Number(zh) > 23 || Number(zm) > 59) return null;
		offsetMinutes = (zone.startsWith('-') ? -1 : 1) * (Number(zh) * 60 + Number(zm));
	}
	// Date.UTC reads a year below 100 as 19xx; setUTCFullYear does not.
	const moment = new Date(0);
	moment.setUTCFullYear(year, month - 1, day);
	moment.setUTCHours(hour, minute - offsetMinutes, second, 0);
	const out = moment.getUTCFullYear();
	if (out < 0 || out > 9999) return null;
	return stamp(moment);
}

/**
 * Whether `value` is a moment in the stored form: the shape, and a moment the
 * calendar and the clock have. `2026-02-30 08:00:00`, `2026-10-14 24:00:00` and
 * `9999-99-99 99:99:99` have the shape and are not; a pattern sees only the
 * shape, and SQLite's `strftime` reads the first two as other moments.
 */
export function isStamp(value: unknown): value is Stamp {
	return typeof value === 'string' && toStamp(value) === value;
}

/**
 * The moment a stored value names, read as UTC, or `null` when it is not a
 * timestamp. Either form is read, and a bare date is the start of that day.
 *
 * Built as `YYYY-MM-DDTHH:MM:SSZ` from the stored form, not by appending `Z`
 * to it: `2026-10-14 08:00:00Z` is not ECMAScript's date-time form, and older
 * Safari refuses it.
 */
export function parseStamp(value: unknown): Date | null {
	const stored = toStamp(value, 'lower');
	if (stored === null) return null;
	return new Date(`${stored.slice(0, 10)}T${stored.slice(11)}Z`);
}

/**
 * The moment a stored value names, as ISO 8601 with `Z` and a fraction of
 * `.000`, as `toISOString()` writes it, or `null` when it is not a timestamp.
 * `2026-10-14 08:00:00` is `2026-10-14T08:00:00.000Z`.
 */
export function toIso(value: unknown): string | null {
	return parseStamp(value)?.toISOString() ?? null;
}

/** Days in `month` (1 to 12) of `year`, in the proleptic Gregorian calendar. */
function daysIn(year: number, month: number): number {
	if (month === 2) return year % 4 === 0 && (year % 100 !== 0 || year % 400 === 0) ? 29 : 28;
	return [4, 6, 9, 11].includes(month) ? 30 : 31;
}
