/**
 * What a token costs (card 2014): the price table in `src/lib/pricing.ts`, how a
 * model id finds its row, and the one rule that turns a recorded entry into what
 * `costOf` prices.
 *
 * Every expected figure is written out as a number from the published rates,
 * read on 2026-10-14, and is not worked out from the table it tests: a wrong
 * rate in the table fails here rather than being agreed with.
 *
 *   model        input  5m write  1h write  cache read  output   (USD per million)
 *   Opus 5.5     4      5         8         0.20        20
 *   Sonnet 5.5   2      2.50      4         0.20        10
 *   Haiku 5.5    0.10   0.125     0.20      0.01        0.50     (prompts of 100K or fewer)
 *   Opus 5       5      6.25      10        0.50        25
 *   Fable 5.1    10     12.50     20        0.25        50
 *
 * Until this card `claude-opus-5-5` was priced as `claude-opus-5`, at about
 * twice its rate, and `claude-haiku-5-5` was not priced at all. The card window
 * priced each entry without its measured breakdown, so its rows did not add up
 * to the card's total.
 */
import { readFileSync } from 'node:fs';
import { join } from 'node:path';
import { beforeEach, describe, expect, it } from 'vitest';
import {
	MODEL_PRICES,
	VERSION_AFTER_KEY,
	costInputOf,
	costOf,
	costOfBreakdown,
	formatRate,
	priceFor,
	unpricedReason,
	UNPRICED_SUM_NOTE,
	PRICING_VERIFIED,
	type TokenBreakdown
} from '$lib/pricing';
import {
	getBoardTokenTotals,
	getCardTokenEntries,
	getCardTokenTotal,
	getCardTokenTotals,
	getUserSpendByPeriod,
	recordTokenUsage
} from '$lib/server/tokens';
import { sqlite } from '$lib/server/db';
import { makeBoard, makeCard, makeSubtask, makeUser, resetDb } from './helpers/fixtures';

describe('the 5.5 models', () => {
	it('each resolves to its own row, at its published rate', () => {
		expect(priceFor('claude-opus-5-5')).toMatchObject({ input: 4, output: 20, cacheReadMultiplier: 0.05 });
		expect(priceFor('claude-sonnet-5-5')).toMatchObject({ input: 2, output: 10 });
		// Sonnet 5.5 reads cache at the usual 0.1x ($0.20), not Opus 5.5's 0.05x.
		expect(priceFor('claude-sonnet-5-5')?.cacheReadMultiplier).toBeUndefined();
		expect(priceFor('claude-haiku-5-5')).toMatchObject({ input: 0.1, output: 0.5 });
		expect(priceFor('claude-haiku-5-5')?.cacheReadMultiplier).toBeUndefined();
	});

	it('Haiku 5.5 says that it is priced at the rate for prompts of 100K tokens or fewer', () => {
		expect(priceFor('claude-haiku-5-5')?.note).toMatch(/100K tokens or fewer/);
		expect(priceFor('claude-opus-5-5')?.note).toBeUndefined();
	});

	it('every older row is kept', () => {
		for (const id of [
			'claude-fable-5-1', 'claude-mythos-5-1', 'claude-fable-5', 'claude-mythos-5', 'claude-opus-5',
			'claude-opus-4-8', 'claude-opus-4-7', 'claude-opus-4-6', 'claude-opus-4-5', 'claude-opus-4-1',
			'claude-opus-4', 'claude-sonnet-5', 'claude-sonnet-4-6', 'claude-sonnet-4-5', 'claude-sonnet-4',
			'claude-haiku-4-5', 'claude-haiku-3-5'
		]) {
			expect(MODEL_PRICES[id], id).toBeDefined();
		}
		expect(Object.keys(MODEL_PRICES)).toHaveLength(20);
		expect(PRICING_VERIFIED).toBe('2026-10-14');
	});
});

