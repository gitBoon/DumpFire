import { json, error } from '@sveltejs/kit';
import { db } from '$lib/server/db';
import { categories } from '$lib/server/db/schema';
import { eq, asc } from 'drizzle-orm';
import { canViewBoard, canEditBoard } from '$lib/server/board-access';
import { emit } from '$lib/server/events';
import type { RequestHandler } from './$types';

/** GET /api/v1/boards/:boardId/categories — List all categories for a board. */
export const GET: RequestHandler = async ({ params, locals }) => {
	if (!locals.user) throw error(401, 'Not authenticated');

	const boardId = Number(params.boardId);
	if (isNaN(boardId)) throw error(400, 'Invalid board ID');

	if (!canViewBoard(locals.user, boardId)) {
		throw error(403, 'No access to this board');
	}

	const all = db.select()
		.from(categories)
		.where(eq(categories.boardId, boardId))
		.orderBy(asc(categories.name))
		.all();

	return json(all);
};

/** POST /api/v1/boards/:boardId/categories — Create a category on a board. */
export const POST: RequestHandler = async ({ params, request, locals }) => {
	if (!locals.user) throw error(401, 'Not authenticated');

	const boardId = Number(params.boardId);
	if (isNaN(boardId)) throw error(400, 'Invalid board ID');

	if (!canEditBoard(locals.user, boardId)) {
		throw error(403, 'No edit access to this board');
	}

	const body = await request.json();
	const { name, color } = body;

	if (!name || !name.trim()) throw error(400, 'name is required');
	if (name.length > 200) throw error(400, 'Name too long (max 200 chars)');

	const category = db
		.insert(categories)
		.values({
			boardId,
			name: name.trim(),
			color: color || '#6366f1'
		})
		.returning()
		.get();

	emit(boardId, 'update', { type: 'category' });

	return json(category, { status: 201 });
};
