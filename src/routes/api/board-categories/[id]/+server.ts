import { json, error } from '@sveltejs/kit';
import { db } from '$lib/server/db';
import { boardCategories } from '$lib/server/db/schema';
import { eq } from 'drizzle-orm';
import type { RequestHandler } from './$types';

export const PUT: RequestHandler = async ({ params, request, locals }) => {
	if (!locals.user) throw error(401, 'Not authenticated');

	const id = Number(params.id);
	const data = await request.json();

	// Whitelist allowed fields
	const updateData: Record<string, unknown> = {};
	if ('name' in data) updateData.name = data.name;
	if ('color' in data) updateData.color = data.color;

	const updated = db.update(boardCategories).set(updateData).where(eq(boardCategories.id, id)).returning().get();
	if (!updated) throw error(404, 'Board category not found');
	return json(updated);
};

export const DELETE: RequestHandler = async ({ params, locals }) => {
	if (!locals.user) throw error(401, 'Not authenticated');

	const id = Number(params.id);
	db.delete(boardCategories).where(eq(boardCategories.id, id)).run();
	return json({ success: true });
};
