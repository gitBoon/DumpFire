/**
 * rate-limit.ts — In-memory rate limiter for brute-force protection.
 *
 * Three kinds of count, each per key (an address, a session, an account):
 *
 *   - `checkRateLimit` counts attempts, and `takeAllowance` counts an amount
 *     (the addresses a report is mailed to, card 2182), each in a fixed
 *     window, not a sliding one: the window starts at a key's first attempt
 *     and the count starts again from nothing when it ends, however many
 *     attempts were refused in it. So nearly twice `maxAttempts` can be made
 *     back to back across the end of a window (all but the first of one
 *     window's, at its end, then the next window's), and `maxAttempts` in
 *     every window for as long as anyone keeps asking.
 *   - `signInWait` and its two neighbours count wrong passwords at one account
 *     (card 2177) in an idle window: the count is forgotten 15 minutes after
 *     the last one, so it lasts as long as the guessing does.
 *   - `countSignInAttempt` is `checkRateLimit` for sign-in's count by address,
 *     which also notes the account each attempt was at, so that a sign-in
 *     that succeeds gives back that account's attempts and no others
 *     (`refundSignInAttempts`, card 2226).
 *
 * And one that is not a count over time: `enterSignIn` and `leaveSignIn`
 * hold the sign-ins in flight at one account, or at one remembered browser,
 * to a number (card 2194), and an account's checks in the first lane of
 * password checks (the review's L1).
 *
 * All of it is in memory: a restart empties every count. Entries auto-expire
 * to prevent memory leaks.
 */

interface RateLimitEntry {
	count: number;
	resetAt: number;
	/** Requests `takeAllowance` refused in this window. */
	refused?: number;
	/**
	 * Sign-in only (card 2226): how many of the window's admitted attempts
	 * were at each account, by the account's key (`user:<id>`, or
	 * `name:<sha-256>`), so that a success can give back its own and no more.
	 */
	at?: Map<string, number>;
}

const store = new Map<string, RateLimitEntry>();

/** Wrong passwords at one account (or at one name that is no account), and when the last was. */
interface WrongSignIns {
	count: number;
	lastAt: number;
}

const wrongSignIns = new Map<string, WrongSignIns>();

/**
 * The most keys `wrongSignIns` holds (the review's N7). Every name that is no
 * account is a key of its own, so names sent from many addresses would grow
 * it for 15 minutes each. Full, the key counted longest ago is forgotten
 * first: each count moves its key to the end, so the first is the oldest.
 */
export const WRONG_SIGN_IN_KEYS = 10_000;

/** How long after the last wrong password an account's count is forgotten. */
export const SIGN_IN_IDLE_MS = 15 * 60 * 1000;

// Cleanup stale entries every 5 minutes. Unref'd: housekeeping must never be
// the reason a process stays alive.
setInterval(() => {
	const now = Date.now();
	for (const [key, entry] of store) {
		if (now > entry.resetAt) store.delete(key);
	}
	for (const [key, entry] of wrongSignIns) {
		if (now - entry.lastAt > SIGN_IN_IDLE_MS) wrongSignIns.delete(key);
	}
	for (const [key, at] of oneAtATimeSaid) {
		if (now - at > SIGN_IN_IDLE_MS) oneAtATimeSaid.delete(key);
	}
}, 5 * 60 * 1000).unref();

/**
 * Count an attempt for `key`, and say whether it is over the limit.
 * @returns `limited`, with `retryAfterSecs` until the window ends if it is,
 * and `attempts`: this one's number in the window, the refused ones included.
 */
export function checkRateLimit(
	key: string,
	maxAttempts: number = 10,
	windowMs: number = 15 * 60 * 1000 // 15 minutes
): { limited: boolean; retryAfterSecs: number; attempts: number } {
	const now = Date.now();
	const entry = store.get(key);

	if (!entry || now > entry.resetAt) {
		// The first attempt, or the first since the window ended: a new
		// window starts here, and the count with it.
		store.set(key, { count: 1, resetAt: now + windowMs });
		return { limited: false, retryAfterSecs: 0, attempts: 1 };
	}

	// Counted whether or not it is refused. The window still ends where it
	// was set to: a refused attempt does not move it on.
	entry.count++;

	if (entry.count > maxAttempts) {
		const retryAfterSecs = Math.ceil((entry.resetAt - now) / 1000);
		return { limited: true, retryAfterSecs, attempts: entry.count };
	}

	return { limited: false, retryAfterSecs: 0, attempts: entry.count };
}

/**
 * Take `n` from `key`'s allowance of `max` in a fixed window of `windowMs`
 * that starts at its first take: all of `n` or none of it. A take that would
 * pass `max` is refused whole and takes nothing, with `used` (what the window
 * has taken so far), `retryAfterSecs` until the window ends, and
 * `firstRefusal` true for the window's first refusal, for a line in the log
 * once a window and not once a request. Taking nothing always succeeds.
 *
 * Card 2182 counts the addresses report mail reaches with it, so one call of
 * ten addresses is ten and not one.
 */
