import { json } from '@sveltejs/kit';
import { db } from '$lib/server/db';
import { columns } from '$lib/server/db/schema';
import { eq } from 'drizzle-orm';
import { emit } from '$lib/server/events';
import type { RequestHandler } from './$types';

export const PUT: RequestHandler = async ({ request }) => {
	const { updates, boardId } = await request.json();
	for (const update of updates) {
		db.update(columns).set({ position: update.position }).where(eq(columns.id, update.id)).run();
	}
	if (boardId) emit(boardId, 'update', { type: 'column' });
	return json({ success: true });
};
