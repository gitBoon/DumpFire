/**
 * `inTransaction` and `afterCommit`: several writes saved together or not at
 * all, and the outside world told only of what was committed.
 *
 * These drive the helper directly. What each route does with it is in
 * `tests/atomic-moves.test.ts`. One test here goes through a route, to show
 * what a request gets when the helper refuses to run.
 */
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { error, isHttpError } from '@sveltejs/kit';
import { db, sqlite } from '$lib/server/db';
import { cards } from '$lib/server/db/schema';
import { afterCommit, inTransaction } from '$lib/server/db/transaction';
import { CardMoveError } from '$lib/server/card-moves';
import { emit, subscribeGlobal } from '$lib/server/events';
import { createLogger } from '$lib/server/logger';
import { api } from './helpers/api';
import { makeBoard, makeUser, resetDb } from './helpers/fixtures';

const log = createLogger('TEST');

// `settings` is a key and a value, which is all these tests need of a table.
const put = (key: string) => sqlite.prepare('INSERT INTO settings (key, value) VALUES (?, ?)').run(key, 'x');
const keys = () =>
	(sqlite.prepare('SELECT key FROM settings ORDER BY key').all() as { key: string }[]).map((r) => r.key);
const logged = () =>
	sqlite.prepare('SELECT timestamp, level, context, message, meta FROM system_logs ORDER BY id').all() as {
		timestamp: string;
		level: string;
		context: string;
		message: string;
		meta: string | null;
	}[];
const turn = () => new Promise((resolve) => setImmediate(resolve));

// The logger prints every ERROR; the ones these tests cause on purpose would
// bury the output.
beforeEach(() => {
	resetDb();
	vi.spyOn(console, 'error').mockImplementation(() => {});
});
afterEach(() => {
	vi.restoreAllMocks();
});

describe('inTransaction', () => {
	it('returns what the function returns, and commits what it wrote', () => {
		const result = inTransaction(() => {
			put('a');
			put('b');
			return 42;
		});

		expect(result).toBe(42);
		expect(keys()).toEqual(['a', 'b']);
		expect(sqlite.inTransaction).toBe(false);
	});

	it('writes nothing if the function throws, and passes the error on as it was thrown', () => {
		const refusal = new CardMoveError(409, 'Card has 1 incomplete subtask');

		let caught: unknown;
		try {
			inTransaction(() => {
				put('a');
				throw refusal;
			});
		} catch (e) {
			caught = e;
		}

		// The same object: a route tells a refusal from a crash by its class.
		expect(caught).toBe(refusal);
		expect(keys()).toEqual([]);
		expect(sqlite.inTransaction).toBe(false);
	});

	it('lets a SvelteKit error() through, having written nothing', () => {
		let caught: unknown;
		try {
			inTransaction(() => {
				put('a');
				error(403, 'No edit access to this board');
			});
		} catch (e) {
			caught = e;
		}

		expect(isHttpError(caught, 403)).toBe(true);
		expect(keys()).toEqual([]);
	});

	it('takes the write lock at the start of the outermost one, and nests as a savepoint', () => {
		// What better-sqlite3 was asked for: `.immediate()` is BEGIN IMMEDIATE,
		// and a plain call inside an open transaction is a savepoint.
		const asked: string[] = [];
		const real = sqlite.transaction.bind(sqlite);
		vi.spyOn(sqlite, 'transaction').mockImplementation(((fn: () => unknown) => {
			const tx = real(fn);
			const plain = () => {
				asked.push(sqlite.inTransaction ? 'savepoint' : 'begin');
				return tx();
			};
			plain.immediate = () => {
				asked.push(sqlite.inTransaction ? 'savepoint (asked for immediate)' : 'begin immediate');
				return tx.immediate();
			};
			return plain;
		}) as unknown as typeof sqlite.transaction);

		inTransaction(() => {
			expect(sqlite.inTransaction).toBe(true);
			inTransaction(() => put('a'));
		});

		expect(asked).toEqual(['begin immediate', 'savepoint']);
		expect(keys()).toEqual(['a']);
	});

	it('rolls an inner part back alone when the outer part catches its failure', () => {
		inTransaction(() => {
			put('outer-before');
			try {
				inTransaction(() => {
					put('inner');
					throw new Error('inner failed');
				});
			} catch {
				// Carried on from: the inner part was its own transaction.
			}
			put('outer-after');
		});

		expect(keys()).toEqual(['outer-after', 'outer-before']);
	});

	it('rolls everything back, the committed inner part too, when the outer part fails', () => {
		expect(() =>
			inTransaction(() => {
				inTransaction(() => put('inner'));
				put('outer');
				throw new Error('outer failed');
			})
		).toThrow('outer failed');

		expect(keys()).toEqual([]);
	});

	it('refuses an async function, and leaves no row once the event loop has turned', async () => {
		let caught: unknown;
		try {
			// @ts-expect-error A function that returns a promise must not type-check.
			inTransaction(async () => {
				put('a');
			});
		} catch (e) {
			caught = e;
		}

		expect(caught).toBeInstanceOf(TypeError);
		expect((caught as Error).message).toMatch(/returns a promise/);
		expect(sqlite.inTransaction).toBe(false);
		await turn();
		expect(keys()).toEqual([]);
	});

	it('refuses a function that is not async but returns a promise', async () => {
		expect(() =>
			// @ts-expect-error The same, without the keyword.
			inTransaction(() => {
				put('a');
				return Promise.reject(new Error('never handled by the caller'));
			})
		).toThrow(TypeError);

		// The rejection of the promise it returned is nobody's unhandled rejection.
		await turn();
		expect(keys()).toEqual([]);
	});

	it('drops the effects of a refused async function with its writes', async () => {
		const ran: string[] = [];
		expect(() =>
			// @ts-expect-error As above.
			inTransaction(async () => {
				afterCommit(() => ran.push('effect'));
			})
		).toThrow(TypeError);

		await turn();
		expect(ran).toEqual([]);
	});
});

