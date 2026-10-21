import { json } from '$lib/server/v1-json';
import { db } from '$lib/server/db';
import { columns } from '$lib/server/db/schema';
import { eq } from 'drizzle-orm';
import { deleteBoardFor, updateBoard } from '$lib/server/boards';
import { pathId, readBody } from '$lib/server/request-body';
import { requireBoard, requireUser } from '$lib/server/route-guards';
import { writeAs } from '$lib/server/write-as';
import { COLUMN_ORDER } from '$lib/server/card-order';
import type { RequestHandler } from './$types';

/**
 * GET /api/v1/boards/:boardId — Get board details with its columns.
 *
 * A board that is not there is 404 to everyone, and then one the caller
 * cannot open is 403 (`requireBoard`). It was 403 first, to all but an
 * administrator.
 */
export const GET: RequestHandler = async ({ params, locals }) => {
	const boardId = pathId(params.boardId, 'board');
	const board = requireBoard(locals.user, boardId, 'view');

	const cols = db.select()
		.from(columns)
		.where(eq(columns.boardId, boardId))
		.orderBy(...COLUMN_ORDER)
		.all();

	return json({ ...board, columns: cols });
};

/**
 * PUT /api/v1/boards/:boardId — Update board name, emoji, categoryId, or isPublic.
 *
 * Edit access is enough for the first three. `isPublic` is the board's
 * owner's to send, or an administrator's. A body that sets none of them is
 * `400 No valid fields to update`. Only the fields whose value changes are
 * written, logged and told: a body whose every field is as the board holds it
 * answers the board as it is (card 2345).
 *
 * `parentCardId` is taken only as the card the board hangs under, null for
 * none, so a board read with GET can be sent back whole (an editor leaves
 * `isPublic` out). Any other, null on
 * a sub-board included, is a 400 (card 2287), where the other fields were
 * saved and it was ignored: a board is linked under a card, or taken out from
 * under one, on the board page (card 2114's D8).
 *
 * The work is `updateBoard` in `$lib/server/boards`, which `PUT
 * /api/boards/:id` shares (card 2012); this route passes `refuseEmpty`,
 * `refuseParent`, and `tellBeforeEntry` for the order it tells in.
 */
export const PUT: RequestHandler = async ({ params, request, locals }) => {
	requireUser(locals.user);
	const boardId = pathId(params.boardId, 'board');
	const body = await readBody(request);

	// One transaction: the board is read and the caller checked in the one that
	// changes it and writes its activity entry. A failure between the two
	// writes used to leave a board changed with nothing to say who changed it.
	// It asks first whether the key or session is still open, and who its
	// account is now (card 2253).
	const updated = writeAs(locals, (caller) =>
		updateBoard(caller, { boardId }, body, { source: 'api', refuseEmpty: true, refuseParent: true, tellBeforeEntry: true })
	);

	return json(updated);
};

/** DELETE /api/v1/boards/:boardId — Delete a board and all its data (`deleteBoardFor`, card 2012). */
export const DELETE: RequestHandler = async ({ params, locals }) => {
	requireUser(locals.user);
	const boardId = pathId(params.boardId, 'board');

	// One transaction: the caller is checked in the same one that deletes the
	// board, which asks first whether the key or session is still open, and who
	// its account is now (card 2253). Every sub-board at every depth goes with
	// it, where this used to name one level of them; what else goes is in
	// $lib/server/deletes.ts. A board that is not there is 404 to everyone,
	// before who is asking is looked at.
	writeAs(locals, (caller) => deleteBoardFor(caller, { boardId }, null, { source: 'api' }));

	return json({ success: true });
};
