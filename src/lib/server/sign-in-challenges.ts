/**
 * sign-in-challenges.ts — the pending sign-in of two-step sign-in (card 2769):
 * a right password opens a challenge, and only the second factor, checked
 * against it, makes a session.
 *
 * A challenge is a row of `sign_in_challenges` and a cookie. The cookie holds
 * a token of 32 random bytes, base64url; the row holds only its SHA-256, and
 * a short id of 8 random hex characters made separately, which is all the log
 * ever names. It lasts ten minutes, read through `toStamp`, and a lifetime
 * that names no moment has passed.
 *
 * The cookie (decision 27) is `__Host-dumpfire_challenge`, Secure, whenever
 * cookies are HTTPS-only here (`secureCookies()`) or the request itself came
 * over `https:`, and `dumpfire_challenge` otherwise: HttpOnly, SameSite=Strict,
 * Path=/, ten minutes, no Domain. It is read from the raw `Cookie` header, by
 * the name in force alone: one pair of that name is the token, none or more
 * than one is no challenge, and a cookie of the other name is ignored. It is
 * deleted with Path=/ and the same Secure.
 *
 * Issuing (`issueChallenge`) is one synchronous transaction, a savepoint in a
 * caller's own: the account's hash is still the one checked, expired
 * challenges are swept (each expired verify challenge a stolen-password
 * signal, decision 15b: one that signed in was taken, so any still there was
 * not finished), this browser's previous challenge goes, of whichever
 * account, and with it all but the account's newest two, and the new row is
 * written. The same sweep runs at start-up and every five minutes
 * (`startChallengeSweep`), so that the signal does not wait for some later
 * sign-in to be issued. Taking one
 * (`takeChallenge`) is a conditional DELETE in the transaction that makes the
 * session or the factor; the caller read the row in the same synchronous
 * stretch, so one row taken is an invariant, and anything else throws
 * (decision 6).
 *
 * An enrol challenge also keeps what is being set up, sealed under the MFA
 * key and bound to its account and its token's hash (`enrolAad`): the new
 * secret, and once its first code is right, that code's step and the ten
 * recovery codes (`EnrolState`). It moves through three stages, each written
 * by a conditional UPDATE from the one before: `secret_shown` when issued,
 * `code_verified` at the right first code, `codes_shown` once the page has
 * shown the codes.
 */
import { randomBytes } from 'node:crypto';
import type { Cookies } from '@sveltejs/kit';
import { sqlite } from './db';
import { afterCommit, inTransaction } from './db/transaction';
import { registerStampFunctions } from './db/timestamps';
import { httpsOnlyCookie } from './auth';
import { onlyCookieValue } from './cookie-header';
import { sha256Hex } from './mfa-crypto';
import { openEnrolment, sealEnrolment } from './mfa-store';
import { sendSecurityNotice } from './notifications';
import type { Lane } from './passwords';
import { newTotpSecret } from './totp';
import { createLogger } from './logger';
import { parseStamp, stamp, toStamp } from '$lib/timestamps';

const log = createLogger('AUTH');

// ─── The cookie (decision 27) ───────────────────────────────────────────────

/** The challenge cookie's name where cookies are not HTTPS-only. */
export const CHALLENGE_COOKIE = 'dumpfire_challenge';
/** Its name where they are: the `__Host-` prefix holds it to this origin, Secure and Path=/. */
export const SECURE_CHALLENGE_COOKIE = '__Host-dumpfire_challenge';

/** How long a challenge lasts: ten minutes, in seconds, the cookie's and the row's. */
export const CHALLENGE_SECONDS = 600;

/** A token as it is made: 32 bytes, base64url. Anything else is no token. */
const TOKEN = /^[A-Za-z0-9_-]{43}$/;

/** The challenge cookie's name in force for a request to `url`: the only name that is read. */
export function challengeCookieName(url: URL): string {
	return httpsOnlyCookie(url) ? SECURE_CHALLENGE_COOKIE : CHALLENGE_COOKIE;
}

/**
 * The challenge token this request sends, read from its raw `Cookie` header:
 * exactly one pair of the name in force, holding a token as one is made.
 * Null for none, for two or more (a planted cookie beside the real one), and
 * for anything else.
 */
export function readChallengeToken(request: Request, url: URL): string | null {
	return onlyToken(request, challengeCookieName(url));
}

/** The one cookie named `name` in the request's raw `Cookie` header, holding a token as one is made; null otherwise. */
function onlyToken(request: Request, name: string): string | null {
	return onlyCookieValue(request, name, TOKEN);
}

