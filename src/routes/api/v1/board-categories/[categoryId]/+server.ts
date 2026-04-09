import { json, error } from '@sveltejs/kit';
import { db } from '$lib/server/db';
import { boardCategories } from '$lib/server/db/schema';
import { eq } from 'drizzle-orm';
import type { RequestHandler } from './$types';

/** GET /api/v1/board-categories/:categoryId — Get a single board category. */
export const GET: RequestHandler = async ({ params, locals }) => {
	if (!locals.user) throw error(401, 'Not authenticated');

	const categoryId = Number(params.categoryId);
	if (isNaN(categoryId)) throw error(400, 'Invalid category ID');

	const category = db.select()
		.from(boardCategories)
		.where(eq(boardCategories.id, categoryId))
		.get();

	if (!category) throw error(404, 'Board category not found');

	return json(category);
};

/** PUT /api/v1/board-categories/:categoryId — Update a board category. */
export const PUT: RequestHandler = async ({ params, request, locals }) => {
	if (!locals.user) throw error(401, 'Not authenticated');

	const categoryId = Number(params.categoryId);
	if (isNaN(categoryId)) throw error(400, 'Invalid category ID');

	const existing = db.select()
		.from(boardCategories)
		.where(eq(boardCategories.id, categoryId))
		.get();

	if (!existing) throw error(404, 'Board category not found');

	const body = await request.json();
	const updateData: Record<string, unknown> = {};

	if ('name' in body) {
		if (!body.name || !body.name.trim()) throw error(400, 'name cannot be empty');
		if (body.name.length > 200) throw error(400, 'Name too long (max 200 chars)');
		updateData.name = body.name.trim();
	}
	if ('color' in body) updateData.color = body.color;

	if (Object.keys(updateData).length === 0) {
		throw error(400, 'No valid fields to update');
	}

	const updated = db.update(boardCategories)
		.set(updateData)
		.where(eq(boardCategories.id, categoryId))
		.returning()
		.get();

	return json(updated);
};

/** DELETE /api/v1/board-categories/:categoryId — Delete a board category. */
export const DELETE: RequestHandler = async ({ params, locals }) => {
	if (!locals.user) throw error(401, 'Not authenticated');

	const categoryId = Number(params.categoryId);
	if (isNaN(categoryId)) throw error(400, 'Invalid category ID');

	const existing = db.select()
		.from(boardCategories)
		.where(eq(boardCategories.id, categoryId))
		.get();

	if (!existing) throw error(404, 'Board category not found');

	db.delete(boardCategories).where(eq(boardCategories.id, categoryId)).run();

	return json({ success: true });
};
