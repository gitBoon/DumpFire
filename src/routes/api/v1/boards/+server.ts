import { error } from '@sveltejs/kit';
import { json } from '$lib/server/v1-json';
import { db } from '$lib/server/db';
import { columns } from '$lib/server/db/schema';
import { eq } from 'drizzle-orm';
import { createBoard, listBoardsFor } from '$lib/server/boards';
import { requireUser } from '$lib/server/route-guards';
import { readBody } from '$lib/server/request-body';
import { writeAs } from '$lib/server/write-as';
import type { RequestHandler } from './$types';

/** GET /api/v1/boards — List all boards accessible to the API key's user (`listBoardsFor`, card 2012). */
export const GET: RequestHandler = async ({ locals }) => {
	if (!locals.user) throw error(401, 'Not authenticated');

	return json(listBoardsFor(locals.user, {}, {}));
};

/**
 * POST /api/v1/boards — Create a new board.
 *
 * Body: { name, emoji?, parentCardId?, categoryId? }
 *
 * If parentCardId is provided, the board is created as a sub-board
 * linked to that card. The user must have edit access to the parent
 * card's board.
 *
 * `categoryId` files the new board under that dashboard grouping, as the
 * page's create does (card 2287): one that is not there is 404, one of boards
 * the caller cannot open 403. It was ignored, and the board made unfiled. A
 * new board is private: `isPublic` is not read here.
 *
 * Default columns (To Do, On Hold, In Progress, Complete) are
 * created automatically. The API key's user is added as board owner.
 *
 * A new board has no row to guard, so its fields are read first (card 2117,
 * R1): `name` text, trimmed, of 1 to 200 characters; `emoji` text of 1 to 32;
 * `parentCardId` and `categoryId` ids, or null for none. The parent card and
 * the grouping are looked for after.
 *
 * The work is `createBoard` in `$lib/server/boards`, which `POST /api/boards`
 * shares (card 2012), so that the two cannot differ. The answer adds the
 * board's columns.
 */
export const POST: RequestHandler = async ({ request, locals }) => {
	requireUser(locals.user);
	const body = await readBody(request);

	// One transaction: the fields are read, and the parent card and the
	// grouping read and the caller checked, in the one that makes the board,
	// its columns, its owner and its activity entry. It asks first whether the
	// key or session is still open, and who its account is now (card 2253).
	const created = writeAs(locals, (caller) => {
		const board = createBoard(caller, {}, body, { source: 'api', allowCategory: true });

		// Return the board with its columns
		const boardColumns = db.select().from(columns).where(eq(columns.boardId, board.id)).all();

		return { ...board, columns: boardColumns };
	});

	return json(created, { status: 201 });
};
