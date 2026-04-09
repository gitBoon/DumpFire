import { json, error } from '@sveltejs/kit';
import { db } from '$lib/server/db';
import { columns } from '$lib/server/db/schema';
import { eq } from 'drizzle-orm';
import { emit } from '$lib/server/events';
import { canEditBoard } from '$lib/server/board-access';
import type { RequestHandler } from './$types';

export const PUT: RequestHandler = async ({ params, request, locals }) => {
	if (!locals.user) throw error(401, 'Not authenticated');

	const id = Number(params.id);
	const data = await request.json();
	const { boardId: _clientBoardId, ...rawData } = data;

	// Always resolve the board from the database — never trust the client
	const column = db.select().from(columns).where(eq(columns.id, id)).get();
	if (!column) throw error(404, 'Column not found');

	if (!canEditBoard(locals.user, column.boardId)) {
		throw error(403, 'No edit access to this board');
	}

	// Whitelist allowed fields to prevent mass assignment
	const updateData: Record<string, unknown> = {};
	const allowed = ['title', 'color', 'position', 'wipLimit'];
	for (const key of allowed) {
		if (key in rawData) updateData[key] = rawData[key];
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

	if (!canEditBoard(locals.user, column.boardId)) {
		throw error(403, 'No edit access to this board');
	}

	db.delete(columns).where(eq(columns.id, id)).run();
	emit(column.boardId, 'update', { type: 'column' });
	return json({ success: true });
};
