/**
 * tokens.ts — what work actually cost.
 *
 * Story points estimate effort before the work and are an opinion. Tokens are
 * measured after it and are an observation, which is the whole reason this
 * exists.
 *
 * The store is a ledger (`token_usage`), not a counter. Entries accrue while a
 * card is worked on, so the total climbs toward completion and you can see
 * *when* the cost was incurred rather than only the final figure. A mistaken
 * entry is corrected by writing a negative one, never by rewriting history.
 *
 * One rule runs through all of this: **absent is not zero.** A card nobody has
 * reported against returns `entries: 0` and must render as "—". Only a card
 * with entries that genuinely sum to zero is a recorded zero. Historical cards
 * predate the feature and we cannot know what they cost, so we never imply that
 * we do.
 */

import { db, sqlite } from './db';
import { inTransaction } from './db/transaction';
import { tokenUsage } from './db/schema';
import { eq } from 'drizzle-orm';
import { canEditBoard } from './board-access';
import { getCardBoardId, getSubtaskCardId } from './work-access';
import type { SessionUser } from './auth';
import { costOf, costInputOf, type CostInput } from '$lib/pricing';

/**
 * A backstop against a fat-fingered paste, not a plausibility test.
 *
 * The total is a poor signal on its own: cache reads dominate agentic work (98%
 * of a measured session) and a long session on a 1M-context model genuinely
 * passes 100M. The old 100M cap refused a real 137,205,251-token measurement on
 * 2026-09-24 and forced it to be split into invented halves. Ten billion is
 * ~5,000 calls at a full 1M context — beyond any single piece of work.
 */
export const MAX_TOKENS_PER_ENTRY = 10_000_000_000;

/**
 * The real plausibility test, applied whenever `apiCalls` is given.
 *
 * One call cannot consume more than a context window (input, cache reads and
 * cache writes together) plus its output. The largest window is 1M tokens and
 * output tops out well under 200k, so anything above this per call is impossible
 * whatever the model — which is what a running total or a doubled paste
 * produces. Model-agnostic on purpose: model ids are free text and pricing does
 * not carry context sizes.
 */
export const MAX_TOKENS_PER_CALL = 1_200_000;
const MAX_MODEL_LEN = 80;
const MAX_NOTE_LEN = 500;

export class TokenError extends Error {
	constructor(
		public status: number,
		message: string
	) {
		super(message);
		this.name = 'TokenError';
	}
}

export type TokenTarget = { kind: 'card'; id: number } | { kind: 'subtask'; id: number };

export interface TokenEntry {
	id: number;
	cardId: number | null;
	subtaskId: number | null;
	subtaskTitle: string | null;
	tokens: number;
	model: string | null;
	inputTokens: number | null;
	outputTokens: number | null;
	cacheReadTokens: number | null;
	cacheWrite5mTokens: number | null;
	cacheWrite1hTokens: number | null;
	apiCalls: number | null;
	note: string | null;
	createdAt: string;
}

export interface TokenTotal {
	/** Sum of every entry. Meaningless unless `entries > 0` — see the module note. */
	total: number;
	/** Entries on the card itself, excluding its subtasks. */
	direct: number;
	/** Entries on the card's subtasks. */
	fromSubtasks: number;
	/** How many entries make up the total. Zero means NOT RECORDED, not zero cost. */
	entries: number;
	/** Tokens per model, largest first. Empty when nothing is recorded. */
	byModel: { model: string; tokens: number }[];
	/**
	 * Estimated cost in USD, or null when no contributing entry named a model
	 * we can price. Never silently zero — see `unpricedTokens`.
	 */
	costUsd: number | null;
	/** True only when every priced entry carried an exact input/output split. */
	costExact: boolean;
	/** Tokens excluded from the cost because their model is unknown. */
	unpricedTokens: number;
	/**
	 * API round trips behind the total, or null when no entry recorded it.
	 * Total = calls x context size; without this the two cannot be separated.
	 */
	apiCalls: number | null;
}

const EMPTY: TokenTotal = {
	total: 0, direct: 0, fromSubtasks: 0, entries: 0, byModel: [],
	costUsd: null, costExact: false, unpricedTokens: 0, apiCalls: null
};

/** A total with no entries behind it. Callers render this as "—". */
export function emptyTotal(): TokenTotal {
	return { ...EMPTY, byModel: [] };
}

// ─── Recording ───────────────────────────────────────────────────────────────

function validateAmount(tokens: unknown, calls: number | null): number {
	if (typeof tokens !== 'number' || !Number.isFinite(tokens)) {
		throw new TokenError(400, 'tokens must be a number');
	}
	if (!Number.isInteger(tokens)) {
		throw new TokenError(400, 'tokens must be a whole number');
	}
	if (tokens === 0) {
		// A zero entry carries no information and would only make "recorded" and
		// "not recorded" harder to tell apart.
		throw new TokenError(400, 'tokens must not be zero — omit the call instead');
	}
	if (Math.abs(tokens) > MAX_TOKENS_PER_ENTRY) {
		throw new TokenError(
			400,
			`tokens is implausible (max ${MAX_TOKENS_PER_ENTRY.toLocaleString()} per entry). ` +
				'Report the usage for this step, not a running total. A genuinely larger ' +
				'measurement should be recorded as one entry per session or per subtask.'
		);
	}
	if (calls !== null && calls > 0 && Math.abs(tokens) / calls > MAX_TOKENS_PER_CALL) {
		const perCall = Math.round(Math.abs(tokens) / calls);
		throw new TokenError(
			400,
			`tokens is implausible: ${Math.abs(tokens).toLocaleString()} over ${calls.toLocaleString()} ` +
				`API calls is ${perCall.toLocaleString()} per call, more than any model's context window ` +
				`(max ${MAX_TOKENS_PER_CALL.toLocaleString()} per call). Check this is the usage for this ` +
				'step rather than a running total, and that apiCalls covers the same window.'
		);
	}
	return tokens;
}

