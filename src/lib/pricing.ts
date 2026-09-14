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
 * Prices verified 2026-06-24. They are list rates and change — SOURCE_NOTE is
 * rendered next to the totals so nobody has to guess how stale this is.
 */

export const PRICING_VERIFIED = '2026-06-24';
export const SOURCE_NOTE = `Anthropic list prices, USD, verified ${PRICING_VERIFIED}`;

export interface ModelPrice {
	/** USD per million input tokens. */
	input: number;
	/** USD per million output tokens. */
	output: number;
	label: string;
}

/**
 * Keyed by the model id an agent would report. Lookup is prefix-tolerant so a
 * dated variant (`claude-haiku-4-5-20251001`) still matches its family.
 */
export const MODEL_PRICES: Record<string, ModelPrice> = {
	'claude-fable-5-1': { input: 10, output: 50, label: 'Fable 5.1' },
	'claude-mythos-5-1': { input: 10, output: 50, label: 'Mythos 5.1' },
	'claude-fable-5': { input: 10, output: 50, label: 'Fable 5' },
	'claude-opus-5': { input: 5, output: 25, label: 'Opus 5' },
	'claude-opus-4-8': { input: 5, output: 25, label: 'Opus 4.8' },
	'claude-opus-4-7': { input: 5, output: 25, label: 'Opus 4.7' },
	'claude-opus-4-6': { input: 5, output: 25, label: 'Opus 4.6' },
	'claude-sonnet-5': { input: 2, output: 10, label: 'Sonnet 5' },
	'claude-sonnet-4-6': { input: 3, output: 15, label: 'Sonnet 4.6' },
	'claude-haiku-4-5': { input: 1, output: 5, label: 'Haiku 4.5' }
};

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

export interface CostInput {
	tokens: number;
	model: string | null;
	/** Exact split when the caller reported one; otherwise the blend is used. */
	inputTokens?: number | null;
	outputTokens?: number | null;
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

	const hasSplit =
		typeof e.inputTokens === 'number' &&
		typeof e.outputTokens === 'number' &&
		e.inputTokens + e.outputTokens !== 0;

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
