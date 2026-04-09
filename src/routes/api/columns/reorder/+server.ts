import { json, error } from '@sveltejs/kit';
import { db } from '$lib/server/db';
import { columns } from '$lib/server/db/schema';
import { eq } from 'drizzle-orm';
import { emit } from '$lib/server/events';
import { getBoardRole } from '$lib/server/board-access';
import type { RequestHandler } from './$types';

export const PUT: RequestHandler = async ({ request, locals }) => {
	if (!locals.user) throw error(401, 'Not authenticated');

	const { updates, boardId } = await request.json();

	// Verify board access — only owners/admins can reorder columns
	if (boardId) {
		const role = getBoardRole(locals.user, boardId);
		if (role !== 'admin' && role !== 'owner') {
			throw error(403, 'Only board owners and admins can reorder columns');
		}
	}

	for (const update of updates) {
		db.update(columns).set({ position: update.position }).where(eq(columns.id, update.id)).run();
	}
	if (boardId) emit(boardId, 'update', { type: 'column' });
	return json({ success: true });
};