function clean(value: unknown, max: number, field: string): string | null {
	if (value === undefined || value === null || value === '') return null;
	if (typeof value !== 'string') throw new TokenError(400, `${field} must be a string`);
	const trimmed = value.trim();
	if (!trimmed) return null;
	if (trimmed.length > max) throw new TokenError(400, `${field} must be ${max} characters or fewer`);
	return trimmed;
}

export interface BreakdownInput {
	/** Round trips this entry covers. Optional, but it makes the total legible. */
	apiCalls?: unknown;
	inputTokens?: unknown;
	outputTokens?: unknown;
	cacheReadTokens?: unknown;
	cacheWrite5mTokens?: unknown;
	cacheWrite1hTokens?: unknown;
}

export interface StoredBreakdown {
	inputTokens: number | null;
	outputTokens: number | null;
	cacheReadTokens: number | null;
	cacheWrite5mTokens: number | null;
	cacheWrite1hTokens: number | null;
}

const NO_BREAKDOWN: StoredBreakdown = {
	inputTokens: null, outputTokens: null,
	cacheReadTokens: null, cacheWrite5mTokens: null, cacheWrite1hTokens: null
};

/** Call counts are a plain positive integer, or absent. */
function parseCallCount(v: unknown): number | null {
	if (v === undefined || v === null || v === '') return null;
	const n = Number(v);
	if (!Number.isInteger(n) || n < 0) throw new TokenError(400, 'apiCalls must be a whole number');
	return n;
}

/**
 * Validate a measured breakdown.
 *
 * Cache components are optional on top of input/output, because a caller with
 * only an input/output split is still better off than one with neither. But
 * whatever is given must sum to the total: a breakdown that contradicts it
 * means two different claims about the same work.
 *
 * Cache reads are the reason this exists. In a measured Claude Code session on
 * 2026-09-14 they were 99.3% of all tokens and are billed at a tenth of fresh
 * input, so a figure without them is not approximately right — it is wrong by
 * about an order of magnitude in one direction or the other.
 */
function validateBreakdown(total: number, b: BreakdownInput): StoredBreakdown {
	const parts: (keyof StoredBreakdown)[] = [
		'inputTokens', 'outputTokens', 'cacheReadTokens', 'cacheWrite5mTokens', 'cacheWrite1hTokens'
	];
	const given = parts.filter((k) => b[k] !== undefined && b[k] !== null);
	if (given.length === 0) return { ...NO_BREAKDOWN };

	if (!given.includes('inputTokens') || !given.includes('outputTokens')) {
		throw new TokenError(400, 'A breakdown must include at least inputTokens and outputTokens');
	}

	const out = { ...NO_BREAKDOWN };
	let sum = 0;
	for (const k of parts) {
		const raw = b[k];
		if (raw === undefined || raw === null) {
			// Absent cache components mean zero, not unknown: a caller reporting a
			// breakdown at all is claiming it is complete.
			if (k !== 'inputTokens' && k !== 'outputTokens') out[k] = 0;
			continue;
		}
		const n = Number(raw);
		if (!Number.isInteger(n)) throw new TokenError(400, `${k} must be a whole number`);
		if (n < 0) throw new TokenError(400, `${k} must not be negative`);
		out[k] = n;
		sum += n;
	}

	// A correction is a negative total; its components describe the magnitude.
	if (sum !== Math.abs(total)) {
		throw new TokenError(
			400,
			`The breakdown sums to ${sum} but tokens is ${total}. Every component must be included and they must add up.`
		);
	}
	if (total < 0) {
		for (const k of parts) if (out[k] !== null) out[k] = -out[k]!;
	}
	return out;
}

/**
 * Resolve the target, check the caller may edit the board it lives on, and
 * return the board id so the caller can fire an SSE refresh.
 */
export function resolveTarget(user: SessionUser, target: TokenTarget): number {
	if (target.kind === 'card') {
		const boardId = getCardBoardId(target.id);
		// Archived cards are deliberately still addressable: archiving is not
		// deletion, and work that was done still cost what it cost.
		if (boardId === null) throw new TokenError(404, `Card #${target.id} does not exist`);
		if (!canEditBoard(user, boardId)) {
			throw new TokenError(403, `No edit access to the board holding card #${target.id}`);
		}
		return boardId;
	}
	const cardId = getSubtaskCardId(target.id);
	if (cardId === null) throw new TokenError(404, `Subtask #${target.id} does not exist`);
	const boardId = getCardBoardId(cardId);
	if (boardId === null) throw new TokenError(404, `Subtask #${target.id} has no reachable board`);
	if (!canEditBoard(user, boardId)) {
		throw new TokenError(403, `No edit access to the board holding subtask #${target.id}`);
	}
	return boardId;
}

// ─── What a correction may take back ─────────────────────────────────────────

/**
 * One target's entries of one model, summed the way they are priced (card
 * 2220): `blend` is the tokens of the entries priced at the assumed 90/10
 * split, and the rest are the components of the measured and split entries
 * (a split entry counts as measured with no cache, which prices the same).
 */
interface PricedSums {
	blend: number;
	inputTokens: number;
	outputTokens: number;
	cacheReadTokens: number;
	cacheWrite5mTokens: number;
	cacheWrite1hTokens: number;
}

const COMPONENTS = ['inputTokens', 'outputTokens', 'cacheReadTokens', 'cacheWrite5mTokens', 'cacheWrite1hTokens'] as const;

function noSums(): PricedSums {
	return { blend: 0, inputTokens: 0, outputTokens: 0, cacheReadTokens: 0, cacheWrite5mTokens: 0, cacheWrite1hTokens: 0 };
}

