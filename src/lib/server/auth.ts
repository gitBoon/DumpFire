/**
 * auth.ts — Server-side authentication utilities for DumpFire.
 *
 * Handles session management, cookie operations and the checking of a
 * current password. Passwords are hashed and checked in passwords.ts, on
 * worker threads (card 2191); session tokens are crypto.randomUUID().
 */

import { createHash, randomBytes } from 'node:crypto';
import { db, sqlite } from './db';
import { afterCommit, inTransaction } from './db/transaction';
import { users, sessions, apiKeys, webhooks, reportSchedules, type Session, type User } from './db/schema';
import { and, eq, sql } from 'drizzle-orm';
import { error, type Cookies } from '@sveltejs/kit';
import { getRequestEvent } from '$app/server';
import { endUnusedInvites } from './invites';
import { FIRST_LANE_CHECKS_PER_ACCOUNT, enterSignIn, firstLaneChecksAt, leaveSignIn } from './rate-limit';
import { PASSWORDS_BUSY, checkPassword } from './passwords';
import { createLogger } from './logger';
import { stamp, toStamp } from '$lib/timestamps';
import { PASSWORD_CHANGED_MEANWHILE, STEP_UP_IN_FLIGHT, STEP_UP_MISSING, STEP_UP_SIGNED_OUT } from '$lib/step-up-words';
import { registerStampFunctions } from './db/timestamps';
import { pathToLog } from './secret-paths';

const log = createLogger('AUTH');

// ─── Constants ───────────────────────────────────────────────────────────────

export const SESSION_COOKIE_NAME = 'dumpfire_session';
const SESSION_DURATION_DAYS = 30;

// ─── Types ───────────────────────────────────────────────────────────────────

export type SessionUser = {
	id: number;
	username: string;
	email: string;
	emoji: string;
	role: string;
};

// ─── Checking a Current Password ────────────────────────────────────────────

/**
 * How many wrong current passwords end the session that sent them (card 2701,
 * decision 6): the usual bound, sudo's. The real user loses only the session,
 * and signs in again.
 */
export const WRONG_CURRENT_PASSWORDS_SIGN_OUT = 3;

/**
 * The answer to a check from a session that already has one under way (card
 * 2701, decision 5), and the answer once a session has been ended by its third
 * wrong current password, or had ended some other way while its check was
 * made (decision 6). Kept in `$lib/step-up-words`, which the pages read too:
 * a confirm dialog knows a refusal of the password by its words.
 */
export { STEP_UP_IN_FLIGHT, STEP_UP_SIGNED_OUT };

/** What a check answers: whether the password matched, and whether the session is signed out. */
type Checked = { matches: boolean; signedOut: boolean };
/** The answer for a session that is signed out (its row gone, or just ended), whatever the password. */
const signedOut = (): Checked => ({ matches: false, signedOut: true });

/**
 * The sessions with a current password being checked now. Kept in memory, as
 * the requests it guards are: a restart ends both. Session tokens only, never
 * a password.
 */
const checksInFlight = new Set<string>();

/** Forget every check under way, as a restart does: for tests, between them. */
export function forgetChecksInFlight(): void {
	checksInFlight.clear();
}

