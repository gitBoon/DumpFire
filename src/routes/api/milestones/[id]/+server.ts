/**
 * Session-authenticated milestone read/update/delete plus card assignment for
 * the planning view. Mirrors /api/v1/milestones/:milestoneId.
 */
import { json, error } from '@sveltejs/kit';
import { changeMilestone, deleteMilestoneFor, readMilestone } from '$lib/server/milestone-service';
import { pathId, readBody } from '$lib/server/request-body';
import { requireUser } from '$lib/server/route-guards';
import { writeAs } from '$lib/server/write-as';
import type { RequestHandler } from './$types';

/** The milestone, as `GET /api/v1/milestones/:milestoneId` answers it without its cards: `readMilestone` (card 2012). */
export const GET: RequestHandler = async ({ params, locals }) => {
	if (!locals.user) throw error(401, 'Not authenticated');
	const id = pathId(params.id, 'milestone');
	return json(readMilestone(locals.user, { milestoneId: id }, {}));
};

/**
 * PATCH /api/milestones/:id — change the milestone, or put a card in it or
 * take one out, as `PATCH /api/v1/milestones/:milestoneId` and
 * `POST` and `DELETE /api/v1/milestones/:milestoneId/cards` do.
 *
 * The milestone is looked for and the caller checked first (404, then 403),
 * and then every field is read (card 2117, R1).
 *
 * `cardId` in the body puts that card in, or with `attach: false` takes it
 * out. `attach` is true or false: `"false"` put the card in. Taking a card
 * out is `takeCardOutOfMilestone`'s rule (R5): the card must be in this
 * milestone, `404 Card is not in this milestone`. The milestone in the path
 * was never looked at, so a card was taken out of its own through another
 * milestone's id, or one that was not there, and answered 200. An archived
 * card is not put in (decision 15).
 *
 * Otherwise `name` is text, trimmed, of 1 to 200 characters; `description`
 * text of at most 50,000; `targetDate` a date written `YYYY-MM-DD`, or null;
 * `status` `open` or `closed`; `boardId` an id, or null for a goal across
 * boards. A value the milestone already holds, sent back unchanged, is
 * accepted as it is. A board sent must be there (404), editable (403), and
 * hold every card of the milestone (400): `updateMilestone`.
 *
 * The work is `changeMilestone` in `$lib/server/milestone-service`, which the
 * v1 route shares (card 2012); this route passes `allowCard`.
 */
export const PATCH: RequestHandler = async ({ params, request, locals }) => {
	requireUser(locals.user);
	const id = pathId(params.id, 'milestone');
	const body = await readBody(request);

	// The milestone read, the caller checked and the change made in one
	// transaction that asks first whether the session is still open, and
	// who its account is now (card 2253). Each helper's own transaction is
	// a savepoint inside it. A card moved in or out: its board's pages are
	// told, once it has committed.
	const done = writeAs(locals, (caller) => changeMilestone(caller, { milestoneId: id }, body, { source: 'ui', allowCard: true }));

	if (done.moved) return json(done.moved);
	return json(done.changed);
};

export const DELETE: RequestHandler = async ({ params, locals }) => {
	requireUser(locals.user);
	const id = pathId(params.id, 'milestone');

	// `deleteMilestone`'s own transaction is a savepoint inside one that asks
	// first whether the session is still open, and who its account is now
	// (card 2253).
	const { released } = writeAs(locals, (caller) => deleteMilestoneFor(caller, { milestoneId: id }, null, { source: 'ui' }));
	return json({ success: true, cardsReleased: released });
};