describe('how a model id finds its row', () => {
	it('every row is found by its own id, and by its id with a date after it', () => {
		for (const [id, price] of Object.entries(MODEL_PRICES)) {
			expect(priceFor(id), id).toBe(price);
			expect(priceFor(`${id}-20260101`), `${id}-20260101`).toBe(price);
			expect(priceFor(id.toUpperCase()), id.toUpperCase()).toBe(price);
		}
	});

	it('a dated or tagged id finds its row', () => {
		expect(priceFor('claude-haiku-4-5-20251001')).toBe(MODEL_PRICES['claude-haiku-4-5']);
		expect(priceFor('claude-opus-4-20250514')).toBe(MODEL_PRICES['claude-opus-4']);
		expect(priceFor('claude-opus-4-6[1m]')).toBe(MODEL_PRICES['claude-opus-4-6']);
		expect(priceFor('claude-opus-5-5-fast')).toBe(MODEL_PRICES['claude-opus-5-5']);
		expect(priceFor('claude-opus-5-5[1m]')).toBe(MODEL_PRICES['claude-opus-5-5']);
	});

	it('a version DumpFire does not list is unpriced, never priced as an older model', () => {
		for (const id of ['claude-opus-5-6', 'claude-opus-4-9', 'claude-sonnet-5-5-1', 'claude-haiku-5-6', 'claude-fable-5-2', 'claude-opus-5-1234567']) {
			expect(priceFor(id), id).toBeNull();
		}
		const r = costOf([
			{ tokens: 1000, model: 'claude-opus-5-6' },
			{ tokens: 500, model: 'claude-opus-5' }
		]);
		expect(r.unpricedTokens).toBe(1000);
		// 500 at the 90/10 blend of Opus 5: 450 x $5 + 50 x $25, per million.
		expect(r.usd).toBeCloseTo(0.0035, 10);
	});

	it('a version written straight after the key, with no dash, is unpriced too', () => {
		// `claude-fable-5-10` begins with `claude-fable-5-1` and the rest is `0`;
		// `claude-opus-50` begins with `claude-opus-5`. Neither is that model.
		for (const id of ['claude-fable-5-10', 'claude-opus-4-10', 'claude-opus-50', 'claude-sonnet-50']) {
			expect(priceFor(id), id).toBeNull();
		}
	});

	it('the ids that carry a date or a tag after their row still find it', () => {
		const opus55 = MODEL_PRICES['claude-opus-5-5'];
		for (const id of [
			'claude-opus-5-5-20261001', 'claude-opus-5-5@20261001', 'claude-opus-5-5[1m]',
			'claude-opus-5-5-fast', 'claude-opus-5-5-v1:0', 'claude-opus-5-5-20261001-v1:0'
		]) {
			expect(priceFor(id), id).toBe(opus55);
		}
	});

	it('the rule is a digit, or a dash and one to seven digits: a version, and not a date', () => {
		expect(VERSION_AFTER_KEY.test('0')).toBe(true);
		expect(VERSION_AFTER_KEY.test('5-20261001')).toBe(true);
		expect(VERSION_AFTER_KEY.test('@20261001')).toBe(false);
		expect(VERSION_AFTER_KEY.test('-v1:0')).toBe(false);
		expect(VERSION_AFTER_KEY.test('-5')).toBe(true);
		expect(VERSION_AFTER_KEY.test('-5-1')).toBe(true);
		expect(VERSION_AFTER_KEY.test('-1234567')).toBe(true);
		expect(VERSION_AFTER_KEY.test('-20251001')).toBe(false);
		expect(VERSION_AFTER_KEY.test('-fast')).toBe(false);
		expect(VERSION_AFTER_KEY.test('[1m]')).toBe(false);
		expect(VERSION_AFTER_KEY.test('')).toBe(false);
	});
});

