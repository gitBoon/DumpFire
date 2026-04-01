import { json } from '@sveltejs/kit';
import { db } from '$lib/server/db';
import { categories } from '$lib/server/db/schema';
import { eq } from 'drizzle-orm';
import type { RequestHandler } from './$types';

export const POST: RequestHandler = async ({ params }) => {
	const boardId = Number(params.id);
	db.delete(categories).where(eq(categories.boardId, boardId)).run();
	return json({ success: true });
};