/**
 * What one entry adds to its target's sums: classed as `PRICED_AS` classes it,
 * so a sum here is the sum the ledger prices. `sign` -1 is the entry taken away.
 */
function sumsOf(entry: { tokens: number } & { [K in keyof StoredBreakdown]: number | null }, sign: 1 | -1 = 1): PricedSums {
	const out = noSums();
	const measured = entry.cacheReadTokens !== null && entry.inputTokens !== null && entry.outputTokens !== null;
	const split =
		!measured && entry.inputTokens !== null && entry.outputTokens !== null &&
		entry.tokens !== 0 && entry.inputTokens + entry.outputTokens === entry.tokens;
	if (!measured && !split) {
		out.blend = sign * entry.tokens;
		return out;
	}
	out.inputTokens = sign * entry.inputTokens!;
	out.outputTokens = sign * entry.outputTokens!;
	if (measured) {
		out.cacheReadTokens = sign * entry.cacheReadTokens!;
		out.cacheWrite5mTokens = sign * (entry.cacheWrite5mTokens ?? 0);
		out.cacheWrite1hTokens = sign * (entry.cacheWrite1hTokens ?? 0);
	}
	return out;
}

/** The sums of what is stored on one target for one model, the exact model string. */
function recordedSums(target: TokenTarget, model: string | null): PricedSums {
	const where = target.kind === 'card' ? 'tu.card_id = ? AND tu.subtask_id IS NULL' : 'tu.subtask_id = ?';
	const row = sqlite
		.prepare(
			`SELECT COALESCE(SUM(CASE WHEN pricedAs = 'blend' THEN tokens ELSE 0 END), 0) AS blend,
			        COALESCE(SUM(CASE WHEN pricedAs <> 'blend' THEN input_tokens ELSE 0 END), 0) AS inputTokens,
			        COALESCE(SUM(CASE WHEN pricedAs <> 'blend' THEN output_tokens ELSE 0 END), 0) AS outputTokens,
			        COALESCE(SUM(CASE WHEN pricedAs = 'measured' THEN cache_read_tokens ELSE 0 END), 0) AS cacheReadTokens,
			        COALESCE(SUM(CASE WHEN pricedAs = 'measured' THEN COALESCE(cache_write_5m_tokens, 0) ELSE 0 END), 0) AS cacheWrite5mTokens,
			        COALESCE(SUM(CASE WHEN pricedAs = 'measured' THEN COALESCE(cache_write_1h_tokens, 0) ELSE 0 END), 0) AS cacheWrite1hTokens
			 FROM (SELECT tu.*, ${PRICED_AS} AS pricedAs FROM token_usage tu WHERE ${where} AND tu.model IS ?)`
		)
		.get(target.id, model) as PricedSums;
	return row;
}

function addSums(a: PricedSums, b: PricedSums): PricedSums {
	const out = { ...a };
	out.blend += b.blend;
	for (const k of COMPONENTS) out[k] += b[k];
	return out;
}

/** "of claude-opus-5-5", or what stands for an entry with no model named. */
const ofModel = (model: string | null) => (model === null ? 'of the entries with no model' : `of ${model}`);
const counted = (n: number) => n.toLocaleString('en-GB');

/**
 * What a refused correction's message adds so that the next try can be right:
 * the models the target's entries do name, when the correction named none, and
 * for a card whose subtasks hold entries, that those are corrected on the subtask.
 */
function correctionHints(target: TokenTarget, model: string | null): string {
	let out = '';
	if (model === null) {
		const where = target.kind === 'card' ? 'card_id = ? AND subtask_id IS NULL' : 'subtask_id = ?';
		const named = (
			sqlite
				.prepare(`SELECT DISTINCT model FROM token_usage WHERE ${where} AND model IS NOT NULL ORDER BY model`)
				.all(target.id) as { model: string }[]
		).map((r) => r.model);
		if (named.length) {
			out += ` This ${target.kind} has entries of ${named.join(', ')}: send the model of the entries it corrects.`;
		}
	}
	if (target.kind === 'card') {
		const onSubtasks = sqlite
			.prepare('SELECT 1 FROM token_usage tu JOIN subtasks s ON s.id = tu.subtask_id WHERE s.card_id = ? LIMIT 1')
			.get(target.id);
		if (onSubtasks) {
			out += " Only the card's own entries count here: an entry on one of its subtasks is corrected on that subtask.";
		}
	}
	return out;
}

/**
 * Refuse an entry that would take a sum the ledger prices below zero (card 2220).
 *
 * A negative entry with no breakdown is priced at the blend, at the full input
 * rate. The measured work it is usually meant to correct is mostly cache reads,
 * at a tenth or less of that, so a bare total taken from it priced the card below
 * zero. So a correction is held to what was recorded, on its own target (a card's
 * own entries, or one subtask's) and of its own model: one with no breakdown
 * takes back at most the tokens recorded without one, and one with a breakdown
 * no part beyond what is recorded of that part. Only a sum the change lowers is
 * looked at, so a positive entry is never refused for what is already stored.
 *
 * `pending` is what earlier entries of the same batch add, not yet written.
 * `removing` is the entry id when the change is an entry taken away.
 */
