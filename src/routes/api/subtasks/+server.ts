import { json, error } from '@sveltejs/kit';
import { requireUser } from '$lib/server/route-guards';
import { createSubtask, listSubtasks } from '$lib/server/subtasks';
import { readBody, readQueryId } from '$lib/server/request-body';
import { writeAs } from '$lib/server/write-as';
import type { RequestHandler } from './$types';

/**
 * GET /api/subtasks?cardId= — a card's subtasks, by position and then id; no
 * card named, none. The work is `listSubtasks` in `$lib/server/subtasks`,
 * which the v1 list shares (card 2012).
 */
export const GET: RequestHandler = async ({ url, locals }) => {
	if (!locals.user) throw error(401, 'Not authenticated');

	// An id, as an id in the path is read (card 2117): `2.5` and `5abc` were
	// read as another card, or as none.
	const cardId = readQueryId(url.searchParams.get('cardId'), 'card', 'Invalid cardId');
	if (cardId === undefined) return json([]);

	return json(listSubtasks(locals.user, { cardId }, {}));
};

/**
 * POST /api/subtasks — add a subtask to a card, after its last one.
 *
 * `cardId` names the row guarded, so it is read first: the card is looked
 * for and the caller checked (404, then 403). Then every field is read (card
 * 2117, R1), as `POST /api/v1/cards/:cardId/subtasks` reads them: `title`
 * text, trimmed, of 1 to 500 characters; `description` at most 50,000;
 * `priority` one of the four; `colorTag` a colour written `#rrggbb` or empty;
 * `dueDate` a date written `YYYY-MM-DD`, or null. A title that was missing
 * gave "New subtask", and every other field was stored as sent.
 *
 * The work is `createSubtask` in `$lib/server/subtasks`, which the v1 route
 * shares (card 2012). This route takes no `position`, names the subtask alone
 * in its entry, and sends `subtask` as its live event's type after the entry.
 */
export const POST: RequestHandler = async ({ request, locals }) => {
	requireUser(locals.user);
	const body = await readBody(request);

	// One transaction: the card is read, the caller checked and the position
	// worked out in the one that creates the subtask and writes its entry. It
	// asks first whether the session is still open, and who its account is now
	// (card 2253). The card is named in the body, and read in there.
	const subtask = writeAs(locals, (caller) => createSubtask(caller, {}, body, { source: 'ui', eventType: 'subtask' }));
	return json(subtask, { status: 201 });
};
