import { json, error } from '@sveltejs/kit';
import { db } from '$lib/server/db';
import { cards, columns } from '$lib/server/db/schema';
import { eq, and, isNull } from 'drizzle-orm';
import {
	requireMilestone,
	updateMilestone,
	deleteMilestone,
	MilestoneError
} from '$lib/server/milestones';
import type { RequestHandler } from './$types';

/** GET /api/v1/milestones/:milestoneId — the milestone and its cards. */
export const GET: RequestHandler = async ({ params, locals }) => {
	if (!locals.user) throw error(401, 'Not authenticated');

	const id = Number(params.milestoneId);
	if (isNaN(id)) throw error(400, 'Invalid milestone ID');

	try {
		const milestone = requireMilestone(locals.user, id);
		const memberCards = db
			.select({
				id: cards.id,
				title: cards.title,
				priority: cards.priority,
				columnId: cards.columnId,
				columnTitle: columns.title,
				boardId: columns.boardId
			})
			.from(cards)
			.innerJoin(columns, eq(cards.columnId, columns.id))
			.where(and(eq(cards.milestoneId, id), isNull(cards.archivedAt)))
			.all();

		return json({ ...milestone, cards: memberCards });
	} catch (e) {
		if (e instanceof MilestoneError) throw error(e.status, e.message);
		throw e;
	}
};

/** PATCH /api/v1/milestones/:milestoneId — update name/description/targetDate/status/boardId. */
export const PATCH: RequestHandler = async ({ params, request, locals }) => {
	if (!locals.user) throw error(401, 'Not authenticated');

	const id = Number(params.milestoneId);
	if (isNaN(id)) throw error(400, 'Invalid milestone ID');

	const body = await request.json();
	try {
		return json(updateMilestone(locals.user, id, body));
	} catch (e) {
		if (e instanceof MilestoneError) throw error(e.status, e.message);
		throw e;
	}
};

/**
 * DELETE /api/v1/milestones/:milestoneId — delete the goal, keep the work.
 *
 * The milestone's cards are released back to having no milestone; they are
 * never deleted. The response says how many were released.
 */
export const DELETE: RequestHandler = async ({ params, locals }) => {
	if (!locals.user) throw error(401, 'Not authenticated');

	const id = Number(params.milestoneId);
	if (isNaN(id)) throw error(400, 'Invalid milestone ID');

	try {
		const { released } = deleteMilestone(locals.user, id);
		return json({ success: true, cardsReleased: released });
	} catch (e) {
		if (e instanceof MilestoneError) throw error(e.status, e.message);
		throw e;
	}
};
