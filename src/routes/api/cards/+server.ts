import { json } from '@sveltejs/kit';
import { requireUser } from '$lib/server/route-guards';
import { createCard } from '$lib/server/cards';
import { linkBaseUrl } from '$lib/server/email';
import { readBody } from '$lib/server/request-body';
import { writeAs } from '$lib/server/write-as';
import type { RequestHandler } from './$types';

/**
 * POST /api/cards — raise a card in a column.
 *
 * `columnId` names the row guarded, so it is read first: the column is
 * looked for and the caller checked (404, then 403). Then every field is read
 * (card 2117, R1), as `POST /api/v1/boards/:boardId/cards` reads them, and
 * then the category the body names is looked for: one of the card's board,
 * or one that belongs to no board (R3), `404 Category not found on this
 * board` otherwise. A create is checked as new: a value copied from another
 * card, as a duplicate is, is held to the rules (R6).
 *
 * A title over 500 characters was refused before the column was looked for;
 * every other field was stored as sent, and a reporting field outside its
 * vocabulary was a 500.
 *
 * A card created in a Complete column is completed as it is created, as a
 * card moved into one is (card 2134): see `$lib/server/card-create`. The
 * answer is the card as written, with its `completedAt`.
 *
 * The work is `createCard` in `$lib/server/cards`, which the v1 create
 * shares (card 2012). The board is the one the target column is on: a
 * `boardId` in the body is ignored.
 *
 * This route alone passes `withContents` (card 2296): the New Task window's
 * `subtasks`, `labelIds`, `assigneeIds` and `subBoards` are written with the
 * card, in its transaction, each by the service its own route uses, and any
 * refusal refuses the whole request. v1 ignores them.
 */
export const POST: RequestHandler = async ({ request, locals, url }) => {
	requireUser(locals.user);
	const body = await readBody(request);
	const baseUrl = linkBaseUrl(url);

	// One transaction: the column is read and the caller checked in the one
	// that creates the card and writes its entries. A failure between the
	// writes used to leave a card that nobody was recorded as having raised.
	// It asks first whether the session is still open, and who its account is
	// now (card 2253).
	const card = writeAs(locals, (caller) => createCard(caller, {}, body, { source: 'ui', baseUrl, withContents: true }));
	return json(card, { status: 201 });
};
