import { json, error } from '@sveltejs/kit';
import { createBoard, listBoardsFor } from '$lib/server/boards';
import { readBody } from '$lib/server/request-body';
import { requireUser } from '$lib/server/route-guards';
import { writeAs } from '$lib/server/write-as';
import type { RequestHandler } from './$types';

/** The boards the caller can open, newest first: `listBoardsFor`, which the v1 twin shares (card 2012). */
export const GET: RequestHandler = async ({ locals }) => {
	if (!locals.user) throw error(401, 'Not authenticated');

	return json(listBoardsFor(locals.user, {}, {}));
};

/**
 * POST /api/boards — make a board, with its four columns and its owner.
 *
 * A new board has no row to guard, so its fields are read first (card 2117,
 * R1): `name` text, trimmed, of 1 to 200 characters; `emoji` text of 1 to
 * 32; `parentCardId` an id, or null for none; `categoryId`, the dashboard
 * grouping, an id or null. `{}` made "Untitled Board", and a grouping that
 * was not there was stored as sent: `boards.category_id` has no foreign key.
 *
 * The work, with the `board_created` entry `POST /api/v1/boards` writes too
 * and for a sub-board the live update that shows it on its card (card 2143),
 * is `createBoard` in `$lib/server/boards`, which the v1 route shares (card
 * 2012); this route passes `allowCategory`.
 */
export const POST: RequestHandler = async ({ request, locals }) => {
	requireUser(locals.user);
	const body = await readBody(request);

	// One transaction: the board, its columns and its owner are made together,
	// and the fields are read in it. It asks first whether the session is
	// still open, and who its account is now (card 2253).
	const board = writeAs(locals, (caller) => createBoard(caller, {}, body, { source: 'ui', allowCategory: true }));

	return json(board, { status: 201 });
};
