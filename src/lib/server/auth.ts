/**
 * auth.ts — Server-side authentication utilities for DumpFire.
 *
 * Handles password hashing, session management, and cookie operations.
 * Uses bcryptjs for password hashing and crypto.randomUUID() for session tokens.
 */

import { hashSync, compareSync } from 'bcryptjs';
import { createHash, randomBytes } from 'node:crypto';
import { db, sqlite } from './db';
import { afterCommit } from './db/transaction';
import { users, sessions, apiKeys, type Session, type User } from './db/schema';
import { eq, lt } from 'drizzle-orm';
import { error, type Cookies } from '@sveltejs/kit';
import { endUnusedInvites } from './invites';
import { checkRateLimit, resetRateLimit } from './rate-limit';
import { createLogger } from './logger';

const log = createLogger('AUTH');

// ─── Constants ───────────────────────────────────────────────────────────────

export const SESSION_COOKIE_NAME = 'dumpfire_session';
const BCRYPT_ROUNDS = 12;
const SESSION_DURATION_DAYS = 30;

// ─── Types ───────────────────────────────────────────────────────────────────

export type SessionUser = {
	id: number;
	username: string;
	email: string;
	emoji: string;
	role: string;
};

// ─── Password Utilities ──────────────────────────────────────────────────────

/** Hash a plaintext password using bcrypt with 12 rounds. */
export function hashPassword(password: string): string {
	return hashSync(password, BCRYPT_ROUNDS);
}

/** Verify a plaintext password against a bcrypt hash. */
export function verifyPassword(password: string, hash: string): boolean {
	return compareSync(password, hash);
}

// ─── Checking a Current Password ────────────────────────────────────────────

/** How many current passwords one session may try in the window: sign-in's number. */
const CURRENT_PASSWORD_ATTEMPTS = 10;
/** Fifteen minutes, as for sign-in. */
const CURRENT_PASSWORD_WINDOW_MS = 15 * 60 * 1000;

/**
 * Whether `password` is the account's current password, whose hash is `hash`,
 * with the attempt counted against `session`: the session the request was
 * made with, read from its cookie.
 *
 * The email form, the password form and Generate Key each ask a caller who is
 * already signed in for their current password. It is what whoever holds a
 * session and not the password (an unlocked machine, a copied cookie) would
 * need, to move the email, set a new password or make a key, and each guess
 * used to be answered at once, as often as asked. Now it is sign-in's rule:
 * every attempt is counted, ten in 15 minutes, and the right password clears
 * the count. The eleventh attempt in the window is answered 429 before any
 * password is checked, whatever it carries, the right one included.
 *
 * The count is the session's and not the account's. Kept on the account,
 * whoever held one session of it could keep every session of it refused, the
 * owner's included, and so keep the owner from changing the password, which
 * is how the owner ends the other sessions. A session is made only by signing
 * in or with an invite, and each of those asks for the password or sets it, so
 * a count on the session slows the guesser as much. It is kept in memory, as
 * sign-in's is: a restart clears it.
 *
 * Each wrong password is a WARN line naming `where` and the user, as each
 * failed sign-in is, and so is the first refusal at the limit in each window,
 * the eleventh attempt; the refusals after it in that window are not logged.
 * The session is never logged: it is what signs its holder in.
 *
 * Asked once for a request, before its transaction: a check takes about a
 * quarter of a second. A route that checks again inside the transaction,
 * because the password was changed in between, uses `verifyPassword`. That is
 * the same guess, and is not counted twice.
 */
export function currentPasswordMatches(
	session: string,
	userId: number,
	password: string,
	hash: string,
	where: string
): boolean {
	const key = `current-password:${session}`;

	const { limited, retryAfterSecs, attempts } = checkRateLimit(key, CURRENT_PASSWORD_ATTEMPTS, CURRENT_PASSWORD_WINDOW_MS);
	if (limited) {
		const minutes = Math.ceil(retryAfterSecs / 60);
		// Said once a window, at the first refusal: a script that goes on
		// asking would otherwise write a line for every one.
		if (attempts === CURRENT_PASSWORD_ATTEMPTS + 1) {
			log.warn(
				`Current password not checked for user ${userId} on ${where}: too many wrong ones from this session`,
				{ where, retryAfterSecs },
				{ userId }
			);
		}
		error(429, `Too many wrong passwords. Try again in ${minutes} minute(s).`);
	}

	if (verifyPassword(password, hash)) {
		resetRateLimit(key);
		return true;
	}

	log.warn(`Wrong current password for user ${userId} on ${where}`, { where }, { userId });
	return false;
}

// ─── Session Management ─────────────────────────────────────────────────────