/**
 * Whether `password` is the account's current password, whose hash is `hash`,
 * with the attempt counted against `session`: the session the request was
 * made with, read from its cookie.
 *
 * The email form, the password form and Generate Key each ask a caller who is
 * already signed in for their current password, and so does every
 * destructive, privilege-changing or exfiltrating admin action (card 2701,
 * `confirmStepUp` in step-up.ts). It is what whoever holds a session and not
 * the password (an unlocked machine, a copied cookie, a script running in a
 * page) would need, and a password found here passes every one of them.
 *
 * So the compares are counted on the session's own row
 * (`sessions.wrong_password_count`, migration 0062), for the session's whole
 * life: no window, and a restart does not clear it. Only a right password
 * sets it back to 0. The third wrong one ends the session (decisions 5 and 6,
 * as ruled again by the code review's S1 on 2026-11-04: only a check that
 * compares a password is counted). Steps 1 to 4 run in one turn, with
 * nothing awaited between them, so that no other check can come between:
 *
 *   1. The session's row is read. Gone, the answer is signed out. A count
 *      already at 3 or more ends the session, answered signed out, with no
 *      password compared.
 *   2. One check under way per session: a second is answered 429
 *      (`STEP_UP_IN_FLIGHT`), not counted, with no password compared. The
 *      pages send one request per press.
 *   3. One of the account's five places in the first lane of password checks
 *      (passwords.ts), its sessions' current passwords and its remembered
 *      browsers' sign-ins together (the review's L1). None free is answered
 *      429 (`PASSWORDS_BUSY`), not counted, with no password compared. The
 *      first lane goes ahead of every sign-in, invite and set-up, so without
 *      it one signed-in user could keep checks in flight without end.
 *   4. Counted, in one statement (`UPDATE … RETURNING`), and then compared on
 *      a worker thread. A compare that fails on the worker stays counted: it
 *      was made.
 *   5. The row is read again. Gone (ended by a sign-out, a password change or
 *      a reset meanwhile), the answer is signed out whatever the check found,
 *      and a right password clears nothing: an answer given after the end
 *      never tells a right guess from a wrong one. Otherwise a right password
 *      sets the count to 0, and a wrong one that leaves it at 3 ends the
 *      session. With one check at a time, nothing else can count meanwhile.
 *
 * The count is the session's and not the account's. Kept on the account,
 * whoever held one session of it could keep every session of it refused, the
 * owner's included, and so keep the owner from changing the password, which
 * is how the owner ends the other sessions. Sign-in's own counts, by address
 * and by account, are not touched: a stolen session could otherwise slow or
 * lock the owner's sign-in from a browser that was never stolen.
 *
 * Each wrong password is a WARN line naming `where` and the user, as each
 * failed sign-in is, and each session ended for it another. The session is
 * never logged: it is what signs its holder in. Nor is the password.
 *
 * Asked once for a request, before its transaction, and awaited. It resolves
 * to `{ matches, signedOut }` rather than a boolean, so that a missed `await`
 * does not compile; `refuseWrongPassword` turns it into the route's answer. A
 * route whose stored hash moved in between is refused by
 * `whilePasswordHolds`, which compares nothing again (the code review's S2).
 */
export async function checkCurrentPassword(
	session: string,
	userId: number,
	password: string,
	hash: string,
	where: string
): Promise<Checked> {
	const thisSession = and(eq(sessions.id, session), eq(sessions.userId, userId));

	// 1. The session as it is.
	const row = db.select({ count: sessions.wrongPasswordCount }).from(sessions).where(thisSession).get();
	if (!row) return signedOut();
	if (row.count >= WRONG_CURRENT_PASSWORDS_SIGN_OUT) {
		endAfterWrongPasswords(session, userId, where);
		return signedOut();
	}

	// 2. One check at a time for the session: not counted.
	if (checksInFlight.has(session)) error(429, { message: STEP_UP_IN_FLIGHT, stepUp: 'in-flight' });

	// 3. A place in the account's first lane: not counted.
	const place = firstLaneChecksAt(userId);
	if (!enterSignIn(place, FIRST_LANE_CHECKS_PER_ACCOUNT)) error(429, { message: PASSWORDS_BUSY, stepUp: 'busy' });

	// 4. Counted, with nothing awaited since step 1, and then compared.
	checksInFlight.add(session);
	let matches: boolean;
	try {
		const counted = db
			.update(sessions)
			.set({ wrongPasswordCount: sql`${sessions.wrongPasswordCount} + 1` })
			.where(thisSession)
			.returning({ count: sessions.wrongPasswordCount })
			.get();
		if (!counted) return signedOut();
		matches = (await checkPassword(password, hash, 'known')).matches;
	} finally {
		checksInFlight.delete(session);
		leaveSignIn(place);
	}

	// 5.
	if (matches) {
		const cleared = db.update(sessions).set({ wrongPasswordCount: 0 }).where(thisSession).returning({ id: sessions.id }).get();
		return cleared ? { matches: true, signedOut: false } : signedOut();
	}
	const now = db.select({ count: sessions.wrongPasswordCount }).from(sessions).where(thisSession).get();
	if (!now) return signedOut();
	log.warn(`Wrong current password for user ${userId} on ${where}`, { where }, { userId });
	if (now.count >= WRONG_CURRENT_PASSWORDS_SIGN_OUT) {
		endAfterWrongPasswords(session, userId, where);
		return signedOut();
	}
	return { matches: false, signedOut: false };
}

