import { json, error } from '@sveltejs/kit';
import { db } from '$lib/server/db';
import { columns } from '$lib/server/db/schema';
import { eq } from 'drizzle-orm';
import { emit } from '$lib/server/events';
import { canEditBoard } from '$lib/server/board-access';
import type { RequestHandler } from './$types';

export const PUT: RequestHandler = async ({ request, locals }) => {
	if (!locals.user) throw error(401, 'Not authenticated');

	const { updates, boardId } = await request.json();

	// Verify board access — editors, owners, and admins can reorder columns
	if (boardId && !canEditBoard(locals.user, boardId)) {
		throw error(403, 'No edit access to this board');
	}

	for (const update of updates) {
		db.update(columns).set({ position: update.position }).where(eq(columns.id, update.id)).run();
	}
	if (boardId) emit(boardId, 'update', { type: 'column' });
	return json({ success: true });
};
