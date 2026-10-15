/**
 * A rehearsal, not a test: the migration runner taken over a copy of a real
 * database file, to see what it will do to that database before it is allowed
 * to.
 *
 * It is not part of `npm test`. `npm run rehearse` (scripts/rehearse.mjs)
 * makes the copy, runs this against it and prints what happened. The copy is
 * the only file opened for writing here. The application's own connection is
 * the in-memory one the tests use, and no server and no scheduler is started,
 * so a copy of a database that holds real schedules and credentials sends
 * nothing anywhere.
 *
 * What must hold, or the rehearsal fails:
 *
 *   - the runner does not stop
 *   - no table has fewer rows than it had. The migration record gains a row
 *     for each file applied, and `time_entries` may go only if it was empty
 *   - no id counter is lower
 *   - no more rows break a foreign key than did before
 *   - `PRAGMA integrity_check` says ok, and foreign keys are on afterwards
 *   - a second run applies nothing, rebuilds nothing and changes no row count
 *
 * What is reported and does not fail it, because the server starts all the
 * same: a table left in the shape it has, and anything that still differs from
 * the model. Both are for somebody to read.
 *
 * Everything found is written to the file REHEARSE_REPORT names before
 * anything is asserted, so the account survives a failure.
 */
import Database from 'better-sqlite3';
import { writeFileSync } from 'node:fs';
import { join } from 'node:path';
import { expect, it } from 'vitest';
import { runMigrations, type MigrationReport } from '$lib/server/db/migrate';

const COPY = process.env.REHEARSE_DB;
const REPORT = process.env.REHEARSE_REPORT;

/** What is compared before and after. */
type State = {
	/** Rows in each table, SQLite's own tables left out. */
	rows: Record<string, number>;
	/** Each id counter in `sqlite_sequence`. */
	sequences: Record<string, number>;
	/** How many rows `PRAGMA foreign_key_check` reports. */
	violations: number;
};

export type Rehearsal = {
	before: State | null;
	after: State | null;
	first: MigrationReport | null;
	second: MigrationReport | null;
	/** How long the first run took: how long the first start will take before it listens. */
	milliseconds: number | null;
	integrity: string | null;
	foreignKeysOn: boolean | null;
	/** Why the rehearsal failed. Empty if it did not. */
	problems: string[];
	/** Worth knowing, and not a failure. */
	notes: string[];
};

function stateOf(database: Database.Database): State {
	const names = (
		database.prepare("SELECT name FROM sqlite_master WHERE type = 'table' ORDER BY name").all() as { name: string }[]
	)
		.map((row) => row.name)
		.filter((name) => !name.startsWith('sqlite_'));

	const rows: Record<string, number> = {};
	for (const name of names) {
		rows[name] = (database.prepare(`SELECT COUNT(*) AS n FROM "${name.replaceAll('"', '""')}"`).get() as { n: number }).n;
	}

	const sequences: Record<string, number> = {};
	if (database.prepare("SELECT 1 FROM sqlite_master WHERE name = 'sqlite_sequence'").get()) {
		for (const row of database.prepare('SELECT name, seq FROM sqlite_sequence').all() as { name: string; seq: number }[]) {
			sequences[row.name] = Math.max(sequences[row.name] ?? 0, row.seq);
		}
	}

	return { rows, sequences, violations: (database.pragma('foreign_key_check') as unknown[]).length };
}

/** Every way `after` has less than `before`, and what it has more of. */
function compare(before: State, after: State, applied: number, found: Rehearsal): void {
	for (const [table, had] of Object.entries(before.rows)) {
		const has = after.rows[table];
		if (has === undefined) {
			// 0052 drops this one, on the understanding that nothing ever used it.
			if (table === 'time_entries' && had === 0) found.notes.push('time_entries was empty and was dropped');
			else found.problems.push(`${table} had ${had} row(s) and is gone`);
			continue;
		}
		const expected = had + (table === '__drizzle_migrations' ? applied : 0);
		if (has < expected) found.problems.push(`${table} had ${had} row(s) and has ${has}`);
		else if (has > expected) found.notes.push(`${table} had ${had} row(s) and has ${has}: a migration put the others there`);
	}
	for (const [name, was] of Object.entries(before.sequences)) {
		const is = after.sequences[name];
		// A table that was dropped takes its counter with it.
		if (is === undefined && after.rows[name] === undefined) continue;
		if (is === undefined || is < was) found.problems.push(`the id counter of ${name} was ${was} and is ${is ?? 'gone'}`);
	}
	if (after.violations > before.violations) {
		found.problems.push(`${before.violations} row(s) broke a foreign key before and ${after.violations} do now`);
	} else if (after.violations < before.violations) {
		found.notes.push(`${before.violations} row(s) broke a foreign key before and ${after.violations} do now`);
	}
}

it('takes the migration runner over the copy', () => {
	if (!COPY) throw new Error('REHEARSE_DB is not set. Run this with "npm run rehearse", which makes the copy.');

	const found: Rehearsal = {
		before: null,
		after: null,
		first: null,
		second: null,
		milliseconds: null,
		integrity: null,
		foreignKeysOn: null,
		problems: [],
		notes: []
	};

	// Opened as the application opens its database (src/lib/server/db/index.ts).
	const database = new Database(COPY, { fileMustExist: true });
	try {
		database.pragma('journal_mode = WAL');
		database.pragma('synchronous = NORMAL');
		database.pragma('foreign_keys = ON');

		found.before = stateOf(database);
		const migrationsDir = join(process.cwd(), 'drizzle');

		const started = Date.now();
		try {
			found.first = runMigrations({ database, migrationsDir });
		} catch (err) {
			found.problems.push(`the runner stopped, as the server would have: ${err instanceof Error ? err.message : String(err)}`);
		}
		found.milliseconds = Date.now() - started;

		if (found.first) {
			found.after = stateOf(database);
			compare(found.before, found.after, found.first.applied.length, found);

			try {
				found.second = runMigrations({ database, migrationsDir });
			} catch (err) {
				found.problems.push(`a second run stopped: ${err instanceof Error ? err.message : String(err)}`);
			}
			if (found.second) {
				if (found.second.applied.length > 0) {
					found.problems.push(`a second run applied ${found.second.applied.join(', ')}`);
				}
				if (found.second.rebuilt.length > 0) {
					found.problems.push(`a second run rebuilt ${found.second.rebuilt.map((table) => table.table).join(', ')}`);
				}
				const again = stateOf(database);
				for (const [table, has] of Object.entries(found.after.rows)) {
					if (again.rows[table] !== has) {
						found.problems.push(`a second run changed ${table} from ${has} row(s) to ${again.rows[table] ?? 'none'}`);
					}
				}
			}
		}

		found.integrity = database.pragma('integrity_check', { simple: true }) as string;
		if (found.integrity !== 'ok') found.problems.push(`PRAGMA integrity_check says: ${found.integrity}`);
		found.foreignKeysOn = database.pragma('foreign_keys', { simple: true }) === 1;
		if (!found.foreignKeysOn) found.problems.push('foreign keys are off on the connection afterwards');
	} finally {
		database.close();
		if (REPORT) writeFileSync(REPORT, JSON.stringify(found, null, '\t'));
	}

	expect(found.problems).toEqual([]);
});
