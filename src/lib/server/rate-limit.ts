/**
 * rate-limit.ts — In-memory rate limiter for brute-force protection.
 *
 * Counts attempts per key (an address, a session, an email) in a fixed
 * window, not a sliding one: the window starts at a key's first attempt and
 * the count starts again from nothing when it ends, however many attempts
 * were refused in it. So nearly twice `maxAttempts` can be made back to back
 * across the end of a window (all but the first of one window's, at its end,
 * then the next window's), and `maxAttempts` in every window for as long as
 * anyone keeps asking. Entries auto-expire to prevent memory leaks.
 */

interface RateLimitEntry {
	count: number;
	resetAt: number;
}

const store = new Map<string, RateLimitEntry>();

// Cleanup stale entries every 5 minutes. Unref'd: housekeeping must never be
// the reason a process stays alive.
setInterval(() => {
	const now = Date.now();
	for (const [key, entry] of store) {
		if (now > entry.resetAt) store.delete(key);
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

/** Forget every count. For tests, which would otherwise limit each other. */
export function resetAllRateLimits(): void {
	store.clear();
}

/** Reset the rate limit for a key (e.g., on successful login). */
export function resetRateLimit(key: string): void {
	store.delete(key);
}
