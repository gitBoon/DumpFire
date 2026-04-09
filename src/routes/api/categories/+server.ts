import { json, error } from '@sveltejs/kit';
import { db } from '$lib/server/db';
import { categories } from '$lib/server/db/schema';
import { asc } from 'drizzle-orm';
import { emit } from '$lib/server/events';
import type { RequestHandler } from './$types';

export const GET: RequestHandler = async ({ locals }) => {
	if (!locals.user) throw error(401, 'Not authenticated');

	// Categories are global — return all
	const all = db.select().from(categories).orderBy(asc(categories.name)).all();
	return json(all);
};

export const POST: RequestHandler = async ({ request, locals }) => {
	if (!locals.user) throw error(401, 'Not authenticated');

	const { boardId, name, color } = await request.json();
	const category = db
		.insert(categories)
		.values({
			boardId: boardId || null,
			name: name || 'New Category',
			color: color || '#6366f1'
		})
		.returning()
		.get();
	if (boardId) emit(boardId, 'update', { type: 'category' });
	return json(category, { status: 201 });
};