/** End a session for its wrong current passwords, with a WARN line that names the user and the route, never the session. */
function endAfterWrongPasswords(session: string, userId: number, where: string): void {
	log.warn(`Session ended after three wrong current passwords for user ${userId} on ${where}`, { where }, { userId });
	deleteSession(session, 'three wrong current passwords');
}

/**
 * The route's answer to a current password that did not pass: nothing when it
 * matched; for a session signed out, 403 `{ message: STEP_UP_SIGNED_OUT,
 * signedOut: true, stepUp: 'signed-out' }` with the session cookie cleared;
 * otherwise 403 in the route's own words, `says`, with `stepUp: 'wrong'`. The
 * answer never says whether a signed-out session's password was right, and
 * never echoes the password.
 */
export function refuseWrongPassword(cookies: Cookies, checked: Checked, says: string): void {
	if (checked.signedOut) {
		clearSessionCookie(cookies);
		error(403, { message: STEP_UP_SIGNED_OUT, signedOut: true, stepUp: 'signed-out' });
	}
	if (!checked.matches) error(403, { message: says, stepUp: 'wrong' });
}

/**
 * What `whilePasswordHolds` answers when the stored hash moved between the
 * check and the write. Kept in `$lib/step-up-words`, which the pages read too.
 */
export { PASSWORD_CHANGED_MEANWHILE };

/** `never` for a promise: a transaction's work cannot await (transaction.ts). */
type NotAPromise<T> = T extends PromiseLike<unknown> ? never : T;

/**
 * The accounts whose password a running `whilePasswordHolds` write holds,
 * innermost last (card 2726). Pushed only there, once the stored hash has been
 * compared under the lock, and popped in its `finally`, whether the write
 * returns or throws. Nothing else writes it and nothing exports a way to.
 *
 * It cannot outlast its request: the write is synchronous inside one
 * transaction (`inTransaction` refuses one that returns a promise), so no
 * other request's code runs while it is set, and it is popped before the
 * transaction's `afterCommit` effects run. It is kept by account, not as a
 * bare count as `writingWithKey()` is: a nested `whilePasswordHolds` for
 * another account adds that account alone, so a write is never proven for a
 * caller whose password was not the one held.
 */
const held: number[] = [];

/**
 * Run `write` in one transaction, only while the account's stored hash is
 * still `checkedHash`, the one the password was checked against before it.
 *
 * The three routes that ask for a current password used to check it again
 * inside their transaction when the stored hash had changed in between: a
 * bcrypt check with the write lock held, which a transaction can no longer
 * make now that a check is awaited. So the stored hash is compared under the
 * lock instead. If it has changed (the password changed or reset meanwhile),
 * nothing is written and the answer is 409 `PASSWORD_CHANGED_MEANWHILE`, with
 * `stepUp: 'changed'`: the proof no longer holds. The password is not
 * compared again against the new hash: that compare would be a guess the
 * session's count never saw (the code review's S2, 2026-11-04). Nothing can
 * change the hash between the comparison and the write: better-sqlite3 runs
 * the whole transaction without yielding, under `BEGIN IMMEDIATE`.
 *
 * While `write` runs, and only then, `passwordHeld(userId)` is true (card
 * 2726): a service that must not write without the password asks it itself.
 */
export async function whilePasswordHolds<T>(userId: number, checkedHash: string, write: (current: User) => NotAPromise<T>): Promise<T> {
	return inTransaction(() => {
		const current = db.select().from(users).where(eq(users.id, userId)).get();
		if (!current) throw error(404, 'User not found');
		if (current.passwordHash !== checkedHash) error(409, { message: PASSWORD_CHANGED_MEANWHILE, stepUp: 'changed' });
		held.push(userId);
		try {
			return write(current);
		} finally {
			held.pop();
		}
	}) as T;
}

