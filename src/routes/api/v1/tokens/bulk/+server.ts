import { json } from '$lib/server/v1-json';
import { recordTokenBatch } from '$lib/server/token-service';
import { readBody } from '$lib/server/request-body';
import { requireUser } from '$lib/server/route-guards';
import { writeAs } from '$lib/server/write-as';
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
 *
 * The work is `recordTokenBatch` in `$lib/server/token-service` (card 2012),
 * which reads `entries` once the key or session has been asked for.
 */
export const POST: RequestHandler = async ({ request, locals }) => {
	requireUser(locals.user);
	const body = await readBody(request);

	// One transaction around the batch writer, which checks each entry's
	// card or subtask and the caller's access to it before it writes. With
	// those reads in the same transaction as the writes, what was checked is
	// what is written to. It asks first whether the key or session is still
	// open, and who its account is now (card 2253): once for the whole
	// batch, so a refusal writes none of it. Each board written to is told
	// once it has committed.
	const result = writeAs(locals, (caller) => recordTokenBatch(caller, {}, body, { source: 'api' }));

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

	const { totals } = result;
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
};
