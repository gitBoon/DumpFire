import { json, error } from '@sveltejs/kit';
import { recordTokenUsage, TokenError } from '$lib/server/tokens';
import { emit } from '$lib/server/events';
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
	if (!locals.user) throw error(401, 'Not authenticated');

	const subtaskId = Number(params.subtaskId);
	if (isNaN(subtaskId)) throw error(400, 'Invalid subtask ID');

	const body = await request.json();
	try {
		const result = recordTokenUsage(
			locals.user,
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
