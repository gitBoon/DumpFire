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
 *     for each file applied, `time_entries` may go only if it was empty, and
 *     a table a migration file declares a one-off for (tests/rehearsal/one-offs.ts)
 *     may lose rows in a run that applied that file, which is noted
 *   - no id counter is lower
 *   - no more rows break a foreign key than did before
 *   - `PRAGMA integrity_check` says ok, and foreign keys are on afterwards
 *   - a second run applies nothing, rebuilds nothing and changes no row count
 *   - the timestamp conversion (card 2095) does not fail, and a second run
 *     converts nothing
 *
 * What is reported and does not fail it, because the server starts all the
 * same: a table left in the shape it has, anything that still differs from
 * the model, and timestamps in no form the conversion can read. All three are
 * for somebody to read.
 *
 * Everything found is written to the file REHEARSE_REPORT names before
 * anything is asserted, so the account survives a failure.
 */
import Database from 'better-sqlite3';
import { writeFileSync } from 'node:fs';
import { join } from 'node:path';
import { expect, it } from 'vitest';
import { runMigrations, type MigrationReport } from '$lib/server/db/migrate';
import { compare, stateOf, type State } from './compare';

const COPY = process.env.REHEARSE_DB;
const REPORT = process.env.REHEARSE_REPORT;

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
			compare(found.before, found.after, found.first.applied, found);
			// A conversion that failed was rolled back, converts nothing on either
			// run, and would pass the second-run check below (card 2095, R6).
			if (found.first.timestamps?.failed) {
				found.problems.push(`timestamps could not be brought to the stored form: ${found.first.timestamps.failed}`);
			}

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
				// The first run left every value it could read in the stored form,
				// so the second has nothing to convert. If it does, the conversion
				// writes a form it does not itself recognise as converged.
				const reconverted = Object.entries(found.second.timestamps?.converted ?? {});
				if (reconverted.length > 0) {
					found.problems.push(
						`a second run converted timestamps again: ${reconverted.map(([column, n]) => `${column} ${n}`).join(', ')}`
					);
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
