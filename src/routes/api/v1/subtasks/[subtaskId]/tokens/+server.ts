import { error } from '@sveltejs/kit';
import { json } from '$lib/server/v1-json';
import { recordTokenUsage, TokenError } from '$lib/server/tokens';
import { emit } from '$lib/server/events';
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
 */
export const POST: RequestHandler = async ({ params, request, locals }) => {
	requireUser(locals.user);

	const subtaskId = pathId(params.subtaskId, 'subtask');

	// The fields are held to tokens.ts's own rules, which recordTokenUsage
	// reads, and to nothing stricter (card 2117, R10).
	const body = await readBody(request);
	try {
		// The caller checked, the sums read and the entry written in one
		// transaction that asks first whether the key or session is still open,
		// and who its account is now (card 2253). They were separate steps with
		// no transaction around them. A refusal is no TokenError, and is passed
		// on as it is.
		const result = writeAs(locals, (caller) =>
			recordTokenUsage(
				requireUser(caller),
				{ kind: 'subtask', id: subtaskId },
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
				subtaskId,
				cardId: result.cardId,
				cardTotal: result.total.total,
				recorded: result.total.entries > 0,
				entries: result.total.entries
			},
			{ status: 201 }
		);
	} catch (e) {
		if (e instanceof TokenError) throw error(e.status, e.message);
		throw e;
	}
};