function checkWithinRecorded(
	target: TokenTarget,
	model: string | null,
	change: PricedSums,
	pending: PricedSums = noSums(),
	removing?: number
): void {
	const after = addSums(addSums(recordedSums(target, model), pending), change);
	const where = `on this ${target.kind}`;
	const parts = ['blend', ...COMPONENTS] as const;
	const short = parts.find((k) => change[k] < 0 && after[k] < 0);
	if (!short) return;
	if (removing !== undefined) {
		throw new TokenError(
			400,
			`Removing entry #${removing} would leave the ${model === null ? 'entries recorded with no model' : `${model} entries`} ${where} below zero: ` +
				'remove the negative entries that correct it first.'
		);
	}
	const before = after[short] - change[short];
	const hints = correctionHints(target, model);
	if (short === 'blend') {
		// The measured parts there, so that one more try, with a breakdown, can be right.
		const recorded = COMPONENTS.filter((k) => after[k] - change[k] > 0).map((k) => `${k} ${counted(after[k] - change[k])}`);
		throw new TokenError(
			400,
			`A correction without a breakdown can take back at most ${counted(Math.max(before, 0))} tokens ${ofModel(model)} ${where}, ` +
				'which is what was recorded there without a breakdown.' +
				(recorded.length
					? ' The rest were measured: send the breakdown of what is taken back, as positive numbers that add up to it, ' +
						`each no more than is recorded (${recorded.join(', ')}).`
					: '') +
				hints
		);
	}
	throw new TokenError(
		400,
		`${short} of this correction is ${counted(-change[short])}, more than the ${counted(before)} recorded ${model === null ? 'with no model' : `for ${model}`} ${where}.` +
			hints
	);
}

export interface RecordResult {
	entryId: number;
	boardId: number;
	cardId: number;
	total: TokenTotal;
}

/**
 * Add one entry to the ledger.
 *
 * Deliberately additive: there is no "set the total to N". Two agents working
 * the same card can each report their own usage without having to know, or
 * overwrite, what the other spent.
 */
export function recordTokenUsage(
	user: SessionUser,
	target: TokenTarget,
	tokens: unknown,
	model?: unknown,
	note?: unknown,
	breakdown?: BreakdownInput
): RecordResult {
	const calls = parseCallCount(breakdown?.apiCalls);
	const amount = validateAmount(tokens, calls);
	const modelName = clean(model, MAX_MODEL_LEN, 'model');
	const noteText = clean(note, MAX_NOTE_LEN, 'note');
	const split = validateBreakdown(amount, breakdown ?? {});
	const boardId = resolveTarget(user, target);
	// After the caller is checked, so a target's entries are read only for one who may edit them.
	checkWithinRecorded(target, modelName, sumsOf({ tokens: amount, ...split }));

	const cardId = target.kind === 'card' ? target.id : getSubtaskCardId(target.id)!;

	const row = db
		.insert(tokenUsage)
		.values({
			cardId: target.kind === 'card' ? target.id : null,
			subtaskId: target.kind === 'subtask' ? target.id : null,
			tokens: amount,
			model: modelName,
			inputTokens: split.inputTokens,
			outputTokens: split.outputTokens,
			cacheReadTokens: split.cacheReadTokens,
			cacheWrite5mTokens: split.cacheWrite5mTokens,
			cacheWrite1hTokens: split.cacheWrite1hTokens,
			apiCalls: calls,
			note: noteText,
			reportedByUserId: user.id
		})
		.returning({ id: tokenUsage.id })
		.get();

	return { entryId: row.id, boardId, cardId, total: getCardTokenTotal(cardId) };
}

export interface BatchEntryInput {
	cardId?: unknown;
	subtaskId?: unknown;
	tokens?: unknown;
	model?: unknown;
	note?: unknown;
	apiCalls?: unknown;
	inputTokens?: unknown;
	outputTokens?: unknown;
	cacheReadTokens?: unknown;
	cacheWrite5mTokens?: unknown;
	cacheWrite1hTokens?: unknown;
}

export interface BatchProblem {
	index: number;
	reason: string;
}

/**
 * Record many entries at once — validated as a whole, then written.
 *
 * Same contract as the other bulk endpoints: if any entry is bad, *nothing* is
 * written and every problem comes back at once. Reporting a card's whole cost
 * is one call rather than one per subtask, which matters against a 60/min rate
 * limit when a card has a dozen steps.
 */
export function recordTokenUsageBatch(
	user: SessionUser,
	entries: BatchEntryInput[]
): { written: number; problems: BatchProblem[]; boardIds: number[]; cardIds: number[] } {
	if (!Array.isArray(entries)) throw new TokenError(400, 'entries must be an array');
	if (entries.length === 0) throw new TokenError(400, 'entries is empty');
	if (entries.length > 200) throw new TokenError(400, 'Batch too large (max 200 entries)');

	const problems: BatchProblem[] = [];
	// What the entries checked so far add to each target's sums of each model: an
	// entry is held to what is stored and to the earlier entries of the batch.
	const pending = new Map<string, PricedSums>();
	const prepared: {
		target: TokenTarget;
		tokens: number;
		model: string | null;
		note: string | null;
		split: StoredBreakdown;
		calls: number | null;
		boardId: number;
		cardId: number;
	}[] = [];

	entries.forEach((e, index) => {
		const hasCard = e.cardId !== undefined && e.cardId !== null;
		const hasSubtask = e.subtaskId !== undefined && e.subtaskId !== null;
		if (hasCard === hasSubtask) {
			problems.push({ index, reason: 'Set exactly one of cardId or subtaskId' });
			return;
		}
		const target: TokenTarget = hasCard
			? { kind: 'card', id: Number(e.cardId) }
			: { kind: 'subtask', id: Number(e.subtaskId) };
		if (isNaN(target.id)) {
			problems.push({ index, reason: 'cardId/subtaskId must be a number' });
			return;
		}
		try {
			const calls = parseCallCount(e.apiCalls);
			const tokens = validateAmount(e.tokens, calls);
			const model = clean(e.model, MAX_MODEL_LEN, 'model');
			const note = clean(e.note, MAX_NOTE_LEN, 'note');
			const split = validateBreakdown(tokens, e);
			const boardId = resolveTarget(user, target);
			const key = JSON.stringify([target.kind, target.id, model]);
			const change = sumsOf({ tokens, ...split });
			const before = pending.get(key) ?? noSums();
			checkWithinRecorded(target, model, change, before);
			pending.set(key, addSums(before, change));
			const cardId = target.kind === 'card' ? target.id : getSubtaskCardId(target.id)!;
			prepared.push({ target, tokens, model, note, split, calls, boardId, cardId });
		} catch (err) {
			problems.push({ index, reason: err instanceof TokenError ? err.message : String(err) });
		}
	});

	if (problems.length > 0) return { written: 0, problems, boardIds: [], cardIds: [] };

	inTransaction(() => {
		for (const p of prepared) {
			db.insert(tokenUsage)
				.values({
					cardId: p.target.kind === 'card' ? p.target.id : null,
					subtaskId: p.target.kind === 'subtask' ? p.target.id : null,
					tokens: p.tokens,
					model: p.model,
					inputTokens: p.split.inputTokens,
					outputTokens: p.split.outputTokens,
					cacheReadTokens: p.split.cacheReadTokens,
					cacheWrite5mTokens: p.split.cacheWrite5mTokens,
					cacheWrite1hTokens: p.split.cacheWrite1hTokens,
					apiCalls: p.calls,
					note: p.note,
					reportedByUserId: user.id
				})
				.run();
		}
	});

	return {
		written: prepared.length,
		problems: [],
		boardIds: [...new Set(prepared.map((p) => p.boardId))],
		cardIds: [...new Set(prepared.map((p) => p.cardId))]
	};
}

