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
import { pathId, readBody, readChoice, readDate, readId, readText } from '$lib/server/request-body';
import { requireUser } from '$lib/server/route-guards';
import { boardsOpenTo, WITHHELD_CARD_TITLE } from '$lib/server/planning';
import type { RequestHandler } from './$types';

/** What a milestone's `status` may be. */
const STATUSES = ['open', 'closed'] as const;

/**
 * GET /api/v1/milestones/:milestoneId — the milestone and its cards.
 *
 * A card on a board the caller cannot open is listed withheld, as the
 * summary lists it (card 2129): its id, with `withheld: true`, "A card on a
 * board you cannot open" for its title, an empty column title, and null for
 * its priority, column and board. A card moved off a board keeps that
 * board's milestone, so a viewer of the board was given the title and board
 * of a card on another.
 */
export const GET: RequestHandler = async ({ params, locals }) => {
	if (!locals.user) throw error(401, 'Not authenticated');

	const id = pathId(params.milestoneId, 'milestone');

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
		const opens = boardsOpenTo(locals.user);
		const shown = memberCards.map((card) =>
			opens(card.boardId)
				? { ...card, withheld: false }
				: { id: card.id, title: WITHHELD_CARD_TITLE, priority: null, columnId: null, columnTitle: '', boardId: null, withheld: true }
		);

		return json({ ...milestone, cards: shown });
	} catch (e) {
		if (e instanceof MilestoneError) throw error(e.status, e.message);
		throw e;
	}
};

/**
 * PATCH /api/v1/milestones/:milestoneId — update name/description/targetDate/status/boardId.
 *
 * The milestone is looked for and the caller checked (404, then 403), then
 * every field is read (400): `name` text, trimmed, of 1 to 200 characters;
 * `description` text of at most 50,000; `targetDate` a date written
 * `YYYY-MM-DD`, or null; `status` `open` or `closed`; `boardId` an id, or null
 * for a goal across boards. A value the milestone already holds, sent back
 * unchanged, is accepted as it is.
 */
export const PATCH: RequestHandler = async ({ params, request, locals }) => {
	const user = requireUser(locals.user);
	const id = pathId(params.milestoneId, 'milestone');
	const body = await readBody(request);
	try {
		const milestone = requireMilestone(user, id, true);
		const name = readText(body, 'name', {
			trim: true,
			min: 1,
			max: 200,
			keep: milestone.name,
			says: { empty: 'name cannot be empty', invalid: 'name too long (max 200 chars)' }
		});
		const description = readText(body, 'description', { max: 50000, keep: milestone.description });
		const targetDate = readDate(body, 'targetDate', { nullable: true, keep: milestone.targetDate });
		const status = readChoice(body, 'status', { from: STATUSES, keep: milestone.status, says: 'status must be open or closed' });
		const boardId = readId(body, 'boardId', { nullable: true, keep: milestone.boardId });

		return json(updateMilestone(user, id, { name, description, targetDate, status, boardId }));
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

	const id = pathId(params.milestoneId, 'milestone');

	try {
		const { released } = deleteMilestone(locals.user, id);
		return json({ success: true, cardsReleased: released });
	} catch (e) {
		if (e instanceof MilestoneError) throw error(e.status, e.message);
		throw e;
	}
};
