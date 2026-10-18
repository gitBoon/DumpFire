import { error } from '@sveltejs/kit';
import { json } from '$lib/server/v1-json';
import { inTransaction } from '$lib/server/db/transaction';
import { recordTokenUsageBatch, getCardTokenTotals, TokenError } from '$lib/server/tokens';
import { emit } from '$lib/server/events';
import { readBody, readObjects } from '$lib/server/request-body';
import { requireUser } from '$lib/server/route-guards';
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
 *
 * `entries` is a list of objects: an entry that is not one is
 * `400 entries[<n>] must be an object` (decision 18), where it was a 500. Each
 * entry's fields are held to tokens.ts's own rules, and to nothing stricter.
 */
export const POST: RequestHandler = async ({ request, locals }) => {
	const user = requireUser(locals.user);
	const body = await readBody(request);
	const entries = readObjects(body, 'entries', {
		required: true,
		says: { missing: 'entries must be an array', type: 'entries must be an array' }
	});
	try {
		// One transaction around the batch writer, which checks each entry's
		// card or subtask and the caller's access to it before it writes. With
		// those reads in the same transaction as the writes, what was checked is
		// what is written to.
		const result = inTransaction(() => {
			const recorded = recordTokenUsageBatch(user, entries);
			for (const boardId of recorded.boardIds) emit(boardId, 'update', { type: 'card' });
			return recorded;
		});

		if (result.problems.length > 0) {
			return json(
				{
					message: 'Batch rejected — nothing was written',
					written: 0,
					problems: result.problems
				},
				{ status: 409 }
			);
		}

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
