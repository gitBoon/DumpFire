import { json, error } from '@sveltejs/kit';
import { db } from '$lib/server/db';
import { boardCategories } from '$lib/server/db/schema';
import { eq } from 'drizzle-orm';
import { pathId, readBody, readColour, readText } from '$lib/server/request-body';
import { requireBoardCategoryEdit, requireUser } from '$lib/server/route-guards';
import { writeAs } from '$lib/server/write-as';
import type { RequestHandler } from './$types';

export const PUT: RequestHandler = async ({ params, request, locals }) => {
	requireUser(locals.user);
	const id = pathId(params.id, 'category');
	const body = await readBody(request);

	const updated = writeAs(locals, (caller) => {
		// Renaming a grouping changes how every board filed under it is shown.
		// The boards filed under it are read in the transaction that renames it,
		// which asks first whether the session is still open, and who its
		// account is now (card 2253).
		const grouping = requireBoardCategoryEdit(caller, id);

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

	// The grouping read, the caller checked and the grouping deleted in one
	// transaction that asks first whether the session is still open, and who
	// its account is now (card 2253). The check and the delete were two steps
	// with no transaction around them.
	writeAs(locals, (caller) => {
		requireBoardCategoryEdit(caller, id);

		db.delete(boardCategories).where(eq(boardCategories.id, id)).run();
	});
	return json({ success: true });
};
