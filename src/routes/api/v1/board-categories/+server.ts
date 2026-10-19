import { error } from '@sveltejs/kit';
import { json } from '$lib/server/v1-json';
import { db } from '$lib/server/db';
import { boardCategories } from '$lib/server/db/schema';
import { readBody, readColour, readText } from '$lib/server/request-body';
import { boardCategoriesFor } from '$lib/server/list-access';
import { requireUser } from '$lib/server/route-guards';
import { writeAs } from '$lib/server/write-as';
import type { RequestHandler } from './$types';

/**
 * GET /api/v1/board-categories — the dashboard groupings the key's user is
 * listed: those that hold a board they can open, and the empty ones (card
 * 2128, `boardCategoryRule`). Every grouping was listed to every key.
 */
export const GET: RequestHandler = async ({ locals }) => {
	if (!locals.user) throw error(401, 'Not authenticated');

	return json(boardCategoriesFor(locals.user));
};

/**
 * POST /api/v1/board-categories — Create a board category.
 *
 * A grouping is on no board, so there is no row to guard and its fields are
 * read at once: `name` text, trimmed, of 1 to 200 characters, and `color` a
 * colour written `#rrggbb`.
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

	// Made in a transaction that asks first whether the key or session is
	// still open (card 2253). Any signed-in caller may make one, so the account
	// as it is now is asked nothing more.
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
