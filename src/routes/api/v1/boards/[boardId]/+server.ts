import { json, error } from '@sveltejs/kit';
import { db } from '$lib/server/db';
import { boards, columns } from '$lib/server/db/schema';
import { eq, asc } from 'drizzle-orm';
import { canViewBoard } from '$lib/server/board-access';
import type { RequestHandler } from './$types';

/** GET /api/v1/boards/:boardId — Get board details with its columns. */
export const GET: RequestHandler = async ({ params, locals }) => {
	if (!locals.user) throw error(401, 'Not authenticated');

	const boardId = Number(params.boardId);
	if (isNaN(boardId)) throw error(400, 'Invalid board ID');

	if (!canViewBoard(locals.user, boardId)) {
		throw error(403, 'No access to this board');
	}

	const board = db.select().from(boards).where(eq(boards.id, boardId)).get();
	if (!board) throw error(404, 'Board not found');

	const cols = db.select()
		.from(columns)
		.where(eq(columns.boardId, boardId))
		.orderBy(asc(columns.position))
		.all();

	return json({ ...board, columns: cols });
};
