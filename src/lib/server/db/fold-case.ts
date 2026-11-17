/**
 * Case folding for every letter, not A to Z alone (card 2843).
 *
 * SQLite's `lower()` folds A to Z only, so `lower('École')` is `École`, and a
 * search that lowered one side in SQLite and the other in JavaScript never
 * found a title or a name with a capital beyond them; one that lowered both
 * in SQLite found it typed exactly, but `école` did not find `École`.
 * `fold_case(v)` is JavaScript's `toLowerCase()`, registered on the shared
 * connection where it is opened (`db/index.ts`), so both sides of a search
 * fold by the same rule. NULL is NULL, and a value that is not text (a
 * number, a blob) is handed back unchanged.
 *
 * The connection is opened once, and a restore copies rows into it rather
 * than opening another (`db/restore.ts`), so the one registration covers the
 * server, the tests' in-memory database and what a restore leaves.
 *
 * Its users: `foldsTo` for the searches (card 2843), and `foldEquals` for
 * the people directory's three uniqueness checks, a group's name and a
 * person's address (card 2890, `people.ts`).
 */
import type Database from 'better-sqlite3';
import { sql, type SQL, type SQLWrapper } from 'drizzle-orm';

/** Give `database` `fold_case(v)`: `v.toLowerCase()` for text, NULL for NULL, anything else unchanged. */
export function registerFoldCase(database: Database.Database): void {
	database.function('fold_case', { deterministic: true }, (value: unknown) => (typeof value === 'string' ? value.toLowerCase() : value));
}

/**
 * `column` holds `text` as typed, in any case of any letter: `instr` of both
 * sides folded by `fold_case`, so no character of `text` is a wildcard and it
 * reaches SQL as a bound parameter.
 */
export function foldsTo(column: SQLWrapper, text: string): SQL {
	return sql`instr(fold_case(${column}), fold_case(${text})) > 0`;
}

/** `column` is `text` in any case of any letter (card 2890): both sides folded by `fold_case`, `text` a bound parameter. */
export function foldEquals(column: SQLWrapper, text: string): SQL {
	return sql`fold_case(${column}) = fold_case(${text})`;
}
