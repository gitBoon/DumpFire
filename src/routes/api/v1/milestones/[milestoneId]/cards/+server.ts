import { json, error } from '@sveltejs/kit';
import { setCardMilestone, requireMilestone, MilestoneError } from '$lib/server/milestones';
import { emit } from '$lib/server/events';
import type { RequestHandler } from './$types';

/**
 * POST /api/v1/milestones/:milestoneId/cards — put a card in this milestone.
 *
 * Body: `{ cardId }`. A card belongs to at most one milestone, so this replaces
 * whatever it was in before rather than erroring.
 */
export const POST: RequestHandler = async ({ params, request, locals }) => {
	if (!locals.user) throw error(401, 'Not authenticated');

	const milestoneId = Number(params.milestoneId);
	if (isNaN(milestoneId)) throw error(400, 'Invalid milestone ID');

	const { cardId } = await request.json();
	if (!cardId) throw error(400, 'cardId is required');

	try {
		const result = setCardMilestone(locals.user, Number(cardId), milestoneId);
		emit(result.boardId, 'update', { type: 'card' });
		return json(result);
	} catch (e) {
		if (e instanceof MilestoneError) throw error(e.status, e.message);
		throw e;
	}
};

/**
 * DELETE /api/v1/milestones/:milestoneId/cards — take a card out of this milestone.
 *
 * Body: `{ cardId }`. The card itself is untouched.
 */
export const DELETE: RequestHandler = async ({ params, request, locals }) => {
	if (!locals.user) throw error(401, 'Not authenticated');

	const milestoneId = Number(params.milestoneId);
	if (isNaN(milestoneId)) throw error(400, 'Invalid milestone ID');

	const { cardId } = await request.json();
	if (!cardId) throw error(400, 'cardId is required');

	try {
		// Checked so removing a card still proves you could see the goal it was in.
		requireMilestone(locals.user, milestoneId, true);
		const result = setCardMilestone(locals.user, Number(cardId), null);
		emit(result.boardId, 'update', { type: 'card' });
		return json(result);
	} catch (e) {
		if (e instanceof MilestoneError) throw error(e.status, e.message);
		throw e;
	}
};
