import { error } from '@sveltejs/kit';
import { json } from '$lib/server/v1-json';
import { setCardMilestone, requireMilestone, takeCardOutOfMilestone, MilestoneError } from '$lib/server/milestones';
import { emit } from '$lib/server/events';
import { pathId, readBody, readId } from '$lib/server/request-body';
import { requireUser } from '$lib/server/route-guards';
import type { RequestHandler } from './$types';

/**
 * POST /api/v1/milestones/:milestoneId/cards — put a card in this milestone.
 *
 * Body: `{ cardId }`. A card belongs to at most one milestone, so this replaces
 * whatever it was in before rather than erroring. An archived card is refused,
 * as the batch refuses one.
 *
 * The milestone is looked for and the caller checked (404, then 403), then
 * `cardId` is read (400), then the card is looked for.
 */
export const POST: RequestHandler = async ({ params, request, locals }) => {
	const user = requireUser(locals.user);
	const milestoneId = pathId(params.milestoneId, 'milestone');
	const body = await readBody(request);

	try {
		requireMilestone(user, milestoneId, true);
		const cardId = readId(body, 'cardId', { required: true, says: { missing: 'cardId is required' } });
		const result = setCardMilestone(user, cardId, milestoneId);
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
 * Body: `{ cardId }`. The card itself is untouched. The milestone must be
 * there and the caller able to change it, and the card must be in it:
 * `404 Card is not in this milestone`. A card in another milestone used to be
 * taken out of that one.
 */
export const DELETE: RequestHandler = async ({ params, request, locals }) => {
	const user = requireUser(locals.user);
	const milestoneId = pathId(params.milestoneId, 'milestone');
	const body = await readBody(request);

	try {
		requireMilestone(user, milestoneId, true);
		const cardId = readId(body, 'cardId', { required: true, says: { missing: 'cardId is required' } });
		const result = takeCardOutOfMilestone(user, cardId, milestoneId);
		emit(result.boardId, 'update', { type: 'card' });
		return json(result);
	} catch (e) {
		if (e instanceof MilestoneError) throw error(e.status, e.message);
		throw e;
	}
};