describe('a measured breakdown', () => {
	// 100K input, 20K output, 5M cache read, 200K written for 5 minutes, 300K for an hour.
	const b: TokenBreakdown = { input: 100_000, output: 20_000, cacheRead: 5_000_000, cacheWrite5m: 200_000, cacheWrite1h: 300_000 };

	it('costs what the published rates say', () => {
		// 0.1 x 4 + 0.02 x 20 + 5 x 0.20 + 0.2 x 5 + 0.3 x 8
		expect(costOfBreakdown(b, 'claude-opus-5-5')).toBeCloseTo(5.2, 10);
		// 0.1 x 2 + 0.02 x 10 + 5 x 0.20 + 0.2 x 2.5 + 0.3 x 4
		expect(costOfBreakdown(b, 'claude-sonnet-5-5')).toBeCloseTo(3.1, 10);
		// 0.1 x 0.1 + 0.02 x 0.5 + 5 x 0.01 + 0.2 x 0.125 + 0.3 x 0.2
		expect(costOfBreakdown(b, 'claude-haiku-5-5')).toBeCloseTo(0.155, 10);
		// 0.1 x 5 + 0.02 x 25 + 5 x 0.50 + 0.2 x 6.25 + 0.3 x 10
		expect(costOfBreakdown(b, 'claude-opus-5')).toBeCloseTo(7.75, 10);
		// 0.1 x 10 + 0.02 x 50 + 5 x 0.25 + 0.2 x 12.5 + 0.3 x 20
		expect(costOfBreakdown(b, 'claude-fable-5-1')).toBeCloseTo(11.75, 10);
		expect(costOfBreakdown(b, 'claude-opus-5-6')).toBeNull();
	});
});

