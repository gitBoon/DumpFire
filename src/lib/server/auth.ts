/**
 * auth.ts — Server-side authentication utilities for DumpFire.
 *
 * Handles session management, cookie operations and the checking of a
 * current password. Passwords are hashed and checked in passwords.ts, on
 * worker threads (card 2191); session codes are crypto.randomUUID().
 *
 * A session's code is kept only as its SHA-256, 32 bytes as a BLOB in
 * `sessions.id` (card 2775, as invite tokens are since card 2849), so the
 * database holds no working sign-in. A session ends at one deadline: the
 * earlier of its expiry, slid by each use to the idle limit of the account's
 * role, and its start plus the total limit of that role, both judged on the
 * role as it is at every check (`SESSION_LIMITS`). The code itself goes no
 * further than the gate: `readSessionCookie` is the gate's alone, and from
 * there on a request carries the hash, in `locals.credential`.
 *
 * Since the compatibility release (card 3064) two-step sign-in may be dormant
 * (`twoStepRequired`): until it is required, a session made on a password
 * alone (`two_step` 0) opens while its account holds no second factor and has
 * `DORMANT_LIMITS` (a session made with a code keeps `SESSION_LIMITS`, the
 * code review's CS-L2), and a session the release kept is swapped to a new
 * code at its first use, by either cookie name (R12 to R14, CS-M1).
 */

import { createHash, randomBytes } from 'node:crypto';
import { db, sqlite } from './db';
import { afterCommit, inTransaction } from './db/transaction';
import { users, sessions, settings, apiKeys, reportSchedules, mfaFactors, mfaRecoveryCodes, type Session, type User } from './db/schema';
import { twoStepRequired } from './two-step-switch';
import { and, eq, isNull, ne, sql } from 'drizzle-orm';
import { error, type Cookies } from '@sveltejs/kit';
import { getRequestEvent } from '$app/server';
import { endUnusedInvites } from './invites';
import { codeAskedOf, endPendingSignIns, holdsFactor, matchFactors, spendRecoveryCode, spendStep, type FactorMatch } from './mfa-store';
import { raiseSignal } from './sign-in-challenges';
// A cycle of functions only (webhooks.ts imports `keyEnded`): neither uses the other at module load (card 2923, decision 13).
import { accountMayHaveRead, holdWebhooksOfSetter, revealedToAccount, type EndingCause } from './webhooks';
import { holdSettingsSetBy, type SettingsRemoved } from './setting-setters';
import { recordSchedulesAs } from './outbound-changes';
import { REVOKED_BECAUSE, endApiKeys, keyRecorded } from './key-revocations';
import { deletedHere, passwordReplacedHere } from './account-endings';
import { FIRST_LANE_CHECKS_PER_ACCOUNT, enterSignIn, firstLaneChecksAt, leaveSignIn } from './rate-limit';
import { PASSWORDS_BUSY, checkPassword } from './passwords';
import { createLogger } from './logger';
import { parseStamp, stamp, toStamp, type Stamp } from '$lib/timestamps';
import { cookieValues, onlyCookieValue, sendsCookie } from './cookie-header';
import {
	PASSWORD_CHANGED_MEANWHILE,
	STEP_UP_CODE_SPENT,
	STEP_UP_FACTOR_UNUSABLE,
	STEP_UP_IN_FLIGHT,
	STEP_UP_MISSING,
	STEP_UP_NO_FACTOR,
	STEP_UP_SIGNED_OUT,
	stepUpMissing
} from '$lib/step-up-words';
import { registerStampFunctions } from './db/timestamps';
import { pathToLog } from './secret-paths';

const log = createLogger('AUTH');

// ─── Constants ───────────────────────────────────────────────────────────────

/** The session cookie's name where cookies are not HTTPS-only. Tests use it. */
export const SESSION_COOKIE_NAME = 'dumpfire_session';
/** Its name where they are: `__Host-` holds it to this origin, Secure, Path=/, no Domain (card 2775). */
export const SECURE_SESSION_COOKIE_NAME = '__Host-dumpfire_session';

const HOUR = 60 * 60 * 1000;

/**
 * How long a session lasts (card 2775): ended after `idleMs` with no request
 * of its holder's, and `totalMs` after it was made whatever its use. An
 * administrator's and the superadmin's are the shorter; `user` alone has the
 * longer, so an unknown role fails short. Judged on the account's role at
 * every check. Constants, not a setting: a policy an administrator could
 * lengthen from a page would undo the card. Changing them is a release.
 */
export const SESSION_LIMITS = {
	administrator: { idleMs: 12 * HOUR, totalMs: 24 * HOUR },
	user: { idleMs: 3 * 24 * HOUR, totalMs: 7 * 24 * HOUR }
} as const;

/**
 * How long a session made on a password alone (`two_step` 0) lasts while
 * two-step sign-in is dormant (card 3064, R13): 30 days idle, as the version
 * before two-step sign-in had it, and 90 days in all, for every role. A
 * session made with a code keeps `SESSION_LIMITS` whatever the switch (the
 * code review's CS-L2): an account that has set up two-step sign-in has the
 * limits card 2775 gave it. Constants, as those are.
 */
export const DORMANT_LIMITS = { idleMs: 30 * 24 * HOUR, totalMs: 90 * 24 * HOUR } as const;

/** How far ahead a stored moment may be and still be believed: a clock that steps back a little signs nobody out (as known-browsers.ts). */
const SESSION_CLOCK_GRACE_MS = 60 * 1000;

/**
 * The least a session must have left of its total limit to be replaced by the
 * holder's own password change (card 2775, the code review's CS2): less, and
 * the change is refused rather than handing over a session about to end.
 */
const SHORTEST_REPLACEMENT_MS = 60 * 1000;

/**
 * The limits of a session of an account with this role, made with a code
 * (`twoStep` 1) or on a password alone (0), by whether two-step sign-in is
 * `required` (card 3064, R13): `DORMANT_LIMITS` for a password-only session
 * while it is dormant, for every role; otherwise `user`'s for `user` and the
 * administrator's for any other, a session made with a code included whatever
 * the switch (the code review's CS-L2), and any other mark failing short.
 * Every rule that reads a session's length asks this with the switch read
 * where it is asked: `findSession` (through `deadlineOf`), the slide
 * (`nextExpiry`), `createSession`, `replacementStart`, the cookie and
 * `cleanExpiredSessions`.
 */
function sessionLimits(role: string, required: boolean, twoStep: number): { idleMs: number; totalMs: number } {
	if (!required && twoStep === 0) return DORMANT_LIMITS;
	return role === 'user' ? SESSION_LIMITS.user : SESSION_LIMITS.administrator;
}

/** The form a session's code is kept in: its SHA-256, 32 bytes, a BLOB (card 2775, as card 2849). */
export function sessionTokenHash(token: string): Buffer {
	return createHash('sha256').update(token).digest();
}

/** What a log line names a session by: the first 8 hex characters of its hash, never the code. */
function sessionRefOf(hash: Buffer): string {
	return hash.subarray(0, 4).toString('hex');
}

/** The rows held in some other form, written by an image from before card 2775. */
export const SESSION_NOT_IN_HASH_FORM = "(typeof(id) <> 'blob' OR length(id) <> 32)";

/**
 * When the session ends unless used again, in milliseconds, or null when its
 * start or expiry cannot be believed: one that names no moment, a start more
 * than the grace in the future (a clock stepped back far, or a row written by
 * hand), or an expiry further out than the role's idle limit allows (a role
 * raised on the host, where no code runs, or a longer limit written by
 * another image). Null is passed. The limits are those of `role` with
 * two-step sign-in `required` or dormant, for a session marked `twoStep`
 * (card 3064, R13, CS-L2).
 */
function deadlineOf(role: string, required: boolean, twoStep: number, createdAt: string, expiresAt: string, now: number): number | null {
	const { idleMs, totalMs } = sessionLimits(role, required, twoStep);
	const started = parseStamp(createdAt)?.getTime();
	const expires = parseStamp(expiresAt)?.getTime();
	if (started === undefined || expires === undefined) return null;
	if (started > now + SESSION_CLOCK_GRACE_MS) return null;
	if (expires > now + idleMs + SESSION_CLOCK_GRACE_MS) return null;
	return Math.min(expires, started + totalMs);
}

/** The expiry a use at `now` gives a session of `role` marked `twoStep` started at `startedAt`: the idle limit, capped at the total, as `sessionLimits` gives them. */
function nextExpiry(role: string, required: boolean, twoStep: number, startedAt: number, now: number): Stamp {
	const { idleMs, totalMs } = sessionLimits(role, required, twoStep);
	return stamp(new Date(Math.min(now + idleMs, startedAt + totalMs)));
}

// ─── Types ───────────────────────────────────────────────────────────────────

export type SessionUser = {
	id: number;
	username: string;
	email: string;
	emoji: string;
	role: string;
	/**
	 * Null past every gate (card 2671): a disabled account has no session and
	 * no key, so `sessionUserOf` always writes null, and it reaches page data
	 * as null. Carried so that a board check of the caller (`roleOnBoard`)
	 * knows the account is enabled without reading it again; left out, as an
	 * account built by hand is, it is read by id.
	 */
	disabledAt?: null;
};

// ─── Checking a Current Password and Its Code ───────────────────────────────

/**
 * How many wrong answers end the session that sent them (card 2701, decision
 * 6; card 2771, D4): a wrong current password or a wrong code, counted alike.
 * The usual bound, sudo's. The real user loses only the session, and signs in
 * again.
 */
export const WRONG_CURRENT_PASSWORDS_SIGN_OUT = 3;

/**
 * The answer to a check from a session that already has one under way (card
 * 2701, decision 5), and the answer once a session has been ended by its third
 * wrong answer, or had ended some other way while its check was made
 * (decision 6). Kept in `$lib/step-up-words`, which the pages read too: a
 * confirm dialog knows a refusal of the password by its words.
 */
export { STEP_UP_IN_FLIGHT, STEP_UP_SIGNED_OUT };

