import { json } from '$lib/server/v1-json';
import { db } from '$lib/server/db';
import { columns } from '$lib/server/db/schema';
import { eq, asc } from 'drizzle-orm';
import { emit } from '$lib/server/events';
import { pathId, readBody, readColour, readNumber, readText } from '$lib/server/request-body';
import { requireBoard, requireUser } from '$lib/server/route-guards';
import { writeAs } from '$lib/server/write-as';
import type { RequestHandler } from './$types';

/** GET /api/v1/boards/:boardId/columns — List all columns for a board. */
export const GET: RequestHandler = async ({ params, locals }) => {
	const boardId = pathId(params.boardId, 'board');
	// A board that is not there is 404 to everyone, then one the caller cannot open 403.
	requireBoard(locals.user, boardId, 'view');

	const cols = db.select()
		.from(columns)
		.where(eq(columns.boardId, boardId))
		.orderBy(asc(columns.position))
		.all();

	return json(cols);
};

/** POST /api/v1/boards/:boardId/columns — Create a new column. */
export const POST: RequestHandler = async ({ params, request, locals }) => {
	requireUser(locals.user);
	const boardId = pathId(params.boardId, 'board');
	const body = await readBody(request);

	// The board is looked for and the caller checked in the transaction that
	// adds the column, once the body has arrived. A board that is not there is
	// 404 to everyone: it was 403, and for an administrator a 500 from the
	// database. The transaction asks first whether the key or session is still
	// open, and who its account is now (card 2253).
	const col = writeAs(locals, (caller) => {
		requireBoard(caller, boardId, 'edit');

		const title = readText(body, 'title', {
			required: true,
			trim: true,
			min: 1,
			max: 200,
			says: { missing: 'title is required', empty: 'title is required' }
		});
		const color = readColour(body, 'color', {});
		const position = readNumber(body, 'position', {});

		// If no position specified, put it at the end
		const existingCols = db.select({ position: columns.position })
			.from(columns)
			.where(eq(columns.boardId, boardId))
			.orderBy(asc(columns.position))
			.all();
		const maxPos = existingCols.length > 0 ? Math.max(...existingCols.map(c => c.position)) : -1;

		const row = db.insert(columns)
			.values({
				boardId,
				title,
				color: color ?? '#6366f1',
				position: position ?? maxPos + 1
			})
			.returning()
			.get();

		emit(boardId, 'update', { type: 'column' });
		return row;
	});

	return json(col, { status: 201 });
};
