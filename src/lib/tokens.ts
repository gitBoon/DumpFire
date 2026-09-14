/**
 * Token formatting, shared between the server and the browser.
 *
 * Lives here rather than in `$lib/server/tokens.ts` because the boards list and
 * the card modal both render these figures, and `$lib/server` is unreachable
 * from client code by design.
 */

/**
 * Compact token count: 80,400 → "80.4k", 2,400,000 → "2.4M".
 *
 * Magnitude is the question a reader is actually asking — "was this cheap or
 * expensive" — not whether it was 80,412 or 80,431. The exact figure is still
 * available in the card modal's breakdown.
 */
export function formatTokens(n: number): string {
	const abs = Math.abs(n);
	const sign = n < 0 ? '-' : '';
	if (abs < 1000) return `${n}`;
	if (abs < 1_000_000) {
		const k = abs / 1000;
		return `${sign}${k < 10 ? k.toFixed(1) : Math.round(k)}k`;
	}
	const m = abs / 1_000_000;
	return `${sign}${m < 10 ? m.toFixed(1) : Math.round(m)}M`;
}
