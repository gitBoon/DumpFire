import { json } from '@sveltejs/kit';
import { deleteBoardFor, updateBoard } from '$lib/server/boards';
import { pathId, readBody } from '$lib/server/request-body';
import { requireUser } from '$lib/server/route-guards';
import { writeAs } from '$lib/server/write-as';
import type { RequestHandler } from './$types';

/**
 * PUT /api/boards/:id — change a board: its name, emoji, dashboard grouping,
 * whether it is public, and the card it hangs under (`parentCardId`, this
 * route's alone). A body that sets no field is answered as it was, with
 * nothing recorded or told (R2 of card 2012's plan; v1 refuses it), and
 * since card 2345 nothing written; nor is a body whose every field is as the
 * board holds it.
 *
 * The work is `updateBoard` in `$lib/server/boards`, which the v1 route
 * shares (card 2012); this route passes `allowParent`.
 */
export const PUT: RequestHandler = async ({ params, request, locals }) => {
	requireUser(locals.user);
	const id = pathId(params.id, 'board');
	const body = await readBody(request);

	// One transaction, entered once the body has arrived: the board is read,
	// the caller checked, and who may make it public asked, in the one that
	// changes it. It asks first whether the session is still open, and who
	// its account is now (card 2253).
	const updated = writeAs(locals, (caller) => updateBoard(caller, { boardId: id }, body, { source: 'ui', allowParent: true }));
	return json(updated);
};

/**
 * DELETE /api/boards/:id — delete a board, every sub-board at every depth
 * with it (`deleteBoardFor` in `$lib/server/boards`, card 2012). Only owners
 * and admins can delete boards. A board that is not there is 404 to
 * everyone, before who is asking is looked at, as `DELETE
 * /api/v1/boards/{id}` answers it (card 2211): an administrator was answered
 * 200 for deleting nothing, and anyone else 403.
 */
export const DELETE: RequestHandler = async ({ params, locals }) => {
	requireUser(locals.user);

	const id = pathId(params.id, 'board');

	// One transaction: the caller is checked in the same one that deletes the
	// board. It asks first whether the session is still open, and who its
	// account is now (card 2253).
	writeAs(locals, (caller) => deleteBoardFor(caller, { boardId: id }, null, { source: 'ui' }));
	return json({ success: true });
};