/**
 * The code sent beside the password (card 2771, D2), in a form already
 * checked by the step-up: the authenticator app's six digits, spaces dropped,
 * or a recovery code as typed, trimmed.
 */
export type ProofCode = { kind: 'authenticator'; digits: string } | { kind: 'recovery'; typed: string };

/**
 * What a check answers (card 2771, D5): whether the password and the code
 * both passed, whether the session is signed out, which code passed and, for a
 * recovery code, how many the account has left.
 */
export type Proven = {
	matches: boolean;
	signedOut: boolean;
	/** `password` for a check made with no code: an account with no factor while two-step sign-in is dormant (card 3064, R6). */
	by: 'authenticator' | 'recovery code' | 'password' | null;
	codesLeft: number | null;
	/** A right password with a wrong code raised the account's signal: the step-up sends the notice (D6). */
	signalled: boolean;
};
/** The answer for a session that is signed out (its row gone, or just ended), whatever the password and code. */
const signedOut = (signalled = false): Proven => ({ matches: false, signedOut: true, by: null, codesLeft: null, signalled });
/** The answer for a wrong password or code, the session still open. */
const notProven = (signalled = false): Proven => ({ matches: false, signedOut: false, by: null, codesLeft: null, signalled });

/**
 * The sessions with a current password being checked now. Kept in memory, as
 * the requests it guards are: a restart ends both. The hex of each session's
 * hash only, never its code or a password.
 */
const checksInFlight = new Set<string>();

/** Forget every check under way, as a restart does: for tests, between them. */
export function forgetChecksInFlight(): void {
	checksInFlight.clear();
}

/**
 * Whether `password` is the account's current password, whose hash is `hash`,
 * and `code` a right code of the account's second factor, with the attempt
 * counted against `sessionHash`: the session the request was made with, as
 * the gate found it (`locals.credential`, card 2775).
 *
 * Every destructive, privilege-changing or exfiltrating action, and the
 * Account page's email, password and API key forms, ask a caller who is
 * already signed in for their current password and a code (cards 2701 and
 * 2771, `confirmStepUp` in step-up.ts, its only caller). It is what whoever
 * holds a session and not the password and the authenticator (an unlocked
 * machine, a copied cookie, a script running in a page) would need.
 *
 * So the attempts are counted on the session's own row
 * (`sessions.wrong_password_count`, migration 0062), for the session's whole
 * life: no window, and a restart does not clear it. One attempt counts once,
 * whichever part is wrong, by its weight (one for each authenticator its code
 * was tried against, card 2772), and only a right password with a right code
 * sets it back to 0. A count of 3 ends the session (decisions 5 and 6, as
 * ruled again by the code review's S1 on 2026-11-04: only a check that
 * compares a password is counted). Steps 1 to 4 run in one turn, with nothing
 * awaited between them, so that no other check can come between:
 *
 *   1. The session's row is read. Gone, the answer is signed out.
 *   2. One check under way per session: a second is answered 429
 *      (`STEP_UP_IN_FLIGHT`), not counted, nothing ended, with no password
 *      compared. The pages send one request per press. Asked before the
 *      threshold below (card 2772's code review, CR1): the check under way
 *      has added its weight before its compare, so with three authenticators
 *      a right one holds the count at 3 until it clears it, and a second
 *      request then must not end the session.
 *      Then a count already at 3 or more ends the session, answered signed
 *      out, with no password compared.
 *   2b. The account's second factor (card 2771, D3), not counted, with no
 *      password compared: none is 403 `no-factor` with a WARN line; for an
 *      authenticator code, every authenticator of the account is tried
 *      (`matchFactors`, card 2772, D4): none that opens is 503
 *      `factor-unusable` (the ERROR lines are `factorSecret`'s), and a code
 *      whose every match is at or below its factor's last step spent is 400
 *      `code-spent`, whatever the password (S1: decided before the compare,
 *      it says nothing of the password). A code that matches no step goes on:
 *      it is never refused here. Each secret is opened only to check, and
 *      zeroed there (S3). A recovery code skips the opening. The attempt's
 *      weight is taken here: the authenticators tried, or 1 for a recovery
 *      code (card 2772, D4, S1).
 *   3. One of the account's five places in the first lane of password checks
 *      (passwords.ts), its sessions' current passwords and its remembered
 *      browsers' sign-ins together (the review's L1). None free is answered
 *      429 (`PASSWORDS_BUSY`), not counted, with no password compared. The
 *      first lane goes ahead of every sign-in, invite and set-up, so without
 *      it one signed-in user could keep checks in flight without end.
 *   4. Counted, by the weight of 2b, in one statement (`UPDATE … RETURNING`),
 *      and then compared on a worker thread: a guess against N authenticators
 *      has 2N candidates, so it counts N, before the compare and the same for
 *      a wrong password or a wrong code, and nothing is added after it (card
 *      2772, D4, S1). A compare that fails on the worker stays counted: it
 *      was made.
 *   5. A wrong password: the row read again, a WARN line, and a count of 3
 *      ends the session; the code is never examined again, nor spent. A right
 *      one: one synchronous transaction, nothing awaited (card 2771, D4, S3).
 *      The session's row is read again: gone (ended by a sign-out, a password
 *      change or a reset meanwhile), the answer is signed out and nothing is
 *      spent, so that an answer given after the end never tells a right guess
 *      from a wrong one. The authenticators are read and tried again
 *      (`matchFactors`), each secret zeroed after; the code verified at the
 *      moment it arrived, taken at 2b (the step then or the one before, so a
 *      step boundary passing during the compare does not make it wrong: the
 *      code review's CS2) and the matched factor's step alone spent
 *      (`spendStep`), or the recovery code
 *      spent (`spendRecoveryCode`); and then the count set to 0. A wrong code,
 *      or a recovery code used or unknown, leaves the count at its weight and,
 *      the password being shown known, raises the account's signal (at most
 *      once an hour) and `failed_codes_since_sign_in` (D6): the WARN line says
 *      so, and a count of 3 ends the session. A step spent by another request
 *      since 2b, or a factor gone or not opening, fails closed: nothing spent,
 *      the count left at its weight, answered as a wrong one. A fault in the
 *      transaction rolls the spend and the clear back together and leaves the
 *      attempt counted.
 *
 * The count is the session's and not the account's. Kept on the account,
 * whoever held one session of it could keep every session of it refused, the
 * owner's included, and so keep the owner from changing the password, which
 * is how the owner ends the other sessions. Sign-in's own counts, by address
 * and by account, and its code lanes, pauses and lock, are not touched: a
 * stolen session could otherwise slow or lock the owner's sign-in from a
 * browser that was never stolen (card 2771, D6).
 *
 * Each wrong answer is a WARN line naming `where` and the user, as each
 * failed sign-in is, and each session ended for it another. The session is
 * never logged: it is what signs its holder in. Nor is the password, the code
 * or the secret.
 *
 * Asked once for a request, before its transaction, and awaited. It resolves
 * to a `Proven` rather than a boolean, so that a missed `await` does not
 * compile; `refuseWrongPassword` turns it into the route's answer. A route
 * whose stored hash moved in between is refused by `whilePasswordHolds`,
 * which compares nothing again (the code review's S2); the code is spent by
 * then (S4).
 *
 * `code` null is a check of the password alone (card 3064, R6), which
 * `confirmStepUp` asks only of an account with no factor while two-step
 * sign-in is dormant: step 2b is skipped, the weight is 1, and the step-5
 * transaction reads the account's factors and the switch again; a factor
 * added, or two-step sign-in required, since the step-up read them is
 * answered 400 `STEP_UP_MISSING` with nothing spent or cleared and the
 * attempt left counted (fail closed). Asked with null for an account that
 * holds a factor, or while two-step sign-in is required, it is a fault in the
 * caller, and throws, with nothing counted.
 */
