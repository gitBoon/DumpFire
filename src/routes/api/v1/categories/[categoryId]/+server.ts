import { json, error } from '@sveltejs/kit';
import { db } from '$lib/server/db';
import { categories, cards, columns } from '$lib/server/db/schema';
import { eq } from 'drizzle-orm';
import { canEditBoard } from '$lib/server/board-access';
import { emit } from '$lib/server/events';
import type { RequestHandler } from './$types';

/**
 * Resolve the board that owns a category, verifying it exists.
 */
function getCategoryWithBoard(categoryId: number) {
	const category = db.select().from(categories).where(eq(categories.id, categoryId)).get();
	if (!category) return null;
	return category;
}

/** GET /api/v1/categories/:categoryId — Get a single category. */
export const GET: RequestHandler = async ({ params, locals }) => {
	if (!locals.user) throw error(401, 'Not authenticated');

	const categoryId = Number(params.categoryId);
	if (isNaN(categoryId)) throw error(400, 'Invalid category ID');

	const category = getCategoryWithBoard(categoryId);
	if (!category) throw error(404, 'Category not found');

	return json(category);
};

/** PUT /api/v1/categories/:categoryId — Update a category. */
export const PUT: RequestHandler = async ({ params, request, locals }) => {
	if (!locals.user) throw error(401, 'Not authenticated');

	const categoryId = Number(params.categoryId);
	if (isNaN(categoryId)) throw error(400, 'Invalid category ID');

	const category = getCategoryWithBoard(categoryId);
	if (!category) throw error(404, 'Category not found');

	// If the category is scoped to a board, check edit access
	if (category.boardId && !canEditBoard(locals.user, category.boardId)) {
		throw error(403, 'No edit access to this board');
	}

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

	const updated = db.update(categories)
		.set(updateData)
		.where(eq(categories.id, categoryId))
		.returning()
		.get();

	if (category.boardId) emit(category.boardId, 'update', { type: 'category' });

	return json(updated);
};

/** DELETE /api/v1/categories/:categoryId — Delete a category. */
export const DELETE: RequestHandler = async ({ params, locals }) => {
	if (!locals.user) throw error(401, 'Not authenticated');

	const categoryId = Number(params.categoryId);
	if (isNaN(categoryId)) throw error(400, 'Invalid category ID');

	const category = getCategoryWithBoard(categoryId);
	if (!category) throw error(404, 'Category not found');

	if (category.boardId && !canEditBoard(locals.user, category.boardId)) {
		throw error(403, 'No edit access to this board');
	}

	db.delete(categories).where(eq(categories.id, categoryId)).run();

	if (category.boardId) emit(category.boardId, 'update', { type: 'category' });

	return json({ success: true });
};