describe('afterCommit', () => {
	it('runs at once outside a transaction', () => {
		const ran: string[] = [];
		afterCommit(() => ran.push('now'));
		expect(ran).toEqual(['now']);
	});

	it('waits for the commit, then runs in the order queued', () => {
		const ran: string[] = [];
		const openWhenStarted: boolean[] = [];
		const effect = (name: string) => () => {
			ran.push(name);
			openWhenStarted.push(sqlite.inTransaction);
		};

		inTransaction(() => {
			afterCommit(effect('first'));
			put('a');
			afterCommit(effect('second'));
			expect(ran).toEqual([]);
		});

		expect(ran).toEqual(['first', 'second']);
		expect(openWhenStarted).toEqual([false, false]);
		// The write the effects follow from was there when they started.
		expect(keys()).toEqual(['a']);
	});

	it('holds a nested part\'s effects until the outermost commit', () => {
		const ran: string[] = [];
		inTransaction(() => {
			afterCommit(() => ran.push('outer 1'));
			inTransaction(() => {
				afterCommit(() => ran.push('inner'));
			});
			// The inner part has ended, but nothing is committed yet.
			expect(ran).toEqual([]);
			afterCommit(() => ran.push('outer 2'));
		});

		expect(ran).toEqual(['outer 1', 'inner', 'outer 2']);
	});

	it('runs nothing when the transaction rolls back', async () => {
		const ran: string[] = [];
		expect(() =>
			inTransaction(() => {
				afterCommit(() => ran.push('effect'));
				throw new Error('failed');
			})
		).toThrow('failed');

		await turn();
		expect(ran).toEqual([]);

		// And the queue was emptied: the next commit does not send it either.
		inTransaction(() => put('a'));
		expect(ran).toEqual([]);
	});

	it('keeps the outer part\'s effects and drops the inner part\'s when the inner fails and is caught', () => {
		const ran: string[] = [];
		inTransaction(() => {
			afterCommit(() => ran.push('outer before'));
			try {
				inTransaction(() => {
					afterCommit(() => ran.push('inner'));
					throw new Error('inner failed');
				});
			} catch {
				// Carried on from.
			}
			afterCommit(() => ran.push('outer after'));
		});

		expect(ran).toEqual(['outer before', 'outer after']);
	});

	it('logs an effect that throws and one that rejects, and neither stops anything', async () => {
		const unhandled: unknown[] = [];
		const onUnhandled = (reason: unknown) => unhandled.push(reason);
		process.on('unhandledRejection', onUnhandled);
		const ran: string[] = [];

		try {
			const result = inTransaction(() => {
				put('a');
				afterCommit(() => {
					throw new Error('the webhook table is gone');
				});
				afterCommit(() => Promise.reject(new Error('the mail server hung up')));
				afterCommit(() => ran.push('the one after them'));
				return 'saved';
			});

			// The caller is told the write succeeded, which it did.
			expect(result).toBe('saved');
			expect(keys()).toEqual(['a']);
			expect(ran).toEqual(['the one after them']);

			await turn();
			await turn();
			expect(unhandled).toEqual([]);
		} finally {
			process.off('unhandledRejection', onUnhandled);
		}

		const errors = logged().filter((row) => row.context === 'TX');
		expect(errors.map((row) => row.level)).toEqual(['ERROR', 'ERROR']);
		expect(errors[0].message).toMatch(/threw/);
		expect(errors[0].meta).toContain('the webhook table is gone');
		expect(errors[1].message).toMatch(/rejected/);
		expect(errors[1].meta).toContain('the mail server hung up');
	});

	it('logs an effect that throws when it is run at once, too', () => {
		expect(() =>
			afterCommit(() => {
				throw new Error('nobody was listening');
			})
		).not.toThrow();

		expect(logged().map((row) => row.meta)).toEqual([expect.stringContaining('nobody was listening')]);
	});

	it('lets an effect open a transaction and queue effects of its own', () => {
		const ran: string[] = [];
		inTransaction(() => {
			afterCommit(() => {
				inTransaction(() => {
					put('from the effect');
					afterCommit(() => ran.push('second generation'));
				});
				ran.push('first generation');
			});
			afterCommit(() => ran.push('sibling'));
		});

		expect(ran).toEqual(['second generation', 'first generation', 'sibling']);
		expect(keys()).toEqual(['from the effect']);
	});

	it('holds a live event back until the commit, and drops it on a rollback', () => {
		const seen: string[] = [];
		const unsubscribe = subscribeGlobal((event) => seen.push(`${event} (open: ${sqlite.inTransaction})`));
		try {
			inTransaction(() => {
				emit(1, 'update', { type: 'card' });
				expect(seen).toEqual([]);
			});
			expect(seen).toEqual(['update (open: false)']);

			expect(() =>
				inTransaction(() => {
					emit(1, 'celebrate', {});
					throw new Error('failed');
				})
			).toThrow('failed');
			expect(seen).toEqual(['update (open: false)']);
		} finally {
			unsubscribe();
		}
	});
});

