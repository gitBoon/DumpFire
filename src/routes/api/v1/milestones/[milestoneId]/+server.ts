import { error } from '@sveltejs/kit';
import { json } from '$lib/server/v1-json';
import { changeMilestone, deleteMilestoneFor, readMilestone } from '$lib/server/milestone-service';
import { pathId, readBody } from '$lib/server/request-body';
import { requireUser } from '$lib/server/route-guards';
import { writeAs } from '$lib/server/write-as';
import type { RequestHandler } from './$types';

/**
 * GET /api/v1/milestones/:milestoneId — the milestone and its cards.
 *
 * A card on a board the caller cannot open is listed withheld, as the
 * summary lists it (card 2129). The read is `readMilestone` in
 * `$lib/server/milestone-service`, which the internal route shares (card
 * 2012); this route asks it for the cards (`withCards`).
 */
export const GET: RequestHandler = async ({ params, locals }) => {
	if (!locals.user) throw error(401, 'Not authenticated');

	const id = pathId(params.milestoneId, 'milestone');
	return json(readMilestone(locals.user, { milestoneId: id }, { withCards: true }));
};

/**
 * PATCH /api/v1/milestones/:milestoneId — update name/description/targetDate/status/boardId.
 *
 * The milestone is looked for and the caller checked (404, then 403), then
 * every field is read (400): `name` text, trimmed, of 1 to 200 characters;
 * `description` text of at most 50,000; `targetDate` a date written
 * `YYYY-MM-DD`, or null; `status` `open` or `closed`; `boardId` an id, or null
 * for a goal across boards. A value the milestone already holds, sent back
 * unchanged, is accepted as it is. A board sent must be there (404), editable
 * (403), and hold every card of the milestone (400): `updateMilestone`.
 * The work is `changeMilestone`, which the internal route shares (card 2012).
 */
export const PATCH: RequestHandler = async ({ params, request, locals }) => {
	requireUser(locals.user);
	const id = pathId(params.milestoneId, 'milestone');
	const body = await readBody(request);

	// The milestone read, the caller checked and the change made in one
	// transaction that asks first whether the key or session is still open,
	// and who its account is now (card 2253). `updateMilestone`'s own
	// transaction is a savepoint inside it.
	const { changed } = writeAs(locals, (caller) => changeMilestone(caller, { milestoneId: id }, body, { source: 'api' }));

	return json(changed);
};

/**
 * DELETE /api/v1/milestones/:milestoneId — delete the goal, keep the work.
 *
 * The milestone's cards are released back to having no milestone; they are
 * never deleted. The response says how many were released.
 */
export const DELETE: RequestHandler = async ({ params, locals }) => {
	requireUser(locals.user);

	const id = pathId(params.milestoneId, 'milestone');

	// `deleteMilestone`'s own transaction is a savepoint inside one that asks
	// first whether the key or session is still open, and who its account is
	// now (card 2253).
	const { released } = writeAs(locals, (caller) => deleteMilestoneFor(caller, { milestoneId: id }, null, { source: 'api' }));
	return json({ success: true, cardsReleased: released });
};
