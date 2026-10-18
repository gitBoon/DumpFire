/**
 * What the rehearsal compares before and after the runner, and how.
 *
 * A plain module, not a test file: neither vitest configuration picks it up,
 * so copy.rehearsal.ts and tests/migrations.test.ts can both import it without
 * one of them running the other's tests (card 2106, R3).
 */
import type Database from 'better-sqlite3';
import { ONE_OFFS, type OneOff } from './one-offs';

/** What is compared before and after. */
export type State = {
	/** Rows in each table, SQLite's own tables left out. */
	rows: Record<string, number>;
	/** Each id counter in `sqlite_sequence`. */
	sequences: Record<string, number>;
	/** How many rows `PRAGMA foreign_key_check` reports. */
	violations: number;
};

/** Where `compare` writes what it found. */
export type Findings = {
	/** Why the rehearsal fails. */
	problems: string[];
	/** Worth knowing, and not a failure. */
	notes: string[];
};

export function stateOf(database: Database.Database): State {
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

/**
 * Every way `after` has less than `before`, and what it has more of.
 *
 * `applied` is the files the run applied. A table that lost rows is a problem
 * unless a one-off in `oneOffs` names it and its file is among them: then the
 * loss is what the file was written to do, and is a note. A one-off that keeps
 * its rows (`keepsRows`) excuses no loss; a run that applied it to a table
 * with rows notes what it changed.
 */
export function compare(
	before: State,
	after: State,
	applied: readonly string[],
	found: Findings,
	oneOffs: readonly OneOff[] = ONE_OFFS
): void {
	for (const [table, had] of Object.entries(before.rows)) {
		const has = after.rows[table];
		if (has === undefined) {
			// 0052 drops this one, on the understanding that nothing ever used it.
			if (table === 'time_entries' && had === 0) found.notes.push('time_entries was empty and was dropped');
			else found.problems.push(`${table} had ${had} row(s) and is gone`);
			continue;
		}
		const expected = had + (table === '__drizzle_migrations' ? applied.length : 0);
		if (has < expected) {
			const declared = oneOffs.filter((oneOff) => oneOff.table === table && !oneOff.keepsRows);
			const ran = declared.find((oneOff) => applied.includes(oneOff.file));
			if (ran) {
				found.notes.push(
					`${table} had ${had} row(s) and has ${has}: ${ran.change} by ${ran.file}, a one-off declared in tests/rehearsal/one-offs.ts`
				);
			} else if (declared.length > 0) {
				found.problems.push(
					`${table} had ${had} row(s) and has ${has}, and ${declared.map((d) => d.file).join(', ')}, ` +
						'which may take its rows, was not applied in this run'
				);
			} else {
				found.problems.push(`${table} had ${had} row(s) and has ${has}`);
			}
		} else if (has > expected) {
			found.notes.push(`${table} had ${had} row(s) and has ${has}: a migration put the others there`);
		}
	}
	for (const oneOff of oneOffs) {
		if (oneOff.keepsRows && applied.includes(oneOff.file) && (after.rows[oneOff.table] ?? 0) > 0) {
			found.notes.push(
				`${oneOff.table}: ${oneOff.change} in its ${after.rows[oneOff.table]} row(s) by ${oneOff.file}, ` +
					'a one-off declared in tests/rehearsal/one-offs.ts'
			);
		}
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
