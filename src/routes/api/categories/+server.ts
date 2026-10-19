import { json, error } from '@sveltejs/kit';
import { db } from '$lib/server/db';
import { categories } from '$lib/server/db/schema';
import { emit } from '$lib/server/events';
import { cardCategoriesFor } from '$lib/server/list-access';
import { inTransaction } from '$lib/server/db/transaction';
import { readBody, readColour, readId, readText } from '$lib/server/request-body';
import { requireCategoryCreate, requireUser } from '$lib/server/route-guards';
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
 * meant none.
 */
export const POST: RequestHandler = async ({ request, locals }) => {
	const user = requireUser(locals.user);
	const body = await readBody(request);

	const category = inTransaction(() => {
		const boardId = requireCategoryCreate(user, readId(body, 'boardId', { nullable: true, says: 'Invalid board ID' }));

		const name = readText(body, 'name', {
			required: true,
			trim: true,
			min: 1,
			max: 200,
			says: { missing: 'name is required', empty: 'name is required' }
		});
		const color = readColour(body, 'color', {});

		const category = db
			.insert(categories)
			.values({
				boardId,
				name,
				color: color ?? '#6366f1'
			})
			.returning()
			.get();
		if (boardId) emit(boardId, 'update', { type: 'category' });
		return category;
	});
	return json(category, { status: 201 });
};
