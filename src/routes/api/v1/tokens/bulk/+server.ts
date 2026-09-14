import { json, error } from '@sveltejs/kit';
import { recordTokenUsageBatch, getCardTokenTotals, TokenError } from '$lib/server/tokens';
import { emit } from '$lib/server/events';
import type { RequestHandler } from './$types';

/**
 * POST /api/v1/tokens/bulk — report many token entries at once.
 *
 * Body:
 * ```json
 * { "entries": [
 *     { "cardId": 1713,    "tokens": 18400, "model": "claude-opus-5", "note": "planning" },
 *     { "subtaskId": 3471, "tokens":  9100, "model": "claude-sonnet-5" }
 * ] }
 * ```
 *
 * Each entry sets exactly one of `cardId` / `subtaskId`. Validated as a whole
 * and all-or-nothing, like the dependency and milestone batches: if any entry
 * is bad, nothing is written and every problem comes back at once, so a long
 * list is fixed in one round trip rather than one error at a time.
 *
 * Unlike those batches this one is **not** idempotent — entries are additive by
 * design, so re-running the same list genuinely does add the tokens twice.
 * Report each step once.
 */
export const POST: RequestHandler = async ({ request, locals }) => {
	if (!locals.user) throw error(401, 'Not authenticated');

	const body = await request.json();
	try {
		const result = recordTokenUsageBatch(locals.user, body.entries);

		if (result.problems.length > 0) {
			return json(
				{
					error: 'Batch rejected — nothing was written',
					written: 0,
					problems: result.problems
				},
				{ status: 409 }
			);
		}

		for (const boardId of result.boardIds) emit(boardId, 'update', { type: 'card' });

		const totals = getCardTokenTotals(result.cardIds);
		return json(
			{
				written: result.written,
				boardsTouched: result.boardIds,
				cardTotals: result.cardIds.map((id) => ({
					cardId: id,
					total: totals.get(id)?.total ?? 0,
					entries: totals.get(id)?.entries ?? 0
				}))
			},
			{ status: 201 }
		);
	} catch (e) {
		if (e instanceof TokenError) throw error(e.status, e.message);
		throw e;
	}
};
