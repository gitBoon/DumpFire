import { json, error } from '@sveltejs/kit';
import { db } from '$lib/server/db';
import { columns } from '$lib/server/db/schema';
import { eq } from 'drizzle-orm';
import { canViewBoard, canEditBoard } from '$lib/server/board-access';
import { emit } from '$lib/server/events';
import type { RequestHandler } from './$types';

/** Look up the column and verify access. Returns the column or throws. */
function getColumnWithAccess(columnId: number, user: any, requireEdit: boolean) {
	const col = db.select().from(columns).where(eq(columns.id, columnId)).get();
	if (!col) throw error(404, 'Column not found');

	if (requireEdit) {
		if (!canEditBoard(user, col.boardId)) throw error(403, 'No edit access to this board');
	} else {
		if (!canViewBoard(user, col.boardId)) throw error(403, 'No access to this board');
	}

	return col;
}

/** GET /api/v1/columns/:columnId — Get a single column. */
export const GET: RequestHandler = async ({ params, locals }) => {
	if (!locals.user) throw error(401, 'Not authenticated');

	const columnId = Number(params.columnId);
	if (isNaN(columnId)) throw error(400, 'Invalid column ID');

	const col = getColumnWithAccess(columnId, locals.user, false);
	return json(col);
};

/** PUT /api/v1/columns/:columnId — Update a column. */
export const PUT: RequestHandler = async ({ params, request, locals }) => {
	if (!locals.user) throw error(401, 'Not authenticated');

	const columnId = Number(params.columnId);
	if (isNaN(columnId)) throw error(400, 'Invalid column ID');

	const col = getColumnWithAccess(columnId, locals.user, true);

	const body = await request.json();
	const updates: Record<string, unknown> = {};
	const allowed = ['title', 'color', 'position', 'wipLimit', 'showAddCard'];

	for (const key of allowed) {
		if (key in body) {
			if (key === 'title') {
				if (!body.title || !String(body.title).trim()) throw error(400, 'title cannot be empty');
				if (String(body.title).length > 200) throw error(400, 'Column title too long (max 200 chars)');
				updates.title = String(body.title).trim();
			} else {
				updates[key] = body[key];
			}
		}
	}

	if (Object.keys(updates).length === 0) {
		throw error(400, 'No valid fields to update');
	}

	const updated = db.update(columns)
		.set(updates)
		.where(eq(columns.id, columnId))
		.returning()
		.get();

	emit(col.boardId, 'update', { type: 'column' });

	return json(updated);
};

/** DELETE /api/v1/columns/:columnId — Delete a column and all its cards. */
export const DELETE: RequestHandler = async ({ params, locals }) => {
	if (!locals.user) throw error(401, 'Not authenticated');

	const columnId = Number(params.columnId);
	if (isNaN(columnId)) throw error(400, 'Invalid column ID');

	const col = getColumnWithAccess(columnId, locals.user, true);

	db.delete(columns).where(eq(columns.id, columnId)).run();
	emit(col.boardId, 'update', { type: 'column' });

	return json({ success: true });
};