export function takeAllowance(
	key: string,
	n: number,
	max: number,
	windowMs: number
): { taken: true } | { taken: false; used: number; retryAfterSecs: number; firstRefusal: boolean } {
	if (n <= 0) return { taken: true };
	const now = Date.now();
	let entry = store.get(key);
	if (!entry || now > entry.resetAt) {
		entry = { count: 0, resetAt: now + windowMs };
		store.set(key, entry);
	}
	if (entry.count + n > max) {
		entry.refused = (entry.refused ?? 0) + 1;
		return {
			taken: false,
			used: entry.count,
			retryAfterSecs: Math.ceil((entry.resetAt - now) / 1000),
			firstRefusal: entry.refused === 1
		};
	}
	entry.count += n;
	return { taken: true };
}

// ─── Wrong passwords at one account (card 2177) ─────────────────────────────
//
// Sign-in waits before it checks a password at an account that has had five
// wrong in a row: the right password gets in after at most four seconds. It
// slows a guesser who waits for each answer, however many addresses they use.
// One who sends many at once, each waiting its own few seconds side by side,
// is held by card 2194 instead: browsers not remembered for the account are
// let in no more at once than the free guesses left, and one at a time while
// the waits last (`enterSignIn`, below), the rest refused at once. That is the
// one refusal at an account, and a browser remembered for it never meets it.

/** Wrong passwords at an account that cost nothing: the waits begin at the next. */
export const FREE_WRONG_SIGN_INS = 5;

/** The count read when an attempt arrives, and the wait in milliseconds before its password is checked. */
const SIGN_IN_WAITS: readonly [atLeast: number, ms: number][] = [
	[FREE_WRONG_SIGN_INS + 2, 4000],
	[FREE_WRONG_SIGN_INS + 1, 2000],
	[FREE_WRONG_SIGN_INS, 1000]
];

/** `key`'s count, forgotten once 15 minutes have passed since its last wrong password. */
function wrongSignInCount(key: string, now: number): number {
	const entry = wrongSignIns.get(key);
	if (!entry) return 0;
	if (now - entry.lastAt > SIGN_IN_IDLE_MS) {
		wrongSignIns.delete(key);
		return 0;
	}
	return entry.count;
}

/**
 * How long a sign-in at `key` waits before its password is checked: none for
 * fewer than five wrong passwords, then 1, 2 and 4 seconds. Read when the
 * attempt arrives, so attempts sent together wait alike and are not put in a line.
 */
export function signInWait(key: string): number {
	const count = wrongSignInCount(key, Date.now());
	return SIGN_IN_WAITS.find(([atLeast]) => count >= atLeast)?.[1] ?? 0;
}

/** Count a wrong password (or a name that is no account) at `key`. Returns the count, this one included. */
export function countWrongSignIn(key: string): number {
	const now = Date.now();
	const count = wrongSignInCount(key, now) + 1;
	// Taken out and put back, so the map stays in the order last counted.
	wrongSignIns.delete(key);
	if (wrongSignIns.size >= WRONG_SIGN_IN_KEYS) {
		const oldest = wrongSignIns.keys().next().value;
		if (oldest !== undefined) wrongSignIns.delete(oldest);
	}
	wrongSignIns.set(key, { count, lastAt: now });
	return count;
}

/** Forget `key`'s wrong passwords: the right one was given. */
export function forgetWrongSignIns(key: string): void {
	wrongSignIns.delete(key);
}

/** `key`'s wrong passwords now: what `signInWait` reads, as a count (card 2194). */
export function wrongSignInsAt(key: string): number {
	return wrongSignInCount(key, Date.now());
}

// ─── Sign-ins in flight at one key (card 2194) ──────────────────────────────
//
// A sign-in from a browser not remembered for an account takes a place at the
// account's key from the moment it passes the per-address limit to its answer,
// the wait and the password check included; a remembered browser's takes one
// at its own nonce (`nonce:<nonce>`), and another at the account's first-lane
// checks (`known:user:<id>`), which a session's current password takes too
// (the review's L1). Places are taken in one synchronous
// stretch as the attempt arrives, so attempts sent together take them in
// order of arrival, and given back in a `finally`. A key with none in flight
// has no entry, so names that are no account do not pile up (the review's N4).

const signInsInFlight = new Map<string, number>();

/**
 * Take a place at `key` if fewer than `allowed` sign-ins are in flight there,
 * and say whether one was taken. Every place taken is given back with
 * `leaveSignIn`.
 */
export function enterSignIn(key: string, allowed: number): boolean {
	const inFlight = signInsInFlight.get(key) ?? 0;
	if (inFlight >= allowed) return false;
	signInsInFlight.set(key, inFlight + 1);
	return true;
}

