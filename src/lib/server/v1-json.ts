/**
 * v1-json.ts — how the public API, and the body of every webhook, give a
 * stored timestamp (card 2095, plan R1).
 *
 * The database holds every moment as `YYYY-MM-DD HH:MM:SS`, in UTC (decision
 * 7). That form names no zone, so the ordinary parser of almost every reader
 * reads it in its own: `new Date('2026-07-14 08:00:00')` on a machine set to
 * Europe/London is 07:00 UTC, an hour out for seven months of the year, and
 * PowerShell's `[datetime]` and Python's `fromisoformat` do the same. So the
 * v1 API and webhook bodies answer every stored timestamp as ISO 8601 with
 * `Z` (`2026-10-14T08:00:00.000Z`), the form `generatedAt` and a webhook's own
 * `timestamp` already had.
 *
 * - `json(data, init)` is `json` from `@sveltejs/kit`, given `onTheWire(data)`.
 *   Every handler under `src/routes/api/v1/` imports `json` from here, and
 *   `tests/timestamps.test.ts` reads the source to hold them to it.
 * - `onTheWire(data)` is a copy of `data` with each stored timestamp turned
 *   into ISO 8601. A string is turned only when both hold: its key ends in
 *   `At` or `_at`, or is `timestamp`, `from` or `to` (the activity report's
 *   `period`, and the board-history spans); and its value is exactly in the
 *   stored form. So a date (`dueDate`, `asOf`, `targetDate`) is never touched,
 *   and nor is anything a user typed, a card titled `2026-10-14 08:00:00`
 *   included. Arrays and plain objects are walked; anything else is kept as
 *   it is, and `data` itself is not changed.
 *
 * The internal tree, the page loads, the live stream and the two CSV exports
 * answer the stored form: their only readers are DumpFire's own pages, which
 * read either form with `parseStamp`, and a spreadsheet, which reads the
 * stored form as a date and time.
 */
import { json as kitJson } from '@sveltejs/kit';
import { toIso } from '$lib/timestamps';

/** Exactly the stored form: nothing before it and nothing after it. */
const STORED_FORM = /^\d{4}-\d{2}-\d{2} \d{2}:\d{2}:\d{2}$/;

/** The keys whose values are moments: `createdAt`, `last_run_at`, `timestamp`, a period's `from` and `to`. */
function namesAMoment(key: string): boolean {
	return key.endsWith('At') || key.endsWith('_at') || key === 'timestamp' || key === 'from' || key === 'to';
}

/** A value built with `{}` or `Object.create(null)`, which is walked, and not a `Date`, a `Map` or a class's object. */
function isPlainObject(value: unknown): value is Record<string, unknown> {
	if (value === null || typeof value !== 'object') return false;
	const proto = Object.getPrototypeOf(value);
	return proto === Object.prototype || proto === null;
}

/**
 * A copy of `data` in which every stored timestamp under a key that names a
 * moment is ISO 8601 with `Z`. See the module comment for the rule.
 */
export function onTheWire<T>(data: T): T {
	return walk(data, null) as T;
}

function walk(value: unknown, key: string | null): unknown {
	if (typeof value === 'string') {
		if (key === null || !namesAMoment(key) || !STORED_FORM.test(value)) return value;
		return toIso(value) ?? value;
	}
	// An array's items are under the key that holds the array: a list of
	// moments under `completedAt` is a list of moments.
	if (Array.isArray(value)) return value.map((item) => walk(item, key));
	// Built with `Object.fromEntries`, which makes every key a key of the copy:
	// assigned one by one, a key named `__proto__` (as `JSON.parse` makes it)
	// would set the copy's prototype instead, and be gone from the answer.
	if (isPlainObject(value)) {
		return Object.fromEntries(Object.entries(value).map(([name, item]) => [name, walk(item, name)]));
	}
	return value;
}

/** `json` from `@sveltejs/kit`, with every stored timestamp in `data` as ISO 8601 (`onTheWire`). */
export function json(data: unknown, init?: ResponseInit): Response {
	return kitJson(onTheWire(data), init);
}
