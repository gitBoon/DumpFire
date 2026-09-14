/**
 * pricing.ts — turning token counts into money.
 *
 * Anthropic list prices, in USD per million tokens. Input and output are priced
 * very differently (5x on every current model), which is the whole difficulty:
 * the ledger records a single total per entry, so unless a caller reports the
 * split we have to assume one.
 *
 * That assumption is stated in the UI rather than hidden, and every figure
 * derived from it is labelled an estimate. A cost number people trust without
 * knowing what it rests on is worse than no cost number.
 *
 * Every rate here was checked against the published pricing table on
 * 2026-09-14 — base input, both cache-write tiers, cache read and output, for
 * all seventeen models. They are list rates and change, so SOURCE_NOTE is
 * rendered next to the totals and nobody has to guess how stale this is.
 *
 * Source: https://platform.claude.com/docs/en/about-claude/pricing
 */

export const PRICING_VERIFIED = '2026-09-14';
export const SOURCE_NOTE = `Anthropic list prices, USD, verified ${PRICING_VERIFIED}`;

export interface ModelPrice {
	/** USD per million input tokens. */
	input: number;
	/** USD per million output tokens. */
	output: number;
	label: string;
	/**
	 * Cache-read multiplier, when the model does not use the standard 0.1x.
	 * Claude Fable 5.1 and Mythos 5.1 read cache at 0.025x — pricing them at
	 * 0.1x would overstate their cache reads fourfold, and cache reads are
	 * ~99% of agentic usage.
	 */
	cacheReadMultiplier?: number;
}

/**
 * Keyed by the model id an agent would report. Lookup is prefix-tolerant so a
 * dated variant (`claude-haiku-4-5-20251001`) still matches its family.
 */
export const MODEL_PRICES: Record<string, ModelPrice> = {
	// Cache-read rates confirmed against the published table: Opus 5 $0.50/MTok,
	// Sonnet 5 $0.20, Haiku 4.5 $0.10 — all 0.1x of base input. The two 5.1
	// models are the exception at 0.025x ($0.25 on a $10 base).
	'claude-fable-5-1': { input: 10, output: 50, label: 'Fable 5.1', cacheReadMultiplier: 0.025 },
	'claude-mythos-5-1': { input: 10, output: 50, label: 'Mythos 5.1', cacheReadMultiplier: 0.025 },
	'claude-fable-5': { input: 10, output: 50, label: 'Fable 5' },
	'claude-mythos-5': { input: 10, output: 50, label: 'Mythos 5' },
	'claude-opus-5': { input: 5, output: 25, label: 'Opus 5' },
	'claude-opus-4-8': { input: 5, output: 25, label: 'Opus 4.8' },
	'claude-opus-4-7': { input: 5, output: 25, label: 'Opus 4.7' },
	'claude-opus-4-6': { input: 5, output: 25, label: 'Opus 4.6' },
	'claude-opus-4-5': { input: 5, output: 25, label: 'Opus 4.5' },
	'claude-opus-4-1': { input: 15, output: 75, label: 'Opus 4.1' },
	'claude-opus-4': { input: 15, output: 75, label: 'Opus 4' },
	'claude-sonnet-5': { input: 2, output: 10, label: 'Sonnet 5' },
	'claude-sonnet-4-6': { input: 3, output: 15, label: 'Sonnet 4.6' },
	'claude-sonnet-4-5': { input: 3, output: 15, label: 'Sonnet 4.5' },
	'claude-sonnet-4': { input: 3, output: 15, label: 'Sonnet 4' },
	'claude-haiku-4-5': { input: 1, output: 5, label: 'Haiku 4.5' },
	'claude-haiku-3-5': { input: 0.8, output: 4, label: 'Haiku 3.5' }
};

/**
 * What this money figure is, and what it is not.
 *
 * These rates are what the API *would* charge for the usage recorded. On a
 * fixed-price plan nobody is billed them — the figure exists to answer "what is
 * this work worth in metered terms", which is a comparison, not an invoice.
 *
 * Kept separate from BLEND_NOTE on purpose. They qualify different things and
 * collapsing them into one hedge ("hypothetical") would imply the measurement
 * itself is soft. It is not: the tokens were counted and the rates are
 * published. Only the billing relationship is notional.
 */
export const NOT_BILLED_NOTE =
	'what the API would charge for this usage — not what you are billed on a fixed plan';

/**
 * The assumed split when a caller reports only a total.
 *
 * Agentic coding is overwhelmingly input — the conversation is resent every
 * turn while replies stay short. 90/10 is a reasonable middle for that shape.
 *
 * Two things make this conservative, and both push the estimate HIGH:
 * prompt caching bills repeated input at a fraction of list, and batch work is
 * half price. Neither is modelled. So treat the figure as a ceiling on list
 * rates, not a prediction of an invoice.
 */
export const ASSUMED_INPUT_SHARE = 0.9;
export const BLEND_NOTE =
	`assumes ${Math.round(ASSUMED_INPUT_SHARE * 100)}/${Math.round((1 - ASSUMED_INPUT_SHARE) * 100)} input/output and no caching, so it errs high`;

/** Resolve a reported model id to a price, tolerating dated suffixes. */
export function priceFor(model: string | null | undefined): ModelPrice | null {
	if (!model) return null;
	const key = model.trim().toLowerCase();
	if (MODEL_PRICES[key]) return MODEL_PRICES[key];
	// Longest prefix wins, so `claude-opus-4-8...` cannot match `claude-opus-4`.
	let best: ModelPrice | null = null;
	let bestLen = 0;
	for (const [id, price] of Object.entries(MODEL_PRICES)) {
		if (key.startsWith(id) && id.length > bestLen) {
			best = price;
			bestLen = id.length;
		}
	}
	return best;
}

