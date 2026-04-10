import { json, error } from '@sveltejs/kit';
import { db } from '$lib/server/db';
import { columns } from '$lib/server/db/schema';
import { eq, asc } from 'drizzle-orm';
import { canViewBoard, canEditBoard } from '$lib/server/board-access';
import { emit } from '$lib/server/events';
import type { RequestHandler } from './$types';

/** GET /api/v1/boards/:boardId/columns — List all columns for a board. */
export const GET: RequestHandler = async ({ params, locals }) => {
	if (!locals.user) throw error(401, 'Not authenticated');

	const boardId = Number(params.boardId);
	if (isNaN(boardId)) throw error(400, 'Invalid board ID');

	if (!canViewBoard(locals.user, boardId)) {
		throw error(403, 'No access to this board');
	}

	const cols = db.select()
		.from(columns)
		.where(eq(columns.boardId, boardId))
		.orderBy(asc(columns.position))
		.all();

	return json(cols);
};

/** POST /api/v1/boards/:boardId/columns — Create a new column. */
export const POST: RequestHandler = async ({ params, request, locals }) => {
	if (!locals.user) throw error(401, 'Not authenticated');

	const boardId = Number(params.boardId);
	if (isNaN(boardId)) throw error(400, 'Invalid board ID');

	if (!canEditBoard(locals.user, boardId)) {
		throw error(403, 'No edit access to this board');
	}

	const body = await request.json();
	const { title, color, position } = body;

	if (!title || !String(title).trim()) throw error(400, 'title is required');
	if (String(title).length > 200) throw error(400, 'Column title too long (max 200 chars)');

	// If no position specified, put it at the end
	const existingCols = db.select({ position: columns.position })
		.from(columns)
		.where(eq(columns.boardId, boardId))
		.orderBy(asc(columns.position))
		.all();
	const maxPos = existingCols.length > 0 ? Math.max(...existingCols.map(c => c.position)) : -1;

	const col = db.insert(columns)
		.values({
			boardId,
			title: String(title).trim(),
			color: color || '#6366f1',
			position: position ?? maxPos + 1
		})
		.returning()
		.get();

	emit(boardId, 'update', { type: 'column' });

	return json(col, { status: 201 });
};
