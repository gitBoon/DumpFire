import { error, json } from '@sveltejs/kit';
import { whilePasswordHolds } from '$lib/server/auth';
import { columnDeleteGuard, deleteColumnFor, updateColumn } from '$lib/server/columns';
import { pathId, readBody } from '$lib/server/request-body';
import { requireUser } from '$lib/server/route-guards';
import { STEP_UP_MISSING, confirmStepUp } from '$lib/server/step-up';
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

/**
 * Delete a column and its cards: `deleteColumnFor`, which the v1 route shares
 * (card 2012).
 *
 * A column that holds any card, archived ones included, asks for the caller's
 * own password again, in `currentPassword` (card 2701, decision 18,
 * step-up.ts): every card goes with it, with their sub-boards and files, for
 * good. An empty one asks for none. Every refusal of the delete is made first
 * (`columnDeleteGuard`), with no password checked or counted. `DELETE
 * /api/v1/columns/{id}` asks for none: a key has no password (card 2703).
 */
export const DELETE: RequestHandler = async ({ params, request, locals, cookies }) => {
	requireUser(locals.user);

	const id = pathId(params.id, 'column');
	const body = await readBody(request);

	// Every refusal of the delete, read only, and whether the column holds a
	// card: the one thing that decides whether a password is asked for.
	const { held } = writeAs(locals, (caller) => columnDeleteGuard(caller, { columnId: id }));

	if (held === 0) {
		// One transaction: the column is read and the caller checked in the same
		// one that deletes it, which asks first whether the session is still
		// open, and who its account is now (card 2253). A card that arrived in
		// the column since is not deleted without the password: refused, and
		// nothing written.
		writeAs(locals, (caller) => {
			if (columnDeleteGuard(caller, { columnId: id }).held > 0) error(400, { message: STEP_UP_MISSING, stepUp: 'missing' });
			deleteColumnFor(caller, { columnId: id }, null, { source: 'ui' });
		});
		return json({ success: true });
	}

	// The caller's password, once every refusal that needs none has been made.
	const { userId, hash } = await confirmStepUp(locals, cookies, body, 'DELETE /api/columns/[id]', (caller) =>
		columnDeleteGuard(caller, { columnId: id })
	);

	// One transaction, as above, run only while the caller's stored hash is the
	// one their password was checked against. Its cards go with it, and what
	// goes with them is in $lib/server/deletes.ts.
	await whilePasswordHolds(userId, hash, () =>
		writeAs(locals, (caller) => deleteColumnFor(caller, { columnId: id }, null, { source: 'ui' })));
	return json({ success: true });
};
