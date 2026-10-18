/**
 * timestamps.ts — which columns hold a moment, and bringing every value in
 * them to the stored form (card 2095, decisions 9 and 13).
 *
 * The stored form is `YYYY-MM-DD HH:MM:SS`, UTC, whole seconds: see
 * `src/lib/timestamps.ts`. The code writes nothing else, but a database can
 * hold other forms all the same: values written before card 2095, when ten
 * columns were written with `toISOString()`, and whatever a restored backup
 * brings back. So `normaliseTimestamps` runs at every start, after the
 * backfills (`runMigrations`), and again after every restore
 * (`restoreFromBackup`). It is not a migration, which would run once: a
 * restore would bring the other forms back afterwards.
 *
 * This file logs nothing. The runner and the restore say what it did, once
 * their transactions are over: the logger writes to `system_logs`, which is
 * itself one of the columns converted here.
 */
import type Database from 'better-sqlite3';
import { isStamp, toStamp } from '../../timestamps';

/** A column that holds a moment: its table, and its name. */
export type TimestampColumn = { table: string; column: string };

/** What one run of `normaliseTimestamps` did, column by column (`table.column`). */
export type TimestampNormalisation = {
	/** Values rewritten in the stored form. Only columns with at least one are listed. */
	converted: Record<string, number>;
	/**
	 * Values in no form this build reads, left as they are: how many, and the
	 * first of them in sort order. Reported at every start until dealt with.
	 */
	unreadable: Record<string, { count: number; example: string }>;
	/** Why the run was rolled back and changed nothing. Null when it was not. */
	failed: string | null;
};

/** SQLite's own tables, the migration record and a rebuild's leftovers hold no moment of ours. */
const NOT_OURS = /^(sqlite_|__drizzle_migrations$|__new_)/;

/** The stored form, as a GLOB pattern. */
export const STORED_FORM_GLOB = '[0-9][0-9][0-9][0-9]-[0-9][0-9]-[0-9][0-9] [0-9][0-9]:[0-9][0-9]:[0-9][0-9]';

/**
 * The shapes the conversion recognises, as GLOB patterns: ISO 8601 with a `T`,
 * with or without a fraction or a zone; the stored form with something after
 * the seconds (a fraction, a zone); the stored form to the minute, with no
 * seconds, alone or with a zone (`2026-10-14 08:00`, which `toStamp` reads
 * and was reported as unreadable until the second P6 review); and a bare
 * date. Each is converted only
 * where `strftime` and `toStamp` read it as the same real moment, so
 * `2026-10-14Tnonsense` and `2026-02-30` are reported, not rewritten.
 */
const RECOGNISED = [
	'[0-9][0-9][0-9][0-9]-[0-9][0-9]-[0-9][0-9]T*',
	`${STORED_FORM_GLOB}?*`,
	'[0-9][0-9][0-9][0-9]-[0-9][0-9]-[0-9][0-9] [0-9][0-9]:[0-9][0-9]',
	'[0-9][0-9][0-9][0-9]-[0-9][0-9]-[0-9][0-9] [0-9][0-9]:[0-9][0-9][Z+-]*',
	'[0-9][0-9][0-9][0-9]-[0-9][0-9]-[0-9][0-9]'
];

const quoted = (name: string) => `"${name.replace(/"/g, '""')}"`;

/**
 * Every column of `database` that holds a moment (decision 13): every TEXT
 * column whose name ends in `_at`, and `system_logs.timestamp`. Every table is
 * looked at but SQLite's own, `__drizzle_migrations` and `__new_*` leftovers,
 * so a column added later is covered without being listed anywhere. Columns
 * that hold a day are named `*_date` (or `date`) and are not among them.
 */
export function timestampColumns(database: Database.Database): TimestampColumn[] {
	const tables = (
		database.prepare("SELECT name FROM sqlite_master WHERE type = 'table' ORDER BY name").all() as { name: string }[]
	)
		.map((t) => t.name)
		.filter((name) => !NOT_OURS.test(name));
	const found: TimestampColumn[] = [];
	for (const table of tables) {
		const columns = database.prepare(`PRAGMA table_info(${quoted(table)})`).all() as { name: string; type: string }[];
		for (const c of columns) {
			const named = c.name.endsWith('_at') || (table === 'system_logs' && c.name === 'timestamp');
			if (named && c.type.toUpperCase() === 'TEXT') found.push({ table, column: c.name });
		}
	}
	return found;
}