/**
 * Whether a running `whilePasswordHolds` write holds the password of the
 * account `userId` (card 2726). A service asks it for the caller as the
 * write's `writeAs` read them (`caller.id`), so that what asks a password
 * cannot be written through a route that forgot to ask.
 *
 * At run time it proves only that the write runs inside `whilePasswordHolds`
 * for that account. It is not an unforgeable token: `whilePasswordHolds` takes
 * the hash as an argument, which any server code can read from the row. That
 * the password was checked first is held by source scans, at test time:
 * `tests/check-at-the-write.test.ts` lets `whilePasswordHolds` be used
 * nowhere in src but in a handler on its CURRENT_PASSWORD list, each of which
 * asks for the password before it, and the step-up pin
 * (`tests/step-up.test.ts`, cases 1 and 2) holds each action that asks to ask
 * before what it guards. Together: the write ran inside `whilePasswordHolds`
 * in an allowed handler. A proof only a password check can mint is a card of
 * its own.
 */
export function passwordHeld(userId: number): boolean {
	return held.includes(userId);
}

/**
 * Refused 400 `STEP_UP_MISSING` (`stepUp: 'missing'`) unless `passwordHeld(userId)`
 * (card 2726): the answer a route gives a request that sent no password, which
 * the pages meet by asking for it.
 */
export function requirePasswordHeld(userId: number): void {
	if (!passwordHeld(userId)) error(400, { message: STEP_UP_MISSING, stepUp: 'missing' });
}

// ─── Session Management ─────────────────────────────────────────────────────

/** Create a new session for a user. Returns the session token (UUID). */
export function createSession(userId: number): string {
	const token = crypto.randomUUID();
	const expiresAt = stamp(new Date(Date.now() + SESSION_DURATION_DAYS * 24 * 60 * 60 * 1000));

	db.insert(sessions)
		.values({ id: token, userId, expiresAt })
		.run();

	// Said once the session is committed. The logger keeps a line written
	// inside a transaction whichever way it ends, and this one would then say
	// a session was created that was rolled back.
	afterCommit(() =>
		log.info(`Session created for user ${userId}`, { tokenPrefix: token.slice(0, 8), expiresAt }, { userId })
	);

	return token;
}

/** What `findSession` found for a token. */
type FoundSession =
	| { open: true; session: Session; user: User }
	| { open: false; why: 'missing' }
	| { open: false; why: 'expired' | 'orphaned'; session: Session };

/**
 * Whether the session with this token is open: it is there, it has not
 * expired, and its account still exists. If not, which of those it failed.
 *
 * Two reads, and nothing written or logged. `validateSession`,
 * `sessionStillOpen`, `openSessionUser` and `stillAuthenticated` all ask it,
 * so that what counts as an open session is decided in one place.
 */
function findSession(token: string): FoundSession {
	const session = db.select()
		.from(sessions)
		.where(eq(sessions.id, token))
		.get();
	if (!session) return { open: false, why: 'missing' };

	// Read as the moment it names, and closed when it names none (the P6
	// review, S2): compared as text, `zzz`, 30 February 2099, or ISO with its
	// `T` on the day itself all sorted after now, and kept the session open.
	const expires = toStamp(session.expiresAt);
	if (expires === null || expires <= stamp()) return { open: false, why: 'expired', session };

	const user = db.select()
		.from(users)
		.where(eq(users.id, session.userId))
		.get();
	if (!user) return { open: false, why: 'orphaned', session };

	return { open: true, session, user };
}

/**
 * Validate a session token. Returns the user if valid, null otherwise.
 * Also extends the session expiry on each valid access (sliding window).
 */
