import { json } from '$lib/server/v1-json';
import { recordTokens } from '$lib/server/token-service';
import { pathId, readBody } from '$lib/server/request-body';
import { requireUser } from '$lib/server/route-guards';
import { writeAs } from '$lib/server/write-as';
import type { RequestHandler } from './$types';

/**
 * POST /api/v1/subtasks/:subtaskId/tokens — add to what this step cost.
 *
 * Body: `{ "tokens": 9100, "model": "claude-sonnet-5", "note": "verification" }`
 *
 * The natural place to report: a subtask is one step, so its cost is known the
 * moment it is ticked. Subtask entries roll up into the parent card, so a card
 * whose work is fully broken into subtasks needs no direct entry of its own.
 *
 * The response returns the parent card's running total, not the subtask's, so
 * a caller ticking off steps sees the figure that actually matters climbing.
 *
 * The work is `recordTokens` in `$lib/server/token-service`, which the card
 * route shares (card 2012).
 */
export const POST: RequestHandler = async ({ params, request, locals }) => {
	requireUser(locals.user);

	const subtaskId = pathId(params.subtaskId, 'subtask');

	// The fields are held to tokens.ts's own rules, which recordTokenUsage
	// reads, and to nothing stricter (card 2117, R10).
	const body = await readBody(request);

	// The caller checked, the sums read and the entry written in one
	// transaction that asks first whether the key or session is still open,
	// and who its account is now (card 2253). The board is told once it has
	// committed.
	const result = writeAs(locals, (caller) => recordTokens(caller, { kind: 'subtask', id: subtaskId }, body, { source: 'api' }));
	return json(
		{
			entryId: result.entryId,
			subtaskId,
			cardId: result.cardId,
			cardTotal: result.total.total,
			recorded: result.total.entries > 0,
			entries: result.total.entries
		},
		{ status: 201 }
	);
};
