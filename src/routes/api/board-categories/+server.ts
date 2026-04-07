import { json } from '@sveltejs/kit';
import { db } from '$lib/server/db';
import { boardCategories } from '$lib/server/db/schema';
import { eq, asc } from 'drizzle-orm';
import type { RequestHandler } from './$types';

export const GET: RequestHandler = async () => {
	const all = db.select().from(boardCategories).orderBy(asc(boardCategories.name)).all();
	return json(all);
};

export const POST: RequestHandler = async ({ request }) => {
	const { name, color } = await request.json();
	const category = db
		.insert(boardCategories)
		.values({
			name: name || 'New Category',
			color: color || '#6366f1'
		})
		.returning()
		.get();
	return json(category, { status: 201 });
};
