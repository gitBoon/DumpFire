import { json, error } from '@sveltejs/kit';
import { db } from '$lib/server/db';
import { boardCategories } from '$lib/server/db/schema';
import { asc } from 'drizzle-orm';
import type { RequestHandler } from './$types';

/** GET /api/v1/board-categories — List all board categories (dashboard grouping). */
export const GET: RequestHandler = async ({ locals }) => {
	if (!locals.user) throw error(401, 'Not authenticated');

	const all = db.select()
		.from(boardCategories)
		.orderBy(asc(boardCategories.name))
		.all();

	return json(all);
};

/** POST /api/v1/board-categories — Create a board category. */
export const POST: RequestHandler = async ({ request, locals }) => {
	if (!locals.user) throw error(401, 'Not authenticated');

	const body = await request.json();
	const { name, color } = body;

	if (!name || !name.trim()) throw error(400, 'name is required');
	if (name.length > 200) throw error(400, 'Name too long (max 200 chars)');

	const category = db
		.insert(boardCategories)
		.values({
			name: name.trim(),
			color: color || '#6366f1'
		})
		.returning()
		.get();

	return json(category, { status: 201 });
};