export function validateSession(token: string): SessionUser | null {
	const tokenPrefix = token.slice(0, 8);
	const found = findSession(token);

	// Distinguish a deleted/unknown token from a naturally expired one — the
	// difference matters when investigating "I got logged out" reports.
	if (!found.open && found.why === 'missing') {
		log.warn('Session validation failed — token not in DB (deleted or never issued)', { tokenPrefix });
		return null;
	}

	if (!found.open && found.why === 'expired') {
		log.info('Session validation failed — session expired', { tokenPrefix, expiresAt: found.session.expiresAt }, { userId: found.session.userId });
		return null;
	}

	if (!found.open) {
		// Orphaned session — clean up
		log.warn('Orphaned session (user no longer exists) — deleting', { tokenPrefix, userId: found.session.userId });
		db.delete(sessions).where(eq(sessions.id, token)).run();
		return null;
	}

	// Slide the session expiry forward
	const newExpiry = stamp(new Date(Date.now() + SESSION_DURATION_DAYS * 24 * 60 * 60 * 1000));
	db.update(sessions)
		.set({ expiresAt: newExpiry })
		.where(eq(sessions.id, token))
		.run();

	return sessionUserOf(found.user);
}

/** An account's row, as a request's `locals.user` holds it. */
function sessionUserOf(user: User): SessionUser {
	return {
		id: user.id,
		username: user.username,
		email: user.email,
		emoji: user.emoji || '👤',
		role: user.role
	};
}

/**
 * Whether the session with this token is still open: there, not expired, and
 * with an account. False for no token at all.
 *
 * Written for the live streams, which are let in once by the gate and then
 * stay open, so that a sign-out, a password change or a reset stops what an
 * open tab receives. Each stream now asks `openSessionUser` at its heartbeat,
 * the board stream too since card 2170, which answers this and gives the
 * account as well. Unlike `validateSession` it writes and logs nothing. It does not move the
 * expiry on, or an open tab would keep its session alive for ever, and it
 * leaves an orphaned session for the gate to delete.
 */
export function sessionStillOpen(token: string | undefined): boolean {
	return token !== undefined && findSession(token).open;
}

/**
 * The account of the session with this token as it is now, if the session is
 * still open as `sessionStillOpen` asks it; null if not, or for no token.
 *
 * For a live stream let in for what its account was when it opened: the
 * system log for an administrator, every board's events for one, and a
 * board's events for someone who can open it. It asks this at each heartbeat
 * in place of `sessionStillOpen`, and ends when the session has gone or what
 * it was let in for has (the role, or for the board stream access to the
 * board, card 2170), so that an administrator made an ordinary user, or
 * someone taken off a board, stops receiving within one heartbeat.
 * Like `sessionStillOpen` it writes and logs nothing.
 */
export function openSessionUser(token: string | undefined): SessionUser | null {
	if (token === undefined) return null;
	const found = findSession(token);
	return found.open ? sessionUserOf(found.user) : null;
}

/** Delete a session (logout). The reason is recorded in the system log. */
export function deleteSession(token: string, reason = 'unspecified'): void {
	const session = db.select({ userId: sessions.userId }).from(sessions).where(eq(sessions.id, token)).get();
	db.delete(sessions).where(eq(sessions.id, token)).run();
	if (session) {
		log.info(`Session deleted (${reason})`, { tokenPrefix: token.slice(0, 8), reason }, { userId: session.userId });
	}
}

// ─── What Setting a Password Ends ───────────────────────────────────────────

/**
 * What `endAccountAccess` ended: how many of each, and the ids of the webhooks
 * it switched off and the report schedules it paused, for the log line.
 */
export type AccessEnded = {
	sessions: number;
	invites: number;
	apiKeys: number;
	/** Webhooks the account set that were on, switched off. */
	webhooks: number;
	/** The account's report schedules that were on, paused. */
	reportSchedules: number;
	webhookIds: number[];
	reportScheduleIds: number[];
};

/** ` (id 4)`, ` (ids 4, 7)`, or nothing for none: the ids a log line names. */
export const namingIds = (ids: number[]): string =>
	ids.length === 0 ? '' : ` (${ids.length === 1 ? 'id' : 'ids'} ${ids.join(', ')})`;