/**
 * Remove one entry outright. For a correction prefer a negative entry. An entry
 * that negative entries balance is removed after them, not before (card 2220).
 */
export function deleteTokenEntry(user: SessionUser, entryId: number): { cardId: number; boardId: number } {
	const entry = db.select().from(tokenUsage).where(eq(tokenUsage.id, entryId)).get();
	if (!entry) throw new TokenError(404, `Token entry #${entryId} does not exist`);

	const target: TokenTarget = entry.cardId
		? { kind: 'card', id: entry.cardId }
		: { kind: 'subtask', id: entry.subtaskId! };
	const boardId = resolveTarget(user, target);
	const cardId = entry.cardId ?? getSubtaskCardId(entry.subtaskId!)!;
	// Removing an entry a correction balances would leave the correction alone, below zero.
	checkWithinRecorded(target, entry.model, sumsOf(entry, -1), noSums(), entryId);

	db.delete(tokenUsage).where(eq(tokenUsage.id, entryId)).run();
	return { cardId, boardId };
}

// ─── Reading ─────────────────────────────────────────────────────────────────

interface RawRow {
	cardId: number;
	direct: number;
	fromSubtasks: number;
	entries: number;
}

/**
 * How one entry is priced, as SQL, for the grouped totals to GROUP BY.
 *
 * The grouped totals sum a model's entries before pricing them, and a sum can
 * only be priced one way. They used to price the whole group at the blend when
 * any one entry had no breakdown, so a card with one measured and one total-only
 * entry of the same model read $0.50 in its own window and $5.66 on the board.
 * Grouping by this keeps entries priced differently apart, and each part's sum
 * prices exactly as the sum of its entries would (every way of pricing is linear
 * in the tokens), so every total agrees with `costInputOf` entry by entry:
 *
 * - `measured`: cache reads, input and output all recorded, the rule in
 *   `costInputOf`. Absent cache writes count as zero, as there.
 * - `split`: input and output recorded and adding up to the tokens, the rule in
 *   `costOfEntry`. Only entries from before the cache columns are like this.
 * - `blend`: anything else, priced at the assumed 90/10 split.
 */
const PRICED_AS = `CASE
	WHEN tu.cache_read_tokens IS NOT NULL AND tu.input_tokens IS NOT NULL AND tu.output_tokens IS NOT NULL THEN 'measured'
	WHEN tu.input_tokens IS NOT NULL AND tu.output_tokens IS NOT NULL
	     AND tu.tokens <> 0 AND tu.input_tokens + tu.output_tokens = tu.tokens THEN 'split'
	ELSE 'blend' END`;

/** The priced sums of one group of entries priced the same way. */
interface PricedGroup {
	model: string | null;
	pricedAs: 'measured' | 'split' | 'blend';
	tokens: number;
	inputTokens: number | null;
	outputTokens: number | null;
	cacheReadTokens: number | null;
	cw5m: number | null;
	cw1h: number | null;
}

/**
 * One group's sums to what `costOf` takes. A `split` group goes in as a breakdown
 * with no cache components, which `costOfBreakdown` prices exactly as
 * `costOfEntry` prices a split; that way the group is not refused for a sum of
 * tokens that comes to zero, as a correction and the entry it corrects can.
 */
function groupCostInput(r: PricedGroup): CostInput {
	if (r.pricedAs === 'blend') return { tokens: r.tokens, model: r.model, breakdown: null };
	return {
		tokens: r.tokens,
		model: r.model,
		inputTokens: r.inputTokens,
		outputTokens: r.outputTokens,
		breakdown: {
			input: r.inputTokens ?? 0,
			output: r.outputTokens ?? 0,
			cacheRead: r.pricedAs === 'measured' ? r.cacheReadTokens ?? 0 : 0,
			cacheWrite5m: r.pricedAs === 'measured' ? r.cw5m ?? 0 : 0,
			cacheWrite1h: r.pricedAs === 'measured' ? r.cw1h ?? 0 : 0
		}
	};
}

/**
 * Totals for many cards in one query, rolling each card's subtasks up into it.
 *
 * Cards with nothing recorded are simply absent from the returned map, which is
 * what keeps "not recorded" distinct from "recorded zero" all the way to the UI.
 */