export async function checkCurrentProof(
	sessionHash: Buffer,
	userId: number,
	password: string,
	code: ProofCode | null,
	hash: string,
	where: string
): Promise<Proven> {
	const thisSession = and(eq(sessions.tokenHash, sessionHash), eq(sessions.userId, userId));
	const session = sessionHash.toString('hex');

	// 1. The session as it is.
	const row = db.select({ count: sessions.wrongPasswordCount }).from(sessions).where(thisSession).get();
	if (!row) return signedOut();
	// 2. One check at a time for the session: not counted, and asked before
	// the count's threshold, which an attempt under way has raised by its
	// weight before its compare (card 2772's code review, CR1). With three
	// authenticators a right attempt holds the count at 3 until it clears it;
	// a second request meanwhile is told to wait, never signed out.
	if (checksInFlight.has(session)) error(429, { message: STEP_UP_IN_FLIGHT, stepUp: 'in-flight' });
	if (row.count >= WRONG_CURRENT_PASSWORDS_SIGN_OUT) {
		endAfterWrongPasswords(sessionHash, userId, where);
		return signedOut();
	}

	// 2b. The account's second factor: not counted, no password compared. The
	// code is judged at the moment it arrived, here and after the compare
	// alike: a step boundary passing during the compare does not make a code
	// that was good when it came a wrong one (card 2771's code review, CS2).
	const at = Date.now();
	if (code === null) {
		// The password alone (card 3064, R6): only for an account with no factor
		// while two-step sign-in is dormant, which the caller read with nothing
		// awaited since. Anything else is a fault in the caller.
		if (holdsFactor(userId) || twoStepRequired()) {
			throw new Error('A current password was checked with no code for an account that holds a factor, or while two-step sign-in is required.');
		}
	} else if (!holdsFactor(userId)) {
		log.warn(`Password not confirmed for user ${userId} on ${where}: the account has no second factor`, { where }, { userId });
		error(403, { message: STEP_UP_NO_FACTOR, stepUp: 'no-factor' });
	}
	// What one attempt counts (card 2772, D4, S1): an authenticator code is
	// tried against every authenticator of the account, so it counts one for
	// each tried; a recovery code counts one, and so does the password alone.
	// Taken here, before the compare, and the same whichever part turns out
	// wrong: no answer says which.
	let weight = 1;
	let arrived: FactorMatch | null = null;
	if (code !== null && code.kind === 'authenticator') {
		arrived = matchFactors(userId, code.digits, at);
		if (arrived.tried === 0) error(503, { message: STEP_UP_FACTOR_UNUSABLE, stepUp: 'factor-unusable' });
		if (arrived.matched === null && arrived.spent) error(400, { message: STEP_UP_CODE_SPENT, stepUp: 'code-spent' });
		weight = arrived.tried;
	}

	// 3. A place in the account's first lane: not counted.
	const place = firstLaneChecksAt(userId);
	if (!enterSignIn(place, FIRST_LANE_CHECKS_PER_ACCOUNT)) error(429, { message: PASSWORDS_BUSY, stepUp: 'busy' });

	// 4. Counted, by the attempt's weight, with nothing awaited since step 1,
	// and then compared.
	checksInFlight.add(session);
	let matches: boolean;
	try {
		const counted = db
			.update(sessions)
			.set({ wrongPasswordCount: sql`${sessions.wrongPasswordCount} + ${weight}` })
			.where(thisSession)
			.returning({ count: sessions.wrongPasswordCount })
			.get();
		if (!counted) return signedOut();
		matches = (await checkPassword(password, hash, 'known')).matches;
	} finally {
		checksInFlight.delete(session);
		leaveSignIn(place);
	}

	// 5. A wrong password: the code is never looked at again.
	if (!matches) return afterWrongAnswer(sessionHash, userId, where, `Wrong current password for user ${userId} on ${where}`, false);

	// A right one: the code verified and spent, and the count cleared, in one
	// transaction with nothing awaited.
	const proved = inTransaction((): Proof => {
		const now = Date.now();
		if (!db.select({ count: sessions.wrongPasswordCount }).from(sessions).where(thisSession).get()) return { kind: 'gone' };
		const held = db.select().from(mfaFactors).where(eq(mfaFactors.userId, userId)).get();
		if (code === null) {
			// The password alone (card 3064, R6): a factor added, or two-step
			// sign-in required, since the step-up read them now asks for a code.
			// Nothing spent or cleared, the attempt left counted (fail closed).
			if (held || twoStepRequired()) return { kind: 'code needed' };
			db.update(sessions).set({ wrongPasswordCount: 0 }).where(thisSession).run();
			return { kind: 'proven', codesLeft: null };
		}
		if (!held) return { kind: 'not spent' };
		let codesLeft: number | null = null;
		if (code.kind === 'authenticator') {
			// Every authenticator tried again, at the arrival's moment (CS2), its
			// unusable ones not said again; the spend below stays the authority,
			// and spends the matched factor's step alone (card 2772, D4).
			const found = matchFactors(userId, code.digits, at, { said: false });
			if (found.matched === null) {
				// Wrong only when no factor matched at 2b either: a match lost since
				// (spent by another request, its factor gone or not opening) fails
				// closed, as does a transaction with no factor that opens.
				return found.spent || found.tried === 0 || (arrived !== null && arrived.matched !== null) ? { kind: 'not spent' } : wrongCode(userId, now);
			}
			if (spendStep(found.matched.factorId, found.matched.step) === 'not spent') return { kind: 'not spent' };
		} else {
			if (spendRecoveryCode(userId, code.typed) !== 'spent') return wrongCode(userId, now);
			codesLeft = db
				.select({ id: mfaRecoveryCodes.id })
				.from(mfaRecoveryCodes)
				.where(and(eq(mfaRecoveryCodes.userId, userId), isNull(mfaRecoveryCodes.usedAt)))
				.all().length;
		}
		db.update(sessions).set({ wrongPasswordCount: 0 }).where(thisSession).run();
		return { kind: 'proven', codesLeft };
	});

	if (proved.kind === 'gone') return signedOut();
	if (proved.kind === 'code needed') {
		log.warn(
			`Password not confirmed for user ${userId} on ${where}: a second factor was added, or two-step sign-in required, while it was checked`,
			{ where },
			{ userId }
		);
		error(400, { message: STEP_UP_MISSING, stepUp: 'missing' });
	}
	if (proved.kind === 'proven') {
		return {
			matches: true,
			signedOut: false,
			by: code === null ? 'password' : code.kind === 'authenticator' ? 'authenticator' : 'recovery code',
			codesLeft: proved.codesLeft,
			signalled: false
		};
	}
	if (proved.kind === 'wrong code') {
		return afterWrongAnswer(sessionHash, userId, where, `Wrong code for user ${userId} on ${where}: the password was right`, proved.signalled);
	}
	return afterWrongAnswer(
		sessionHash,
		userId,
		where,
		`Code not spent for user ${userId} on ${where}: the password was right, and the code's step was used meanwhile or the factor could not be opened`,
		false
	);
}

/** What the transaction of a right password found (card 2771, D4). */
type Proof =
	| { kind: 'gone' }
	/** A check of the password alone that a factor added, or two-step sign-in required, meanwhile now asks a code of (card 3064, R6). */
	| { kind: 'code needed' }
	| { kind: 'proven'; codesLeft: number | null }
	| { kind: 'wrong code'; signalled: boolean }
	| { kind: 'not spent' };

/**
 * A wrong code after a right password, inside the check's transaction (card
 * 2771, D6, S2): the clearest sign the password is known. The account's
 * signal raised (its banner, at most once an hour) and its failed codes since
 * sign-in counted; sign-in's lanes are not touched.
 */
function wrongCode(userId: number, now: number): Proof {
	const signalled = raiseSignal(userId, 'wrong-code', now);
	db.update(users)
		.set({ failedCodesSinceSignIn: sql`${users.failedCodesSinceSignIn} + 1` })
		.where(eq(users.id, userId))
		.run();
	return { kind: 'wrong code', signalled };
}

/**
 * The tail of a counted attempt that did not pass: the session's row read
 * again (gone, signed out), the WARN line `line`, and a count of 3 or more
 * ends the session.
 */
function afterWrongAnswer(sessionHash: Buffer, userId: number, where: string, line: string, signalled: boolean): Proven {
	const thisSession = and(eq(sessions.tokenHash, sessionHash), eq(sessions.userId, userId));
	const now = db.select({ count: sessions.wrongPasswordCount }).from(sessions).where(thisSession).get();
	if (!now) return signedOut(signalled);
	log.warn(line, { where }, { userId });
	if (now.count >= WRONG_CURRENT_PASSWORDS_SIGN_OUT) {
		endAfterWrongPasswords(sessionHash, userId, where);
		return signedOut(signalled);
	}
	return notProven(signalled);
}

/** End a session for its wrong current passwords, with a WARN line that names the user and the route, never the session. */
function endAfterWrongPasswords(sessionHash: Buffer, userId: number, where: string): void {
	log.warn(`Session ended after three wrong current passwords for user ${userId} on ${where}`, { where }, { userId });
	deleteSession(sessionHash, 'three wrong current passwords');
}

/**
 * The route's answer to a current password and code that did not pass:
 * nothing when both did; for a session signed out, 403 `{ message:
 * STEP_UP_SIGNED_OUT, signedOut: true, stepUp: 'signed-out' }` with the
 * session cookie cleared; otherwise 403 in `says`, with `stepUp: 'wrong'`. The
 * answer never says whether a signed-out session's password was right, nor
 * which of the password and the code was wrong, and never echoes either.
 */
