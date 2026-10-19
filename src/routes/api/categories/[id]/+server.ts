import { json, error } from '@sveltejs/kit';
import { db } from '$lib/server/db';
import { categories } from '$lib/server/db/schema';
import { eq } from 'drizzle-orm';
import { emit } from '$lib/server/events';
import { pathId, readBody, readColour, readText } from '$lib/server/request-body';
import { requireCategoryEdit, requireUser } from '$lib/server/route-guards';
import { writeAs } from '$lib/server/write-as';
import type { RequestHandler } from './$types';

export const PUT: RequestHandler = async ({ params, request, locals }) => {
	requireUser(locals.user);
	const id = pathId(params.id, 'category');
	const body = await readBody(request);

	const updated = writeAs(locals, (caller) => {
		// Checked against the board the category belongs to, read from its row,
		// in the transaction that changes it, which asks first whether the
		// session is still open, and who its account is now (card 2253).
		const user = requireUser(caller);
		const category = requireCategoryEdit(user, id);

		const updates: Partial<typeof categories.$inferInsert> = {};
		const name = readText(body, 'name', { trim: true, min: 1, max: 200, keep: category.name });
		if (name !== undefined) updates.name = name;
		const color = readColour(body, 'color', { keep: category.color });
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

	// The category read, the caller checked and the category deleted in one
	// transaction that asks first whether the session is still open, and who
	// its account is now (card 2253). The check and the delete were two steps
	// with no transaction around them.
	writeAs(locals, (caller) => {
		const category = requireCategoryEdit(caller, id);

		db.delete(categories).where(eq(categories.id, id)).run();
		if (category.boardId) emit(category.boardId, 'update', { type: 'category' });
	});
	return json({ success: true });
};