export function getCardTokenTotals(cardIds: number[]): Map<number, TokenTotal> {
	const out = new Map<number, TokenTotal>();
	if (cardIds.length === 0) return out;

	const placeholders = cardIds.map(() => '?').join(',');
	const rows = sqlite
		.prepare(
			`SELECT card_id AS cardId,
			        SUM(direct) AS direct,
			        SUM(fromSubtasks) AS fromSubtasks,
			        SUM(entries) AS entries
			 FROM (
			   SELECT tu.card_id AS card_id, SUM(tu.tokens) AS direct, 0 AS fromSubtasks, COUNT(*) AS entries
			     FROM token_usage tu
			    WHERE tu.card_id IN (${placeholders})
			    GROUP BY tu.card_id
			   UNION ALL
			   SELECT s.card_id AS card_id, 0 AS direct, SUM(tu.tokens) AS fromSubtasks, COUNT(*) AS entries
			     FROM token_usage tu
			     JOIN subtasks s ON s.id = tu.subtask_id
			    WHERE s.card_id IN (${placeholders})
			    GROUP BY s.card_id
			 )
			 GROUP BY card_id`
		)
		.all(...cardIds, ...cardIds) as RawRow[];

	for (const r of rows) {
		const direct = r.direct ?? 0;
		const fromSubtasks = r.fromSubtasks ?? 0;
		out.set(r.cardId, {
			total: direct + fromSubtasks,
			direct,
			fromSubtasks,
			entries: r.entries ?? 0,
			byModel: [],
			costUsd: null,
			costExact: false,
			unpricedTokens: 0,
			apiCalls: null
		});
	}

	// Cost needs per-model figures, which the totals query deliberately does not
	// carry. One extra grouped query covers the whole batch rather than one per
	// card, which matters on a dashboard listing every board. Grouped by how each
	// entry is priced too (PRICED_AS), so the card prices as its own window does.
	const costRows = sqlite
		.prepare(
			`SELECT COALESCE(tu.card_id, s.card_id) AS cardId,
			        tu.model                        AS model,
			        ${PRICED_AS}                    AS pricedAs,
			        SUM(tu.tokens)                  AS tokens,
			        SUM(tu.input_tokens)            AS inputTokens,
			        SUM(tu.output_tokens)           AS outputTokens,
			        SUM(tu.cache_read_tokens)       AS cacheReadTokens,
			        SUM(tu.cache_write_5m_tokens)   AS cw5m,
			        SUM(tu.cache_write_1h_tokens)   AS cw1h,
			        SUM(tu.api_calls)               AS apiCalls,
			        COUNT(tu.api_calls)             AS withCalls,
			        COUNT(*)                        AS n
			   FROM token_usage tu
			   LEFT JOIN subtasks s ON s.id = tu.subtask_id
			  WHERE COALESCE(tu.card_id, s.card_id) IN (${placeholders})
			  GROUP BY COALESCE(tu.card_id, s.card_id), tu.model, pricedAs`
		)
		.all(...cardIds) as (PricedGroup & {
		cardId: number; apiCalls: number | null; withCalls: number; n: number;
	})[];

	const byCard = new Map<number, typeof costRows>();
	for (const r of costRows) {
		if (!byCard.has(r.cardId)) byCard.set(r.cardId, []);
		byCard.get(r.cardId)!.push(r);
	}
	for (const [cardId, rows2] of byCard) {
		const existing = out.get(cardId);
		if (!existing) continue;
		const cost = costOf(rows2.map(groupCostInput));
		existing.costUsd = cost.usd;
		existing.costExact = cost.exact;
		existing.unpricedTokens = cost.unpricedTokens;
		// Only usable when EVERY entry carried a count: dividing the full token
		// total by a partial call count yields an impossible context-per-call.
		const complete = rows2.every((r) => r.withCalls === r.n);
		const calls = rows2.reduce((sum, r) => sum + (r.apiCalls ?? 0), 0);
		existing.apiCalls = complete && calls > 0 ? calls : null;
	}
	return out;
}

/** One card's total, subtasks rolled in, including the per-model split. */
export function getCardTokenTotal(cardId: number): TokenTotal {
	const base = getCardTokenTotals([cardId]).get(cardId);
	if (!base) return emptyTotal();

	const models = sqlite
		.prepare(
			`SELECT COALESCE(tu.model, 'unspecified') AS model, SUM(tu.tokens) AS tokens
			   FROM token_usage tu
			   LEFT JOIN subtasks s ON s.id = tu.subtask_id
			  WHERE tu.card_id = ? OR s.card_id = ?
			  GROUP BY COALESCE(tu.model, 'unspecified')
			  ORDER BY tokens DESC`
		)
		.all(cardId, cardId) as { model: string; tokens: number }[];

	// Cost from the entries themselves rather than from the per-model subtotals,
	// so an entry carrying an exact input/output split is costed exactly and only
	// the rest falls back to the blend. `costInputOf` is the card window's rule
	// for its rows too, so the rows add up to this figure.
	const cost = costOf(getCardTokenEntries(cardId).map(costInputOf));

	return {
		...base,
		byModel: models,
		costUsd: cost.usd,
		costExact: cost.exact,
		unpricedTokens: cost.unpricedTokens
	};
}

