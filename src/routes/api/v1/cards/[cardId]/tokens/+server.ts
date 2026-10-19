import { error } from '@sveltejs/kit';
import { json } from '$lib/server/v1-json';
import { readCardTokens, recordTokens } from '$lib/server/token-service';
import { pathId, readBody } from '$lib/server/request-body';
import { requireUser } from '$lib/server/route-guards';
import { writeAs } from '$lib/server/write-as';
import type { RequestHandler } from './$types';

/**
 * GET /api/v1/cards/:cardId/tokens — what this card has cost so far.
 *
 * `entries: 0` means **nothing has been recorded**, which is not the same as a
 * recorded zero. Every card that predates this feature is in that state and
 * must be shown as "—" rather than "0 tokens".
 *
 * The read is `readCardTokens` in `$lib/server/token-service`, which the
 * internal route shares (card 2012).
 */
export const GET: RequestHandler = async ({ params, locals }) => {
	if (!locals.user) throw error(401, 'Not authenticated');

	const cardId = pathId(params.cardId, 'card');
	return json(readCardTokens(locals.user, { cardId }, {}));
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
 *
 * The work is `recordTokens` in `$lib/server/token-service`, which the
 * subtask route shares (card 2012).
 */
export const POST: RequestHandler = async ({ params, request, locals }) => {
	requireUser(locals.user);

	const cardId = pathId(params.cardId, 'card');

	// The fields are held to tokens.ts's own rules, which recordTokenUsage
	// reads, and to nothing stricter (card 2117, R10).
	const body = await readBody(request);

	// The caller checked, the sums read and the entry written in one
	// transaction that asks first whether the key or session is still open,
	// and who its account is now (card 2253). The board is told once it has
	// committed.
	const result = writeAs(locals, (caller) => recordTokens(caller, { kind: 'card', id: cardId }, body, { source: 'api' }));
	return json(
		{
			entryId: result.entryId,
			cardId: result.cardId,
			recorded: result.total.entries > 0,
			...result.total
		},
		{ status: 201 }
	);
};
