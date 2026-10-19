import { json } from '@sveltejs/kit';
import { deleteColumnFor, updateColumn } from '$lib/server/columns';
import { pathId, readBody } from '$lib/server/request-body';
import { requireUser } from '$lib/server/route-guards';
import { writeAs } from '$lib/server/write-as';
import type { RequestHandler } from './$types';

/**
 * PUT /api/columns/:id — change a column.
 *
 * The column is looked for and the caller checked (404, then 403), and then
 * every field is read (card 2117): `title` text, trimmed, of 1 to 200
 * characters; `color` a colour written `#rrggbb`; `position` a number;
 * `showAddCard` true or false, as `PUT /api/v1/columns/:columnId` takes it.
 * The WIP limit keeps its own reading. A value the column already holds, sent
 * back unchanged, is accepted as it is. A body with none of them is
 * `400 No valid fields to update`.
 *
 * `showAddCard` was left out, so the board page's "Show Add Task" was a 500
 * on every press; its page changed its own copy and the toggle looked saved
 * until the next load.
 *
 * A title that would make the column a Complete column, or stop it being
 * one, is `409` while the column holds any card, archived ones included, and
 * nothing is written (card 2134): see `completionRoleRefusal`.
 *
 * The work, the WIP limit's reading with it, is `updateColumn` in
 * `$lib/server/columns`, which the v1 route shares (card 2012).
 */
export const PUT: RequestHandler = async ({ params, request, locals }) => {
	requireUser(locals.user);
	const id = pathId(params.id, 'column');
	const body = await readBody(request);

	// The column is read and the caller checked in the transaction that changes
	// it, once the body has arrived, and the session asked again, and who its
	// account is now (card 2253).
	const updated = writeAs(locals, (caller) => updateColumn(caller, { columnId: id }, body, { source: 'ui' }));
	return json(updated);
};

/** Delete a column and its cards: `deleteColumnFor`, which the v1 route shares (card 2012). */
export const DELETE: RequestHandler = async ({ params, locals }) => {
	requireUser(locals.user);

	const id = pathId(params.id, 'column');

	// One transaction: the column is read and the caller checked in the same
	// one that deletes it, which asks first whether the session is still open,
	// and who its account is now (card 2253). Its cards go with it, and what
	// goes with them is in $lib/server/deletes.ts.
	writeAs(locals, (caller) => deleteColumnFor(caller, { columnId: id }, null, { source: 'ui' }));
	return json({ success: true });
};