describe('effects queued inside a transaction the helper did not open', () => {
	// The restore and the migration runner open their own.
	// Nothing they run queues an effect today; this is what happens if
	// something ever does.
	it('are not sent by the next commit, and an error says so', () => {
		const ran: string[] = [];
		sqlite.transaction(() => {
			afterCommit(() => ran.push('stray'));
		})();

		inTransaction(() => {
			afterCommit(() => ran.push('mine'));
		});

		expect(ran).toEqual(['mine']);
		const errors = logged().filter((row) => row.context === 'TX');
		expect(errors).toHaveLength(1);
		expect(errors[0].message).toMatch(/1 effect\(s\) were queued inside a transaction that inTransaction did not open/);
	});

	it('are dropped by the next turn of the event loop if nothing else comes first', async () => {
		const ran: string[] = [];
		sqlite.transaction(() => {
			afterCommit(() => ran.push('stray'));
		})();
		expect(logged()).toEqual([]);

		await turn();

		expect(ran).toEqual([]);
		expect(logged().map((row) => row.context)).toEqual(['TX']);

		// Gone, not waiting: nothing later sends it.
		afterCommit(() => ran.push('later'));
		inTransaction(() => put('a'));
		expect(ran).toEqual(['later']);
	});

});

describe('inTransaction, called while a transaction the helper did not open is open', () => {
	// It used to run as a savepoint of that transaction and return as if it had
	// saved. Whether it had was up to a transaction that nothing here commits.
	it('throws before it runs the function, so nothing is written and nothing is queued', async () => {
		const ran: string[] = [];
		let called = false;

		// The transaction around it commits: what is not there afterwards was
		// never written, not written and rolled back.
		sqlite.transaction(() => {
			expect(() =>
				inTransaction(() => {
					called = true;
					put('a');
					afterCommit(() => ran.push('stray'));
				})
			).toThrow(/a transaction that it did not open is open on the database connection/);
			// Still open, and no deeper than it was.
			expect(sqlite.inTransaction).toBe(true);
			put('written by the transaction around it');
		})();

		await turn();

		expect(called).toBe(false);
		expect(keys()).toEqual(['written by the transaction around it']);
		expect(ran).toEqual([]);
		// No effect was queued, so there is no stray to report.
		expect(logged()).toEqual([]);

		// And the helper is as it was for the next caller.
		inTransaction(() => put('b'));
		expect(keys()).toEqual(['b', 'written by the transaction around it']);
	});

	it('fails a request made then, which used to be answered 201 for a card that was never committed', async () => {
		const owner = makeUser();
		const { cols } = makeBoard({ owner });
		const create = () =>
			api('POST', '/api/cards', { user: owner, body: { columnId: cols['To Do'].id, title: 'Never saved' } });

		// A transaction left open on the connection, as a rollback that failed
		// would leave one.
		sqlite.exec('BEGIN');
		try {
			// `api()` passes on whatever is not an `error(...)` answer. SvelteKit
			// answers 500 for it.
			await expect(create()).rejects.toThrow(/a transaction that it did not open is open/);
			// Not written inside the open transaction either.
			expect(db.select().from(cards).all()).toEqual([]);
		} finally {
			sqlite.exec('ROLLBACK');
		}

		expect(db.select().from(cards).all()).toEqual([]);
		// With the connection clear again, the same request is saved.
		expect((await create()).status).toBe(201);
		expect(db.select().from(cards).all()).toMatchObject([{ title: 'Never saved' }]);
	});
});