/**
 * Give `database` the two functions the conversion's SQL calls, from
 * `src/lib/timestamps.ts`, so that SQL and code read a moment by one rule (the
 * P6 review, S1): `is_stamp(v)`, 1 when `v` is a real moment in the stored
 * form and 0 otherwise, and `stamp_of(v)`, `toStamp(v)` or NULL.
 *
 * A GLOB sees only the shape, so `9999-99-99 99:99:99` passed as stored; and
 * `strftime` reads `2026-02-30` as 2 March and keeps an hour of 24, so such a
 * value was rewritten as another moment, or as one that is no moment at all.
 * The check the suite runs after every test (tests/helpers/timestamps.ts)
 * calls `is_stamp` the same way.
 */
export function registerStampFunctions(database: Database.Database): void {
	database.function('is_stamp', { deterministic: true }, (value: unknown) => (isStamp(value) ? 1 : 0));
	database.function('stamp_of', { deterministic: true }, (value: unknown) => toStamp(value, 'lower'));
}

/**
 * Bring every value in every timestamp column to the stored form, where it can
 * be read, and report the rest (decision 9).
 *
 * A value in a shape it recognises is rewritten with
 * `strftime('%Y-%m-%d %H:%M:%S', value)`, which gives UTC from an offset and
 * drops a fraction, so it still names the same moment, to the second; and only
 * where `toStamp` reads it as that same moment, which refuses a day or an hour
 * the calendar and the clock do not have. Anything else that is not NULL and
 * not a real moment in the stored form (`is_stamp`) is left exactly as it is
 * and counted, with one example.
 *
 * One immediate transaction. A failure rolls the whole of it back and is
 * returned in `failed`; this never throws, because the server runs on mixed
 * forms today and stopping it would be worse than what this fixes. A second
 * run converts nothing.
 */
export function normaliseTimestamps(database: Database.Database): TimestampNormalisation {
	registerStampFunctions(database);
	const run = database.transaction(() => {
		const converted: Record<string, number> = {};
		const unreadable: TimestampNormalisation['unreadable'] = {};
		for (const { table, column } of timestampColumns(database)) {
			const c = quoted(column);
			const t = quoted(table);
			const shapes = RECOGNISED.map((glob) => `${c} GLOB '${glob}'`).join(' OR ');
			const changes = database
				.prepare(
					`UPDATE ${t} SET ${c} = strftime('%Y-%m-%d %H:%M:%S', ${c})
					 WHERE typeof(${c}) = 'text' AND NOT ${c} GLOB '${STORED_FORM_GLOB}'
					   AND (${shapes}) AND strftime('%Y-%m-%d %H:%M:%S', ${c}) = stamp_of(${c})`
				)
				.run().changes;
			if (changes > 0) converted[`${table}.${column}`] = changes;

			const left = database
				.prepare(
					`SELECT COUNT(*) AS count, MIN(${c}) AS example FROM ${t}
					 WHERE ${c} IS NOT NULL AND NOT is_stamp(${c})`
				)
				.get() as { count: number; example: unknown };
			if (left.count > 0) unreadable[`${table}.${column}`] = { count: left.count, example: String(left.example) };
		}
		return { converted, unreadable };
	});
	try {
		return { ...run.immediate(), failed: null };
	} catch (err) {
		return { converted: {}, unreadable: {}, failed: err instanceof Error ? err.message : String(err) };
	}
}

/** `cards.completed_at 12, cards.updated_at 3`: each column converted and its count. */
export function convertedList(converted: TimestampNormalisation['converted']): string {
	return Object.entries(converted)
		.map(([column, count]) => `${column} ${count}`)
		.join(', ');
}

/** `api_keys.expires_at 1 (such as "zzz")`: each column with values left, its count and its example. */
export function unreadableList(unreadable: TimestampNormalisation['unreadable']): string {
	return Object.entries(unreadable)
		.map(([column, { count, example }]) => `${column} ${count} (such as ${JSON.stringify(example)})`)
		.join(', ');
}

/** The total of a `converted` or of counts, for a sentence. */
export function totalConverted(converted: TimestampNormalisation['converted']): number {
	return Object.values(converted).reduce((sum, n) => sum + n, 0);
}
