import { error } from '@sveltejs/kit';
import { json } from '$lib/server/v1-json';
import { db } from '$lib/server/db';
import { categories } from '$lib/server/db/schema';
import { eq } from 'drizzle-orm';
import { requireCategory, requireCategoryEdit, requireUser } from '$lib/server/route-guards';
import { emit } from '$lib/server/events';
import { pathId, readBody, readColour, readText } from '$lib/server/request-body';
import { writeAs } from '$lib/server/write-as';
import type { RequestHandler } from './$types';

/**
 * GET /api/v1/categories/:categoryId — one card category, if it belongs to no
 * board or to a board the key's user can open (card 2128). 404 for none, 403
 * "No access to this category" otherwise: any key was given any category by
 * its id, with the id of its board.
 */
export const GET: RequestHandler = async ({ params, locals }) => {
	if (!locals.user) throw error(401, 'Not authenticated');

	const categoryId = pathId(params.categoryId, 'category');

	return json(requireCategory(locals.user, categoryId));
};

/** PUT /api/v1/categories/:categoryId — Update a category. */
export const PUT: RequestHandler = async ({ params, request, locals }) => {
	requireUser(locals.user);
	const categoryId = pathId(params.categoryId, 'category');
	const body = await readBody(request);

	const updated = writeAs(locals, (caller) => {
		// Edit access to the owning board; a category with no board is admin-only.
		// It used to be open to everyone, so any API key could rename a shared one.
		// Asked in the transaction that changes it, once the body has arrived,
		// which asks first whether the key or session is still open, and who its
		// account is now (card 2253).
		const category = requireCategoryEdit(caller, categoryId);

		const updateData: Partial<typeof categories.$inferInsert> = {};
		const name = readText(body, 'name', {
			trim: true,
			min: 1,
			max: 200,
			keep: category.name,
			says: { empty: 'name cannot be empty' }
		});
		if (name !== undefined) updateData.name = name;
		const color = readColour(body, 'color', { keep: category.color });
		if (color !== undefined) updateData.color = color;

		if (Object.keys(updateData).length === 0) {
			throw error(400, 'No valid fields to update');
		}

		const row = db.update(categories)
			.set(updateData)
			.where(eq(categories.id, categoryId))
			.returning()
			.get();

		if (category.boardId) emit(category.boardId, 'update', { type: 'category' });
		return row;
	});

	return json(updated);
};

/** DELETE /api/v1/categories/:categoryId — Delete a category. */
export const DELETE: RequestHandler = async ({ params, locals }) => {
	requireUser(locals.user);

	const categoryId = pathId(params.categoryId, 'category');

	// The category read, the caller checked and the category deleted in one
	// transaction that asks first whether the key or session is still open, and
	// who its account is now (card 2253). The check and the delete were two
	// steps with no transaction around them. The live update waits for the
	// commit.
	writeAs(locals, (caller) => {
		const category = requireCategoryEdit(caller, categoryId);

		db.delete(categories).where(eq(categories.id, categoryId)).run();

		if (category.boardId) emit(category.boardId, 'update', { type: 'category' });
	});

	return json({ success: true });
};