/**
 * End what setting an account's password ends, in the transaction that sets
 * it, so that the password and all of this change together: every session of
 * the account, every invite of it that has not been used, and, when `apiKeys`
 * is true, every API key it has and every webhook it set that is on, which is
 * switched off; when `reportSchedules` is true, every report schedule of it
 * that is on, which is paused. In that order. Returns how many of each, and
 * which webhooks and schedules.
 *
 * Every way of setting a password ends the sessions and the waiting invites:
 * a waiting invite would let whoever holds it set the password again. The keys
 * end on an administrator's reset and when an invite is used, which are how an
 * account is taken back from someone who has its password or a session. On
 * the holder's own change, made with their current password, they end only
 * when the holder asks: a routine change is not about an intruder, and ending
 * keys stops every script that uses them.
 *
 * A webhook goes with the keys (card 2168): it is made with a key, and keeps
 * sending a board's events to its address after the key has gone. "The
 * account set it" is `webhooks.set_by`, the account that last set its address
 * or secret. It is switched off, not deleted, so that the board's owner or an
 * administrator can switch on again one they recognise (`PUT
 * /api/v1/webhooks/{id}`), and it keeps naming its setter. A report schedule
 * is paused on an administrator's reset and when an invite is used, and not on
 * the holder's own change: it is made with a session, which every change
 * ends, and its owner sees it, and switches it on again, on the Reports page.
 * Each statement runs only under its option, whether or not a row matches.
 *
 * An invite that was used is left, marked used: that is how the invite page
 * and the backup tell a spent invite from a waiting one. The invites end
 * through `endUnusedInvites`, in invites.ts, which a change of the account's
 * email address or role calls too.
 *
 * It ends nothing else. A webhook nobody is recorded as having set, one made
 * before migration 0056 or whose setter's account was deleted, is left on, and
 * so is one somebody else set since. Since card 2325 one with no setter is
 * held at delivery all the same (webhooks.ts, `holdOf`), as is one whose
 * setter can no longer open its board.
 *
 * It throws if no transaction is open.
 */
export function endAccountAccess(userId: number, opts: { apiKeys: boolean; reportSchedules: boolean }): AccessEnded {
	if (!sqlite.inTransaction) {
		throw new Error(
			'endAccountAccess must be called inside the transaction that sets the password: wrap the change ' +
				'and this call in inTransaction.'
		);
	}
	const sessionsEnded = db.delete(sessions).where(eq(sessions.userId, userId)).run().changes;
	const invitesEnded = endUnusedInvites(userId);
	const apiKeysEnded = opts.apiKeys ? db.delete(apiKeys).where(eq(apiKeys.userId, userId)).run().changes : 0;
	const ids = (rows: { id: number }[]) => rows.map((row) => row.id).sort((a, b) => a - b);
	const webhookIds = opts.apiKeys
		? ids(
				db
					.update(webhooks)
					.set({ active: false })
					.where(and(eq(webhooks.setBy, userId), eq(webhooks.active, true)))
					.returning({ id: webhooks.id })
					.all()
			)
		: [];
	const reportScheduleIds = opts.reportSchedules
		? ids(
				db
					.update(reportSchedules)
					.set({ enabled: false, updatedAt: stamp() })
					.where(and(eq(reportSchedules.userId, userId), eq(reportSchedules.enabled, true)))
					.returning({ id: reportSchedules.id })
					.all()
			)
		: [];
	return {
		sessions: sessionsEnded,
		invites: invitesEnded,
		apiKeys: apiKeysEnded,
		webhooks: webhookIds.length,
		reportSchedules: reportScheduleIds.length,
		webhookIds,
		reportScheduleIds
	};
}

/**
 * Delete all expired sessions (housekeeping), by the rule `findSession`
 * applies: an expiry that names no moment has passed, and a readable one is
 * compared as the stamp it names (`stamp_of`, which is `toStamp`). Deleted by
 * text, `expires_at < now`, such a session was closed at its next use but
 * never cleared (the second P6 review).
 */
