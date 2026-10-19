/**
 * token-service.ts — what a card's work has cost, read, and the ledger's
 * entries recorded, taken back and recorded in bulk: one function for each,
 * which the API's handlers call (card 2012, part A, slice A3).
 *
 * `GET /api/cards/:id/tokens` (the card window) and its twin `GET
 * /api/v1/cards/:cardId/tokens` read a card's cost word for word alike. The
 * writes are v1's alone, the internal tree being read-only on purpose:
 * `POST /api/v1/cards/:cardId/tokens`, `POST /api/v1/subtasks/:subtaskId/tokens`,
 * `DELETE /api/v1/tokens/:entryId` and `POST /api/v1/tokens/bulk`. Each had
 * its own copy of the body's fields, of the `TokenError` turned into its
 * status, and of the live update, which three of them sent after their
 * transaction (found nearby F16 of
 * `docs/planning/card-2012-service-layer-and-pages.md`). Here each is sent
 * inside the write, and waits for its commit, as every other write's does.
 *
 * The ledger itself stays in `tokens.ts` (`recordTokenUsage`,
 * `recordTokenUsageBatch`, `deleteTokenEntry` and the totals), which other
 * callers use and which is no service. Each write here has the one shape of
 * a service (`ServiceOptions` in `write-as.ts`): `inWrite()` first, then
 * `requireUser(caller)` (401), then what `tokens.ts` checks, in its order.
 * Refusals are kit `error()`s.
 */

import { error } from '@sveltejs/kit';
import type { SessionUser } from './auth';
import { canViewBoard } from './board-access';
import { emit } from './events';
import { readObjects, type RequestBody } from './request-body';
import { requireUser } from './route-guards';
import {
	deleteTokenEntry,
	getCardTokenEntries,
	getCardTokenTotal,
	getCardTokenTotals,
	recordTokenUsage,
	recordTokenUsageBatch,
	TokenError,
	type RecordResult,
	type TokenTarget,
	type TokenTotal
} from './tokens';
import { getCardBoardId } from './work-access';
import { inWrite, type ServiceOptions } from './write-as';

/** The functions here that only read. Every other export is a write, and starts with `inWrite()`. */
export const READS: readonly string[] = ['readCardTokens'];

/** A `TokenError` as the status and words it carries, as each route turned it; anything else as it is. */
function refused(e: unknown): never {
	if (e instanceof TokenError) throw error(e.status, e.message);
	throw e;
}

/**
 * What a card has cost so far, and its entries: `GET /api/cards/:id/tokens`
 * and `GET /api/v1/cards/:cardId/tokens`. The card is looked for and the
 * caller asked for view access (404, then 403). `entries: 0` means nothing
 * has been recorded, which is not a recorded zero (tokens.ts).
 */
export function readCardTokens(user: SessionUser, at: { cardId: number }, opts: { says?: string }) {
	const boardId = getCardBoardId(at.cardId);
	if (boardId === null) throw error(404, 'Card not found');
	if (!canViewBoard(user, boardId)) throw error(403, opts.says ?? 'No access to this board');

	const total = getCardTokenTotal(at.cardId);
	return {
		cardId: at.cardId,
		recorded: total.entries > 0,
		...total,
		entryList: getCardTokenEntries(at.cardId)
	};
}

/**
 * Add one entry to the ledger of the card or subtask `at`: `{ tokens, model,
 * note }` and the breakdown (`apiCalls`, `inputTokens`, `outputTokens`,
 * `cacheReadTokens`, `cacheWrite5mTokens`, `cacheWrite1hTokens`), each held
 * to tokens.ts's own rules and to nothing stricter (card 2117, R10). The
 * caller is checked, the sums read and the entry written in the caller's
 * transaction; the board is told once it has committed. Answers the entry,
 * and the card's running total.
 */
export function recordTokens(caller: SessionUser | null, at: TokenTarget, body: RequestBody, opts: ServiceOptions): RecordResult {
	inWrite();
	try {
		const result = recordTokenUsage(requireUser(caller), at, body.tokens, body.model, body.note, {
			apiCalls: body.apiCalls,
			inputTokens: body.inputTokens,
			outputTokens: body.outputTokens,
			cacheReadTokens: body.cacheReadTokens,
			cacheWrite5mTokens: body.cacheWrite5mTokens,
			cacheWrite1hTokens: body.cacheWrite1hTokens
		});
		emit(result.boardId, 'update', { type: 'card' });
		return result;
	} catch (e) {
		refused(e);
	}
}

/**
 * Remove one ledger entry outright: the entry read, the caller checked and
 * the entry removed in the caller's transaction, and the board told once it
 * has committed. Answers its card, and the card's total as it then is.
 */
export function removeTokenEntry(
	caller: SessionUser | null,
	at: { entryId: number },
	body: null,
	opts: ServiceOptions
): { cardId: number; total: TokenTotal } {
	inWrite();
	try {
		const { cardId, boardId } = deleteTokenEntry(requireUser(caller), at.entryId);
		emit(boardId, 'update', { type: 'card' });
		return { cardId, total: getCardTokenTotal(cardId) };
	} catch (e) {
		refused(e);
	}
}

/**
 * Record many entries at once, validated as a whole and all-or-nothing
 * (`recordTokenUsageBatch`): `entries`, a list of objects, each read after
 * the caller is asked for (`400 entries[<n>] must be an object`, decision
 * 18). Once for the whole batch, so a refusal writes none of it. Each board
 * written to is told once the batch has committed. Answers what the batch
 * did, its `problems` when it was refused, and, when it was not, each card's
 * total as it then is.
 */
export function recordTokenBatch(caller: SessionUser | null, at: Record<string, never>, body: RequestBody, opts: ServiceOptions) {
	inWrite();
	const user = requireUser(caller);
	const entries = readObjects(body, 'entries', {
		required: true,
		says: { missing: 'entries must be an array', type: 'entries must be an array' }
	});
	try {
		const recorded = recordTokenUsageBatch(user, entries);
		for (const boardId of recorded.boardIds) emit(boardId, 'update', { type: 'card' });
		const totals = recorded.problems.length > 0 ? new Map<number, TokenTotal>() : getCardTokenTotals(recorded.cardIds);
		return { ...recorded, totals };
	} catch (e) {
		refused(e);
	}
}
