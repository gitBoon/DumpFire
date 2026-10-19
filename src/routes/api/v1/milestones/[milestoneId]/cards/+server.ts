import { json } from '$lib/server/v1-json';
import { attachCardToMilestone, detachCardFromMilestone } from '$lib/server/milestone-service';
import { pathId, readBody } from '$lib/server/request-body';
import { requireUser } from '$lib/server/route-guards';
import { writeAs } from '$lib/server/write-as';
import type { RequestHandler } from './$types';

/**
 * POST /api/v1/milestones/:milestoneId/cards — put a card in this milestone.
 *
 * Body: `{ cardId }`. A card belongs to at most one milestone, so this replaces
 * whatever it was in before rather than erroring. An archived card is refused,
 * as the batch refuses one.
 *
 * The milestone is looked for and the caller checked (404, then 403), then
 * `cardId` is read (400), then the card is looked for. The work is
 * `attachCardToMilestone` in `$lib/server/milestone-service`, which the
 * internal milestone PATCH shares (card 2012).
 */
export const POST: RequestHandler = async ({ params, request, locals }) => {
	requireUser(locals.user);
	const milestoneId = pathId(params.milestoneId, 'milestone');
	const body = await readBody(request);

	// The milestone read, the caller checked and the card put in, in one
	// transaction that asks first whether the key or session is still open,
	// and who its account is now (card 2253); `setCardMilestone`'s own is a
	// savepoint inside it. The board's pages are told once it has committed.
	const result = writeAs(locals, (caller) => attachCardToMilestone(caller, { milestoneId }, body, { source: 'api' }));
	return json(result);
};

/**
 * DELETE /api/v1/milestones/:milestoneId/cards — take a card out of this milestone.
 *
 * Body: `{ cardId }`. The card itself is untouched. The milestone must be
 * there and the caller able to change it, and the card must be in it:
 * `404 Card is not in this milestone`. A card in another milestone used to be
 * taken out of that one. The work is `detachCardFromMilestone` (card 2012).
 */
export const DELETE: RequestHandler = async ({ params, request, locals }) => {
	requireUser(locals.user);
	const milestoneId = pathId(params.milestoneId, 'milestone');
	const body = await readBody(request);

	// As the POST: one transaction that asks first, the helper's own a
	// savepoint inside it (card 2253).
	const result = writeAs(locals, (caller) => detachCardFromMilestone(caller, { milestoneId }, body, { source: 'api' }));
	return json(result);
};
