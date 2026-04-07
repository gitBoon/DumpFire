import { json, error } from '@sveltejs/kit';
import { db } from '$lib/server/db';
import { columns } from '$lib/server/db/schema';
import { eq } from 'drizzle-orm';
import { emit } from '$lib/server/events';
import { getBoardRole } from '$lib/server/board-access';
import type { RequestHandler } from './$types';

export const PUT: RequestHandler = async ({ params, request, locals }) => {
	const id = Number(params.id);
	const data = await request.json();
	const { boardId, ...updateData } = data;

	// Enforce admin/owner for column management
	if (boardId && locals.user) {
		const role = getBoardRole(locals.user, boardId);
		if (role !== 'admin' && role !== 'owner') {
			throw error(403, 'Only board owners and admins can modify column settings');
		}
	}

	const updated = db.update(columns).set(updateData).where(eq(columns.id, id)).returning().get();
	if (!updated) throw error(404, 'Column not found');
	if (boardId) emit(boardId, 'update', { type: 'column' });
	return json(updated);
};

export const DELETE: RequestHandler = async ({ params, request, locals }) => {
	const id = Number(params.id);
	let boardId: number | undefined;
	try {
		const data = await request.json();
		boardId = data.boardId;
	} catch {}

	// Enforce admin/owner for column deletion
	if (boardId && locals.user) {
		const role = getBoardRole(locals.user, boardId);
		if (role !== 'admin' && role !== 'owner') {
			throw error(403, 'Only board owners and admins can delete columns');
		}
	}

	db.delete(columns).where(eq(columns.id, id)).run();
	if (boardId) emit(boardId, 'update', { type: 'column' });
	return json({ success: true });
};
