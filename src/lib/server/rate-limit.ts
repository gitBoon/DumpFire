/**
 * rate-limit.ts — In-memory rate limiter for brute-force protection.
 *
 * Two kinds of count, each per key (an address, a session, an account):
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
 *
 * All of it is in memory: a restart empties every count. Entries auto-expire
 * to prevent memory leaks.
 */

interface RateLimitEntry {
	count: number;
	resetAt: number;
	/** Requests `takeAllowance` refused in this window. */
	refused?: number;
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
// wrong in a row, and never refuses: the right password always gets in after
// at most four seconds, so nobody can keep an account's owner out. It slows a
// guesser who waits for each answer, however many addresses they use, and not
// one who sends many at once: each of those waits its own few seconds side by
// side, and only the per-address limit bounds their rate.

/** The count read when an attempt arrives, and the wait in milliseconds before its password is checked. */
const SIGN_IN_WAITS: readonly [atLeast: number, ms: number][] = [
	[7, 4000],
	[6, 2000],
	[5, 1000]
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

/** Forget every count. For tests, which would otherwise limit each other. */
export function resetAllRateLimits(): void {
	store.clear();
	wrongSignIns.clear();
}

/** Reset the rate limit for a key (e.g., on successful login). */
export function resetRateLimit(key: string): void {
	store.delete(key);
}
