/**
 * The check that every timestamp the suite leaves behind is in the stored
 * form (card 2095, decision 13).
 *
 * `otherTimestampForms(database)` names every value in a timestamp column
 * (`timestampColumns`, the rule the conversion at start-up uses) that is
 * neither NULL nor a real moment as `YYYY-MM-DD HH:MM:SS`, by the conversion's
 * own `is_stamp`: `2026-02-30 08:00:00` has the shape and is named. Run after every test, it fails the
 * test that left one, which is how a write path that still writes another form
 * is found. A test that writes another form on purpose, to test the
 * conversion, says so first with `allowOtherTimestampForms()`.
 *
 * `afterEachTimestampCheck()` is what `tests/setup.ts` runs after each test:
 * the check, then the allowance forgotten, so that it covers one test only.
 * (Wired in once no server path writes another form: plan R2.)
 */
import type Database from 'better-sqlite3';
import { registerStampFunctions, timestampColumns } from '$lib/server/db/timestamps';

let allowed = false;

/** This test writes another timestamp form on purpose: the check passes it. */
export function allowOtherTimestampForms(): void {
	allowed = true;
}

/**
 * Every value in a timestamp column of `database` that is not NULL and not in
 * the stored form, as `table.column = value`, at most five a column. Empty
 * when there is none, or when this test called `allowOtherTimestampForms()`.
 */
export function otherTimestampForms(database: Database.Database): string[] {
	if (allowed) return [];
	registerStampFunctions(database);
	const found: string[] = [];
	for (const { table, column } of timestampColumns(database)) {
		const values = database
			.prepare(`SELECT "${column}" AS value FROM "${table}" WHERE "${column}" IS NOT NULL AND NOT is_stamp("${column}") LIMIT 5`)
			.all() as { value: unknown }[];
		for (const { value } of values) found.push(`${table}.${column} = ${JSON.stringify(value)}`);
	}
	return found;
}

/**
 * The check after a test: throws naming each value in another form, unless the
 * test allowed them. Forgets the allowance either way.
 */
export function afterEachTimestampCheck(database: Database.Database): void {
	const found = otherTimestampForms(database);
	allowed = false;
	if (found.length > 0) {
		throw new Error(
			`This test left timestamps that are not in the stored form (YYYY-MM-DD HH:MM:SS, UTC): ${found.join('; ')}. ` +
				'Write them with stamp() from $lib/timestamps, or call allowOtherTimestampForms() from ' +
				'tests/helpers/timestamps.ts in a test that writes another form on purpose.'
		);
	}
}
