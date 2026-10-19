import { json } from '@sveltejs/kit';
import { deleteCardCategory, updateCardCategory } from '$lib/server/card-categories';
import { pathId, readBody } from '$lib/server/request-body';
import { requireUser } from '$lib/server/route-guards';
import { writeAs } from '$lib/server/write-as';
import type { RequestHandler } from './$types';

/** Rename or recolour a card category: `updateCardCategory`, which the v1 route shares (card 2012). */
export const PUT: RequestHandler = async ({ params, request, locals }) => {
	requireUser(locals.user);
	const id = pathId(params.id, 'category');
	const body = await readBody(request);

	// Checked against the board the category belongs to, read from its row,
	// in the transaction that changes it, which asks first whether the
	// session is still open, and who its account is now (card 2253).
	const updated = writeAs(locals, (caller) => updateCardCategory(caller, { categoryId: id }, body, { source: 'ui' }));
	return json(updated);
};

/** Delete a card category: `deleteCardCategory` (card 2012). */
export const DELETE: RequestHandler = async ({ params, locals }) => {
	const id = pathId(params.id, 'category');

	// The category read, the caller checked and the category deleted in one
	// transaction that asks first whether the session is still open, and who
	// its account is now (card 2253).
	writeAs(locals, (caller) => deleteCardCategory(caller, { categoryId: id }, null, { source: 'ui' }));
	return json({ success: true });
};
