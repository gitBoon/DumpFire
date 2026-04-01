import { json, error } from '@sveltejs/kit';
import { db } from '$lib/server/db';
import { columns } from '$lib/server/db/schema';
import { eq } from 'drizzle-orm';
import { emit } from '$lib/server/events';
import type { RequestHandler } from './$types';

export const PUT: RequestHandler = async ({ params, request }) => {
	const id = Number(params.id);
	const data = await request.json();
	const { boardId, ...updateData } = data;
	const updated = db.update(columns).set(updateData).where(eq(columns.id, id)).returning().get();
	if (!updated) throw error(404, 'Column not found');
	if (boardId) emit(boardId, 'update', { type: 'column' });
	return json(updated);
};

export const DELETE: RequestHandler = async ({ params, request }) => {
	const id = Number(params.id);
	let boardId: number | undefined;
	try {
		const data = await request.json();
		boardId = data.boardId;
	} catch {}
	db.delete(columns).where(eq(columns.id, id)).run();
	if (boardId) emit(boardId, 'update', { type: 'column' });
	return json({ success: true });
};