/** Every entry behind a card, newest first — the card modal's breakdown. */
export function getCardTokenEntries(cardId: number): TokenEntry[] {
	return sqlite
		.prepare(
			`SELECT tu.id            AS id,
			        tu.card_id       AS cardId,
			        tu.subtask_id    AS subtaskId,
			        s.title          AS subtaskTitle,
			        tu.tokens        AS tokens,
			        tu.model         AS model,
			        tu.input_tokens  AS inputTokens,
			        tu.output_tokens AS outputTokens,
			        tu.cache_read_tokens      AS cacheReadTokens,
			        tu.cache_write_5m_tokens  AS cacheWrite5mTokens,
			        tu.cache_write_1h_tokens  AS cacheWrite1hTokens,
			        tu.api_calls              AS apiCalls,
			        tu.note          AS note,
			        tu.created_at    AS createdAt
			   FROM token_usage tu
			   LEFT JOIN subtasks s ON s.id = tu.subtask_id
			  WHERE tu.card_id = ? OR s.card_id = ?
			  ORDER BY tu.created_at DESC, tu.id DESC`
		)
		.all(cardId, cardId) as TokenEntry[];
}

/**
 * Board totals, for the boards list.
 *
 * Boards with nothing recorded are absent from the map rather than present with
 * a zero, for the same reason as cards.
 */
export function getBoardTokenTotals(
	boardIds: number[]
): Map<number, { total: number; entries: number; costUsd: number | null; unpricedTokens: number }> {
	const out = new Map<number, { total: number; entries: number; costUsd: number | null; unpricedTokens: number }>();
	if (boardIds.length === 0) return out;

	const placeholders = boardIds.map(() => '?').join(',');
	const rows = sqlite
		.prepare(
			`SELECT board_id AS boardId, SUM(tokens) AS total, SUM(entries) AS entries
			 FROM (
			   SELECT co.board_id AS board_id, SUM(tu.tokens) AS tokens, COUNT(*) AS entries
			     FROM token_usage tu
			     JOIN cards c   ON c.id = tu.card_id
			     JOIN columns co ON co.id = c.column_id
			    WHERE co.board_id IN (${placeholders}) AND c.archived_at IS NULL
			    GROUP BY co.board_id
			   UNION ALL
			   SELECT co.board_id AS board_id, SUM(tu.tokens) AS tokens, COUNT(*) AS entries
			     FROM token_usage tu
			     JOIN subtasks s ON s.id = tu.subtask_id
			     JOIN cards c    ON c.id = s.card_id
			     JOIN columns co ON co.id = c.column_id
			    WHERE co.board_id IN (${placeholders}) AND c.archived_at IS NULL
			    GROUP BY co.board_id
			 )
			 GROUP BY board_id`
		)
		.all(...boardIds, ...boardIds) as { boardId: number; total: number; entries: number }[];

	for (const r of rows) {
		if ((r.entries ?? 0) > 0) {
			out.set(r.boardId, { total: r.total ?? 0, entries: r.entries, costUsd: null, unpricedTokens: 0 });
		}
	}

	// Per-board cost, grouped by model so each family is priced at its own rate,
	// and by how each entry is priced (PRICED_AS) so it agrees with every card's.
	const costRows = sqlite
		.prepare(
			`SELECT co.board_id           AS boardId,
			        tu.model              AS model,
			        ${PRICED_AS}          AS pricedAs,
			        SUM(tu.tokens)        AS tokens,
			        SUM(tu.input_tokens)  AS inputTokens,
			        SUM(tu.output_tokens) AS outputTokens,
			        SUM(tu.cache_read_tokens)     AS cacheReadTokens,
			        SUM(tu.cache_write_5m_tokens) AS cw5m,
			        SUM(tu.cache_write_1h_tokens) AS cw1h
			   FROM token_usage tu
			   LEFT JOIN subtasks s ON s.id = tu.subtask_id
			   JOIN cards c    ON c.id = COALESCE(tu.card_id, s.card_id)
			   JOIN columns co ON co.id = c.column_id
			  WHERE co.board_id IN (${placeholders}) AND c.archived_at IS NULL
			  GROUP BY co.board_id, tu.model, pricedAs`
		)
		.all(...boardIds) as (PricedGroup & { boardId: number })[];

	const byBoard = new Map<number, typeof costRows>();
	for (const r of costRows) {
		if (!byBoard.has(r.boardId)) byBoard.set(r.boardId, []);
		byBoard.get(r.boardId)!.push(r);
	}
	for (const [boardId, rows2] of byBoard) {
		const existing = out.get(boardId);
		if (!existing) continue;
		const cost = costOf(rows2.map(groupCostInput));
		existing.costUsd = cost.usd;
		existing.unpricedTokens = cost.unpricedTokens;
	}
	return out;
}

export type SpendPeriod = 'today' | 'week' | 'month' | 'year' | 'all';

export interface UserSpendRow {
	userId: number | null;
	username: string;
	emoji: string;
	tokens: number;
	costUsd: number | null;
	entries: number;
	/**
	 * This person's spend split by model, largest first. The split is the whole
	 * point of recording the model: the same token count on Opus and on Haiku is
	 * very different money, so a person's total says little without it.
	 */
	/** Round trips behind this person's figure, or null when unrecorded. */
	apiCalls: number | null;
	byModel: {
		model: string;
		tokens: number;
		costUsd: number | null;
		/** Round trips for this model. Total = calls x context size. */
		apiCalls: number | null;
		/** True when this model's whole figure came from measured breakdowns. */
		exact: boolean;
		/** The components, so a reader can see *why* the cost is what it is. */
		input: number;
		output: number;
		cacheRead: number;
		cacheWrite5m: number;
		cacheWrite1h: number;
	}[];
}

/**
 * Per-person spend for each time window, from one query.
 *
 * Five windows rather than five queries: the rows come back grouped by user,
 * model and day, and are bucketed here. Grouping by day is what bounds the row
 * count — it cannot grow with the number of entries, only with users x models x
 * days active.
 *
 * Boundaries are calendar periods in the server's local time, converted to the
 * UTC string form the ledger stores. Calendar rather than rolling windows
 * because a fixed-price plan renews on a calendar month, so "this month" is the
 * comparison that actually means something.
 */
