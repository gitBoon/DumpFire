import { json, error } from '@sveltejs/kit';
import { db } from '$lib/server/db';
import { columns } from '$lib/server/db/schema';
import { eq } from 'drizzle-orm';
import { emit } from '$lib/server/events';
import { getBoardRole } from '$lib/server/board-access';
import type { RequestHandler } from './$types';

export const PUT: RequestHandler = async ({ params, request, locals }) => {
	if (!locals.user) throw error(401, 'Not authenticated');

	const id = Number(params.id);
	const data = await request.json();
	const { boardId: _clientBoardId, ...updateData } = data;

	// Always resolve the board from the database — never trust the client
	const column = db.select().from(columns).where(eq(columns.id, id)).get();
	if (!column) throw error(404, 'Column not found');

	const role = getBoardRole(locals.user, column.boardId);
	if (role !== 'admin' && role !== 'owner') {
		throw error(403, 'Only board owners and admins can modify column settings');
	}

	const updated = db.update(columns).set(updateData).where(eq(columns.id, id)).returning().get();
	if (!updated) throw error(404, 'Column not found');
	emit(column.boardId, 'update', { type: 'column' });
	return json(updated);
};

export const DELETE: RequestHandler = async ({ params, locals }) => {
	if (!locals.user) throw error(401, 'Not authenticated');

	const id = Number(params.id);

	// Always resolve the board from the database — never trust the client
	const column = db.select().from(columns).where(eq(columns.id, id)).get();
	if (!column) throw error(404, 'Column not found');

	const role = getBoardRole(locals.user, column.boardId);
	if (role !== 'admin' && role !== 'owner') {
		throw error(403, 'Only board owners and admins can delete columns');
	}

	db.delete(columns).where(eq(columns.id, id)).run();
	emit(column.boardId, 'update', { type: 'column' });
	return json({ success: true });
};
