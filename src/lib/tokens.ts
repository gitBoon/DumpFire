/**
 * Token formatting, shared between the server and the browser.
 *
 * Lives here rather than in `$lib/server/tokens.ts` because the boards list and
 * the card modal both render these figures, and `$lib/server` is unreachable
 * from client code by design.
 */

/**
 * Compact token count: 80,400 → "80k", 8,040 → "8.0k", 2,400,000 → "2.4M", 1,981,000,000 → "1.98B".
 *
 * Magnitude is the question a reader is actually asking — "was this cheap or
 * expensive" — not whether it was 80,412 or 80,431. The exact figure is still
 * available in the card modal's breakdown.
 */
export function formatTokens(n: number): string {
	const abs = Math.abs(n);
	const sign = n < 0 ? '-' : '';
	if (abs < 1000) return `${n}`;
	// Tier boundaries sit where rounding would carry: 999,600 is "1.0M", never
	// "1000k", and 999,600,000 is "1.00B", never "1000M".
	if (abs < 999_500) {
		const k = abs / 1000;
		return `${sign}${k < 10 ? k.toFixed(1) : Math.round(k)}k`;
	}
	if (abs < 999_500_000) {
		const m = abs / 1_000_000;
		return `${sign}${m < 10 ? m.toFixed(1) : Math.round(m)}M`;
	}
	// Billions keep two decimals below ten. A tenth of a billion is 100M — coarser
	// than the M tier was just under the line — and "1.9B" for 1,981M drops what
	// "1981M" was at least saying. Board totals live at this tier now.
	const b = abs / 1_000_000_000;
	return `${sign}${b < 10 ? b.toFixed(2) : b.toFixed(1)}B`;
}
