import { error } from '@sveltejs/kit';
import { json } from '$lib/server/v1-json';
import { deleteCardCategory, updateCardCategory } from '$lib/server/card-categories';
import { requireCategory, requireUser } from '$lib/server/route-guards';
import { pathId, readBody } from '$lib/server/request-body';
import { writeAs } from '$lib/server/write-as';
import type { RequestHandler } from './$types';

/**
 * GET /api/v1/categories/:categoryId — one card category, if it belongs to no
 * board or to a board the key's user can open (card 2128). 404 for none, 403
 * "No access to this category" otherwise: any key was given any category by
 * its id, with the id of its board.
 */
export const GET: RequestHandler = async ({ params, locals }) => {
	if (!locals.user) throw error(401, 'Not authenticated');

	const categoryId = pathId(params.categoryId, 'category');

	return json(requireCategory(locals.user, categoryId));
};

/** PUT /api/v1/categories/:categoryId — Update a category (`updateCardCategory`, card 2012). */
export const PUT: RequestHandler = async ({ params, request, locals }) => {
	requireUser(locals.user);
	const categoryId = pathId(params.categoryId, 'category');
	const body = await readBody(request);

	// Edit access to the owning board; a category with no board is admin-only.
	// Asked in the transaction that changes it, once the body has arrived,
	// which asks first whether the key or session is still open, and who its
	// account is now (card 2253).
	const updated = writeAs(locals, (caller) => updateCardCategory(caller, { categoryId }, body, { source: 'api' }));

	return json(updated);
};

/** DELETE /api/v1/categories/:categoryId — Delete a category (`deleteCardCategory`, card 2012). */
export const DELETE: RequestHandler = async ({ params, locals }) => {
	requireUser(locals.user);

	const categoryId = pathId(params.categoryId, 'category');

	// The category read, the caller checked and the category deleted in one
	// transaction that asks first whether the key or session is still open, and
	// who its account is now (card 2253). The live update waits for the
	// commit.
	writeAs(locals, (caller) => deleteCardCategory(caller, { categoryId }, null, { source: 'api' }));

	return json({ success: true });
};
