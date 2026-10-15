import { json, error } from '@sveltejs/kit';
import { db } from '$lib/server/db';
import { categories } from '$lib/server/db/schema';
import { eq } from 'drizzle-orm';
import { emit } from '$lib/server/events';
import { inTransaction } from '$lib/server/db/transaction';
import { pathId, readBody, readText } from '$lib/server/request-body';
import { requireCategoryEdit, requireUser } from '$lib/server/route-guards';
import type { RequestHandler } from './$types';

export const PUT: RequestHandler = async ({ params, request, locals }) => {
	const user = requireUser(locals.user);
	const id = pathId(params.id, 'category');
	const body = await readBody(request);

	const updated = inTransaction(() => {
		// Checked against the board the category belongs to, read from its row,
		// in the transaction that changes it.
		const category = requireCategoryEdit(user, id);

		const updates: Partial<typeof categories.$inferInsert> = {};
		const name = readText(body, 'name', { trim: true, min: 1, max: 200, keep: category.name });
		if (name !== undefined) updates.name = name;
		const color = readText(body, 'color', { min: 1, max: 32, keep: category.color });
		if (color !== undefined) updates.color = color;
		if (Object.keys(updates).length === 0) throw error(400, 'No valid fields to update');

		const row = db.update(categories).set(updates).where(eq(categories.id, id)).returning().get();
		if (category.boardId) emit(category.boardId, 'update', { type: 'category' });
		return row;
	});
	return json(updated);
};

export const DELETE: RequestHandler = async ({ params, locals }) => {
	const id = pathId(params.id, 'category');

	const category = requireCategoryEdit(locals.user, id);

	db.delete(categories).where(eq(categories.id, id)).run();
	if (category.boardId) emit(category.boardId, 'update', { type: 'category' });
	return json({ success: true });
};