/** Send this browser the challenge cookie. */
export function setChallengeCookie(cookies: Cookies, url: URL, token: string): void {
	cookies.set(challengeCookieName(url), token, {
		path: '/',
		httpOnly: true,
		sameSite: 'strict',
		secure: httpsOnlyCookie(url),
		maxAge: CHALLENGE_SECONDS
	});
}

/** Delete the challenge cookie, by the name in force, with Path=/ and the same Secure. */
export function deleteChallengeCookie(cookies: Cookies, url: URL): void {
	cookies.delete(challengeCookieName(url), { path: '/', secure: httpsOnlyCookie(url) });
}

// ─── The set-up link's cookie (decision 19) ─────────────────────────────────

/**
 * The cookie a set-up link's page (`/enrol/[token]`) leaves for the sign-in
 * that follows: the link's raw token, HttpOnly, SameSite=Strict, sent to the
 * sign-in pages alone (Path=/login), for an hour, Secure as the challenge
 * cookie is. The page asks nothing: the password is asked at `/login`, with
 * all its throttles, and a right one at the account the link is for opens a
 * set-up challenge that names the link. A copy of the database holds only the
 * link's hash, which cannot be made into this cookie. No `__Host-` prefix:
 * that needs Path=/.
 */
export const ENROL_LINK_COOKIE = 'dumpfire_enrol_link';

/** How long the link cookie lasts, in seconds: an hour. */
export const ENROL_LINK_COOKIE_SECONDS = 60 * 60;

/** Leave this browser the link cookie. */
export function setEnrolLinkCookie(cookies: Cookies, url: URL, token: string): void {
	cookies.set(ENROL_LINK_COOKIE, token, {
		path: '/login',
		httpOnly: true,
		sameSite: 'strict',
		secure: httpsOnlyCookie(url),
		maxAge: ENROL_LINK_COOKIE_SECONDS
	});
}

/** The link token this request sends, read from its raw `Cookie` header as the challenge's is: exactly one, or none. */
export function readEnrolLinkToken(request: Request): string | null {
	return onlyToken(request, ENROL_LINK_COOKIE);
}

/** Delete the link cookie, with its Path and the same Secure. */
export function deleteEnrolLinkCookie(cookies: Cookies, url: URL): void {
	cookies.delete(ENROL_LINK_COOKIE, { path: '/login', secure: httpsOnlyCookie(url) });
}

// ─── The row ────────────────────────────────────────────────────────────────

/** What a challenge is for: the code of a factor held, or setting one up. */
export type ChallengePurpose = 'verify' | 'enrol';

/** A row of `sign_in_challenges`, as SQLite answers it. */
export type ChallengeRow = {
	token_hash: string;
	short_id: string;
	user_id: number;
	purpose: string;
	stage: string | null;
	lane: string;
	password_hash: string;
	key_id: string | null;
	enrol_ciphertext: string | null;
	enrol_nonce: string | null;
	remembered_nonce: string | null;
	wrong_count: number;
	created_at: string;
	expires_at: string;
	enrol_grant: string | null;
	enrolment_link_hash: string | null;
};

/** The hash a token is kept as. */
export const tokenHashOf = (token: string): string => sha256Hex(token);

/**
 * The challenge with this token, if it is live: there, of `purpose`, and
 * before its expiry as `toStamp` reads it at `now`. Null otherwise.
 */
export function liveChallenge(token: string | null, purpose: ChallengePurpose, now: number = Date.now()): ChallengeRow | null {
	if (token === null) return null;
	const row = sqlite.prepare('SELECT * FROM sign_in_challenges WHERE token_hash = ?').get(tokenHashOf(token)) as
		| ChallengeRow
		| undefined;
	if (!row || row.purpose !== purpose) return null;
	const expires = toStamp(row.expires_at);
	return expires !== null && expires > stamp(new Date(now)) ? row : null;
}

/** Count one wrong code on the challenge, in one statement, and answer its count now. */
export function countChallengeWrong(tokenHash: string): number {
	const row = sqlite
		.prepare('UPDATE sign_in_challenges SET wrong_count = wrong_count + 1 WHERE token_hash = ? RETURNING wrong_count')
		.get(tokenHash) as { wrong_count: number } | undefined;
	if (!row) throw new Error('A wrong code was counted on a challenge that is not there.');
	return row.wrong_count;
}

/** Take back one counted code on the challenge: it was right, or a replay. */
export function uncountChallengeWrong(tokenHash: string): void {
	sqlite.prepare('UPDATE sign_in_challenges SET wrong_count = wrong_count - 1 WHERE token_hash = ? AND wrong_count > 0').run(tokenHash);
}

