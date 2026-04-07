import { json, error } from '@sveltejs/kit';
import { db } from '$lib/server/db';
import { boardCategories } from '$lib/server/db/schema';
import { eq } from 'drizzle-orm';
import type { RequestHandler } from './$types';

export const PUT: RequestHandler = async ({ params, request }) => {
	const id = Number(params.id);
	const data = await request.json();
	const updated = db.update(boardCategories).set(data).where(eq(boardCategories.id, id)).returning().get();
	if (!updated) throw error(404, 'Board category not found');
	return json(updated);
};

export const DELETE: RequestHandler = async ({ params }) => {
	const id = Number(params.id);
	db.delete(boardCategories).where(eq(boardCategories.id, id)).run();
	return json({ success: true });
};
