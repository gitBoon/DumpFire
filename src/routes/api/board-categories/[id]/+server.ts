import { json, error } from '@sveltejs/kit';
import { db } from '$lib/server/db';
import { boardCategories } from '$lib/server/db/schema';
import { eq } from 'drizzle-orm';
import { inTransaction } from '$lib/server/db/transaction';
import { pathId, readBody, readColour, readText } from '$lib/server/request-body';
import { requireBoardCategoryEdit, requireUser } from '$lib/server/route-guards';
import type { RequestHandler } from './$types';

export const PUT: RequestHandler = async ({ params, request, locals }) => {
	const user = requireUser(locals.user);
	const id = pathId(params.id, 'category');
	const body = await readBody(request);

	const updated = inTransaction(() => {
		// Renaming a grouping changes how every board filed under it is shown.
		// The boards filed under it are read in the transaction that renames it.
		const grouping = requireBoardCategoryEdit(user, id);

		const updates: Partial<typeof boardCategories.$inferInsert> = {};
		const name = readText(body, 'name', { trim: true, min: 1, max: 200, keep: grouping.name });
		if (name !== undefined) updates.name = name;
		const color = readColour(body, 'color', { keep: grouping.color });
		if (color !== undefined) updates.color = color;
		if (Object.keys(updates).length === 0) throw error(400, 'No valid fields to update');

		return db.update(boardCategories).set(updates).where(eq(boardCategories.id, id)).returning().get();
	});
	return json(updated);
};

export const DELETE: RequestHandler = async ({ params, locals }) => {
	const id = pathId(params.id, 'category');

	requireBoardCategoryEdit(locals.user, id);

	db.delete(boardCategories).where(eq(boardCategories.id, id)).run();
	return json({ success: true });
};
