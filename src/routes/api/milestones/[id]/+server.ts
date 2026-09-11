/**
 * Session-authenticated milestone read/update/delete plus card assignment for
 * the planning view. Mirrors /api/v1/milestones/:milestoneId.
 */
import { json, error } from '@sveltejs/kit';
import {
	requireMilestone,
	updateMilestone,
	deleteMilestone,
	setCardMilestone,
	MilestoneError
} from '$lib/server/milestones';
import { emit } from '$lib/server/events';
import type { RequestHandler } from './$types';

export const GET: RequestHandler = async ({ params, locals }) => {
	if (!locals.user) throw error(401, 'Not authenticated');
	const id = Number(params.id);
	if (isNaN(id)) throw error(400, 'Invalid milestone ID');

	try {
		return json(requireMilestone(locals.user, id));
	} catch (e) {
		if (e instanceof MilestoneError) throw error(e.status, e.message);
		throw e;
	}
};

export const PATCH: RequestHandler = async ({ params, request, locals }) => {
	if (!locals.user) throw error(401, 'Not authenticated');
	const id = Number(params.id);
	if (isNaN(id)) throw error(400, 'Invalid milestone ID');

	const body = await request.json();
	try {
		// `cardId` in the body means "move this card in or out of the milestone",
		// which is what the card modal and the planning view both need most.
		if (body.cardId !== undefined) {
			const attach = body.attach !== false;
			const result = setCardMilestone(locals.user, Number(body.cardId), attach ? id : null);
			emit(result.boardId, 'update', { type: 'card' });
			return json(result);
		}
		return json(updateMilestone(locals.user, id, body));
	} catch (e) {
		if (e instanceof MilestoneError) throw error(e.status, e.message);
		throw e;
	}
};

export const DELETE: RequestHandler = async ({ params, locals }) => {
	if (!locals.user) throw error(401, 'Not authenticated');
	const id = Number(params.id);
	if (isNaN(id)) throw error(400, 'Invalid milestone ID');

	try {
		const { released } = deleteMilestone(locals.user, id);
		return json({ success: true, cardsReleased: released });
	} catch (e) {
		if (e instanceof MilestoneError) throw error(e.status, e.message);
		throw e;
	}
};
