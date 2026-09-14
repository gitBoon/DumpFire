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
import { tokenUsage, subtasks, cards, columns } from './db/schema';
import { eq, inArray } from 'drizzle-orm';
import { canEditBoard } from './board-access';
import { getCardBoardId, getSubtaskCardId } from './work-access';
import type { SessionUser } from './auth';
import { costOf } from '$lib/pricing';

/** A single entry is capped well above any real turn, to catch a fat-fingered paste. */
export const MAX_TOKENS_PER_ENTRY = 100_000_000;
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
}

const EMPTY: TokenTotal = {
	total: 0, direct: 0, fromSubtasks: 0, entries: 0, byModel: [],
	costUsd: null, costExact: false, unpricedTokens: 0
};

/** A total with no entries behind it. Callers render this as "—". */
export function emptyTotal(): TokenTotal {
	return { ...EMPTY, byModel: [] };
}

// ─── Recording ───────────────────────────────────────────────────────────────

function validateAmount(tokens: unknown): number {
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
				'Report the usage for this step, not a running total.'
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

/**
 * An optional exact input/output split.
 *
 * Both halves or neither: one without the other cannot be costed and would
 * silently behave as if the missing half were zero. When present they must
 * agree with the total, because a split that contradicts it means the caller
 * has sent two different claims about the same work.
 */
function validateSplit(
	total: number,
	input: unknown,
	output: unknown
): { inputTokens: number | null; outputTokens: number | null } {
	const hasIn = input !== undefined && input !== null;
	const hasOut = output !== undefined && output !== null;
	if (!hasIn && !hasOut) return { inputTokens: null, outputTokens: null };
	if (hasIn !== hasOut) {
		throw new TokenError(400, 'inputTokens and outputTokens must be given together, or not at all');
	}
	const i = Number(input);
	const o = Number(output);
	if (!Number.isInteger(i) || !Number.isInteger(o)) {
		throw new TokenError(400, 'inputTokens and outputTokens must be whole numbers');
	}
	if (i + o !== total) {
		throw new TokenError(
			400,
			`inputTokens + outputTokens (${i + o}) must equal tokens (${total})`
		);
	}
	return { inputTokens: i, outputTokens: o };
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
	tokens: number,
	model?: unknown,
	note?: unknown,
	inputTokens?: unknown,
	outputTokens?: unknown
): RecordResult {
	const amount = validateAmount(tokens);
	const modelName = clean(model, MAX_MODEL_LEN, 'model');
	const noteText = clean(note, MAX_NOTE_LEN, 'note');
	const split = validateSplit(amount, inputTokens, outputTokens);
	const boardId = resolveTarget(user, target);

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
	inputTokens?: unknown;
	outputTokens?: unknown;
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
	const prepared: {
		target: TokenTarget;
		tokens: number;
		model: string | null;
		note: string | null;
		split: { inputTokens: number | null; outputTokens: number | null };
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
			const tokens = validateAmount(e.tokens);
			const model = clean(e.model, MAX_MODEL_LEN, 'model');
			const note = clean(e.note, MAX_NOTE_LEN, 'note');
			const split = validateSplit(tokens, e.inputTokens, e.outputTokens);
			const boardId = resolveTarget(user, target);
			const cardId = target.kind === 'card' ? target.id : getSubtaskCardId(target.id)!;
			prepared.push({ target, tokens, model, note, split, boardId, cardId });
		} catch (err) {
			problems.push({ index, reason: err instanceof TokenError ? err.message : String(err) });
		}
	});

	if (problems.length > 0) return { written: 0, problems, boardIds: [], cardIds: [] };

	sqlite.transaction(() => {
		for (const p of prepared) {
			db.insert(tokenUsage)
				.values({
					cardId: p.target.kind === 'card' ? p.target.id : null,
					subtaskId: p.target.kind === 'subtask' ? p.target.id : null,
					tokens: p.tokens,
					model: p.model,
					inputTokens: p.split.inputTokens,
					outputTokens: p.split.outputTokens,
					note: p.note,
					reportedByUserId: user.id
				})
				.run();
		}
	})();

	return {
		written: prepared.length,
		problems: [],
		boardIds: [...new Set(prepared.map((p) => p.boardId))],
		cardIds: [...new Set(prepared.map((p) => p.cardId))]
	};
}

