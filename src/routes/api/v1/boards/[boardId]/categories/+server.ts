import { json } from '$lib/server/v1-json';
import { db } from '$lib/server/db';
import { categories } from '$lib/server/db/schema';
import { eq, asc } from 'drizzle-orm';
import { emit } from '$lib/server/events';
import { inTransaction } from '$lib/server/db/transaction';
import { pathId, readBody, readColour, readText } from '$lib/server/request-body';
import { requireBoard, requireUser } from '$lib/server/route-guards';
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

/** POST /api/v1/boards/:boardId/categories — Create a category on a board. */
export const POST: RequestHandler = async ({ params, request, locals }) => {
	const user = requireUser(locals.user);
	const boardId = pathId(params.boardId, 'board');
	const body = await readBody(request);

	// The board is looked for and the caller checked in the transaction that
	// adds the category, once the body has arrived. A board that is not there
	// is 404 to everyone: it was 403, and for an administrator a 500.
	const category = inTransaction(() => {
		requireBoard(user, boardId, 'edit');

		const name = readText(body, 'name', {
			required: true,
			trim: true,
			min: 1,
			max: 200,
			says: { missing: 'name is required', empty: 'name is required' }
		});
		const color = readColour(body, 'color', {});

		const row = db
			.insert(categories)
			.values({ boardId, name, color: color ?? '#6366f1' })
			.returning()
			.get();

		emit(boardId, 'update', { type: 'category' });
		return row;
	});

	return json(category, { status: 201 });
};