describe('log lines written while a transaction is open', () => {
	it('are in system_logs after a rollback, in order and with the time they were logged', async () => {
		const start = new Date().toISOString();
		let whileOpen: unknown[] = [];

		expect(() =>
			inTransaction(() => {
				put('a');
				log.error('first, before the failure');
				log.error('second, explaining it', { reason: 'disk full' });
				// Held in memory: a row written now would be rolled back.
				whileOpen = logged();
				throw new Error('failed');
			})
		).toThrow('failed');
		const end = new Date().toISOString();

		expect(whileOpen).toEqual([]);
		expect(keys()).toEqual([]);
		const rows = logged();
		expect(rows.map((row) => row.message)).toEqual(['first, before the failure', 'second, explaining it']);
		expect(rows[1].meta).toContain('disk full');
		for (const row of rows) {
			expect(row.timestamp >= start && row.timestamp <= end).toBe(true);
		}
	});

	it('are in system_logs after a commit', () => {
		inTransaction(() => {
			put('a');
			log.error('logged inside');
		});

		expect(logged().map((row) => row.message)).toEqual(['logged inside']);
	});

	it('are written once, when the outermost transaction ends, however deep they were logged', () => {
		inTransaction(() => {
			try {
				inTransaction(() => {
					log.error('from the inner part, which fails');
					throw new Error('inner failed');
				});
			} catch {
				// Carried on from.
			}
			expect(logged()).toEqual([]);
			log.error('from the outer part');
		});

		expect(logged().map((row) => row.message)).toEqual([
			'from the inner part, which fails',
			'from the outer part'
		]);
	});

	it('land with the next line logged outside, when the helper did not open the transaction', () => {
		// A migration or a restore: nobody flushes for it.
		expect(() =>
			sqlite.transaction(() => {
				log.error('inside a raw transaction that rolls back');
				throw new Error('failed');
			})()
		).toThrow('failed');
		expect(logged()).toEqual([]);

		log.error('the next line, outside');

		expect(logged().map((row) => row.message)).toEqual([
			'inside a raw transaction that rolls back',
			'the next line, outside'
		]);
	});

	it('still reach the console and the live feed at once', () => {
		const printed = vi.mocked(console.error);
		inTransaction(() => {
			log.error('seen straight away');
			expect(printed.mock.calls.some(([line]) => String(line).includes('seen straight away'))).toBe(true);
		});
	});
});
