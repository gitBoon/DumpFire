import { json } from '$lib/server/v1-json';
import { db } from '$lib/server/db';
import { columns } from '$lib/server/db/schema';
import { eq } from 'drizzle-orm';
import { createColumn } from '$lib/server/columns';
import { pathId, readBody } from '$lib/server/request-body';
import { requireBoard, requireUser } from '$lib/server/route-guards';
import { writeAs } from '$lib/server/write-as';
import { COLUMN_ORDER } from '$lib/server/card-order';
import type { RequestHandler } from './$types';

/** GET /api/v1/boards/:boardId/columns — List all columns for a board. */
export const GET: RequestHandler = async ({ params, locals }) => {
	const boardId = pathId(params.boardId, 'board');
	// A board that is not there is 404 to everyone, then one the caller cannot open 403.
	requireBoard(locals.user, boardId, 'view');

	const cols = db.select()
		.from(columns)
		.where(eq(columns.boardId, boardId))
		.orderBy(...COLUMN_ORDER)
		.all();

	return json(cols);
};

/**
 * POST /api/v1/boards/:boardId/columns — Create a new column. With no
 * position it goes after the board's last (`placeAfterLast`); the colour is
 * read before the position (`colorBeforePosition`). The work is
 * `createColumn` in `$lib/server/columns`, which `POST /api/columns` shares
 * (card 2012).
 */
export const POST: RequestHandler = async ({ params, request, locals }) => {
	requireUser(locals.user);
	const boardId = pathId(params.boardId, 'board');
	const body = await readBody(request);

	// The board is looked for and the caller checked in the transaction that
	// adds the column, once the body has arrived. A board that is not there is
	// 404 to everyone: it was 403, and for an administrator a 500 from the
	// database. The transaction asks first whether the key or session is still
	// open, and who its account is now (card 2253).
	const col = writeAs(locals, (caller) =>
		createColumn(caller, { boardId }, body, { source: 'api', placeAfterLast: true, colorBeforePosition: true })
	);

	return json(col, { status: 201 });
};