/** Remove one entry outright. For a correction prefer a negative entry. */
export function deleteTokenEntry(user: SessionUser, entryId: number): { cardId: number; boardId: number } {
	const entry = db.select().from(tokenUsage).where(eq(tokenUsage.id, entryId)).get();
	if (!entry) throw new TokenError(404, `Token entry #${entryId} does not exist`);

	const target: TokenTarget = entry.cardId
		? { kind: 'card', id: entry.cardId }
		: { kind: 'subtask', id: entry.subtaskId! };
	const boardId = resolveTarget(user, target);
	const cardId = entry.cardId ?? getSubtaskCardId(entry.subtaskId!)!;

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
			unpricedTokens: 0
		});
	}

	// Cost needs per-model figures, which the totals query deliberately does not
	// carry. One extra grouped query covers the whole batch rather than one per
	// card, which matters on a dashboard listing every board.
	const costRows = sqlite
		.prepare(
			`SELECT COALESCE(tu.card_id, s.card_id) AS cardId,
			        tu.model                        AS model,
			        SUM(tu.tokens)                  AS tokens,
			        SUM(tu.input_tokens)            AS inputTokens,
			        SUM(tu.output_tokens)           AS outputTokens,
			        COUNT(*)                        AS n,
			        COUNT(tu.input_tokens)          AS withSplit
			   FROM token_usage tu
			   LEFT JOIN subtasks s ON s.id = tu.subtask_id
			  WHERE COALESCE(tu.card_id, s.card_id) IN (${placeholders})
			  GROUP BY COALESCE(tu.card_id, s.card_id), tu.model`
		)
		.all(...cardIds) as {
		cardId: number; model: string | null; tokens: number;
		inputTokens: number | null; outputTokens: number | null;
		n: number; withSplit: number;
	}[];

	const byCard = new Map<number, typeof costRows>();
	for (const r of costRows) {
		if (!byCard.has(r.cardId)) byCard.set(r.cardId, []);
		byCard.get(r.cardId)!.push(r);
	}
	for (const [cardId, rows2] of byCard) {
		const existing = out.get(cardId);
		if (!existing) continue;
		const cost = costOf(
			rows2.map((r) => ({
				tokens: r.tokens,
				model: r.model,
				// Only trust the summed split when EVERY entry in the group had one;
				// a partial sum would understate the tokens it covers.
				inputTokens: r.withSplit === r.n ? r.inputTokens : null,
				outputTokens: r.withSplit === r.n ? r.outputTokens : null
			}))
		);
		existing.costUsd = cost.usd;
		existing.costExact = cost.exact;
		existing.unpricedTokens = cost.unpricedTokens;
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
	// the rest falls back to the blend.
	const cost = costOf(
		getCardTokenEntries(cardId).map((e) => ({
			tokens: e.tokens,
			model: e.model,
			inputTokens: e.inputTokens,
			outputTokens: e.outputTokens
		}))
	);

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

	// Per-board cost, grouped by model so each family is priced at its own rate.
	const costRows = sqlite
		.prepare(
			`SELECT co.board_id           AS boardId,
			        tu.model              AS model,
			        SUM(tu.tokens)        AS tokens,
			        SUM(tu.input_tokens)  AS inputTokens,
			        SUM(tu.output_tokens) AS outputTokens,
			        COUNT(*)              AS n,
			        COUNT(tu.input_tokens) AS withSplit
			   FROM token_usage tu
			   LEFT JOIN subtasks s ON s.id = tu.subtask_id
			   JOIN cards c    ON c.id = COALESCE(tu.card_id, s.card_id)
			   JOIN columns co ON co.id = c.column_id
			  WHERE co.board_id IN (${placeholders}) AND c.archived_at IS NULL
			  GROUP BY co.board_id, tu.model`
		)
		.all(...boardIds) as {
		boardId: number; model: string | null; tokens: number;
		inputTokens: number | null; outputTokens: number | null;
		n: number; withSplit: number;
	}[];

	const byBoard = new Map<number, typeof costRows>();
	for (const r of costRows) {
		if (!byBoard.has(r.boardId)) byBoard.set(r.boardId, []);
		byBoard.get(r.boardId)!.push(r);
	}
	for (const [boardId, rows2] of byBoard) {
		const existing = out.get(boardId);
		if (!existing) continue;
		const cost = costOf(
			rows2.map((r) => ({
				tokens: r.tokens,
				model: r.model,
				inputTokens: r.withSplit === r.n ? r.inputTokens : null,
				outputTokens: r.withSplit === r.n ? r.outputTokens : null
			}))
		);
		existing.costUsd = cost.usd;
		existing.unpricedTokens = cost.unpricedTokens;
	}
	return out;
}

/** Total across one milestone's cards, for the planning view. */
export function getMilestoneTokenTotal(milestoneId: number): { total: number; entries: number } {
	const memberIds = db
		.select({ id: cards.id })
		.from(cards)
		.where(eq(cards.milestoneId, milestoneId))
		.all()
		.map((c) => c.id);

	if (memberIds.length === 0) return { total: 0, entries: 0 };

	let total = 0;
	let entries = 0;
	for (const t of getCardTokenTotals(memberIds).values()) {
		total += t.total;
		entries += t.entries;
	}
	return { total, entries };
}

// Formatting lives in `$lib/tokens` so the browser can use it too — the boards
// list and the card modal both render these figures.
export { formatTokens } from '$lib/tokens';