export function cleanExpiredSessions(): void {
	const now = stamp();
	registerStampFunctions(sqlite);
	const result = sqlite
		.prepare('DELETE FROM sessions WHERE stamp_of(expires_at) IS NULL OR stamp_of(expires_at) <= ?')
		.run(now);
	if (result.changes > 0) {
		log.info(`Cleaned up ${result.changes} expired session(s)`);
	}
}

// ─── Cookie Utilities ────────────────────────────────────────────────────────

/**
 * Whether a cookie this server sets is sent over HTTPS only: `COOKIE_SECURE`
 * when it is set, and otherwise in production. The session cookie's rule,
 * and the remembered browser's (known-browsers.ts).
 */
export function secureCookies(): boolean {
	return process.env.COOKIE_SECURE !== undefined
		? process.env.COOKIE_SECURE === 'true'
		: process.env.NODE_ENV === 'production';
}

/** Set the session cookie on the response. */
export function setSessionCookie(cookies: Cookies, token: string): void {
	cookies.set(SESSION_COOKIE_NAME, token, {
		path: '/',
		httpOnly: true,
		sameSite: 'lax',
		secure: secureCookies(),
		maxAge: SESSION_DURATION_DAYS * 24 * 60 * 60
	});
}

/** Clear the session cookie. */
export function clearSessionCookie(cookies: Cookies): void {
	cookies.delete(SESSION_COOKIE_NAME, { path: '/' });
}

// ─── User Queries ────────────────────────────────────────────────────────────

/** Check if any users exist in the database. */
export function hasAnyUsers(): boolean {
	const result = db.select().from(users).limit(1).get();
	return !!result;
}

/** Get a user by username (case-insensitive). */
export function getUserByUsername(username: string) {
	return db.select().from(users).where(eq(users.username, username)).get();
}

/** Get a user by email (case-insensitive). */
export function getUserByEmail(email: string) {
	return db.select().from(users).where(eq(users.email, email)).get();
}

// ─── API Key Management ─────────────────────────────────────────────────────

/** Hash an API key using SHA-256. */
export function hashApiKey(key: string): string {
	return createHash('sha256').update(key).digest('hex');
}

/** Generate a new API key. Returns { plaintextKey, keyHash, keyPrefix }. */
export function generateApiKey(): { plaintextKey: string; keyHash: string; keyPrefix: string } {
	const raw = randomBytes(32).toString('hex');
	const plaintextKey = `df_${raw}`;
	const keyHash = hashApiKey(plaintextKey);
	const keyPrefix = plaintextKey.substring(0, 11); // "df_" + first 8 hex chars
	return { plaintextKey, keyHash, keyPrefix };
}

/**
 * The API key a caller presented, if it is one: its row's id, which is what
 * the gate counts the key's requests against, and the user it acts as. Null
 * for a key that is not in `api_keys`, has expired, or belongs to a user who
 * no longer exists.
 *
 * It reads and writes nothing else. `last_used_at` is the gate's to touch,
 * with `markApiKeyUsed`, once the request is let in: a key that is over its
 * rate limit is refused, and was not used.
 *
 * One SHA-256 and one lookup on a unique column, so it is cheap enough to be
 * asked before anything is counted.
 */
export function findApiKey(key: string): { id: number; user: SessionUser } | null {
	const apiKey = db.select()
		.from(apiKeys)
		.where(eq(apiKeys.keyHash, hashApiKey(key)))
		.get();

	const user = apiKey ? keyHolder(apiKey) : null;
	return apiKey && user ? { id: apiKey.id, user: sessionUserOf(user) } : null;
}

/**
 * The account an API key's row acts as, if the key is open: it has not
 * expired, and its account still exists. Null if not. `findApiKey` and
 * `stillAuthenticated` both ask it, so that what counts as an open key is
 * decided in one place.
 */
function keyHolder(apiKey: typeof apiKeys.$inferSelect): User | null {
	// An expiry is read as the moment it names, and one that names none has
	// passed (the P6 review, S2), as a session's is in `findSession`.
	if (apiKey.expiresAt !== null) {
		const expires = toStamp(apiKey.expiresAt);
		if (expires === null || expires < stamp()) return null;
	}

	return db.select()
		.from(users)
		.where(eq(users.id, apiKey.userId))
		.get() ?? null;
}

