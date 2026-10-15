/**
 * transaction.ts — one way to make several writes all or nothing, and one way
 * to tell the outside world only about writes that were committed.
 *
 *     const card = inTransaction(() => {
 *         const { card, boardId } = requireCard(user, id, 'edit');   // read and check
 *         const row = db.update(cards)...returning().get();          // write
 *         logUiActivity({ ... });                                    // the entry, with it
 *         emit(boardId, 'update', { type: 'card' });                 // queued
 *         return row;
 *     });
 *     return json(card);                                             // answer after
 *
 * Rules for code inside a transaction:
 *
 *   - No `await`. See `inTransaction` for why.
 *   - No `redirect()`, cookie or answer. Those come after it returns. A thrown
 *     `error(...)` or a typed error (`CardMoveError`) is fine: it rolls the
 *     transaction back and reaches the caller unchanged.
 *   - A database error is not caught and carried on from, unless the part that
 *     failed is its own nested `inTransaction`.
 *   - No raw `sqlite.transaction` under the helper.
 *   - Anything that leaves the process (a webhook, a live event, mail, a file
 *     moved) goes through `afterCommit`. `emit`, `logActivity` and the notify
 *     functions already do, so calling them is enough.
 *
 * The migration runner and the restore open their own transactions and do not
 * use this: they switch foreign keys off around them.
 * Nothing they run inside those may call `inTransaction`, which throws there,
 * as it does under any transaction it did not open.
 */
import { createLogger, flushPendingLogs } from '../logger';
import { sqlite } from './index';

const log = createLogger('TX');

/** Something to do once the write it follows from is committed. */
export type Effect = () => unknown;

/** `never` for a promise, so that a function returning one does not type-check. */
type NotAPromise<T> = T extends PromiseLike<unknown> ? never : T;

/** Effects waiting for the outermost transaction to commit, in the order queued. */
const queue: Effect[] = [];

/**
 * How many `inTransaction` calls are on the stack. Not used to decide whether
 * a transaction is open, which is read from the connection; only to tell a
 * transaction this helper opened from one it did not.
 */
let depth = 0;

let sweepScheduled = false;

function isThenable(value: unknown): value is PromiseLike<unknown> {
	return (
		value !== null &&
		(typeof value === 'object' || typeof value === 'function') &&
		typeof (value as { then?: unknown }).then === 'function'
	);
}

/** Start an effect. It is never awaited, and nothing it does reaches the caller. */
function start(effect: Effect): void {
	try {
		const result = effect();
		if (isThenable(result)) {
			// A rejection nobody handles ends the process on current Node.
			result.then(undefined, (err: unknown) => {
				log.error('An effect that followed a committed write was rejected', err);
			});
		}
	} catch (err) {
		log.error('An effect that followed a committed write threw', err);
	}
}

/**
 * Drop effects that were queued inside a transaction this helper did not open.
 *
 * Nothing does that today. The restore (`restore.ts`) and the migration runner
 * open their own transactions, and what they run inside them is raw SQL and
 * `switchOffOutside`: none of it reaches `emit`, `logActivity` or a notify
 * function. If something ever does, its effect is queued here with nobody to
 * say whether that transaction was committed. It is not sent on a guess, and
 * it is not left to be sent by the next request's commit: it is dropped, and
 * an error says how many went.
 *
 * Only `afterCommit` called there directly can queue one. `inTransaction`
 * throws there before it runs anything, so nothing is queued through it.
 *
 * Only called with no `inTransaction` on the stack, where anything still in
 * the queue can only be a stray.
 */
function dropStrays(): void {
	if (queue.length === 0) return;
	const strays = queue.splice(0);
	log.error(
		`${strays.length} effect(s) were queued inside a transaction that inTransaction did not open, and were not sent: ` +
			'whether that transaction was committed is not known here. Open it with inTransaction, or send them after it.'
	);
}

/**
 * Drop strays on the next turn of the event loop, so that they are reported
 * promptly and are not kept until some later request happens to come by.
 *
 * Every transaction here is opened and closed without yielding, so by then the
 * one they were queued in is over. If one is still open, it was left open by a
 * fault (a rollback that failed), will never report a commit, and what was
 * queued in it goes the same way.
 */