export function refuseWrongPassword(cookies: Cookies, checked: Pick<Proven, 'matches' | 'signedOut'>, says: string): void {
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
 * the pages meet by asking for it. Its words say what the step-up asks of the
 * account (card 3064, F25): `STEP_UP_MISSING_PASSWORD` where no code is.
 */
export function requirePasswordHeld(userId: number): void {
	if (!passwordHeld(userId)) error(400, { message: stepUpMissing(codeAskedOf(userId)), stepUp: 'missing' });
}

// ─── Session Management ─────────────────────────────────────────────────────

/** A session as `createSession` makes it: the code for the cookie, and what the cookie's lifetime is computed from. */
export type NewSession = { token: string; createdAt: Stamp; role: string; twoStep: 0 | 1 };

/**
 * What `createSession` throws for an account that is disabled (card 2671,
 * S5): no session is made, and the caller's transaction is rolled back. The
 * sign-in completions answer it as an expired sign-in.
 */
export class AccountDisabled extends Error {
	constructor(readonly userId: number) {
		super(`A session cannot be made for user ${userId}, whose account is disabled.`);
		this.name = 'AccountDisabled';
	}
}

/**
 * Create a new session for a user: a fresh code (a v4 UUID), kept only as
 * its SHA-256 (card 2775), with the expiry the account's role gives it now.
 * Returns the code, which only the cookie holds, with the session's start and
 * the role, for the cookie's lifetime (`setSessionCookie`).
 *
 * `startedAt` is the start of a session this one replaces (the holder's own
 * password change, card 2775 decision 7), so that the total limit is not
 * restarted on a password alone; one that names no moment throws, and nothing
 * is written. So does one whose total limit has already passed: the cookie
 * would have no lifetime (the code review's CM15), and a throw inside the
 * caller's transaction rolls it back. It throws too when the account is not
 * there, as the insert's foreign key would, and `AccountDisabled` when the
 * account is disabled (card 2671): its caller answers that as an expired
 * sign-in, the transaction rolled back.
 *
 * `twoStep` is what the session is marked with, and has no default, so that
 * every caller says (card 3064, R5): 1, made after a second factor (card
 * 2769), only once the second factor has been checked, or with the code
 * checked in the same request; 0, made on a password alone while two-step
 * sign-in is dormant, which `findSession` refuses once it is required or the
 * account holds a factor. The holder's own password change passes the
 * replaced session's own mark, so that a password alone never turns a
 * password-only session into a two-step one. A session on a password alone
 * is never made once two-step sign-in is required or while the account holds
 * a factor (the code review's CS-L3): it throws, and nothing is written, as
 * `findSession` would refuse it at its first use.
 *
 * The total limit it is checked against, and the expiry it is given, are the
 * role's with two-step sign-in as the switch says now, for the `twoStep` it
 * is made with (`sessionLimits`, card 3064, R13, S-L1, CS-L2).
 */
export function createSession(userId: number, opts: { twoStep: 0 | 1; startedAt?: Stamp }): NewSession {
	if (opts.twoStep !== 0 && opts.twoStep !== 1) throw new Error('A session is made with two_step 0 or 1, said by its caller.');
	if (opts.twoStep === 0 && (twoStepRequired() || holdsFactor(userId))) {
		throw new Error('A session on a password alone is made only while two-step sign-in is dormant, for an account with no second factor.');
	}
	let createdAt: Stamp;
	if (opts.startedAt === undefined) {
		createdAt = stamp();
	} else {
		const given = toStamp(opts.startedAt);
		if (given === null) throw new Error('A session cannot be started at a moment that names none.');
		createdAt = given;
	}
	const account = db
		.select({ role: users.role, disabledAt: users.disabledAt, createdAt: users.createdAt, passwordHash: users.passwordHash })
		.from(users)
		.where(eq(users.id, userId))
		.get();
	if (!account) throw new Error(`A session cannot be made for user ${userId}, who is not there.`);
	// Every sign-in completion, the verify, the enrol confirm and the own
	// password change, makes its session here (card 2671, S5): a disabled
	// account gets none, whichever way it got this far. Nor does one the record
	// of account endings names as deleted (card 2996, R16), whatever a host edit
	// has done to its row since. Nor one, but the superadmin, holding a password
	// the record says was replaced here (card 2997, decision 7): an older
	// image's import, a host file rollback or a host edit brought it back.
	if (
		account.disabledAt !== null ||
		deletedHere(sqlite, { id: userId, ...account }) ||
		(account.role !== 'superadmin' && passwordReplacedHere(sqlite, { id: userId, ...account }))
	) {
		throw new AccountDisabled(userId);
	}
	const started = parseStamp(createdAt)!.getTime();
	const now = Date.now();
	const required = twoStepRequired();
	if (started + sessionLimits(account.role, required, opts.twoStep).totalMs <= now) {
		throw new Error('A session cannot be made past its total limit: its cookie would have no lifetime.');
	}

	const token = crypto.randomUUID();
	const hash = sessionTokenHash(token);
	const expiresAt = nextExpiry(account.role, required, opts.twoStep, started, now);

	db.insert(sessions)
		.values({ tokenHash: hash, userId, expiresAt, createdAt, twoStep: opts.twoStep })
		.run();

	// Said once the session is committed. The logger keeps a line written
	// inside a transaction whichever way it ends, and this one would then say
	// a session was created that was rolled back.
	const sessionRef = sessionRefOf(hash);
	afterCommit(() => log.info(`Session created for user ${userId}`, { sessionRef, expiresAt }, { userId }));

	return { token, createdAt, role: account.role, twoStep: opts.twoStep };
}

/**
 * What `findSession` found for a hash; an open session with its deadline, in
 * milliseconds, and whether two-step sign-in was required when it was asked,
 * which the slide then uses (card 3064, R13).
 */
type FoundSession =
	| { open: true; session: Session; user: User; deadline: number; required: boolean }
	| { open: false; why: 'missing' }
	| { open: false; why: 'expired' | 'orphaned' | 'one-step' | 'disabled'; session: Session; required?: boolean };

/**
 * Whether the session with this hash is open: it is there, it was made after
 * a second factor or two-step sign-in is dormant and its account holds no
 * factor, its account still exists and is not disabled (card 2671), and its
 * deadline has not passed.
 * If not, which of those it failed.
 *
 * The deadline (card 2775) is the earlier of `expires_at` and `created_at`
 * plus the total limit of the account's role as it is now, with two-step
 * sign-in required or dormant as the switch says now, for the session's own
 * `two_step` (card 3064, R13, CS-L2); a
 * start or an expiry that cannot be believed (`deadlineOf`) has passed. One
 * rule and one refusal, `expired`, for the idle limit and the total alike.
 *
 * The switch is read once, and the factors only for a session made on a
 * password alone; nothing written or logged. `validateSession`, `openSession`
 * (and through it `openSessionUser`) and `stillAuthenticated` all ask it, so
 * that what counts as an open session is decided in one place.
 */
function findSession(hash: Buffer): FoundSession {
	const session = db.select()
		.from(sessions)
		.where(eq(sessions.tokenHash, hash))
		.get();
	if (!session) return { open: false, why: 'missing' };

	// Made on a password alone (`two_step` 0: card 2769, decision 24). Since
	// the compatibility release (card 3064, R5, S-M1) such a session is made
	// while two-step sign-in is dormant, and kept by migration 0084 from
	// before it. Refused whatever its expiry, and deleted by the gate, once
	// two-step sign-in is required, and whatever the switch once its account
	// holds a second factor: an account that has set up two-step sign-in ends
	// the sign-ins that never used it, on every browser.
	const required = twoStepRequired();
	if (session.twoStep !== 1 && (required || holdsFactor(session.userId))) return { open: false, why: 'one-step', session, required };

	const user = db.select()
		.from(users)
		.where(eq(users.id, session.userId))
		.get();
	if (!user) return { open: false, why: 'orphaned', session };

	// Disabled (card 2671): disabling ends every session in its own write, so
	// this is one that write did not reach, as a restore or a host edit can
	// leave. Refused whatever its expiry; the gate deletes it.
	if (user.disabledAt !== null) return { open: false, why: 'disabled', session };

	// Read as the moments they name, and closed when they name none (the P6
	// review, S2): compared as text, `zzz` or 30 February 2099 sorted after
	// now, and kept the session open.
	const now = Date.now();
	const deadline = deadlineOf(user.role, required, session.twoStep, session.createdAt, session.expiresAt, now);
	if (deadline === null || deadline <= now) return { open: false, why: 'expired', session };

	return { open: true, session, user, deadline, required };
}

/**
 * The account of the session whose code this is, and the session's hash, or
 * null when it is not open. The gate's alone: it reads the code from the
 * cookie (`readSessionCookie`), and hashes it here, once.
 *
 * An open session's expiry is moved on to the idle limit of the account's
 * role, capped at its total limit, only when `slide` is true (as it is when
 * not given): the gate says so for its holder's own use alone
 * (`slidesSession`, card 2775, the code review's CS1). Every other request is
 * checked with every refusal and does
 * not keep the session alive. Each refusal is one line naming the session by
 * `sessionRef`, never by its code. A session swapped at the release's old
 * cookie name (`kept_at_release` 2) is never slid: its last 60 seconds stay
 * its last, by whichever name its code is sent.
 *
 * `oldName` says the code came under the session cookie's name from before
 * card 2775, where cookies are HTTPS-only (`readSessionCookie`, card 3064,
 * R14). It is accepted only while two-step sign-in is dormant and before 30
 * days after the release (`oldNameRefusal`), for a session migration 0084
 * kept (`two_step` 0, `kept_at_release` 1 or 2) that passes every other rule
 * of `findSession`; see `keptByOldName`. `reissue` is then the session that
 * replaced it, whose code the gate sets under the secure name, and the hash
 * answered is that session's; null for every other answer.
 *
 * A session 0084 kept and not yet swapped (`kept_at_release` 1) goes the
 * same way whichever name its code came under (the code review's CS-M1): by
 * the secure name too it is refused once `oldNameRefusal` refuses, and is
 * swapped at its first use, never slid. So every kept code is under the
 * 30-day window and the one-time swap, wherever a browser sends it.
 */
export function validateSession(
	token: string,
	{ slide = true, oldName = false }: { slide?: boolean; oldName?: boolean } = {}
): { user: SessionUser; hash: Buffer; reissue: NewSession | null } | null {
	const hash = sessionTokenHash(token);
	const sessionRef = sessionRefOf(hash);
	if (oldName) {
		// Refused before the row is read: the code that travelled under the old
		// name looks nothing up once the window is closed (card 3064, R14).
		const refusal = oldNameRefusal(Date.now());
		if (refusal !== null) {
			log.info(`Session cookie of the old name refused: ${refusal}`, { sessionRef });
			return null;
		}
	}
	const found = findSession(hash);

	// Distinguish a deleted/unknown session from a naturally expired one — the
	// difference matters when investigating "I got logged out" reports. The
	// reference matches the row: `hex(id) LIKE '<sessionRef>%'`.
	if (!found.open && found.why === 'missing') {
		log.warn('Session validation failed — token not in DB (deleted or never issued)', { sessionRef });
		return null;
	}

	if (!found.open && found.why === 'expired') {
		log.info(
			'Session validation failed — session expired',
			{ sessionRef, createdAt: found.session.createdAt, expiresAt: found.session.expiresAt },
			{ userId: found.session.userId }
		);
		return null;
	}

	if (!found.open && found.why === 'one-step') {
		// Made without a second factor (card 2769, decision 24), and refused:
		// two-step sign-in is required, or its account now holds a factor (card
		// 3064, R5, S-M1). Deleted here, as an orphan is, so that it is said once.
		const because = found.required ? 'two-step sign-in is required' : 'the account holds a second factor';
		log.warn('A hashed session row with two_step 0 — refused and deleted', { sessionRef, because }, { userId: found.session.userId });
		db.delete(sessions).where(eq(sessions.tokenHash, hash)).run();
		return null;
	}

	if (!found.open && found.why === 'disabled') {
		// Of an account that is disabled (card 2671): signed out, deleted here
		// so that it is said once.
		log.warn('Session of a disabled account — refused and deleted', { sessionRef }, { userId: found.session.userId });
		db.delete(sessions).where(eq(sessions.tokenHash, hash)).run();
		return null;
	}

	if (!found.open) {
		// Orphaned session — clean up
		log.warn('Orphaned session (user no longer exists) — deleting', { sessionRef, userId: found.session.userId });
		db.delete(sessions).where(eq(sessions.tokenHash, hash)).run();
		return null;
	}

	if (oldName) return keptByOldName(found, hash, sessionRef, true);

	if (found.session.keptAtRelease === KEPT_UNUSED) {
		// A kept code under the secure name (the code review's CS-M1): the same window and the same one-time swap as
		// by the old name, read now that the row has been found.
		const refusal = oldNameRefusal(Date.now());
		if (refusal !== null) {
			log.info(`Session kept at the release refused: ${refusal}`, { sessionRef }, { userId: found.session.userId });
			return null;
		}
		return keptByOldName(found, hash, sessionRef, false);
	}

	if (slide && found.session.keptAtRelease !== KEPT_SWAPPED) {
		// findSession has read the start as a moment.
		const started = parseStamp(found.session.createdAt)!.getTime();
		db.update(sessions)
			.set({ expiresAt: nextExpiry(found.user.role, found.required, found.session.twoStep, started, Date.now()) })
			.where(eq(sessions.tokenHash, hash))
			.run();
	}

	return { user: sessionUserOf(found.user), hash, reissue: null };
}

/** `sessions.kept_at_release` of a session 0084 kept and nobody has used by the old cookie name since (card 3064, R12). */
const KEPT_UNUSED = 1;
/** `sessions.kept_at_release` of such a session once swapped to a new code under the secure name: its last 60 seconds (R14). */
const KEPT_SWAPPED = 2;

/** How long a kept session's row stays open once swapped, for a parallel tab's request sent before the new cookie arrived (card 3064, R14). */
export const OLD_NAME_GRACE_MS = 60 * 1000;

/** How long after the release the old cookie name is read at all (card 3064, R14, S-L3). */
export const OLD_NAME_WINDOW_MS = 30 * 24 * HOUR;

/** The setting migration 0084 writes once, the moment of the compatibility release (card 3064). */
const COMPATIBILITY_RELEASE_AT = 'compatibility_release_at';

/**
 * Why a session cookie of the old name is refused at `now` before any row is
 * read, or null when it may be read (card 3064, R14): two-step sign-in is
 * required; or no release moment is stored, or one that names none (fail
 * closed); or 30 days have passed since it.
 */
function oldNameRefusal(now: number): string | null {
	if (twoStepRequired()) return 'two-step sign-in is required on this server';
	const stored = db.select({ value: settings.value }).from(settings).where(eq(settings.key, COMPATIBILITY_RELEASE_AT)).get()?.value;
	const release = parseStamp(stored)?.getTime();
	if (release === undefined) return 'this server holds no moment of the compatibility release';
	if (now >= release + OLD_NAME_WINDOW_MS) return 'more than 30 days have passed since the compatibility release';
	return null;
}

/**
 * An open session the code of the old cookie name found, past `oldNameRefusal`
 * (card 3064, R14, S-M2, R-L5):
 *
 * - Not one migration 0084 kept (`two_step` 1, or `kept_at_release` 0, however
 *   it is dated): refused, nothing written. Only a kept session's code ever
 *   travelled under the old name.
 * - Mark 1, its first use by the old name: in one transaction, the row marked
 *   2 with its expiry 60 seconds on, where it is still 1, and a new session
 *   made for the account with a new code, the same start, `two_step` 0 and the
 *   dormant expiry (`createSession`). The request goes on as the new session,
 *   whose code the gate sets under the secure name (`reissue`). Where the mark
 *   was no longer 1, a parallel request swapped it first, and this one is
 *   taken as mark 2.
 * - Mark 2, its next 60 seconds: accepted as the old row's session, never
 *   slid, never swapped again, and no new cookie. Then it has ended, and the
 *   five-minute sweep deletes it.
 *
 * An account the record of account endings will not give a session (its
 * password replaced here: `createSession`'s `AccountDisabled`) is refused,
 * nothing written.
 *
 * `byOldName` says which name the code came under: the old one, or the secure
 * one for a session still marked 1 (the code review's CS-M1), which is swapped
 * the same way; the log lines say which.
 */
function keptByOldName(
	found: Extract<FoundSession, { open: true }>,
	hash: Buffer,
	sessionRef: string,
	byOldName: boolean
): { user: SessionUser; hash: Buffer; reissue: NewSession | null } | null {
	const { session, user } = found;
	const sentAs = byOldName ? 'Session cookie of the old name' : 'Session cookie of the secure name';
	if (session.twoStep !== 0 || (session.keptAtRelease !== KEPT_UNUSED && session.keptAtRelease !== KEPT_SWAPPED)) {
		log.warn(`${sentAs} names a session not kept at the release — refused`, { sessionRef }, { userId: session.userId });
		return null;
	}
	if (session.keptAtRelease === KEPT_UNUSED) {
		let replacement: NewSession | null;
		try {
			replacement = inTransaction(() => {
				const swapped = db
					.update(sessions)
					.set({ keptAtRelease: KEPT_SWAPPED, expiresAt: stamp(new Date(Date.now() + OLD_NAME_GRACE_MS)) })
					.where(and(eq(sessions.tokenHash, hash), eq(sessions.keptAtRelease, KEPT_UNUSED)))
					.run().changes;
				// findSession has read the start as a moment.
				return swapped === 1 ? createSession(session.userId, { twoStep: 0, startedAt: toStamp(session.createdAt)! }) : null;
			});
		} catch (err) {
			if (!(err instanceof AccountDisabled)) throw err;
			log.warn(`${sentAs} names a session whose account is given none — refused`, { sessionRef }, { userId: session.userId });
			return null;
		}
		if (replacement !== null) {
			const newHash = sessionTokenHash(replacement.token);
			log.info(
				byOldName
					? 'Session of the old cookie name swapped to a new code under the secure name'
					: 'Session kept at the release, sent under the secure name, swapped to a new code',
				{ sessionRef, newSessionRef: sessionRefOf(newHash) },
				{ userId: session.userId }
			);
			return { user: sessionUserOf(user), hash: newHash, reissue: replacement };
		}
	}
	return { user: sessionUserOf(user), hash, reissue: null };
}

/** An account's row, as a request's `locals.user` holds it. */
function sessionUserOf(user: User): SessionUser {
	return {
		id: user.id,
		username: user.username,
		email: user.email,
		emoji: user.emoji || '👤',
		role: user.role,
		// Every gate refuses a disabled account, so past one it is enabled (card 2671).
		disabledAt: null
	};
}

/**
 * The account of the session with this hash as it is now, if the session is
 * open (`findSession`); null if not, or for no hash.
 *
 * For a live stream let in for what its account was when it opened: the
 * system log for an administrator, every board's events for one, and a
 * board's events for someone who can open it. It asks this at each heartbeat,
 * and ends when the session has gone or what
 * it was let in for has (the role, or for the board stream access to the
 * board, card 2170), so that an administrator made an ordinary user, or
 * someone taken off a board, stops receiving within one heartbeat.
 * It writes and logs nothing, does not move the expiry on, and leaves an
 * orphaned session for the gate to delete.
 */
export function openSessionUser(hash: Buffer | undefined): SessionUser | null {
	return openSession(hash)?.user ?? null;
}

/**
 * The account of the session with this hash as it is now, and the moment the
 * session ends unless it is used again (its deadline, in milliseconds), if it
 * is open; null if not, or for no hash. For the live streams (card 2775, the
 * code review's CS4): each ends itself at the deadline, and reads it again at
 * each heartbeat, since a request of the holder's may have moved it on.
 * Writes and logs nothing, as `openSessionUser`.
 */
export function openSession(hash: Buffer | undefined): { user: SessionUser; deadline: number } | null {
	if (hash === undefined) return null;
	const found = findSession(hash);
	return found.open ? { user: sessionUserOf(found.user), deadline: found.deadline } : null;
}

/**
 * A timer for a live stream that runs `end` at its session's deadline (card
 * 2775, the code review's CS4), so that a stream stops when its session does
 * and not at the heartbeat after. `arm` sets it for a deadline, replacing the
 * one set before (each heartbeat reads the deadline again: a request of the
 * holder's may have moved it on), and ends the stream at once for none;
 * `clear` stops it, as the stream's own end does.
 */
export function sessionEndTimer(end: () => void): { arm: (deadline: number | undefined) => void; clear: () => void } {
	let timer: ReturnType<typeof setTimeout> | null = null;
	const clear = () => {
		if (timer !== null) clearTimeout(timer);
		timer = null;
	};
	return {
		arm(deadline) {
			clear();
			if (deadline === undefined) return end();
			// setTimeout holds at most 2^31 - 1 ms; a deadline is at most seven days on.
			timer = setTimeout(end, Math.min(Math.max(0, deadline - Date.now()), 2 ** 31 - 1));
		},
		clear
	};
}

/** Delete a session (logout), by its hash. The reason is recorded in the system log. */
export function deleteSession(hash: Buffer, reason = 'unspecified'): void {
	const session = db.select({ userId: sessions.userId }).from(sessions).where(eq(sessions.tokenHash, hash)).get();
	db.delete(sessions).where(eq(sessions.tokenHash, hash)).run();
	if (session) {
		log.info(`Session deleted (${reason})`, { sessionRef: sessionRefOf(hash), reason }, { userId: session.userId });
	}
}

/**
 * The start a session replacing the one with this hash keeps, as the stored
 * form, for the holder's own password change (card 2775, decision 7): the
 * replaced session's own start, so that a password alone does not restart
 * the total limit. Null when there is none to keep, and the change is
 * refused: no such session, a start that names no moment, or less than a
 * minute left of the total limit of `role`, the account's role now (the code
 * review's CS2), which would hand over a session about to end. The total
 * limit is the role's with two-step sign-in as the switch says now, for the
 * replaced session's own `two_step` (card 3064, R13, S-L1, CS-L2): while it
 * is dormant, a session kept at the release changes its holder's password
 * days after it.
 *
 * With the start, the replaced session's own `two_step` (card 3064, R5),
 * which the replacement keeps: a password alone never makes a session that
 * never used a second factor into one that did.
 */
export function replacementStart(hash: Buffer, role: string, now: number = Date.now()): { startedAt: Stamp; twoStep: 0 | 1 } | null {
	const row = db.select({ createdAt: sessions.createdAt, twoStep: sessions.twoStep }).from(sessions).where(eq(sessions.tokenHash, hash)).get();
	const started = row ? toStamp(row.createdAt) : null;
	if (row === undefined || started === null) return null;
	const left = parseStamp(started)!.getTime() + sessionLimits(role, twoStepRequired(), row.twoStep).totalMs - now;
	return left < SHORTEST_REPLACEMENT_MS ? null : { startedAt: started, twoStep: row.twoStep === 1 ? 1 : 0 };
}

/**
 * End every session of an account, and answer how many: for a change of its
 * role (card 2775, decision 6), which takes effect at its holder's next sign-in.
 */
export function endSessionsOf(userId: number): number {
	return db.delete(sessions).where(eq(sessions.userId, userId)).run().changes;
}

/**
 * End every session of an account but the one whose hash is `keep`, and
 * answer how many: for the removal of an authenticator (card 2772, D2), whose
 * holder has just proved the password and a code in the session kept. A
 * session made with the authenticator removed, often a lost phone's, does not
 * outlive it.
 */
export function endOtherSessions(userId: number, keep: Buffer): number {
	return db.delete(sessions).where(and(eq(sessions.userId, userId), ne(sessions.tokenHash, keep))).run().changes;
}

/**
 * End every session a sign-out names (card 2775, the code review's CS3):
 * each value of the session cookie of the name in force for a request to
 * `url`, in a code's shape, read from the raw `Cookie` header and hashed
 * here, so that a planted cookie sent beside the real one does not leave the
 * real session open. Each session ended is one INFO line, by `sessionRef`.
 * Answers how many were ended.
 *
 * Where the name in force is the secure one, each value of the name from
 * before card 2775 too (card 3064, F22): a sign-out by the old name ends the
 * session the gate swapped it to, and this ends the kept session its code
 * still names for its last 60 seconds (`keptByOldName`), so that the code
 * that travelled under the old name signs nobody in after the sign-out.
 */
export function endSessionsSent(request: Request, url: URL, reason: string): number {
	let ended = 0;
	const inForce = sessionCookieName(url);
	const names = inForce === SESSION_COOKIE_NAME ? [inForce] : [inForce, SESSION_COOKIE_NAME];
	for (const code of names.flatMap((name) => cookieValues(request, name))) {
		if (!SESSION_CODE.test(code)) continue;
		const hash = sessionTokenHash(code);
		if (db.select({ userId: sessions.userId }).from(sessions).where(eq(sessions.tokenHash, hash)).get()) ended++;
		deleteSession(hash, reason);
	}
	return ended;
}

/** The hash of the session a credential (`locals.credential`) names, or undefined for none: a key, or no gate. */
export function sessionHashIn(credential: Credential | null | undefined): Buffer | undefined {
	return credential?.kind === 'session' ? credential.hash : undefined;
}

// ─── What Setting a Password Ends ───────────────────────────────────────────

/**
 * What `endAccountAccess` ended: how many of each, and the ids of the webhooks
 * it switched off and the report schedules it paused, for the log line.
 */
export type AccessEnded = {
	sessions: number;
	invites: number;
	/** Pending sign-ins waiting for their second factor (card 2768). */
	challenges: number;
	/** Links to set up an authenticator (card 2768). */
	enrolmentLinks: number;
	apiKeys: number;
	/** Webhooks the account set that were on, switched off (card 2935, P9: only those it set). */
	webhooks: number;
	/**
	 * Webhooks of others whose secret the account could read, switched off or held with its keys (card 2935): 0
	 * without `apiKeys`, and for an account that provably read nothing (P1).
	 */
	readableWebhooks: number;
	/** The account's report schedules that were on, paused. */
	reportSchedules: number;
	/**
	 * Card 2922, with `apiKeys` alone (none otherwise): the mail settings, App URL and backup destinations the
	 * account set that were in force, now held for the superadmin's review (`holdSettingsSetBy`), and how many links
	 * of the requests it made were ended.
	 */
	settingsHeld: SettingsRemoved;
	requestLinks: number;
	/** The ids of the API keys deleted, in order (card 2915's code review, CS2). */
	apiKeyIds: number[];
	webhookIds: number[];
	reportScheduleIds: number[];
};

/** The account's username, for a hold's lines (card 2922), or `user <id>` where it is not found. */
function usernameOf(userId: number): string {
	return db.select({ username: users.username }).from(users).where(eq(users.id, userId)).get()?.username ?? `user ${userId}`;
}

/** ` (id 4)`, ` (ids 4, 7)`, or nothing for none: the ids a log line names. */
export const namingIds = (ids: number[]): string =>
	ids.length === 0 ? '' : ` (${ids.length === 1 ? 'id' : 'ids'} ${ids.join(', ')})`;

/**
 * End what setting an account's password ends, in the transaction that sets
 * it, so that the password and all of this change together: every session of
 * the account, every invite of it that has not been used, every pending
 * sign-in and enrolment link of it (card 2768), and, when `apiKeys`
 * is true, every API key it has and every webhook it set that is on, which is
 * switched off; and every report schedule of it that is on, which is paused,
 * always (card 2894: no option). In that order. Returns how many of each, and
 * which keys (card 2915's code review, CS2), webhooks and schedules.
 *
 * Every way of setting a password ends the sessions and the waiting invites:
 * a waiting invite would let whoever holds it set the password again. The keys
 * end on an administrator's password set and when an invite is used, which are
 * how an account is taken back from someone who has its password or a
 * session, on a reset of the account's two-step sign-in (`resetTwoStep`, card
 * 2915), which answers a lost or stolen authenticator that a key would skip,
 * and when an administrator disables the account (`disableAccount`, card 2671),
 * which ends all of this with the keys and the webhooks. On
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
 * is paused on every way of setting the password, the holder's own change
 * included, and on a reset of the account's two-step sign-in (card 2894): it
 * sends a board's activity whether or not anyone is signed in, so one made by
 * whoever held the account outlives every session. Its owner turns it on
 * again on the Reports page, which asks for the password and a code (card
 * 2751). The keys' and webhooks' statements run only under `apiKeys`; each
 * statement runs whether or not a row matches.
 *
 * An invite that was used is left, marked used: that is how the invite page
 * and the backup tell a spent invite from a waiting one. The invites end
 * through `endUnusedInvites`, in invites.ts, which a change of the account's
 * email address or role calls too. The pending sign-ins and enrolment links
 * end through `endPendingSignIns`, in mfa-store.ts, which those changes call
 * too: a sign-in that waits for its second factor was begun with the password
 * this replaces.
 *
 * It ends nothing else. A webhook nobody is recorded as having set, one made
 * before migration 0056 or whose setter's account was deleted, is left on, and
 * so is one somebody else set since. One with no setter is switched off for
 * good all the same (card 2752: at every start, after every restore and at
 * delivery; webhooks.ts, `switchOffLostWebhooks`), as is one whose setter can
 * no longer open its board, at the write that takes the board away. This
 * switch-off records a hold too, 'setter access ended' (card 2752's code
 * review, CS4): switched on again by the board's owner or an administrator,
 * the webhook is given a new secret, and until then nobody else may make a
 * webhook to its receiver on that board.
 *
 * Under `apiKeys`, a webhook the account set that was already switched off
 * without a hold (by a `PUT`, or by a restore kept apart) is held too (card
 * 2923, decision 1): `held_because` 'setter access ended', `held_at` now,
 * left off, so that switching it on gives it a new secret, which whoever held
 * the account may know. One already off with another hold keeps it (decision
 * 4). The holder's own change that keeps the keys holds nothing (decision 3).
 * One statement for both, after a read of those already off, in
 * `holdWebhooksOfSetter` (webhooks.ts), which `deleteUser` calls too (card
 * 2923's code review, E4). `webhooks` and `webhookIds` count only those that
 * were on.
 *
 * Once committed, both groups are told (`tellSwitchedOff`, card 2923): one
 * WARN under Webhooks for those switched off and one for those held, naming
 * the action and who made it (`cause.log`), and one mail to each owner of
 * their boards, listing both apart, naming the kind of action and nobody
 * (`cause.mail`, the code review's S5). Every caller gives both.
 *
 * Under `apiKeys`, every webhook whose secret the account could read as an
 * administrator (every board) or a board's owner, whoever set it, that has a
 * secret is held the same way (card 2935), unless the account provably read
 * nothing (`accountMayHaveRead`, P1), asked before its keys are deleted, with
 * `exceptInvite`, the invite being used now, left out. Those are counted in
 * `readableWebhooks`; `webhooks` and `webhookIds` stay the ones it set (P9).
 *
 * Under `apiKeys` too (card 2922): the mail settings, the App URL and the
 * backup destinations the account set are held for the superadmin's review
 * (`holdSettingsSetBy`, setting-setters.ts), so that nothing whoever held the
 * account pointed elsewhere sends anything until the superadmin keeps or
 * removes it, and every link of the requests the account made is deleted, as
 * a disable deletes them (card 2671): `settingsHeld` and `requestLinks`.
 *
 * Under `apiKeys`, each key is recorded as ended here before it is deleted
 * (card 2995, `endApiKeys`, `access ended`): no restore brings it back, and
 * every check of a key refuses it.
 *
 * It throws if no transaction is open.
 */
export function endAccountAccess(userId: number, opts: { apiKeys: boolean; cause: EndingCause; exceptInvite?: Buffer }): AccessEnded {
	if (!sqlite.inTransaction) {
		throw new Error(
			'endAccountAccess must be called inside the transaction that sets the password: wrap the change ' +
				'and this call in inTransaction.'
		);
	}
	// Asked before anything ends (card 2935, P1): the keys deleted below are part of the answer.
	const readable = opts.apiKeys && accountMayHaveRead(userId, opts.exceptInvite ?? null);
	// And what its keys were given (card 2947, R10), read before the keys are deleted below, whose rows go with them.
	const revealed = opts.apiKeys ? revealedToAccount(userId) : [];
	const sessionsEnded = db.delete(sessions).where(eq(sessions.userId, userId)).run().changes;
	const invitesEnded = endUnusedInvites(userId);
	const pending = endPendingSignIns(userId);
	const ids = (rows: { id: number }[]) => rows.map((row) => row.id).sort((a, b) => a - b);
	// The ids of the keys deleted, in order (card 2915's code review, CS2): a log line's meta names them. Each recorded
	// first, `access ended`, so that no restore brings it back (card 2995, `endApiKeys`).
	const apiKeyIds = opts.apiKeys ? endApiKeys(sqlite, { userId }, REVOKED_BECAUSE.accessEnded) : [];
	const apiKeysEnded = apiKeyIds.length;
	// Recorded as a hold (the code review of card 2752, CS4): switched on again,
	// each is given a new secret, which whoever held the account may know; and
	// its receiver is the owner's to send to. Those already off with no hold are
	// held too, and both are told once committed (card 2923; `holdWebhooksOfSetter`).
	// With those whose secret it could read (card 2935); the ids are those it set (P9).
	const hold = opts.apiKeys ? holdWebhooksOfSetter(userId, opts.cause, { readable, revealed }) : null;
	const webhookIds = hold ? hold.switchedOff.filter((hook) => hook.reader === undefined).map((hook) => hook.id) : [];
	// With its keys (card 2922): the mail settings, App URL and backup destinations it set held for the superadmin's
	// review, its lines told once committed; and every link of the requests it made ended, as a disable ends them
	// (card 2671): a mailed link is a key to the thread that whoever held the account may hold. Its lines name nobody
	// where `cause.unnamed` (the record's passes; card 2997's code review, FP1).
	const settingsHeld = opts.apiKeys
		? holdSettingsSetBy({ id: userId, username: usernameOf(userId) }, { log: opts.cause.log, unnamed: opts.cause.unnamed }).inForce
		: { mail: false, appUrl: false, destinations: [] };
	const requestLinksEnded = opts.apiKeys
		? sqlite.prepare('DELETE FROM request_links WHERE request_id IN (SELECT id FROM task_requests WHERE requester_user_id = ?)').run(userId).changes
		: 0;
	// Always (card 2894): every caller is a way of taking the account back.
	const reportScheduleIds = ids(
		db
			.update(reportSchedules)
			.set({ enabled: false, updatedAt: stamp() })
			.where(and(eq(reportSchedules.userId, userId), eq(reportSchedules.enabled, true)))
			.returning({ id: reportSchedules.id })
			.all()
	);
	// Each recorded `off` in this server's record of where it sends (card 3004, O10), in one statement that always runs.
	recordSchedulesAs(sqlite, reportScheduleIds, 'off');
	return {
		sessions: sessionsEnded,
		invites: invitesEnded,
		challenges: pending.challenges,
		enrolmentLinks: pending.enrolmentLinks,
		apiKeys: apiKeysEnded,
		webhooks: webhookIds.length,
		readableWebhooks: hold?.readable ?? 0,
		reportSchedules: reportScheduleIds.length,
		settingsHeld,
		requestLinks: requestLinksEnded,
		apiKeyIds,
		webhookIds,
		reportScheduleIds
	};
}

/**
 * Delete every session whose deadline has passed (housekeeping), by the rule
 * `findSession` applies (card 2775): an expiry passed, a start plus the total
 * limit of the account's role passed, a start or an expiry that names no
 * moment, a start more than the grace in the future, or an expiry further
 * out than the role's idle limit allows. Each is read as the stamp it names
 * (`stamp_of`, which is `toStamp`): deleted by text, `expires_at < now`, a
 * session that names no moment was closed at its next use but never cleared
 * (the second P6 review). The role is read from the account, `user` or any
 * other, as `sessionLimits` reads it, with two-step sign-in as the switch
 * says now and the session's own `two_step` (card 3064, R13, F1, CS-L2):
 * while it is dormant a session made on a password alone has the dormant
 * limits whatever its role, so that a session kept at the release, with its
 * expiry 30 days on, is not deleted at the first start; one made with a code
 * has its role's. A session held in plain is gone before this runs
 * (`endPlainSessions`, at start). Run at start and then every five minutes
 * (`startSessionSweep`, card 2883).
 */
export function cleanExpiredSessions(): void {
	const nowMs = Date.now();
	const at = (ms: number) => stamp(new Date(ms));
	const required = twoStepRequired();
	const administrator = sessionLimits('admin', required, 1);
	const user = sessionLimits('user', required, 1);
	const passwordOnly = sessionLimits('user', required, 0);
	registerStampFunctions(sqlite);
	const role = '(SELECT role FROM users WHERE users.id = sessions.user_id)';
	// A password-only session while dormant first, then by the role, as `sessionLimits` decides.
	const limit = (dormant: string, forUser: string, forAdministrator: string) =>
		`CASE WHEN @dormant = 1 AND two_step = 0 THEN ${dormant} WHEN ${role} = 'user' THEN ${forUser} ELSE ${forAdministrator} END`;
	const result = sqlite
		.prepare(
			`DELETE FROM sessions
			 WHERE stamp_of(expires_at) IS NULL OR stamp_of(expires_at) <= @now
			    OR stamp_of(created_at) IS NULL OR stamp_of(created_at) > @future
			    OR stamp_of(created_at) <= ${limit('@passwordOnlyStartCutoff', '@userStartCutoff', '@administratorStartCutoff')}
			    OR stamp_of(expires_at) > ${limit('@passwordOnlyExpiryBound', '@userExpiryBound', '@administratorExpiryBound')}`
		)
		.run({
			now: at(nowMs),
			future: at(nowMs + SESSION_CLOCK_GRACE_MS),
			dormant: required ? 0 : 1,
			passwordOnlyStartCutoff: at(nowMs - passwordOnly.totalMs),
			userStartCutoff: at(nowMs - user.totalMs),
			administratorStartCutoff: at(nowMs - administrator.totalMs),
			passwordOnlyExpiryBound: at(nowMs + passwordOnly.idleMs + SESSION_CLOCK_GRACE_MS),
			userExpiryBound: at(nowMs + user.idleMs + SESSION_CLOCK_GRACE_MS),
			administratorExpiryBound: at(nowMs + administrator.idleMs + SESSION_CLOCK_GRACE_MS)
		});
	if (result.changes > 0) {
		log.info(`Cleaned up ${result.changes} expired session(s)`);
	}
}

/** How often ended sessions are cleared on their own: every five minutes. */
export const SESSION_SWEEP_EVERY_MS = 5 * 60 * 1000;

let sessionSweepTimer: ReturnType<typeof setInterval> | null = null;

/** The clean-up, as the timer runs it: a failure is logged and goes no further. */
function sweepSessionsNow(): void {
	try {
		cleanExpiredSessions();
	} catch (err) {
		log.error('Ended sessions could not be cleared', err);
	}
}

/**
 * Clear ended sessions every five minutes (card 2883), so that a row whose
 * deadline has passed does not wait for a restart. Only arms the timer: the
 * start-up clean-up is the bare `cleanExpiredSessions()` call before it in
 * hooks.server.ts, which calls this once, after that clean-up. A second call
 * starts no second timer. The timer does not keep the process alive.
 */
export function startSessionSweep(): void {
	if (sessionSweepTimer !== null) return;
	sessionSweepTimer = setInterval(sweepSessionsNow, SESSION_SWEEP_EVERY_MS);
	sessionSweepTimer.unref?.();
}

/** Stop the timer `startSessionSweep` started (for tests). */
export function stopSessionSweep(): void {
	if (sessionSweepTimer !== null) clearInterval(sessionSweepTimer);
	sessionSweepTimer = null;
}

// ─── Cookie Utilities ────────────────────────────────────────────────────────

/**
 * The environment's half of the cookie rule, for a request that did not come
 * over HTTPS (or for no request): `COOKIE_SECURE` when it is set (exactly
 * `true` is on, anything else off), and otherwise `NODE_ENV` exactly
 * `production`. Private since card 2850: every cookie takes `httpsOnlyCookie`,
 * which an HTTPS request makes Secure whatever this says.
 */
function secureCookies(): boolean {
	return process.env.COOKIE_SECURE !== undefined
		? process.env.COOKIE_SECURE === 'true'
		: process.env.NODE_ENV === 'production';
}

/**
 * Whether a cookie this server sets for a request to `url` is HTTPS-only (it
 * takes `Secure`, and the `__Host-` name where it has one): the one rule for
 * every cookie the server sets or deletes (card 2850; the challenge cookie's
 * since 2769 decision 27, the session cookie's since card 2775). An `https:`
 * request is always HTTPS-only, whatever `COOKIE_SECURE` says, so
 * `COOKIE_SECURE=false` affects plain-HTTP requests only (a LAN install,
 * whose browser drops a Secure cookie). Otherwise `COOKIE_SECURE` decides
 * when it is set, and `NODE_ENV=production` when it is not;
 * `secureCookies()` alone for no request.
 */
export function httpsOnlyCookie(url: URL | null): boolean {
	return secureCookies() || url?.protocol === 'https:';
}

/** The address of the request being answered, or null outside one (a test calling a handler directly). */
function currentRequestUrl(): URL | null {
	try {
		return getRequestEvent().url;
	} catch {
		return null;
	}
}

/** The session cookie's name in force for a request to `url` (the current request's when none is given). */
export function sessionCookieName(url: URL | null = currentRequestUrl()): string {
	return httpsOnlyCookie(url) ? SECURE_SESSION_COOKIE_NAME : SESSION_COOKIE_NAME;
}

/** A session code as one is made: a v4 UUID. */
const SESSION_CODE = /^[0-9a-f]{8}-[0-9a-f]{4}-4[0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$/;

/**
 * The session code this request sends: exactly one value of the name in
 * force, read from the raw `Cookie` header, in the shape a code is made in;
 * undefined for none, for two or more (a planted cookie beside the real one),
 * and for anything else (card 2775, decision 11). The gate's alone: from it
 * on, a request carries the session's hash (`locals.credential`).
 *
 * The old name (card 3064, R14, S-M2): where cookies are HTTPS-only and the
 * request sends no cookie of the secure name at all, whatever its value,
 * exactly one value of the name from before card 2775, in a code's shape, is
 * answered with `oldName` true. Whether it signs anybody in is
 * `validateSession`'s to decide. A browser that sends both names is read by
 * the secure one alone, and nothing is swapped.
 */
export function readSessionCookie(request: Request, url: URL): { code: string; oldName: boolean } | undefined {
	const name = sessionCookieName(url);
	const sent = cookieValues(request, name);
	if (sent.length > 1) {
		// A cookie planted beside the real one (card 2775, the code review's
		// CS3): no session is read from it, and it is said, by the references
		// of what was sent, never by the values.
		log.warn(`Session cookie sent ${sent.length} times — no session read from it`, {
			sessionRefs: sent.map((code) => sessionRefOf(sessionTokenHash(code)))
		});
	}
	const code = onlyCookieValue(request, name, SESSION_CODE);
	if (code !== null) return { code, oldName: false };
	if (name === SECURE_SESSION_COOKIE_NAME && sent.length === 0) {
		const old = onlyCookieValue(request, SESSION_COOKIE_NAME, SESSION_CODE);
		if (old !== null) return { code: old, oldName: true };
	}
	return undefined;
}

/**
 * Whether a request is its holder's own use of the session, which slides
 * its expiry (card 2775, the code review's CS1): a navigation of the browser
 * itself (`Sec-Fetch-Mode: navigate`), or a write, which by here has passed
 * the gate's same-origin check. Every other request (a page's own reads, on a
 * timer, on a live event or on a client-side navigation, a stream opening) is
 * checked with every refusal and does not keep the session alive.
 */
export function slidesSession(request: Request): boolean {
	if (request.method !== 'GET' && request.method !== 'HEAD') return true;
	return request.headers.get('sec-fetch-mode') === 'navigate';
}

/**
 * Set the session cookie on the response, for the session just made: by the
 * name in force, HttpOnly, SameSite=Lax, Path=/, no Domain, Secure where
 * cookies are HTTPS-only, and kept until the session's total limit, computed
 * from the session itself, never a default (card 2775, decision 14). At
 * least a second: `createSession` makes no session past its total limit, and
 * this cannot fail once the session is committed (the code review's CM15).
 */
export function setSessionCookie(cookies: Cookies, session: NewSession, url: URL | null = currentRequestUrl()): void {
	cookies.set(sessionCookieName(url), session.token, {
		path: '/',
		httpOnly: true,
		sameSite: 'lax',
		secure: httpsOnlyCookie(url),
		maxAge: cookieMaxAge(session)
	});
}

/**
 * The session cookie's lifetime, in seconds: to the session's total limit,
 * the role's with two-step sign-in as the switch says now, for the session's
 * `twoStep` (card 3064, R13, CS-L2), and at least a second.
 */
function cookieMaxAge(session: NewSession): number {
	const ends = parseStamp(session.createdAt)!.getTime() + sessionLimits(session.role, twoStepRequired(), session.twoStep).totalMs;
	return Math.max(1, Math.ceil((ends - Date.now()) / 1000));
}

/**
 * The `Set-Cookie` value that gives the browser the session that replaced a
 * kept one at the old cookie name (`keptByOldName`, card 3064, R14), under the
 * secure name, as `setSessionCookie` sets it; or null where `response` already
 * sets or clears the session cookie itself (a sign-in, the holder's own
 * password change, a sign-out), whose own cookie stands (S-M2). The gate
 * appends it to every answer it logs, which never pass through
 * `event.cookies`: a page, a page's data and a live stream alike.
 */
export function sessionCookieReissue(response: Response, session: NewSession, url: URL): string | null {
	const name = sessionCookieName(url);
	if (response.headers.getSetCookie().some((cookie) => cookie.startsWith(`${name}=`))) return null;
	return `${name}=${session.token}; Path=/; Max-Age=${cookieMaxAge(session)}; HttpOnly${httpsOnlyCookie(url) ? '; Secure' : ''}; SameSite=Lax`;
}

/** Clear the session cookie, by the name in force, with Path=/ and the same Secure: a `__Host-` deletion without them is ignored. */
export function clearSessionCookie(cookies: Cookies, url: URL | null = currentRequestUrl()): void {
	cookies.delete(sessionCookieName(url), { path: '/', secure: httpsOnlyCookie(url) });
}

/** The deletion of the session cookie of the plain name, as a `Set-Cookie` header's value. */
const PLAIN_SESSION_COOKIE_DELETION = `${SESSION_COOKIE_NAME}=; Path=/; Max-Age=0; Secure; HttpOnly; SameSite=Lax`;

/**
 * The domain a cookie of the old name could have been set for beside this
 * server (card 3064, R14, S-L3, A45): the host of `ORIGIN` (the request's
 * where it is not set) less its first label, where it has three or more;
 * `elecfron.com` for `dumpfire.elecfron.com`. Null for a host of one or two
 * labels, and for an address: an IP address has no parent domain.
 */
function oldCookieParentDomain(url: URL): string | null {
	let host = url.hostname;
	const origin = process.env.ORIGIN?.trim();
	if (origin) {
		try {
			host = new URL(origin).hostname;
		} catch {
			// The adapter refuses to start on an ORIGIN that is no address: the request's host stands.
		}
	}
	if (host.startsWith('[') || /^\d+(\.\d+){3}$/.test(host)) return null;
	const labels = host.split('.');
	return labels.length >= 3 ? labels.slice(1).join('.') : null;
}

/**
 * The `Set-Cookie` values that delete a session cookie of the plain name,
 * when a request where cookies are HTTPS-only still sends one; none
 * otherwise (card 2775, decision 13). Since card 3064 (R14, S-L3) two: with no
 * `Domain`, as live set it, and with `Domain=` the parent domain of this
 * server's host (`oldCookieParentDomain`), where it has one, which clears a
 * cookie of that name another site on that domain could plant. The secure
 * name is the only one set there; a session kept at the release is read by
 * the old name only to be swapped to it. The gate appends them to every
 * answer it logs, its own included, which never pass through `event.cookies`.
 */
export function oldSessionCookieDeletion(request: Request, url: URL): string[] {
	if (!httpsOnlyCookie(url) || !sendsCookie(request, SESSION_COOKIE_NAME)) return [];
	const parent = oldCookieParentDomain(url);
	return parent === null
		? [PLAIN_SESSION_COOKIE_DELETION]
		: [PLAIN_SESSION_COOKIE_DELETION, `${SESSION_COOKIE_NAME}=; Domain=${parent}; Path=/; Max-Age=0; Secure; HttpOnly; SameSite=Lax`];
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
 * for a key that is not in `api_keys`, has expired, has passed its deadline,
 * or belongs to a user who no longer exists.
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
 * Whether an API key's deadline has passed at `now`, a moment in the stored
 * form: the deadline migration 0069 gave every key made before two-step
 * sign-in, until its holder keeps it (card 2772). A key with no deadline has
 * none to pass. A deadline that is set and names no moment has passed, as an
 * unreadable expiry has: the safe side.
 *
 * The one rule, asked by `keyHolder` (so the gate and `stillAuthenticated`),
 * by `keysAndWebhooksOf` in second-step.ts, and by the Keep route's guard and
 * write, so that no two of them can disagree about a key (the plan review,
 * S5).
 */
export function deadlinePassed(key: { deadlineAt: string | null }, now: Stamp): boolean {
	if (key.deadlineAt === null) return false;
	const deadline = toStamp(key.deadlineAt);
	return deadline === null || deadline <= now;
}

/**
 * Whether an API key's expiry has passed at `now`: it is at or before `now`, or
 * is set and names no moment (the P6 review, S2). Half of `keyEnded`, asked on
 * its own where how a key ended is told apart (`endedKeysWithReveals`).
 */
export function keyExpired(key: { expiresAt: string | null }, now: Stamp): boolean {
	if (key.expiresAt === null) return false;
	const expires = toStamp(key.expiresAt);
	return expires === null || expires <= now;
}

/**
 * Whether an API key has ended at `now`, a moment in the stored form: its
 * expiry has passed (`keyExpired`), or its deadline has (`deadlinePassed`), or
 * the record of keys ended on this server names it (`keyRecorded`, card 2995,
 * R7: one brought back by an older image's import or a host edit). A key that
 * expires at `now` has ended, as one whose deadline is `now` has: the same
 * boundary for both (card 2772). The one rule, asked by `keyHolder` (the gate
 * and `stillAuthenticated`), by `keysAndWebhooksOf` in second-step.ts and by
 * the webhooks' hold rule (`keyEndedFor`), so that no list calls a key live
 * that the gate refuses.
 */
export function keyEnded(key: { id: number; keyHash: string; expiresAt: string | null; deadlineAt: string | null }, now: Stamp): boolean {
	return keyExpired(key, now) || deadlinePassed(key, now) || keyRecorded(sqlite, key);
}

/**
 * The account an API key's row acts as, if the key is open: it has not ended
 * (`keyEnded`: its expiry, its deadline, and the record of keys ended here,
 * card 2995), and its account still exists and is not disabled (card 2671).
 * Null if not. `findApiKey` and `stillAuthenticated` both ask it, so that what
 * counts as an open key is decided in one place.
 */
function keyHolder(apiKey: typeof apiKeys.$inferSelect): User | null {
	if (keyEnded(apiKey, stamp())) return null;

	const holder = db.select()
		.from(users)
		.where(eq(users.id, apiKey.userId))
		.get();
	// A disabled account's keys ended at the disable (card 2671, D6): one left
	// by a restore or a host edit is refused here all the same. So is one of an
	// account the record of account endings names as deleted (card 2996, R16).
	return holder === undefined || holder.disabledAt !== null || deletedHere(sqlite, holder) ? null : holder;
}

/**
 * What the gate let a request in with, kept in `locals.credential` beside the
 * account it acts as: the API key's row id under /api/v1/, or the session's
 * hash, never its code (card 2775). Null where it let a request in with
 * neither.
 */
export type Credential = { kind: 'api key'; id: number } | { kind: 'session'; hash: Buffer };

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
		const found = findSession(credential.hash);
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