export function getUserSpendByPeriod(
	boardIds: number[]
): Record<SpendPeriod, UserSpendRow[]> {
	const empty: Record<SpendPeriod, UserSpendRow[]> = {
		today: [], week: [], month: [], year: [], all: []
	};
	if (boardIds.length === 0) return empty;

	const placeholders = boardIds.map(() => '?').join(',');
	const rows = sqlite
		.prepare(
			`SELECT tu.reported_by_user_id  AS userId,
			        u.username              AS username,
			        u.emoji                 AS emoji,
			        tu.model                AS model,
			        date(tu.created_at)     AS day,
			        SUM(tu.tokens)          AS tokens,
			        SUM(tu.input_tokens)    AS inputTokens,
			        SUM(tu.output_tokens)   AS outputTokens,
			        SUM(tu.cache_read_tokens)     AS cacheReadTokens,
			        SUM(tu.cache_write_5m_tokens) AS cw5m,
			        SUM(tu.cache_write_1h_tokens) AS cw1h,
			        SUM(tu.api_calls)       AS apiCalls,
			        COUNT(tu.api_calls)     AS withCalls,
			        COUNT(*)                AS n,
			        ${PRICED_AS}            AS pricedAs
			   FROM token_usage tu
			   LEFT JOIN subtasks s ON s.id = tu.subtask_id
			   JOIN cards c    ON c.id = COALESCE(tu.card_id, s.card_id)
			   JOIN columns co ON co.id = c.column_id
			   LEFT JOIN users u ON u.id = tu.reported_by_user_id
			  WHERE co.board_id IN (${placeholders}) AND c.archived_at IS NULL
			  GROUP BY tu.reported_by_user_id, tu.model, date(tu.created_at), pricedAs`
		)
		.all(...boardIds) as (PricedGroup & {
		userId: number | null; username: string | null; emoji: string | null;
		day: string; apiCalls: number | null; withCalls: number; n: number;
	})[];

	// `date()` yields YYYY-MM-DD, so a plain string compare is a date compare.
	const localStart = (d: Date) => {
		const z = new Date(d.getFullYear(), d.getMonth(), d.getDate());
		return `${z.getFullYear()}-${String(z.getMonth() + 1).padStart(2, '0')}-${String(z.getDate()).padStart(2, '0')}`;
	};
	const now = new Date();
	const startOfToday = localStart(now);
	// Week starts Monday — the working week, not the American Sunday.
	const dow = (now.getDay() + 6) % 7;
	const startOfWeek = localStart(new Date(now.getFullYear(), now.getMonth(), now.getDate() - dow));
	const startOfMonth = `${now.getFullYear()}-${String(now.getMonth() + 1).padStart(2, '0')}-01`;
	const startOfYear = `${now.getFullYear()}-01-01`;

	const bounds: Record<SpendPeriod, string> = {
		today: startOfToday, week: startOfWeek, month: startOfMonth, year: startOfYear, all: ''
	};

	const out = {} as Record<SpendPeriod, UserSpendRow[]>;
	for (const period of Object.keys(bounds) as SpendPeriod[]) {
		const cutoff = bounds[period];
		const inWindow = cutoff ? rows.filter((r) => r.day >= cutoff) : rows;

		const byUser = new Map<number | null, typeof inWindow>();
		for (const r of inWindow) {
			if (!byUser.has(r.userId)) byUser.set(r.userId, []);
			byUser.get(r.userId)!.push(r);
		}

		const list: UserSpendRow[] = [];
		for (const [userId, group] of byUser) {
			const cost = costOf(group.map(groupCostInput));
			// Same person, same model, several days (and ways of pricing) — fold them
			// together. The cost is the sum of each group's, priced as it is above.
			const modelGroups = new Map<string, typeof group>();
			for (const r of group) {
				const key = r.model ?? 'unspecified';
				if (!modelGroups.has(key)) modelGroups.set(key, []);
				modelGroups.get(key)!.push(r);
			}
			const sum = (rs: typeof group, f: (r: (typeof group)[number]) => number | null) =>
				rs.reduce((acc, r) => acc + (f(r) ?? 0), 0);
			const byModel = [...modelGroups.entries()]
				.map(([model, rs]) => {
					const calls = sum(rs, (r) => r.apiCalls);
					return {
						model,
						tokens: sum(rs, (r) => r.tokens),
						// The whole figure came from measured breakdowns.
						exact: rs.every((r) => r.pricedAs === 'measured'),
						apiCalls: rs.every((r) => r.withCalls === r.n) && calls > 0 ? calls : null,
						input: sum(rs, (r) => r.inputTokens),
						output: sum(rs, (r) => r.outputTokens),
						cacheRead: sum(rs, (r) => r.cacheReadTokens),
						cacheWrite5m: sum(rs, (r) => r.cw5m),
						cacheWrite1h: sum(rs, (r) => r.cw1h),
						costUsd: costOf(rs.map(groupCostInput)).usd
					};
				})
				.sort((a, b) => b.tokens - a.tokens);

			list.push({
				userId,
				username: group[0].username ?? 'Deleted user',
				emoji: group[0].emoji ?? '👤',
				tokens: group.reduce((sum, r) => sum + r.tokens, 0),
				costUsd: cost.usd,
				entries: group.reduce((sum, r) => sum + r.n, 0),
				apiCalls: group.every((r) => r.withCalls === r.n)
					? group.reduce((sum, r) => sum + (r.apiCalls ?? 0), 0) || null
					: null,
				byModel
			});
		}
		out[period] = list.sort((a, b) => b.tokens - a.tokens);
	}
	return out;
}

// Formatting lives in `$lib/tokens` so the browser can use it too — the boards
// list and the card modal both render these figures.
export { formatTokens } from '$lib/tokens';
