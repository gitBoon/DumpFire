/**
 * Count the writes a request makes, and make one of them fail.
 *
 *     const writes = failingWrite();
 *     await api('PUT', `/api/cards/${card.id}`, { user, body });
 *     writes.count;                 // how many statements changed the database
 *
 *     writes.failNth(2);            // the second write from now throws
 *     await api(...).catch(() => {});
 *     writes.fired;                 // true: the request got as far as that write
 *     writes.restore();
 *
 * It wraps the connection's `prepare` and `exec`, and the `run`, `get`, `all`
 * and `iterate` of every statement prepared while it is installed. Drizzle
 * prepares a statement for every query and keeps none, so its writes are seen
 * too; a statement prepared once and run in a loop is counted each time it
 * runs. A statement prepared before this was installed is not seen.
 *
 * What counts as a write is a statement SQLite does not call read-only
 * (`stmt.readonly === false`), so an `UPDATE ... RETURNING` read with `.get()`
 * counts and a `SELECT` does not. `exec` always counts: it is given SQL text
 * and reports nothing about it. `BEGIN`, `COMMIT`, `SAVEPOINT` and the pragmas
 * are not seen, because better-sqlite3 prepares those itself.
 *
 * Writes to `system_logs` are left out and are never failed. The logger makes
 * them, when it chooses to, and they are not part of any request.
 */
import { sqlite } from '$lib/server/db';

/** What a write armed with `failNth` throws. */
export class InjectedWriteFailure extends Error {
	constructor(
		/** Which write it was, counting from 1 since `failNth` was called. */
		public readonly nth: number,
		public readonly sql: string
	) {
		super(`failingWrite: write ${nth} was made to fail (${oneLine(sql)})`);
		this.name = 'InjectedWriteFailure';
	}
}

export type FailingWrite = {
	/** Writes since this was installed or `reset()` was last called. */
	readonly count: number;
	/** The SQL of each of them, in the order they ran. */
	readonly writes: readonly string[];
	/**
	 * Make the nth write from now throw an `InjectedWriteFailure` instead of
	 * running. Starts the count again. Only that one write fails.
	 */
	failNth(n: number): void;
	/** True once the write armed with `failNth` has been reached and refused. */
	readonly fired: boolean;
	/** Forget the count and disarm. */
	reset(): void;
	/** Put back everything that was wrapped. Call it in `afterEach`. */
	restore(): void;
};

const oneLine = (sql: string) => sql.replace(/\s+/g, ' ').trim().slice(0, 160);
const isLogWrite = (sql: string) => /\bsystem_logs\b/i.test(sql);

type Statement = {
	readonly: boolean;
	source: string;
	run: (...args: unknown[]) => unknown;
	get: (...args: unknown[]) => unknown;
	all: (...args: unknown[]) => unknown;
	iterate: (...args: unknown[]) => unknown;
};
const METHODS = ['run', 'get', 'all', 'iterate'] as const;

let installed = false;

export function failingWrite(): FailingWrite {
	if (installed) {
		throw new Error('failingWrite is already installed: call restore() on the last one first');
	}
	installed = true;

	const connection = sqlite as unknown as {
		prepare: (...args: unknown[]) => Statement;
		exec: (sql: string) => unknown;
	};
	const realPrepare = connection.prepare;
	const realExec = connection.exec;
	const wrapped: Statement[] = [];

	let writes: string[] = [];
	let failAt: number | null = null;
	let fired = false;

	/** Called before each write runs. Throws if this is the one to fail. */
	const before = (sql: string) => {
		writes.push(oneLine(sql));
		if (failAt !== null && writes.length === failAt) {
			fired = true;
			throw new InjectedWriteFailure(failAt, sql);
		}
	};

	connection.prepare = function (...args: unknown[]) {
		const stmt = realPrepare.apply(sqlite, args);
		if (stmt.readonly || isLogWrite(stmt.source)) return stmt;
		for (const method of METHODS) {
			const real = stmt[method];
			stmt[method] = function (...params: unknown[]) {
				before(stmt.source);
				return real.apply(stmt, params);
			};
		}
		wrapped.push(stmt);
		return stmt;
	};

	connection.exec = function (sql: string) {
		if (!isLogWrite(sql)) before(sql);
		return realExec.call(sqlite, sql);
	};

	return {
		get count() {
			return writes.length;
		},
		get writes() {
			return writes;
		},
		failNth(n: number) {
			if (!Number.isInteger(n) || n < 1) throw new Error(`failNth takes a whole number from 1, not ${n}`);
			writes = [];
			failAt = n;
			fired = false;
		},
		get fired() {
			return fired;
		},
		reset() {
			writes = [];
			failAt = null;
			fired = false;
		},
		restore() {
			// The methods are on the prototypes; what was added here are own
			// properties over them, and removing those puts the real ones back.
			const own = connection as unknown as Record<string, unknown>;
			delete own.prepare;
			delete own.exec;
			for (const stmt of wrapped) {
				for (const method of METHODS) delete (stmt as unknown as Record<string, unknown>)[method];
			}
			wrapped.length = 0;
			installed = false;
		}
	};
}
