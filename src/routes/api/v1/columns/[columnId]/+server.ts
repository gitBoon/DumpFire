import { error } from '@sveltejs/kit';
import { json } from '$lib/server/v1-json';
import { deleteColumnFor, updateColumn } from '$lib/server/columns';
import { pathId, readBody } from '$lib/server/request-body';
import { requireColumn, requireUser } from '$lib/server/route-guards';
import { writeAs } from '$lib/server/write-as';
import type { RequestHandler } from './$types';

/**
 * GET /api/v1/columns/:columnId — Get a single column. A column that is not
 * there is 404, then one on a board the caller cannot open 403
 * (`requireColumn`, in the words its own copy of the guard had).
 */
export const GET: RequestHandler = async ({ params, locals }) => {
	if (!locals.user) throw error(401, 'Not authenticated');

	const columnId = pathId(params.columnId, 'column');

	return json(requireColumn(locals.user, columnId, 'view').column);
};

/**
 * PUT /api/v1/columns/:columnId — Update a column.
 *
 * A title that would make the column a Complete column, or stop it being
 * one, is `409` while the column holds any card, archived ones included, and
 * nothing is written (card 2134): see `completionRoleRefusal`. The work, the
 * WIP limit's reading with it, is `updateColumn` in `$lib/server/columns`,
 * which `PUT /api/columns/:id` shares (card 2012).
 */
export const PUT: RequestHandler = async ({ params, request, locals }) => {
	requireUser(locals.user);
	const columnId = pathId(params.columnId, 'column');
	const body = await readBody(request);

	// The column is read and the caller checked in the transaction that
	// changes it, once the body has arrived, which asks first whether the key
	// or session is still open, and who its account is now (card 2253).
	const updated = writeAs(locals, (caller) => updateColumn(caller, { columnId }, body, { source: 'api' }));

	return json(updated);
};

/** DELETE /api/v1/columns/:columnId — Delete a column and all its cards (`deleteColumnFor`, card 2012). */
export const DELETE: RequestHandler = async ({ params, locals }) => {
	requireUser(locals.user);

	const columnId = pathId(params.columnId, 'column');

	// One transaction: the column is read and the caller checked in the same
	// one that deletes it, which asks first whether the key or session is still
	// open, and who its account is now (card 2253). Its cards go with it, and
	// what goes with them is in $lib/server/deletes.ts.
	writeAs(locals, (caller) => deleteColumnFor(caller, { columnId }, null, { source: 'api' }));

	return json({ success: true });
};
