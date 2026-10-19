import { error } from '@sveltejs/kit';
import { json } from '$lib/server/v1-json';
import { deleteBoardGrouping, updateBoardGrouping } from '$lib/server/board-groupings';
import { requireBoardCategory, requireUser } from '$lib/server/route-guards';
import { writeAs } from '$lib/server/write-as';
import { pathId, readBody } from '$lib/server/request-body';
import type { RequestHandler } from './$types';

/**
 * GET /api/v1/board-categories/:categoryId — one board category, if the key's
 * user is listed it: it holds a board they can open, or none (card 2128).
 * 404 for none, 403 "No access to this board category" otherwise: any key was
 * given any grouping by its id.
 */
export const GET: RequestHandler = async ({ params, locals }) => {
	if (!locals.user) throw error(401, 'Not authenticated');

	const categoryId = pathId(params.categoryId, 'category');

	return json(requireBoardCategory(locals.user, categoryId));
};

/** PUT /api/v1/board-categories/:categoryId — Update a board category (`updateBoardGrouping`, card 2012). */
export const PUT: RequestHandler = async ({ params, request, locals }) => {
	requireUser(locals.user);
	const categoryId = pathId(params.categoryId, 'category');
	const body = await readBody(request);

	// Renaming a grouping changes how every board filed under it is shown.
	// The boards filed under it are read in the transaction that renames it,
	// which asks first whether the key or session is still open, and who its
	// account is now (card 2253).
	const updated = writeAs(locals, (caller) => updateBoardGrouping(caller, { categoryId }, body, { source: 'api' }));

	return json(updated);
};

/** DELETE /api/v1/board-categories/:categoryId — Delete a board category (`deleteBoardGrouping`, card 2012). */
export const DELETE: RequestHandler = async ({ params, locals }) => {
	requireUser(locals.user);

	const categoryId = pathId(params.categoryId, 'category');

	// The grouping read, the caller checked and the grouping deleted in one
	// transaction that asks first whether the key or session is still open, and
	// who its account is now (card 2253).
	writeAs(locals, (caller) => deleteBoardGrouping(caller, { categoryId }, null, { source: 'api' }));

	return json({ success: true });
};
