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
 * Body: { name, emoji?, parentCardId? }
 *
 * If parentCardId is provided, the board is created as a sub-board
 * linked to that card. The user must have edit access to the parent
 * card's board.
 *
 * Default columns (To Do, On Hold, In Progress, Complete) are
 * created automatically. The API key's user is added as board owner.
 *
 * A new board has no row to guard, so its fields are read first (card 2117,
 * R1): `name` text, trimmed, of 1 to 200 characters; `emoji` text of 1 to 32;
 * `parentCardId` an id, or null for none. The parent card is looked for after.
 *
 * The work is `createBoard` in `$lib/server/boards`, which `POST /api/boards`
 * shares (card 2012), so that the two cannot differ. The answer adds the
 * board's columns.
 */
export const POST: RequestHandler = async ({ request, locals }) => {
	requireUser(locals.user);
	const body = await readBody(request);

	// One transaction: the fields are read, and the parent card read and the
	// caller checked, in the one that makes the board, its columns, its owner
	// and its activity entry. It asks first whether the key or session is
	// still open, and who its account is now (card 2253).
	const created = writeAs(locals, (caller) => {
		const board = createBoard(caller, {}, body, { source: 'api' });

		// Return the board with its columns
		const boardColumns = db.select().from(columns).where(eq(columns.boardId, board.id)).all();

		return { ...board, columns: boardColumns };
	});

	return json(created, { status: 201 });
};
