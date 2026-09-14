import { json, error } from '@sveltejs/kit';
import { getCardTokenTotal, getCardTokenEntries } from '$lib/server/tokens';
import { getCardBoardId } from '$lib/server/work-access';
import { canViewBoard } from '$lib/server/board-access';
import type { RequestHandler } from './$types';

/**
 * GET /api/cards/:id/tokens — the card modal's cost block.
 *
 * The internal twin of `/api/v1/cards/:id/tokens`. It exists because the `/api/v1`
 * namespace requires a `Bearer` API key (see hooks.server.ts) and the browser
 * carries a session cookie instead — so the UI cannot call the v1 route at all.
 * Same split as `/api/milestones` and `/api/subtasks/:id/dependencies`.
 *
 * Read-only on purpose: recording cost is a reporting act that belongs to
 * whatever actually observed the usage, not to someone clicking around a card.
 */
export const GET: RequestHandler = async ({ params, locals }) => {
	if (!locals.user) throw error(401, 'Not authenticated');

	const cardId = Number(params.id);
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