/**
 * Cache multipliers, relative to a model's base input rate.
 *
 * These are what make an agentic figure meaningful. A long coding session is
 * ~99% cache reads — the conversation is re-read on every call — and a cache
 * read costs a tenth of fresh input. Pricing those at the full input rate
 * overstates the bill by roughly an order of magnitude.
 *
 * Cache writes cost *more* than fresh input because the write buys reuse: the
 * 5-minute tier at 1.25x, the 1-hour tier at 2x.
 */
export const CACHE_READ_MULTIPLIER = 0.1;
export const CACHE_WRITE_5M_MULTIPLIER = 1.25;
export const CACHE_WRITE_1H_MULTIPLIER = 2.0;

/**
 * A measured breakdown, as Claude Code's session transcripts record it.
 *
 * When an entry carries one of these the cost is exact — no assumed split, no
 * assumption about caching. This is the accurate path and should be preferred
 * everywhere it can be obtained.
 */
export interface TokenBreakdown {
	input: number;
	output: number;
	cacheRead: number;
	cacheWrite5m: number;
	cacheWrite1h: number;
}

/** Sum of every component — the figure reported as an entry's `tokens`. */
export function breakdownTotal(b: TokenBreakdown): number {
	return b.input + b.output + b.cacheRead + b.cacheWrite5m + b.cacheWrite1h;
}

/** Exact cost of a measured breakdown. Null when the model cannot be priced. */
export function costOfBreakdown(b: TokenBreakdown, model: string | null): number | null {
	const price = priceFor(model);
	if (!price) return null;
	const m = 1_000_000;
	return (
		(b.input / m) * price.input +
		(b.output / m) * price.output +
		(b.cacheRead / m) * price.input * (price.cacheReadMultiplier ?? CACHE_READ_MULTIPLIER) +
		(b.cacheWrite5m / m) * price.input * CACHE_WRITE_5M_MULTIPLIER +
		(b.cacheWrite1h / m) * price.input * CACHE_WRITE_1H_MULTIPLIER
	);
}

export interface CostInput {
	tokens: number;
	model: string | null;
	/** Exact split when the caller reported one; otherwise the blend is used. */
	inputTokens?: number | null;
	outputTokens?: number | null;
	/**
	 * A full measured breakdown. When present this is used and everything else
	 * is ignored — it is the only path that gets cache pricing right, and cache
	 * reads are the overwhelming majority of agentic usage.
	 */
	breakdown?: TokenBreakdown | null;
}

export interface CostResult {
	/** USD. Null when the model is unknown — never silently zero. */
	usd: number | null;
	/** True when every contributing entry carried an exact input/output split. */
	exact: boolean;
	/** Tokens we could not price because their model is unknown or missing. */
	unpricedTokens: number;
}

/** Cost of one entry. */
export function costOfEntry(e: CostInput): { usd: number | null; exact: boolean } {
	const price = priceFor(e.model);
	if (!price) return { usd: null, exact: false };

	// A measured breakdown beats every assumption available.
	if (e.breakdown) {
		const usd = costOfBreakdown(e.breakdown, e.model);
		return { usd, exact: usd !== null };
	}

	// An input/output split is only usable when it accounts for the WHOLE total.
	// Once cache components exist, input + output no longer sums to `tokens` —
	// and treating a partial split as complete silently prices only the fraction
	// it covers. That is how a 155M-token figure once came out at $7.52: the
	// cache reads, 99.5% of it, were dropped on the floor. If the split does not
	// add up, the breakdown is incomplete and the blend is the honest fallback.
	const splitCoversTotal =
		typeof e.inputTokens === 'number' &&
		typeof e.outputTokens === 'number' &&
		e.inputTokens + e.outputTokens === e.tokens;
	const hasSplit = splitCoversTotal && e.tokens !== 0;

	const inTok = hasSplit ? e.inputTokens! : e.tokens * ASSUMED_INPUT_SHARE;
	const outTok = hasSplit ? e.outputTokens! : e.tokens * (1 - ASSUMED_INPUT_SHARE);

	const usd = (inTok / 1_000_000) * price.input + (outTok / 1_000_000) * price.output;
	return { usd, exact: hasSplit };
}

/**
 * Cost of many entries.
 *
 * Entries whose model is unknown are counted in `unpricedTokens` rather than
 * being priced at zero — an unpriceable token is a gap in the data, and
 * pretending it was free would quietly understate every total containing one.
 */
export function costOf(entries: CostInput[]): CostResult {
	let usd = 0;
	let priced = 0;
	let exact = 0;
	let unpricedTokens = 0;

	for (const e of entries) {
		const r = costOfEntry(e);
		if (r.usd === null) {
			unpricedTokens += e.tokens;
			continue;
		}
		usd += r.usd;
		priced++;
		if (r.exact) exact++;
	}

	return {
		usd: priced > 0 ? usd : null,
		exact: priced > 0 && exact === priced,
		unpricedTokens
	};
}

/**
 * Money, at a precision that matches how much the figure is worth trusting.
 *
 * Sub-cent amounts still say "<$0.01" rather than "$0.00", because zero reads
 * as free and nothing here is free.
 */
export function formatUsd(usd: number | null): string {
	if (usd === null) return '—';
	const abs = Math.abs(usd);
	if (abs === 0) return '$0.00';
	if (abs < 0.01) return `${usd < 0 ? '-' : ''}<$0.01`;
	if (abs < 100) return `${usd < 0 ? '-' : ''}$${abs.toFixed(2)}`;
	if (abs < 10_000) return `${usd < 0 ? '-' : ''}$${Math.round(abs).toLocaleString()}`;
	return `${usd < 0 ? '-' : ''}$${(abs / 1000).toFixed(1)}k`;
}
