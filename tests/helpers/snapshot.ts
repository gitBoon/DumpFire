/**
 * Every row of every table, to show that a request which failed left the
 * database exactly as it was.
 *
 *     const before = snapshotDb();
 *     await api(...).catch(() => {});
 *     expectUnchanged(before);
 *
 * The id counters (`sqlite_sequence`) are part of it: a rolled-back insert
 * must not use up an id. `system_logs` is left out, with its counter, because
 * a failed request is supposed to leave a log line behind.
 */
import { sqlite } from '$lib/server/db';

type Row = Record<string, unknown>;

/** Table name to its rows, each keyed by what identifies it. */
export type DbSnapshot = Record<string, Record<string, Row>>;

const LEFT_OUT = 'system_logs';

function tableNames(): string[] {
	return (
		sqlite.prepare("SELECT name FROM sqlite_master WHERE type = 'table' ORDER BY name").all() as {
			name: string;
		}[]
	)
		.map((t) => t.name)
		.filter((name) => name !== LEFT_OUT);
}

function rowsOf(table: string): Record<string, Row> {
	const rows: Record<string, Row> = {};

	if (table === 'sqlite_sequence') {
		for (const row of sqlite.prepare('SELECT name, seq FROM sqlite_sequence ORDER BY name').all() as Row[]) {
			if (row.name !== LEFT_OUT) rows[String(row.name)] = row;
		}
		return rows;
	}

	let found: Row[];
	try {
		found = sqlite.prepare(`SELECT rowid AS "#rowid", * FROM "${table}" ORDER BY rowid`).all() as Row[];
	} catch {
		// A table declared WITHOUT ROWID has none to ask for.
		found = (sqlite.prepare(`SELECT * FROM "${table}"`).all() as Row[]).map((row, index) => ({
			'#rowid': index,
			...row
		}));
	}
	for (const { '#rowid': rowid, ...row } of found) rows[String(rowid)] = row;
	return rows;
}

/** Every row of every table but `system_logs`, id counters included. */
export function snapshotDb(): DbSnapshot {
	const snapshot: DbSnapshot = {};
	for (const table of tableNames()) snapshot[table] = rowsOf(table);
	return snapshot;
}

const show = (value: unknown) => {
	const text = JSON.stringify(value);
	return text !== undefined && text.length > 80 ? `${text.slice(0, 77)}...` : text;
};

/**
 * What differs between two snapshots, one line for each row that was added,
 * removed or changed, each naming its table. Empty when they are the same.
 */
export function diffSnapshots(before: DbSnapshot, after: DbSnapshot): string[] {
	const differences: string[] = [];
	const tables = [...new Set([...Object.keys(before), ...Object.keys(after)])].sort();

	for (const table of tables) {
		if (!(table in before)) {
			differences.push(`${table}: the table was not there before`);
			continue;
		}
		if (!(table in after)) {
			differences.push(`${table}: the table is gone`);
			continue;
		}
		const was = before[table];
		const is = after[table];
		// In `sqlite_sequence` a row is a table's id counter, known by its name.
		const what = table === 'sqlite_sequence' ? 'the id counter of' : 'row';

		for (const key of Object.keys(was)) {
			if (!(key in is)) {
				differences.push(`${table}: ${what} ${key} was removed (${show(was[key])})`);
				continue;
			}
			const changed = Object.keys({ ...was[key], ...is[key] })
				.filter((column) => JSON.stringify(was[key][column]) !== JSON.stringify(is[key][column]))
				.map((column) => `${column}: ${show(was[key][column])} became ${show(is[key][column])}`);
			if (changed.length > 0) differences.push(`${table}: ${what} ${key} changed (${changed.join('; ')})`);
		}
		for (const key of Object.keys(is)) {
			if (!(key in was)) differences.push(`${table}: ${what} ${key} was added (${show(is[key])})`);
		}
	}
	return differences;
}

/**
 * Throw unless the database is as `before` recorded it. The message names
 * each table that differs and the difference.
 *
 * `when` goes at the front of it, to say which step of a test this was.
 */
export function expectUnchanged(before: DbSnapshot, when = '', after: DbSnapshot = snapshotDb()): void {
	const differences = diffSnapshots(before, after);
	if (differences.length === 0) return;
	throw new Error(
		`${when ? `${when}: ` : ''}the database is not as it was. ${differences.length} difference(s):\n  ` +
			differences.join('\n  ')
	);
}