describe('one entry, priced the same in the card window as in the card total', () => {
	// The API document's example entry: Opus 5, measured.
	const example = {
		tokens: 52_900, model: 'claude-opus-5', inputTokens: 1200, outputTokens: 900,
		cacheReadTokens: 48_000, cacheWrite5mTokens: 2800, cacheWrite1hTokens: 0
	};

	it('an entry with cache reads, input and output is priced from its breakdown', () => {
		expect(costInputOf(example).breakdown).toEqual({ input: 1200, output: 900, cacheRead: 48_000, cacheWrite5m: 2800, cacheWrite1h: 0 });
		// 1,200 x $5 + 900 x $25 + 48,000 x $0.50 + 2,800 x $6.25, per million. The
		// window's rows priced it at the 90/10 blend, $0.3703.
		const r = costOf([costInputOf(example)]);
		expect(r.usd).toBeCloseTo(0.07, 10);
		expect(r.exact).toBe(true);
	});

	it('an entry without cache reads is not given a breakdown, and one without a split falls back to the blend', () => {
		expect(costInputOf({ ...example, cacheReadTokens: null }).breakdown).toBeNull();
		expect(costInputOf({ ...example, cacheReadTokens: undefined }).breakdown).toBeNull();
		const bare = { tokens: 9100, model: 'claude-sonnet-5', inputTokens: null, outputTokens: null, cacheReadTokens: null, cacheWrite5mTokens: null, cacheWrite1hTokens: null };
		expect(costInputOf(bare).breakdown).toBeNull();
		// 8,190 x $2 + 910 x $10, per million.
		expect(costOf([costInputOf(bare)]).usd).toBeCloseTo(0.02548, 10);
	});

	describe('against the ledger', () => {
		beforeEach(() => {
			resetDb();
		});

		it("the card's total is the sum of its entries, each priced as the window prices it", () => {
			const owner = makeUser();
			const { cols } = makeBoard({ owner });
			const card = makeCard(cols['To Do']);
			recordTokenUsage(owner, { kind: 'card', id: card.id }, 52_900, 'claude-opus-5', 'applied the fix', {
				inputTokens: 1200, outputTokens: 900, cacheReadTokens: 48_000, cacheWrite5mTokens: 2800, cacheWrite1hTokens: 0
			});
			recordTokenUsage(owner, { kind: 'card', id: card.id }, 9100, 'claude-sonnet-5', 'verification');

			const total = getCardTokenTotal(card.id);
			expect(total.costUsd).toBeCloseTo(0.09548, 10);
			const rows = getCardTokenEntries(card.id).map((e) => costOf([costInputOf(e)]).usd!);
			expect(rows.reduce((sum, usd) => sum + usd, 0)).toBeCloseTo(total.costUsd!, 10);
		});

		it('every grouped total prices each entry as the card does, when one model has measured and total-only entries', () => {
			// The grouped totals sum a model's entries before pricing them. They used to
			// price the whole group at the blend when any one entry had no breakdown, so
			// this card read $0.1427 in its own window and $0.441 on the board, the
			// dashboard, the Spend window, All Tasks and the bulk answer.
			const owner = makeUser();
			const { board, cols } = makeBoard({ owner });
			const card = makeCard(cols['To Do']);
			const sub = makeSubtask(card);
			recordTokenUsage(owner, { kind: 'card', id: card.id }, 52_900, 'claude-opus-5', 'measured', {
				inputTokens: 1200, outputTokens: 900, cacheReadTokens: 48_000, cacheWrite5mTokens: 2800, cacheWrite1hTokens: 0
			});
			recordTokenUsage(owner, { kind: 'subtask', id: sub.id }, 9100, 'claude-opus-5', 'total only');
			// An entry from before the cache columns: an input/output split and no cache figures.
			const legacy = recordTokenUsage(owner, { kind: 'card', id: card.id }, 1000, 'claude-opus-5', 'split only', {
				inputTokens: 800, outputTokens: 200
			});
			sqlite
				.prepare('UPDATE token_usage SET cache_read_tokens = NULL, cache_write_5m_tokens = NULL, cache_write_1h_tokens = NULL WHERE id = ?')
				.run(legacy.entryId);

			// $0.07 measured (above); 8,190 x $5 + 910 x $25 at the blend, $0.0637;
			// 800 x $5 + 200 x $25 from the split, $0.009.
			const expected = 0.1427;
			expect(getCardTokenTotal(card.id).costUsd).toBeCloseTo(expected, 10);
			expect(getCardTokenTotals([card.id]).get(card.id)?.costUsd).toBeCloseTo(expected, 10);
			expect(getBoardTokenTotals([board.id]).get(board.id)?.costUsd).toBeCloseTo(expected, 10);
			const spend = getUserSpendByPeriod([board.id]);
			for (const period of ['today', 'all'] as const) {
				expect(spend[period], period).toHaveLength(1);
				expect(spend[period][0].costUsd, period).toBeCloseTo(expected, 10);
				expect(spend[period][0].byModel, period).toHaveLength(1);
				expect(spend[period][0].byModel[0], period).toMatchObject({ model: 'claude-opus-5', tokens: 63_000, exact: false });
				expect(spend[period][0].byModel[0].costUsd, period).toBeCloseTo(expected, 10);
			}
			// Not every entry is measured, so no figure says it is exact.
			expect(getCardTokenTotal(card.id).costExact).toBe(false);
			expect(getCardTokenTotals([card.id]).get(card.id)?.costExact).toBe(false);
		});
	});

	it('the card window prices every entry and every subtask through costInputOf', () => {
		const source = readFileSync(join(process.cwd(), 'src/lib/components/CardModal.svelte'), 'utf8');
		const calls = [...source.matchAll(/costOf\(([^\n]*)/g)].map((m) => m[1]);
		expect(calls.length).toBeGreaterThanOrEqual(2);
		for (const args of calls) {
			expect(args, `costOf(${args}`).toMatch(/^(\[costInputOf\(|\w+\.map\(costInputOf\))/);
		}
	});
});

describe('what is said about a figure', () => {
	it('formatRate shows a third place only where it is not zero', () => {
		expect(formatRate(0.2)).toBe('$0.20');
		expect(formatRate(0.125)).toBe('$0.125');
		expect(formatRate(0.625)).toBe('$0.625');
		expect(formatRate(0.01)).toBe('$0.01');
		expect(formatRate(20)).toBe('$20.00');
		expect(formatRate(6.25)).toBe('$6.25');
	});

	it('an unpriced model is named, and an entry with none says so', () => {
		expect(unpricedReason(null)).toBe('No model recorded, so this cannot be priced.');
		expect(unpricedReason('claude-opus-5-6')).toBe("No price for claude-opus-5-6 in DumpFire's table (prices verified 2026-10-14).");
		expect(UNPRICED_SUM_NOTE).toBe('recorded without a model, or with a model DumpFire has no price for');
	});
});
