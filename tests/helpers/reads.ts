/**
 * Watch the reads a request makes of one table: whether a transaction was
 * open for each, and a chance to change the table between two of them.
 *
 *     const reads = watchReads('invite_tokens', (nth) => {
 *         if (nth === 1) useTheInviteAsAnotherRequestWould();
 *     });
 *     const res = await action('/invite/abc123', { form });
 *     reads.inTransaction;      // [false, true]: looked at, then read where it is used
 *     reads.restore();
 *
 * A request that checks a row and then writes on the strength of it has to
 * make that check inside the transaction that writes. This shows that it
 * does, in two ways:
 *
 *   - `inTransaction` says, for each read of the table in order, whether a
 *     transaction was open on the connection when it ran.
 *   - `afterRead` is called when a read has fetched its rows and before the
 *     request sees them. What it writes is what another request would have
 *     committed at that moment: the request under test has read the table as
 *     it was, and goes on with the table changed under it. It is not called
 *     for a read made inside a transaction, where no other request can write.
 *
 * A read is a statement SQLite calls read-only that names the table after
 * `FROM`. Whatever reads the table while this is installed is counted, the
 * test's own queries and `snapshotDb()` included: install it last, just before
 * the request, and restore it before looking at the rows.
 *
 * It wraps the connection's `prepare`, as `failingWrite` does, so the two
 * cannot be installed together and this cannot be used inside
 * `eachWriteInTurn`.
 *
 * `readBudget(limit)`, below, is the other use of the same wrapping: it counts
 * every read of every table, and stops a walk that would never end.
 */
import { sqlite } from '$lib/server/db';

export type WatchedReads = {
	/** For each read so far, in order: whether a transaction was open when it ran. */
	readonly inTransaction: boolean[];
	/** Put back everything that was wrapped. Call it in a `finally`. */
	restore(): void;
};

type Statement = {
	readonly: boolean;
	source: string;
	get: (...args: unknown[]) => unknown;
	all: (...args: unknown[]) => unknown;
};
const METHODS = ['get', 'all'] as const;

/**
 * @param table The table, by its name in the database.
 * @param afterRead Called after each read of it made outside a transaction, with
 *   which read of the table it was, counting from 1.
 */
export function watchReads(table: string, afterRead?: (nth: number) => void): WatchedReads {
	if (Object.prototype.hasOwnProperty.call(sqlite, 'prepare')) {
		throw new Error('watchReads: the connection is already wrapped, by failingWrite or by another watchReads');
	}

	const connection = sqlite as unknown as { prepare: (...args: unknown[]) => Statement };
	const realPrepare = connection.prepare;
	const named = new RegExp(`\\bfrom\\s+"?${table}"?(?![\\w"])`, 'i');
	const wrapped: Statement[] = [];
	const inTransaction: boolean[] = [];
	// What `afterRead` reads is its own business, and is not counted.
	let busy = false;

	connection.prepare = function (...args: unknown[]) {
		const stmt = realPrepare.apply(sqlite, args);
		if (!stmt.readonly || !named.test(stmt.source)) return stmt;
		for (const method of METHODS) {
			const real = stmt[method];
			stmt[method] = function (...params: unknown[]) {
				const result = real.apply(stmt, params);
				if (busy) return result;
				inTransaction.push(sqlite.inTransaction);
				if (afterRead && !sqlite.inTransaction) {
					busy = true;
					try {
						afterRead(inTransaction.length);
					} finally {
						busy = false;
					}
				}
				return result;
			};
		}
		wrapped.push(stmt);
		return stmt;
	};

	return {
		inTransaction,
		restore() {
			// As in failingWrite: what was added are own properties over the
			// prototypes' methods, and removing them puts the real ones back.
			delete (connection as unknown as Record<string, unknown>).prepare;
			for (const stmt of wrapped) {
				for (const method of METHODS) delete (stmt as unknown as Record<string, unknown>)[method];
			}
			wrapped.length = 0;
		}
	};
}

