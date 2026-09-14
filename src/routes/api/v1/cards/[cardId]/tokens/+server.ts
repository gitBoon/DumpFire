import { json, error } from '@sveltejs/kit';
import {
	recordTokenUsage,
	getCardTokenTotal,
	getCardTokenEntries,
	TokenError
} from '$lib/server/tokens';
import { getCardBoardId } from '$lib/server/work-access';
import { canViewBoard } from '$lib/server/board-access';
import { emit } from '$lib/server/events';
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

	const cardId = Number(params.cardId);
	if (isNaN(cardId)) throw error(400, 'Invalid card ID');

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
	if (!locals.user) throw error(401, 'Not authenticated');

	const cardId = Number(params.cardId);
	if (isNaN(cardId)) throw error(400, 'Invalid card ID');

	const body = await request.json();
	try {
		const result = recordTokenUsage(
			locals.user,
			{ kind: 'card', id: cardId },
			body.tokens,
			body.model,
			body.note
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