/** Delete the challenge, however it ended. */
export function deleteChallenge(tokenHash: string): void {
	sqlite.prepare('DELETE FROM sign_in_challenges WHERE token_hash = ?').run(tokenHash);
}

/**
 * Take the live challenge with this hash, of `purpose` (and, for an enrol
 * challenge, at `stage`): one conditional DELETE, in the transaction that
 * makes the session or the factor. The caller read it in the same synchronous
 * stretch, so exactly one row is taken; anything else is a fault and throws,
 * rolling the transaction back (decision 6).
 */
export function takeChallenge(tokenHash: string, purpose: ChallengePurpose, now: number, stage?: string): ChallengeRow {
	if (!sqlite.inTransaction) {
		throw new Error('takeChallenge must be called inside the transaction that makes the session or the factor.');
	}
	registerStampFunctions(sqlite);
	const taken = sqlite
		.prepare(
			'DELETE FROM sign_in_challenges WHERE token_hash = ? AND purpose = ?' +
				(stage === undefined ? '' : ' AND stage = ?') +
				' AND stamp_of(expires_at) > ? RETURNING *'
		)
		.all(...(stage === undefined ? [tokenHash, purpose] : [tokenHash, purpose, stage]), stamp(new Date(now))) as ChallengeRow[];
	if (taken.length !== 1) {
		throw new Error(`A challenge read in this transaction could not be taken (${taken.length} rows): nothing was written.`);
	}
	return taken[0];
}

// ─── What an enrol challenge keeps (4.3, 4.6) ───────────────────────────────

/** The stages of an enrol challenge, in order. */
export type EnrolStage = 'secret_shown' | 'code_verified' | 'codes_shown';

/**
 * What an enrol challenge keeps sealed: the secret being set up, base64; and,
 * from the right first code on, that code's step, spent when the factor is
 * written, and the ten recovery codes the page shows.
 */
export type EnrolState = { secret: string; step: number | null; codes: string[] | null };

/** Seal `state` for the challenge with this hash, of this account. Throws when no MFA key is loaded. */
function sealEnrolState(userId: number, tokenHash: string, state: EnrolState) {
	const plain = Buffer.from(JSON.stringify(state), 'utf8');
	try {
		return sealEnrolment(userId, tokenHash, plain);
	} finally {
		plain.fill(0);
	}
}

/**
 * What the enrol challenge keeps, opened, or null: none is kept, no MFA key is
 * loaded, it was sealed under another key or for another row, or what opens
 * is not one.
 */
export function openEnrolState(challenge: ChallengeRow): EnrolState | null {
	if (challenge.enrol_ciphertext === null || challenge.enrol_nonce === null) return null;
	const opened = openEnrolment(challenge.user_id, challenge.token_hash, {
		nonce: challenge.enrol_nonce,
		ciphertext: challenge.enrol_ciphertext
	});
	if (opened === null) return null;
	try {
		const state = JSON.parse(opened.toString('utf8')) as EnrolState;
		const wellFormed =
			typeof state.secret === 'string' &&
			(state.step === null || Number.isInteger(state.step)) &&
			(state.codes === null || (Array.isArray(state.codes) && state.codes.every((code) => typeof code === 'string')));
		return wellFormed ? state : null;
	} catch {
		return null;
	} finally {
		opened.fill(0);
	}
}

/**
 * Move the enrol challenge with this hash from stage `from` to `to`, with what
 * it keeps sealed again when `state` is given: one conditional UPDATE. The
 * caller read it at `from` in the same synchronous stretch, so one row is an
 * invariant, and anything else throws.
 */
export function moveEnrolStage(challenge: ChallengeRow, from: EnrolStage, to: EnrolStage, state?: EnrolState): void {
	const sealed = state === undefined ? null : sealEnrolState(challenge.user_id, challenge.token_hash, state);
	const changes = sqlite
		.prepare(
			"UPDATE sign_in_challenges SET stage = ?, key_id = coalesce(?, key_id), enrol_ciphertext = coalesce(?, enrol_ciphertext), " +
				"enrol_nonce = coalesce(?, enrol_nonce) WHERE token_hash = ? AND purpose = 'enrol' AND stage = ?"
		)
		.run(to, sealed?.keyId ?? null, sealed?.ciphertext ?? null, sealed?.nonce ?? null, challenge.token_hash, from).changes;
	if (changes !== 1) throw new Error(`An enrol challenge read at ${from} could not be moved to ${to} (${changes} rows).`);
}

// ─── Pauses (D4) ────────────────────────────────────────────────────────────

/** Wrong codes in a lane at which its authenticator codes are locked, until a recovery code or a reset. */
export const CODES_LOCKED_AT = 30;

