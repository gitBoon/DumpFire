import { json, error } from '@sveltejs/kit';
import { db } from '$lib/server/db';
import { boardCategories } from '$lib/server/db/schema';
import { readBody, readColour, readText } from '$lib/server/request-body';
import { boardCategoriesFor } from '$lib/server/list-access';
import { requireUser } from '$lib/server/route-guards';
import { writeAs } from '$lib/server/write-as';
import type { RequestHandler } from './$types';

/**
 * GET /api/board-categories — the dashboard groupings the caller is listed:
 * those that hold a board they can open, and the empty ones (card 2128,
 * `boardCategoryRule`). Every grouping was listed to every signed-in caller.
 */
export const GET: RequestHandler = async ({ locals }) => {
	if (!locals.user) throw error(401, 'Not authenticated');

	return json(boardCategoriesFor(locals.user));
};

/**
 * POST /api/board-categories — make a dashboard grouping.
 *
 * A grouping is on no board, so there is no row to guard and its fields are
 * read at once (card 2117): `name` text, trimmed, of 1 to 200 characters, and
 * `color` a colour written `#rrggbb`, as `POST /api/v1/board-categories`
 * reads them. A name that was missing or empty gave "New Category", and any
 * colour was stored.
 */
export const POST: RequestHandler = async ({ request, locals }) => {
	requireUser(locals.user);
	const body = await readBody(request);

	const name = readText(body, 'name', {
		required: true,
		trim: true,
		min: 1,
		max: 200,
		says: { missing: 'name is required', empty: 'name is required' }
	});
	const color = readColour(body, 'color', {});

	// Made in a transaction that asks first whether the session is still open
	// (card 2253). Any signed-in caller may make one, so the account as it is
	// now is asked nothing more.
	const category = writeAs(locals, (caller) => {
		requireUser(caller);
		return db
			.insert(boardCategories)
			.values({
				name,
				color: color ?? '#6366f1'
			})
			.returning()
			.get();
	});
	return json(category, { status: 201 });
};
