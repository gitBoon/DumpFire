import { json, error } from '@sveltejs/kit';
import { db } from '$lib/server/db';
import { categories } from '$lib/server/db/schema';
import { eq } from 'drizzle-orm';
import { emit } from '$lib/server/events';
import type { RequestHandler } from './$types';

export const PUT: RequestHandler = async ({ params, request, locals }) => {
	if (!locals.user) throw error(401, 'Not authenticated');

	const id = Number(params.id);
	const data = await request.json();
	const { boardId, ...rawData } = data;

	// Whitelist allowed fields
	const updateData: Record<string, unknown> = {};
	if ('name' in rawData) updateData.name = rawData.name;
	if ('color' in rawData) updateData.color = rawData.color;

	const updated = db.update(categories).set(updateData).where(eq(categories.id, id)).returning().get();
	if (!updated) throw error(404, 'Category not found');
	if (boardId) emit(boardId, 'update', { type: 'category' });
	return json(updated);
};

export const DELETE: RequestHandler = async ({ params, request, locals }) => {
	if (!locals.user) throw error(401, 'Not authenticated');

	const id = Number(params.id);
	let boardId: number | undefined;
	try {
		const data = await request.json();
		boardId = data.boardId;
	} catch {}
	db.delete(categories).where(eq(categories.id, id)).run();
	if (boardId) emit(boardId, 'update', { type: 'category' });
	return json({ success: true });
};