/**
 * What a lane's count of consecutive wrong codes, just reached, sets: a pause
 * of so many minutes, the lock, or nothing. 5: 15 minutes; 10: an hour; 15:
 * four hours; 20 and 25: a day; 30: locked.
 */
export function codePause(count: number): number | 'locked' | null {
	if (count >= CODES_LOCKED_AT) return 'locked';
	switch (count) {
		case 5:
			return 15;
		case 10:
			return 60;
		case 15:
			return 4 * 60;
		case 20:
		case 25:
			return 24 * 60;
		default:
			return null;
	}
}

// ─── Stolen-password signals (decision 15) ──────────────────────────────────

/** Why the account's security banner is raised: a wrong code after the right password, or a verify challenge left unused. */
export type SignalReason = 'wrong-code' | 'unfinished-sign-in';

/** How long after one signal the next raises nothing: an hour. */
const SIGNAL_EVERY_MS = 60 * 60 * 1000;

/**
 * Raise the account's security banner for `reason`, unless one was raised in
 * the last hour (`security_banner_at`, read through `stamp_of`, and one that
 * names no moment is long ago): one conditional UPDATE. True when it was
 * raised, and so when the owner is to be mailed.
 */
export function raiseSignal(userId: number, reason: SignalReason, now: number): boolean {
	registerStampFunctions(sqlite);
	return (
		sqlite
			.prepare(
				'UPDATE users SET security_banner = ?, security_banner_at = ? WHERE id = ? AND ' +
					'(security_banner_at IS NULL OR stamp_of(security_banner_at) IS NULL OR stamp_of(security_banner_at) <= ?)'
			)
			.run(reason, stamp(new Date(now)), userId, stamp(new Date(now - SIGNAL_EVERY_MS))).changes === 1
	);
}

// ─── The sweep (decision 15b) ───────────────────────────────────────────────

/**
 * Delete every expired challenge, of any account, in one transaction (a
 * savepoint in a caller's own). Each verify challenge among them was never
 * finished, since one that signed in was taken: it raises its account's
 * banner, at most once an hour, and mails it the `unfinished-sign-in` notice
 * after the commit (decision 15b). A challenge keeps no address: the notice
 * names when the password was given. Through `afterCommit`, so that inside an
 * invite's or the set-up's own transaction it waits for that one.
 */
export function sweepExpiredChallenges(now: number = Date.now()): void {
	inTransaction(() => {
		registerStampFunctions(sqlite);
		const expired = sqlite
			.prepare(
				'DELETE FROM sign_in_challenges WHERE stamp_of(expires_at) IS NULL OR stamp_of(expires_at) <= ? RETURNING user_id, purpose, created_at'
			)
			.all(stamp(new Date(now))) as { user_id: number; purpose: string; created_at: string }[];
		for (const row of expired) {
			if (row.purpose !== 'verify' || !raiseSignal(row.user_id, 'unfinished-sign-in', now)) continue;
			const at = parseStamp(row.created_at) ?? new Date(now);
			afterCommit(() => sendSecurityNotice(row.user_id, 'unfinished-sign-in', { at, address: null }));
		}
	});
}

/** How often the sweep runs on its own: every five minutes. */
export const CHALLENGE_SWEEP_EVERY_MS = 5 * 60 * 1000;

let sweepTimer: ReturnType<typeof setInterval> | null = null;

/** The sweep, as the timer runs it: a failure is logged and goes no further. */
function sweepNow(): void {
	try {
		sweepExpiredChallenges();
	} catch (err) {
		log.error('Expired sign-in challenges could not be swept', err);
	}
}

/**
 * Sweep expired challenges now, and then every five minutes (CS1 of the
 * card's security review): without it the unfinished-sign-in signal waited
 * for the next challenge issued at any account, which could be weeks, or
 * never. Called once from hooks.server.ts, beside the session clean-up; a
 * second call starts no second timer. The timer does not keep the process
 * alive.
 */
export function startChallengeSweep(): void {
	sweepNow();
	if (sweepTimer !== null) return;
	sweepTimer = setInterval(sweepNow, CHALLENGE_SWEEP_EVERY_MS);
	sweepTimer.unref?.();
}

/** Stop the timer `startChallengeSweep` started (for tests). */
export function stopChallengeSweep(): void {
	if (sweepTimer !== null) clearInterval(sweepTimer);
	sweepTimer = null;
}

// ─── Issuing ────────────────────────────────────────────────────────────────