/** Create a new session for a user. Returns the session token (UUID). */
export function createSession(userId: number): string {
	const token = crypto.randomUUID();
	const expiresAt = new Date(Date.now() + SESSION_DURATION_DAYS * 24 * 60 * 60 * 1000).toISOString();

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
 * `sessionStillOpen` and `openSessionUser` all ask it, so that what counts as
 * an open session is decided in one place.
 */
function findSession(token: string): FoundSession {
	const session = db.select()
		.from(sessions)
		.where(eq(sessions.id, token))
		.get();
	if (!session) return { open: false, why: 'missing' };

	if (session.expiresAt <= new Date().toISOString()) return { open: false, why: 'expired', session };

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
	const newExpiry = new Date(Date.now() + SESSION_DURATION_DAYS * 24 * 60 * 60 * 1000).toISOString();
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
 * For a live stream, which is let in once by the gate and then stays open:
 * it asks this at each heartbeat and ends when the answer is no, so that a
 * sign-out, a password change or a reset stops what an open tab receives.
 * Unlike `validateSession` it writes and logs nothing. It does not move the
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
 * system log for an administrator, and every board's events for one. It asks
 * this at each heartbeat in place of `sessionStillOpen`, and ends when the
 * session has gone or the role it was let in for has, so that an
 * administrator made an ordinary user stops receiving within one heartbeat.
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

/** How many of each `endAccountAccess` ended. */
export type AccessEnded = { sessions: number; invites: number; apiKeys: number };

/**
 * End what setting an account's password ends, in the transaction that sets
 * it, so that the password and all of this change together: every session of
 * the account, every invite of it that has not been used, and, when `apiKeys`
 * is true, every API key it has. In that order. Returns how many of each were
 * deleted.
 *
 * Every way of setting a password ends the sessions and the waiting invites:
 * a waiting invite would let whoever holds it set the password again. The keys
 * end on an administrator's reset and when an invite is used, which are how an
 * account is taken back from someone who has its password or a session. On
 * the holder's own change, made with their current password, they end only
 * when the holder asks: a routine change is not about an intruder, and ending
 * keys stops every script that uses them.
 *
 * An invite that was used is left, marked used: that is how the invite page
 * and the backup tell a spent invite from a waiting one. The invites end
 * through `endUnusedInvites`, in invites.ts, which a change of the account's
 * email address or role calls too.
 *
 * It ends nothing else. Webhooks registered with the account's keys (a webhook
 * has no owner) and the account's report schedules outlive it.
 *
 * It throws if no transaction is open.
 */
export function endAccountAccess(userId: number, opts: { apiKeys: boolean }): AccessEnded {
	if (!sqlite.inTransaction) {
		throw new Error(
			'endAccountAccess must be called inside the transaction that sets the password: wrap the change ' +
				'and this call in inTransaction.'
		);
	}
	const sessionsEnded = db.delete(sessions).where(eq(sessions.userId, userId)).run().changes;
	const invitesEnded = endUnusedInvites(userId);
	const apiKeysEnded = opts.apiKeys ? db.delete(apiKeys).where(eq(apiKeys.userId, userId)).run().changes : 0;
	return { sessions: sessionsEnded, invites: invitesEnded, apiKeys: apiKeysEnded };
}

/** Delete all expired sessions (housekeeping). */
export function cleanExpiredSessions(): void {
	const now = new Date().toISOString();
	const result = db.delete(sessions).where(lt(sessions.expiresAt, now)).run();
	if (result.changes > 0) {
		log.info(`Cleaned up ${result.changes} expired session(s)`);
	}
}

// ─── Cookie Utilities ────────────────────────────────────────────────────────

/** Set the session cookie on the response. */
export function setSessionCookie(cookies: Cookies, token: string): void {
	cookies.set(SESSION_COOKIE_NAME, token, {
		path: '/',
		httpOnly: true,
		sameSite: 'lax',
		secure: process.env.COOKIE_SECURE !== undefined
			? process.env.COOKIE_SECURE === 'true'
			: process.env.NODE_ENV === 'production',
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
	const hash = hashApiKey(key);
	const now = new Date().toISOString();

	const apiKey = db.select()
		.from(apiKeys)
		.where(eq(apiKeys.keyHash, hash))
		.get();

	if (!apiKey) return null;

	// Check expiry
	if (apiKey.expiresAt && apiKey.expiresAt < now) return null;

	const user = db.select()
		.from(users)
		.where(eq(users.id, apiKey.userId))
		.get();

	if (!user) return null;

	return {
		id: apiKey.id,
		user: {
			id: user.id,
			username: user.username,
			email: user.email,
			emoji: user.emoji || '👤',
			role: user.role
		}
	};
}

/** Record that the API key with this row id was used, now. */
export function markApiKeyUsed(id: number): void {
	db.update(apiKeys)
		.set({ lastUsedAt: new Date().toISOString() })
		.where(eq(apiKeys.id, id))
		.run();
}