/** What a read past the budget throws. */
export class ReadBudgetSpent extends Error {
	constructor(public readonly limit: number) {
		super(`readBudget: more than ${limit} reads of the database: a walk that does not end?`);
		this.name = 'ReadBudgetSpent';
	}
}

export type ReadBudget = {
	/** Reads made so far, the one refused included. */
	readonly count: number;
	/**
	 * True once a read past the limit was refused. Asserted false after the
	 * call: code that caught the error and went on would otherwise pass.
	 */
	readonly spent: boolean;
	/** Put back everything that was wrapped. Call it in a `finally`. */
	restore(): void;
};

/**
 * Stop a walk that would never end, by counting reads (card 2142).
 *
 *     const budget = readBudget(1000);
 *     try {
 *         res = await pageLoad(`/board/${loopBoard.id}`, { user });
 *     } finally {
 *         budget.restore();
 *     }
 *     expect(budget.spent).toBe(false);
 *
 * A vitest timeout cannot stop a loop that never gives the event loop back:
 * the test file's process would spin and grow until it died. A walk that
 * reads the database at each step reaches the limit in milliseconds instead,
 * and the read past it throws `ReadBudgetSpent`.
 *
 * Every `get`, `all` and `iterate` of every statement SQLite calls read-only
 * is counted, of any table, inside a transaction or not, so a walk that reads
 * the tree through a join, or inside a transaction, is seen as well. Two
 * walks no budget can see:
 *
 *   - one recursive statement, which is one read however far it goes. A
 *     source check in tests/board-tree-loops.test.ts holds that every one is
 *     built with `UNION`, which ends on a loop, and none with `UNION ALL`;
 *   - a walk over rows already read into memory, as `deepestFirst` in
 *     deletes.ts and `boardsInLoops` in sub-boards.ts are. Each is written so
 *     that every step marks a board not marked before, and is run on a loop by
 *     its own test. That makes each end; it does not make each cheap.
 *     `boardsInLoops` keeps its marks for the whole walk, so it takes one step
 *     for each board. `deepestFirst` starts its marks afresh for every board
 *     it is given and walks each to the top, so it takes rows × depth steps:
 *     2,000 boards deep took 400 ms. Card 2172's limit on how deep boards
 *     nest (20 levels) is what bounds it, for every tree made since.
 *
 * It wraps `prepare` as `watchReads` and `failingWrite` do, and refuses to be
 * installed with either.
 */
export function readBudget(limit: number): ReadBudget {
	if (Object.prototype.hasOwnProperty.call(sqlite, 'prepare')) {
		throw new Error('readBudget: the connection is already wrapped, by failingWrite, watchReads or another readBudget');
	}

	const connection = sqlite as unknown as { prepare: (...args: unknown[]) => Statement };
	const realPrepare = connection.prepare;
	const wrapped: Statement[] = [];
	const counted = ['get', 'all', 'iterate'] as const;
	let count = 0;
	let spent = false;

	connection.prepare = function (...args: unknown[]) {
		const stmt = realPrepare.apply(sqlite, args) as Statement & { iterate: (...args: unknown[]) => unknown };
		if (!stmt.readonly) return stmt;
		for (const method of counted) {
			const real = stmt[method];
			stmt[method] = function (...params: unknown[]) {
				count += 1;
				if (count > limit) {
					spent = true;
					throw new ReadBudgetSpent(limit);
				}
				return real.apply(stmt, params);
			};
		}
		wrapped.push(stmt);
		return stmt;
	};

	return {
		get count() {
			return count;
		},
		get spent() {
			return spent;
		},
		restore() {
			delete (connection as unknown as Record<string, unknown>).prepare;
			for (const stmt of wrapped) {
				for (const method of counted) delete (stmt as unknown as Record<string, unknown>)[method];
			}
			wrapped.length = 0;
		}
	};
}