export type ChallengeToIssue = {
	userId: number;
	/** The hash the password was checked against: the challenge is refused when the account's is another now (decision 26). */
	checkedHash: string;
	purpose: ChallengePurpose;
	/** The lane its codes are counted in: a remembered browser's (`known`), as its password was checked, or every other. */
	lane: Lane;
	/** The token of the challenge this browser already holds, if any: it is replaced. */
	previousToken: string | null;
	/** What lets an enrol challenge set up a factor, and the hash of the link it came from. */
	enrolGrant?: string | null;
	enrolmentLinkHash?: string | null;
};

export type IssuedChallenge =
	| { issued: true; token: string; shortId: string }
	/** The account's password hash is no longer the one checked (`changed`), or the account is gone (`gone`): nothing was written. */
	| { issued: false; why: 'changed' | 'gone' };

/**
 * Issue a challenge (4.3), in one synchronous transaction, a savepoint in the
 * caller's own, in this order:
 *
 *   1. The account is there and its hash is still `checkedHash`; if not,
 *      nothing is written (decision 26): a password set while the check was
 *      awaited ends the sign-in, and so does the account's deletion.
 *   2. Every expired challenge, of any account, is deleted
 *      (`sweepExpiredChallenges`). Each verify challenge among them was never
 *      finished, used or not: it raises its account's banner, at most once
 *      an hour, and mails it the `unfinished-sign-in` notice (decision 15b).
 *   3. This browser's previous challenge is deleted by its hash alone, of
 *      whichever account (CS2: one account's password and then another's in
 *      one browser leaves the first nothing to expire into a signal); then
 *      any enrol challenge of the account when an enrol one is issued, and
 *      all but the account's newest two, so that it has at most three (R3).
 *   4. The row is written, `created_at` with it; an enrol challenge at
 *      `secret_shown`, with a new secret sealed for it. That needs the MFA
 *      key, which the callers check first: without one, this throws.
 *
 * Notices go after the transaction, through `afterCommit`. Logging the
 * issue is the caller's, after its commit.
 */
export function issueChallenge(input: ChallengeToIssue): IssuedChallenge {
	const now = Date.now();
	const at = stamp(new Date(now));

	return inTransaction((): IssuedChallenge => {
		const account = sqlite.prepare('SELECT password_hash FROM users WHERE id = ?').get(input.userId) as
			| { password_hash: string }
			| undefined;
		if (!account) return { issued: false, why: 'gone' };
		if (account.password_hash !== input.checkedHash) return { issued: false, why: 'changed' };

		sweepExpiredChallenges(now);

		if (input.previousToken !== null) {
			sqlite.prepare('DELETE FROM sign_in_challenges WHERE token_hash = ?').run(tokenHashOf(input.previousToken));
		}
		sqlite
			.prepare(
				'DELETE FROM sign_in_challenges WHERE user_id = ? AND (purpose = ? AND ? = ? OR token_hash IN ' +
					'(SELECT token_hash FROM sign_in_challenges WHERE user_id = ? ORDER BY created_at DESC, rowid DESC LIMIT -1 OFFSET 2))'
			)
			.run(input.userId, 'enrol', input.purpose, 'enrol', input.userId);

		const token = randomBytes(32).toString('base64url');
		const shortId = randomBytes(4).toString('hex');
		// An enrol challenge is born with its new secret, sealed for it alone.
		let sealed: { keyId: string; nonce: string; ciphertext: string } | null = null;
		if (input.purpose === 'enrol') {
			const secret = newTotpSecret();
			try {
				sealed = sealEnrolState(input.userId, tokenHashOf(token), { secret: secret.toString('base64'), step: null, codes: null });
			} finally {
				secret.fill(0);
			}
		}
		// `remembered_nonce` is not written: the lane says all that is used of
		// the remembered browser (the review's CR8). The column stays, unused.
		sqlite
			.prepare(
				'INSERT INTO sign_in_challenges (token_hash, short_id, user_id, purpose, stage, lane, password_hash, ' +
					'key_id, enrol_ciphertext, enrol_nonce, enrol_grant, enrolment_link_hash, created_at, expires_at) ' +
					'VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)'
			)
			.run(
				tokenHashOf(token),
				shortId,
				input.userId,
				input.purpose,
				input.purpose === 'enrol' ? 'secret_shown' : null,
				input.lane,
				input.checkedHash,
				sealed?.keyId ?? null,
				sealed?.ciphertext ?? null,
				sealed?.nonce ?? null,
				input.enrolGrant ?? null,
				input.enrolmentLinkHash ?? null,
				at,
				stamp(new Date(now + CHALLENGE_SECONDS * 1000))
			);
		return { issued: true, token, shortId };
	});
}
