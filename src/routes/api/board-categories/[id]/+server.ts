import { json } from '@sveltejs/kit';
import { deleteBoardGrouping, updateBoardGrouping } from '$lib/server/board-groupings';
import { pathId, readBody } from '$lib/server/request-body';
import { requireUser } from '$lib/server/route-guards';
import { writeAs } from '$lib/server/write-as';
import type { RequestHandler } from './$types';

/** Rename or recolour a dashboard grouping: `updateBoardGrouping`, which the v1 route shares (card 2012). */
export const PUT: RequestHandler = async ({ params, request, locals }) => {
	requireUser(locals.user);
	const id = pathId(params.id, 'category');
	const body = await readBody(request);

	// Renaming a grouping changes how every board filed under it is shown.
	// The boards filed under it are read in the transaction that renames it,
	// which asks first whether the session is still open, and who its
	// account is now (card 2253).
	const updated = writeAs(locals, (caller) => updateBoardGrouping(caller, { categoryId: id }, body, { source: 'ui' }));
	return json(updated);
};

/** Delete a dashboard grouping: `deleteBoardGrouping` (card 2012). */
export const DELETE: RequestHandler = async ({ params, locals }) => {
	const id = pathId(params.id, 'category');

	// The grouping read, the caller checked and the grouping deleted in one
	// transaction that asks first whether the session is still open, and who
	// its account is now (card 2253).
	writeAs(locals, (caller) => deleteBoardGrouping(caller, { categoryId: id }, null, { source: 'ui' }));
	return json({ success: true });
};
