import { json, error } from '@sveltejs/kit';
import { readCardTokens } from '$lib/server/token-service';
import { pathId } from '$lib/server/request-body';
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
 *
 * The read is `readCardTokens` in `$lib/server/token-service`, which the v1
 * route shares (card 2012).
 */
export const GET: RequestHandler = async ({ params, locals }) => {
	if (!locals.user) throw error(401, 'Not authenticated');

	const cardId = pathId(params.id, 'card');
	return json(readCardTokens(locals.user, { cardId }, {}));
};