/**
 * What the gate let a request in with, kept in `locals.credential` beside the
 * account it acts as: the API key's row id under /api/v1/, or the session's
 * token. Null where it let a request in with neither.
 */
export type Credential = { kind: 'api key'; id: number } | { kind: 'session'; token: string };

/**
 * The account the API key or session the gate let this request in with acts
 * as, as it is now; refused 401, in the gate's own words, when that key or
 * session is no longer open: deleted, expired, or its account gone. Called
 * inside the transaction that writes, so that the answer holds for the
 * write: through `writeAs` and `stillCallerNow` (write-as.ts, card 2253).
 *
 * The gate decides who is calling before the body is read, and a body can
 * take as long as the caller likes to arrive. A password reset committed
 * meanwhile ends the key or the session (`endAccountAccess`), and switches
 * off the webhooks and pauses the schedules the account had; a create or a
 * change that went on to write after it would make one again, running, for
 * the account that has just been taken back (the review of card 2168, S1).
 * And a role lowered meanwhile left the write to decide on the role the gate
 * had read. Asked in the transaction, with nothing awaited between this and
 * the write, neither can come between them.
 *
 * The account is read through the credential, as the gate reads it, and
 * `locals.user` is set to it, so that what the handler answers after the
 * transaction is as consistent as what it decided. A request the gate let in
 * with no key or session (`null`: a public route) answers null, for the
 * handler's own rule to decide; one that came with a session that has ended
 * is refused, never taken for anonymous.
 *
 * The gate records a credential, or null, on every request it hands on. One
 * with none recorded (`undefined`) reached its handler without the gate: a
 * test that calls a handler directly, which is answered `locals.user` as it
 * is, or, anywhere but under vitest, a fault, refused 401 with one ERROR line
 * naming the request (the plan's R10).
 *
 * It throws if no transaction is open.
 */
export function stillAuthenticated(locals: App.Locals): SessionUser | null {
	if (!sqlite.inTransaction) {
		throw new Error('stillAuthenticated must be called inside the transaction that writes: call it in inTransaction.');
	}
	const credential = locals.credential;
	if (credential === undefined) {
		if (process.env.VITEST) return locals.user;
		// Filed under the account the handler was handed, where there is one,
		// with where it was asked from: a few frames, enough to find the caller.
		const stack = (new Error().stack ?? '').split('\n').slice(1, 6).map((frame) => frame.trim()).join('\n');
		log.error(
			`A write reached its handler with no credential recorded by the gate: ${requestNamed()}; refused 401; ` +
				'this is a fault in DumpFire, not in the request: report this line',
			{ stack },
			{ userId: locals.user?.id ?? null }
		);
		error(401, 'Not authenticated');
	}
	if (credential === null) {
		locals.user = null;
		return null;
	}
	let holder: User | null = null;
	if (credential.kind === 'api key') {
		const apiKey = db.select().from(apiKeys).where(eq(apiKeys.id, credential.id)).get();
		holder = apiKey ? keyHolder(apiKey) : null;
		if (!holder) error(401, 'Invalid or expired API key');
	} else {
		const found = findSession(credential.token);
		holder = found.open ? found.user : null;
		if (!holder) error(401, 'Not authenticated');
	}
	locals.user = sessionUserOf(holder);
	return locals.user;
}

/**
 * The request being answered, as the gate's log line writes it (`POST
 * /api/cards`), for the one line `stillAuthenticated` writes; or words that
 * say SvelteKit could not name it, for a handler called with no request
 * around it.
 */
function requestNamed(): string {
	try {
		const event = getRequestEvent();
		return `${event.request.method} ${pathToLog(event.url.pathname, event.route.id ?? event.url.pathname)}`;
	} catch {
		return 'a request SvelteKit could not name';
	}
}

/** Record that the API key with this row id was used, now. */
export function markApiKeyUsed(id: number): void {
	db.update(apiKeys)
		.set({ lastUsedAt: stamp() })
		.where(eq(apiKeys.id, id))
		.run();
}
