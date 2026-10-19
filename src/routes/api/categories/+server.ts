import { json, error } from '@sveltejs/kit';
import { createCardCategory } from '$lib/server/card-categories';
import { cardCategoriesFor } from '$lib/server/list-access';
import { readBody } from '$lib/server/request-body';
import { requireUser } from '$lib/server/route-guards';
import { writeAs } from '$lib/server/write-as';
import type { RequestHandler } from './$types';

/**
 * GET /api/categories — the card categories the caller may pick: those of no
 * board, and those of the boards they can open (card 2128, `categoryRule`).
 * Every board's was listed to every signed-in caller, as a shared vocabulary.
 */
export const GET: RequestHandler = async ({ locals }) => {
	if (!locals.user) throw error(401, 'Not authenticated');

	return json(cardCategoriesFor(locals.user));
};

/**
 * POST /api/categories — make a card category on a board, or one of no board.
 *
 * `boardId` is read first, because it says whose category this is: an id, or
 * null or left out for one of no board, which is an administrator's to make.
 * The board is looked for and the caller checked (404, then 403), and then
 * the other fields are read (card 2117, R1): `name` text, trimmed, of 1 to 200
 * characters, and `color` a colour written `#rrggbb`. A name that was missing
 * gave "New Category", any colour was stored, and `''` and `0` as the board
 * meant none. The work is `createCardCategory` in
 * `$lib/server/card-categories`, which the v1 route shares (card 2012).
 */
export const POST: RequestHandler = async ({ request, locals }) => {
	requireUser(locals.user);
	const body = await readBody(request);

	// The session is asked again, and who its account is now, in the
	// transaction that makes the category (card 2253): one of no board is an
	// administrator's to make, as they are then.
	const category = writeAs(locals, (caller) => createCardCategory(caller, {}, body, { source: 'ui' }));
	return json(category, { status: 201 });
};