function sweepSoon(): void {
	if (sweepScheduled) return;
	sweepScheduled = true;
	setImmediate(() => {
		sweepScheduled = false;
		if (depth === 0) dropStrays();
	});
}

/**
 * Run `fn` in one transaction on the application's connection and return what
 * it returns. If it throws, everything it wrote is rolled back, the effects it
 * queued are dropped, and the error reaches the caller as it was thrown.
 *
 * The outermost call is `BEGIN IMMEDIATE`: the write lock is taken at the
 * start, so what `fn` reads cannot be changed under it before it writes.
 * Inside another `inTransaction` it is a savepoint, so a part that fails can
 * be caught by the part around it without losing what that part had done.
 *
 * It throws, before `fn` is run, if a transaction is open on the connection
 * that no `inTransaction` opened. As a savepoint of that one, what `fn` wrote
 * would be reported as saved and would be committed only if that transaction
 * was, which nothing here decides. One left open by a fault never is, and
 * every request after it used to be answered 2xx for writes that were lost
 * when the server stopped. Refused, the request is a 500 and writes nothing.
 *
 * `fn` must not be async, and must not return a promise. A transaction here is
 * over when `fn` returns. The part of an async function after its first
 * `await` has not run by then: it runs later, outside this transaction, in
 * whatever transaction happens to be open at that moment or in none, and it is
 * not rolled back when this one is. The type refuses such a function, so
 * `npm run check` fails on it, and it is refused again when it runs, with
 * what it wrote before its first `await` rolled back. What it writes after
 * that `await` cannot be stopped from here, which is why the type check is the
 * guard that matters.
 */
export function inTransaction<T>(fn: () => NotAPromise<T>): T {
	const outermost = !sqlite.inTransaction;
	if (!outermost && depth === 0) {
		throw new Error(
			'inTransaction was called while a transaction that it did not open is open on the database connection, ' +
				'and ran nothing. Inside that transaction its writes would be reported as saved and be committed only ' +
				'if that transaction is, which is not decided here. If no migration, restore or import is running, a ' +
				'transaction has been left open: restart the server.'
		);
	}
	if (outermost) dropStrays();

	const mark = queue.length;
	let result: T;
	depth++;
	try {
		const run = sqlite.transaction((): T => {
			const returned: unknown = fn();
			if (isThenable(returned)) {
				// Its rejection, if it has one, is not the caller's to handle.
				returned.then(undefined, () => {});
				throw new TypeError(
					'inTransaction was given a function that returns a promise. The transaction ends when the ' +
						'function returns, so nothing after its first await would be inside it. Await before ' +
						'the transaction and pass a function that is not async.'
				);
			}
			return returned as T;
		});
		result = outermost ? run.immediate() : run();
	} catch (err) {
		// What this part queued goes with what it wrote. What the part around
		// it had queued before stays.
		queue.length = Math.min(queue.length, mark);
		throw err;
	} finally {
		depth--;
		// The rows the logger held back while the transaction was open.
		if (outermost) flushPendingLogs();
	}

	if (outermost) {
		// Taken before any is run: an effect may open a transaction of its own.
		for (const effect of queue.splice(0)) start(effect);
	}
	return result;
}

/**
 * Do `effect` once the write it follows from is committed.
 *
 * Inside a transaction it is queued until the outermost one commits, and
 * dropped if that one, or the nested part it was queued in, rolls back.
 * Outside any transaction it is done at once. Whether a transaction is open is
 * read from the connection, not counted here.
 *
 * Either way the effect is started and never awaited. If it throws, or returns
 * a promise that rejects, that is logged at ERROR and goes no further: the
 * write is committed and the caller is told so.
 */
export function afterCommit(effect: Effect): void {
	if (!sqlite.inTransaction) {
		dropStrays();
		start(effect);
		return;
	}
	queue.push(effect);
	if (depth === 0) sweepSoon();
}
