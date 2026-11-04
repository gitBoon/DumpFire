import { json } from '@sveltejs/kit';
import { readCardDecisions } from '$lib/server/decision-cards';
import { pathId } from '$lib/server/request-body';
import { requireUser } from '$lib/server/route-guards';
import type { RequestHandler } from './$types';

/**
 * GET /api/cards/:id/decisions — the decisions linked to a card, as its card
 * window lists them (card 2680, decisions 18 and 23): refused as the card is
 * refused to the caller (`requireCard(…, 'view')`), then only the decisions
 * the caller may view, with no count of the rest. Read only.
 */
export const GET: RequestHandler = async ({ params, locals }) => {
	const user = requireUser(locals.user);
	const cardId = pathId(params.id, 'card');
	return json(readCardDecisions(user, cardId, { source: 'ui' }));
};
