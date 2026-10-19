import { json } from '@sveltejs/kit';
import { reorderColumns } from '$lib/server/columns';
import { readBody } from '$lib/server/request-body';
import { requireUser } from '$lib/server/route-guards';
import { writeAs } from '$lib/server/write-as';
import type { RequestHandler } from './$types';

/**
 * PUT /api/columns/reorder — save the order of a board's columns.
 *
 * Body: `{ updates: [{ id, position }] }`. Each entry is an object, its `id`
 * an id and its `position` a number (card 2117): `updates[<n>].position must
 * be a number`. Text was stored as a position, a missing one was a 500, and an
 * entry that was not an object was a 500. The work is `reorderColumns` in
 * `$lib/server/columns` (card 2012).
 */
export const PUT: RequestHandler = async ({ request, locals }) => {
	requireUser(locals.user);
	const body = await readBody(request);

	// One transaction from the reading of the list to the last write: every
	// column gets its new position or none does, and a board is told only once
	// they all have. It asks first whether the session is still open, and who
	// its account is now (card 2253).
	writeAs(locals, (caller) => reorderColumns(caller, {}, body, { source: 'ui' }));
	return json({ success: true });
};
