import { error } from '@sveltejs/kit';
import { json } from '$lib/server/v1-json';
import { db } from '$lib/server/db';
import { boardCategories } from '$lib/server/db/schema';
import { eq } from 'drizzle-orm';
import { requireBoardCategory, requireBoardCategoryEdit, requireUser } from '$lib/server/route-guards';
import { writeAs } from '$lib/server/write-as';
import { pathId, readBody, readColour, readText } from '$lib/server/request-body';
import type { RequestHandler } from './$types';

/**
 * GET /api/v1/board-categories/:categoryId — one board category, if the key's
 * user is listed it: it holds a board they can open, or none (card 2128).
 * 404 for none, 403 "No access to this board category" otherwise: any key was
 * given any grouping by its id.
 */
export const GET: RequestHandler = async ({ params, locals }) => {
	if (!locals.user) throw error(401, 'Not authenticated');

	const categoryId = pathId(params.categoryId, 'category');

	return json(requireBoardCategory(locals.user, categoryId));
};

/** PUT /api/v1/board-categories/:categoryId — Update a board category. */
export const PUT: RequestHandler = async ({ params, request, locals }) => {
	requireUser(locals.user);
	const categoryId = pathId(params.categoryId, 'category');
	const body = await readBody(request);

	const updated = writeAs(locals, (caller) => {
		// Renaming a grouping changes how every board filed under it is shown.
		// The boards filed under it are read in the transaction that renames it,
		// which asks first whether the key or session is still open, and who its
		// account is now (card 2253).
		const grouping = requireBoardCategoryEdit(caller, categoryId);

		const updateData: Partial<typeof boardCategories.$inferInsert> = {};
		const name = readText(body, 'name', {
			trim: true,
			min: 1,
			max: 200,
			keep: grouping.name,
			says: { empty: 'name cannot be empty' }
		});
		if (name !== undefined) updateData.name = name;
		const color = readColour(body, 'color', { keep: grouping.color });
		if (color !== undefined) updateData.color = color;

		if (Object.keys(updateData).length === 0) {
			throw error(400, 'No valid fields to update');
		}

		return db.update(boardCategories)
			.set(updateData)
			.where(eq(boardCategories.id, categoryId))
			.returning()
			.get();
	});

	return json(updated);
};

/** DELETE /api/v1/board-categories/:categoryId — Delete a board category. */
export const DELETE: RequestHandler = async ({ params, locals }) => {
	requireUser(locals.user);

	const categoryId = pathId(params.categoryId, 'category');

	// The grouping read, the caller checked and the grouping deleted in one
	// transaction that asks first whether the key or session is still open, and
	// who its account is now (card 2253). The check and the delete were two
	// steps with no transaction around them.
	writeAs(locals, (caller) => {
		requireBoardCategoryEdit(caller, categoryId);

		db.delete(boardCategories).where(eq(boardCategories.id, categoryId)).run();
	});

	return json({ success: true });
};
