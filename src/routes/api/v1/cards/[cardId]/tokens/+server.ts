import { error } from '@sveltejs/kit';
import { json } from '$lib/server/v1-json';
import {
	recordTokenUsage,
	getCardTokenTotal,
	getCardTokenEntries,
	TokenError
} from '$lib/server/tokens';
import { getCardBoardId } from '$lib/server/work-access';
import { canViewBoard } from '$lib/server/board-access';
import { emit } from '$lib/server/events';
import { pathId, readBody } from '$lib/server/request-body';
import { requireUser } from '$lib/server/route-guards';
import { writeAs } from '$lib/server/write-as';
import type { RequestHandler } from './$types';

function handle(e: unknown): never {
	if (e instanceof TokenError) throw error(e.status, e.message);
	throw e;
}

/**
 * GET /api/v1/cards/:cardId/tokens — what this card has cost so far.
 *
 * `entries: 0` means **nothing has been recorded**, which is not the same as a
 * recorded zero. Every card that predates this feature is in that state and
 * must be shown as "—" rather than "0 tokens".
 */
export const GET: RequestHandler = async ({ params, locals }) => {
	if (!locals.user) throw error(401, 'Not authenticated');

	const cardId = pathId(params.cardId, 'card');

	const boardId = getCardBoardId(cardId);
	if (boardId === null) throw error(404, 'Card not found');
	if (!canViewBoard(locals.user, boardId)) throw error(403, 'No access to this board');

	const total = getCardTokenTotal(cardId);
	return json({
		cardId,
		recorded: total.entries > 0,
		...total,
		entryList: getCardTokenEntries(cardId)
	});
};

/**
 * POST /api/v1/cards/:cardId/tokens — add to what this card has cost.
 *
 * Body: `{ "tokens": 52900, "model": "claude-opus-5", "note": "applied the fix" }`
 *
 * Additive, never a replacement: call it as you go and the total climbs toward
 * completion. Two agents on the same card can each report their own usage
 * without having to know what the other spent. To correct an over-report, send
 * a negative `tokens` rather than trying to overwrite — the original stays in
 * the history where it can be seen.
 */
export const POST: RequestHandler = async ({ params, request, locals }) => {
	requireUser(locals.user);

	const cardId = pathId(params.cardId, 'card');

	// The fields are held to tokens.ts's own rules, which recordTokenUsage
	// reads, and to nothing stricter (card 2117, R10).
	const body = await readBody(request);
	try {
		// The caller checked, the sums read and the entry written in one
		// transaction that asks first whether the key or session is still open,
		// and who its account is now (card 2253). They were separate steps with
		// no transaction around them. A refusal is no TokenError, and `handle`
		// passes it on as it is.
		const result = writeAs(locals, (caller) =>
			recordTokenUsage(
				requireUser(caller),
				{ kind: 'card', id: cardId },
				body.tokens,
				body.model,
				body.note,
				{
					apiCalls: body.apiCalls,
					inputTokens: body.inputTokens,
					outputTokens: body.outputTokens,
					cacheReadTokens: body.cacheReadTokens,
					cacheWrite5mTokens: body.cacheWrite5mTokens,
					cacheWrite1hTokens: body.cacheWrite1hTokens
				}
			)
		);
		emit(result.boardId, 'update', { type: 'card' });
		return json(
			{
				entryId: result.entryId,
				cardId: result.cardId,
				recorded: result.total.entries > 0,
				...result.total
			},
			{ status: 201 }
		);
	} catch (e) {
		handle(e);
	}
};
