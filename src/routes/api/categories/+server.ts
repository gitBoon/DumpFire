import { json } from '@sveltejs/kit';
import { db } from '$lib/server/db';
import { categories } from '$lib/server/db/schema';
import { eq, asc } from 'drizzle-orm';
import { emit } from '$lib/server/events';
import type { RequestHandler } from './$types';

export const GET: RequestHandler = async ({ url }) => {
	const boardId = Number(url.searchParams.get('boardId'));
	if (!boardId) return json([]);
	const all = db.select().from(categories).where(eq(categories.boardId, boardId)).orderBy(asc(categories.name)).all();
	return json(all);
};

export const POST: RequestHandler = async ({ request }) => {
	const { boardId, name, color } = await request.json();
	const category = db
		.insert(categories)
		.values({
			boardId,
			name: name || 'New Category',
			color: color || '#6366f1'
		})
		.returning()
		.get();
	emit(boardId, 'update', { type: 'category' });
	return json(category, { status: 201 });
};
