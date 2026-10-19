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
	takeCardOutOfMilestone,
	MilestoneError
} from '$lib/server/milestones';
import { emit } from '$lib/server/events';
import { pathId, readBody, readBoolean, readChoice, readDate, readId, readText } from '$lib/server/request-body';
import { requireUser } from '$lib/server/route-guards';
import { writeAs } from '$lib/server/write-as';
import type { RequestHandler } from './$types';

/** What a milestone's `status` may be. */
const STATUSES = ['open', 'closed'] as const;

export const GET: RequestHandler = async ({ params, locals }) => {
	if (!locals.user) throw error(401, 'Not authenticated');
	const id = pathId(params.id, 'milestone');

	try {
		return json(requireMilestone(locals.user, id));
	} catch (e) {
		if (e instanceof MilestoneError) throw error(e.status, e.message);
		throw e;
	}
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
 */
export const PATCH: RequestHandler = async ({ params, request, locals }) => {
	requireUser(locals.user);
	const id = pathId(params.id, 'milestone');
	const body = await readBody(request);
	try {
		// The milestone read, the caller checked and the change made in one
		// transaction that asks first whether the session is still open, and
		// who its account is now (card 2253). Each service's own transaction is
		// a savepoint inside it. The check and the change were two steps with
		// no transaction around them.
		const done = writeAs(locals, (caller) => {
			const user = requireUser(caller);
			const milestone = requireMilestone(user, id, true);

			// `cardId` in the body means "move this card in or out of the milestone",
			// which is what the card modal and the planning view both need most.
			if (body.cardId !== undefined) {
				const cardId = readId(body, 'cardId', { required: true });
				const attach = readBoolean(body, 'attach', {}) ?? true;
				return { moved: attach ? setCardMilestone(user, cardId, id) : takeCardOutOfMilestone(user, cardId, id) };
			}

			const name = readText(body, 'name', {
				trim: true,
				min: 1,
				max: 200,
				keep: milestone.name,
				says: { empty: 'name cannot be empty' }
			});
			const description = readText(body, 'description', { max: 50000, keep: milestone.description });
			const targetDate = readDate(body, 'targetDate', { nullable: true, keep: milestone.targetDate });
			const status = readChoice(body, 'status', { from: STATUSES, keep: milestone.status, says: 'status must be open or closed' });
			const boardId = readId(body, 'boardId', { nullable: true, keep: milestone.boardId });

			return { changed: updateMilestone(user, id, { name, description, targetDate, status, boardId }) };
		});

		// A card moved in or out: its board's pages are told, once it has committed.
		if (done.moved) {
			emit(done.moved.boardId, 'update', { type: 'card' });
			return json(done.moved);
		}
		return json(done.changed);
	} catch (e) {
		if (e instanceof MilestoneError) throw error(e.status, e.message);
		throw e;
	}
};

export const DELETE: RequestHandler = async ({ params, locals }) => {
	requireUser(locals.user);
	const id = pathId(params.id, 'milestone');

	try {
		// `deleteMilestone`'s own transaction is a savepoint inside one that asks
		// first whether the session is still open, and who its account is now
		// (card 2253).
		const { released } = writeAs(locals, (caller) => deleteMilestone(requireUser(caller), id));
		return json({ success: true, cardsReleased: released });
	} catch (e) {
		if (e instanceof MilestoneError) throw error(e.status, e.message);
		throw e;
	}
};