/**
 * The most checks of the first lane in flight for one account (the review's
 * L1): its remembered browsers' sign-ins and its sessions' current passwords
 * together, each holding a place at `firstLaneChecksAt(id)` from before its
 * check to its answer. A remembered browser's own five do not bound an
 * account, since every right password makes a new cookie, and a session's
 * count of wrong passwords is given back by a right one; without this one
 * account could fill the first lane.
 */
export const FIRST_LANE_CHECKS_PER_ACCOUNT = 5;

/** The key of an account's first-lane checks in flight, for `enterSignIn` and `leaveSignIn`. */
export function firstLaneChecksAt(userId: number): string {
	return `known:user:${userId}`;
}

/** Give back a place `enterSignIn` took at `key`. */
export function leaveSignIn(key: string): void {
	const inFlight = signInsInFlight.get(key) ?? 0;
	if (inFlight <= 1) signInsInFlight.delete(key);
	else signInsInFlight.set(key, inFlight - 1);
}

/** When each key's sign-ins were last refused for want of a place, for one line in the log a spell. */
const oneAtATimeSaid = new Map<string, number>();

/**
 * Note a refusal at `key` for want of a place, and say whether it is the
 * first since 15 minutes passed without one: the log says so once a spell, not
 * once a refusal. Held to `WRONG_SIGN_IN_KEYS` keys as the wrong passwords are.
 */
export function firstSignInRefusal(key: string): boolean {
	const now = Date.now();
	const last = oneAtATimeSaid.get(key);
	oneAtATimeSaid.delete(key);
	if (oneAtATimeSaid.size >= WRONG_SIGN_IN_KEYS) {
		const oldest = oneAtATimeSaid.keys().next().value;
		if (oldest !== undefined) oneAtATimeSaid.delete(oldest);
	}
	oneAtATimeSaid.set(key, now);
	return last === undefined || now - last > SIGN_IN_IDLE_MS;
}

/** Forget every count. For tests, which would otherwise limit each other. */
export function resetAllRateLimits(): void {
	store.clear();
	wrongSignIns.clear();
	signInsInFlight.clear();
	oneAtATimeSaid.clear();
}

/** Reset the rate limit for a key (the public request form's reply count). */
export function resetRateLimit(key: string): void {
	store.delete(key);
}

// ─── Sign-in's count by address (card 2226) ─────────────────────────────────
//
// Ten attempts an address in 15 minutes. A sign-in that succeeded cleared its
// address's whole count, so anyone with an account could send nine guesses at
// another account, sign in to their own, and send nine more, as often as they
// liked; and push another account's count out of the capped map of wrong
// passwords from one address. Now a success gives back only the attempts its
// address made at the account that signed in: someone who mistypes their own
// password and then signs in has those attempts back, and attempts at another
// account, at a name that is no account, and refusals stay counted to the end
// of the window.

/** Attempts to sign in from one address in a window, and the window. */
const SIGN_IN_ATTEMPTS = 10;
const SIGN_IN_WINDOW_MS = 15 * 60 * 1000;

/** The entry of `address`'s count, while its window lasts. */
function signInEntry(address: string): RateLimitEntry | undefined {
	const entry = store.get(`login:${address}`);
	return entry && Date.now() <= entry.resetAt ? entry : undefined;
}

/**
 * Count a sign-in attempt from `address` (the address's key, `addressKey`) at
 * the account `key`, and say whether the address is over its limit, as
 * `checkRateLimit` says it. An attempt that is let in is noted against `key`;
 * a refusal is counted and noted against nothing.
 */
export function countSignInAttempt(address: string, key: string): ReturnType<typeof checkRateLimit> {
	const counted = checkRateLimit(`login:${address}`, SIGN_IN_ATTEMPTS, SIGN_IN_WINDOW_MS);
	const entry = signInEntry(address);
	if (!counted.limited && entry) {
		entry.at ??= new Map();
		entry.at.set(key, (entry.at.get(key) ?? 0) + 1);
	}
	return counted;
}

/**
 * Give back the attempts `address` made at `key` in this window: the right
 * password was given there. Only that account's, and only while the window
 * they were made in lasts; the count never goes below zero.
 */
export function refundSignInAttempts(address: string, key: string): void {
	const entry = signInEntry(address);
	const made = entry?.at?.get(key);
	if (!entry || !made) return;
	entry.count = Math.max(0, entry.count - made);
	entry.at!.delete(key);
}

/**
 * Keep one of `address`'s attempts at `key` counted to the end of the window,
 * whatever a success at `key` gives back: it was let in and then not checked
 * (the server was too busy, or the caller had gone), so it was an attempt at
 * no account.
 */
export function keepSignInAttemptCounted(address: string, key: string): void {
	const at = signInEntry(address)?.at;
	const made = at?.get(key);
	if (!at || !made) return;
	if (made > 1) at.set(key, made - 1);
	else at.delete(key);
}
