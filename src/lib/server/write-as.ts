/**
 * write-as.ts — who the caller is, asked again at the write (card 2253).
 *
 * The gate decides who is calling before the request's body is read, and a
 * body can take as long as the caller likes to arrive: up to Node's request
 * timeout, on a slow link or held open on purpose. A password reset, a key
 * deleted, a sign-out, or a role lowered, committed meanwhile, was met by
 * nothing: the write went through as the caller the gate had read. So every
 * write handler asks again, in the transaction that writes, whether the key
 * or session it was let in with is still open and who its account is now,
 * and decides who the caller is with that.
 *
 *     const body = await readBody(request);
 *     const card = writeAs(locals, (caller) => {
 *         const { card, boardId } = requireCard(caller, id, 'edit');   // decided as the account is now
 *         const row = db.update(cards)...returning().get();
 *         emit(boardId, 'update', { type: 'card' });                    // queued
 *         return row;
 *     });
 *     return json(card);
 *
 * Inside the callback the caller is `caller`, never `locals.user` nor a name
 * taken from it before the body: those are the account as the gate read it.
 * A check before the body may stay, as a quick refusal, but decides nothing.
 * `tests/check-at-the-write.test.ts` reads every handler for it.
 *
 * What cannot run inside a transaction (VACUUM, the restore, and what leaves
 * the process: mail, a backup, a destination's secret, a code sent to Google)
 * asks `stillCallerNow(locals)` instead, as the statement right after the
 * body, with nothing awaited between it and what it guards. better-sqlite3 is
 * synchronous, so nothing can come between the check and the write, or the
 * start of what leaves.
 *
 * Only a request handler calls these, with the locals the gate handed it:
 * never a scheduler, a job, or an effect run after a commit. Those have no
 * request, and so no key or session, and are refused (`stillAuthenticated`
 * writes an ERROR line for it); they write with `inTransaction`.
 *
 * A service that both API trees call (card 2012, `src/lib/server/cards.ts`
 * and its siblings) is handed `caller` inside the callback, and starts each
 * of its writes with `inWrite()`: refused unless a `writeAs` callback is
 * running, so that a service called outside one, or from a job's bare
 * `inTransaction`, writes nothing. `tests/check-at-the-write.test.ts` reads
 * the routes and the services for the same rule.
 */
import type { SessionUser } from './auth';
import { stillAuthenticated } from './auth';
import { inTransaction } from './db/transaction';
import type { ActivitySource } from './logActivity';

/**
 * What every service write is handed beside the caller, its path ids and the
 * body (card 2012): one shape for all of them,
 *
 *     service(caller, at: { …the ids in the path }, body, opts: ServiceOptions & { …the tree's options })
 *
 * with `null` for the body of a request that has none.
 */
export type ServiceOptions = {
	/** Which tree the request came through, for the entries the write records. */
	source: ActivitySource;
	/** The address the mail a write sends links to (`linkBaseUrl`), where it sends any. */
	baseUrl?: string | null;
	/**
	 * The tree's own words for a refusal, where it has its own (R2). Written
	 * out at the call, or a constant of the route file that holds them, or in
	 * the service's own `_PAGE_OPTIONS` constant (card 2296): never made from
	 * data (tests/check-at-the-write.test.ts).
	 */
	says?: string;
};

/** `never` for a promise: a transaction's work cannot await (transaction.ts). */
type NotAPromise<T> = T extends PromiseLike<unknown> ? never : T;

/**
 * How many `writeAs` callbacks are running: set as a callback starts, after
 * its caller has been asked for, and taken off when it returns or throws.
 * A count, as a `writeAs` inside another is a savepoint of it. Nothing else
 * sets it: what `inWrite` asks is whether a `writeAs` is under way, not
 * merely whether some transaction is open (R4 of card 2012's plan).
 */
let writing = 0;

/**
 * Run `write` in one transaction, handed the caller as their account is now,
 * and answer what it answers.
 *
 * The transaction begins by asking `stillAuthenticated`: a key or session that
 * has ended, or whose account has gone, is refused 401 in the gate's words,
 * and `write` is not run. Otherwise `write` is handed the account as it is now
 * (`locals.user` is set to it as well), or null for a request the gate let in
 * with no key or session, a public route's, for the handler's own rule to
 * decide. A role lowered meanwhile is met by the handler's guards, given
 * `caller`: refused as that account would have been refused at the gate.
 *
 * It is `inTransaction` in every other way: `write` must not be async, a throw
 * rolls back what it wrote, and inside another transaction it is a savepoint.
 */
export function writeAs<T>(locals: App.Locals, write: (caller: SessionUser | null) => NotAPromise<T>): T {
	return inTransaction<T>(() => {
		const caller = stillAuthenticated(locals);
		writing++;
		try {
			return write(caller);
		} finally {
			writing--;
		}
	});
}

/**
 * The first statement of every write a service exports (card 2012): refused,
 * before anything is read, unless it is running inside a `writeAs` callback,
 * where the caller has just been asked for and the transaction that writes
 * is open. A transaction opened inside that callback, a savepoint, is still
 * inside it. A bare `inTransaction` is not: a job or a scheduler has no
 * request, and so no caller to hand a service.
 *
 * A plain error, a 500 if a route reaches it: it can only mean a route or a
 * job calling a service where it may not, which is a fault, not a refusal.
 */
export function inWrite(): void {
	if (writing === 0) {
		throw new Error(
			'A service write was called outside a writeAs callback, and wrote nothing. Call it inside ' +
				'writeAs(locals, (caller) => …), handing it caller.'
		);
	}
}

/**
 * The caller as their account is now, asked in a transaction of its own that
 * writes nothing; refused 401 as `writeAs` refuses.
 *
 * For a handler whose work cannot run inside a transaction: it asks this as
 * the statement right after its body, decides with what it answers, and
 * awaits nothing between this and the call it guards. What runs after an
 * await that follows that call runs on the check already made: the second
 * and later recipients of a report mail, a long backup across several
 * destinations. Each began under a caller who was still signed in and still
 * allowed.
 *
 * The outermost transaction is `BEGIN IMMEDIATE`, so this takes the write
 * lock for the moment it reads.
 */
export function stillCallerNow(locals: App.Locals): SessionUser | null {
	return inTransaction(() => stillAuthenticated(locals));
}
