import { json } from '@sveltejs/kit';
import { ASSIGN_PAGE_OPTIONS, assignToCard, unassignFromCard } from '$lib/server/card-assignees';
import { linkBaseUrl } from '$lib/server/email';
import { pathId, readBody } from '$lib/server/request-body';
import { requireUser } from '$lib/server/route-guards';
import { writeAs } from '$lib/server/write-as';
import type { RequestHandler } from './$types';

/**
 * This route's words for a caller who may not edit the card's board, which it
 * keeps (card 2012, R2): both handlers hand them to the service, the POST in
 * the service's `ASSIGN_PAGE_OPTIONS` (card 2296), whose words are these.
 */
const NO_EDIT = 'No edit access';

/**
 * POST — Assign a user to a card. Body: `{ userId }`, an id (card 2117): `0`,
 * `''` and `false` were `userId is required`, and anything else was looked for.
 *
 * The card is looked for and the caller checked (404, then 403) before
 * `userId` is read (400) and its user looked for (404), all in the
 * transaction that assigns them.
 *
 * It records what `POST /api/v1/cards/{id}/assignees` records (card 2143):
 * an `assignee_added` entry and the mail when someone was added, and the
 * board's open pages are told either way, as that route tells them. Neither
 * was done here, so an assignment made in the card window reached no
 * Activity Log and refreshed no other page.
 *
 * The work is `assignToCard` in `$lib/server/card-assignees`, which the v1
 * route shares (card 2012).
 */
export const POST: RequestHandler = async ({ params, request, locals, url }) => {
	requireUser(locals.user);
	const cardId = pathId(params.id, 'card');
	const body = await readBody(request);
	const baseUrl = linkBaseUrl(url);

	// The session is asked again, and who its account is now, in the
	// transaction that assigns (card 2253). The options are the service's
	// constant, `{ source: 'ui', says: 'No edit access' }` (NO_EDIT's words),
	// which a new card's assignees are written with too (card 2296).
	writeAs(locals, (caller) => assignToCard(caller, { cardId }, body, { ...ASSIGN_PAGE_OPTIONS, baseUrl }));

	return json({ success: true });
};

/**
 * DELETE — Remove a user from a card. Body: `{ userId }`, an id.
 *
 * Removing someone who is not assigned to the card is
 * `404 User is not assigned to this card` (card 2117, decision 9), as the
 * API's route answers it. It was 200, and the card window said it was done.
 *
 * A removal writes the `assignee_removed` entry and tells the board's open
 * pages, as the API's route does (card 2143); a refused one does neither.
 * The work is `unassignFromCard`, which the v1 route shares (card 2012).
 */
export const DELETE: RequestHandler = async ({ params, request, locals }) => {
	requireUser(locals.user);
	const cardId = pathId(params.id, 'card');
	const body = await readBody(request);

	writeAs(locals, (caller) => unassignFromCard(caller, { cardId }, body, { source: 'ui', says: NO_EDIT }));

	return json({ success: true });
};
