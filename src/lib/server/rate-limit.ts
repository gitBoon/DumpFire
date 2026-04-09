/**
 * rate-limit.ts — In-memory rate limiter for brute-force protection.
 *
 * Uses a sliding window approach to track attempts per key (IP or username).
 * Entries auto-expire to prevent memory leaks.
 */

interface RateLimitEntry {
	count: number;
	resetAt: number;
}

const store = new Map<string, RateLimitEntry>();

// Cleanup stale entries every 5 minutes
setInterval(() => {
	const now = Date.now();
	for (const [key, entry] of store) {
		if (now > entry.resetAt) store.delete(key);
	}
}, 5 * 60 * 1000);

/**
 * Check if a request should be rate-limited.
 * @returns Object with `limited` boolean and `retryAfterSecs` if limited.
 */
export function checkRateLimit(
	key: string,
	maxAttempts: number = 10,
	windowMs: number = 15 * 60 * 1000 // 15 minutes
): { limited: boolean; retryAfterSecs: number } {
	const now = Date.now();
	const entry = store.get(key);

	if (!entry || now > entry.resetAt) {
		// First attempt or window expired
		store.set(key, { count: 1, resetAt: now + windowMs });
		return { limited: false, retryAfterSecs: 0 };
	}

	entry.count++;

	if (entry.count > maxAttempts) {
		const retryAfterSecs = Math.ceil((entry.resetAt - now) / 1000);
		return { limited: true, retryAfterSecs };
	}

	return { limited: false, retryAfterSecs: 0 };
}

/** Reset the rate limit for a key (e.g., on successful login). */
export function resetRateLimit(key: string): void {
	store.delete(key);
}
