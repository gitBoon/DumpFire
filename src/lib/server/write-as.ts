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
 */
import type { SessionUser } from './auth';
import { stillAuthenticated } from './auth';
import { inTransaction } from './db/transaction';

/** `never` for a promise: a transaction's work cannot await (transaction.ts). */
type NotAPromise<T> = T extends PromiseLike<unknown> ? never : T;

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
	return inTransaction<T>(() => write(stillAuthenticated(locals)));
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
