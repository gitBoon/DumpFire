import { json } from '$lib/server/v1-json';
import { db } from '$lib/server/db';
import { categories } from '$lib/server/db/schema';
import { eq, asc } from 'drizzle-orm';
import { createCardCategory } from '$lib/server/card-categories';
import { pathId, readBody } from '$lib/server/request-body';
import { requireBoard, requireUser } from '$lib/server/route-guards';
import { writeAs } from '$lib/server/write-as';
import type { RequestHandler } from './$types';

/** GET /api/v1/boards/:boardId/categories — List all categories for a board. */
export const GET: RequestHandler = async ({ params, locals }) => {
	const boardId = pathId(params.boardId, 'board');
	// A board that is not there is 404 to everyone, then one the caller cannot open 403.
	requireBoard(locals.user, boardId, 'view');

	const all = db.select()
		.from(categories)
		.where(eq(categories.boardId, boardId))
		.orderBy(asc(categories.name))
		.all();

	return json(all);
};

/**
 * POST /api/v1/boards/:boardId/categories — Create a category on a board.
 * The work is `createCardCategory` in `$lib/server/card-categories`, which
 * `POST /api/categories` shares (card 2012).
 */
export const POST: RequestHandler = async ({ params, request, locals }) => {
	requireUser(locals.user);
	const boardId = pathId(params.boardId, 'board');
	const body = await readBody(request);

	// The board is looked for and the caller checked in the transaction that
	// adds the category, once the body has arrived. A board that is not there
	// is 404 to everyone: it was 403, and for an administrator a 500. The
	// transaction asks first whether the key or session is still open, and who
	// its account is now (card 2253).
	const category = writeAs(locals, (caller) => createCardCategory(caller, { boardId }, body, { source: 'api' }));

	return json(category, { status: 201 });
};
