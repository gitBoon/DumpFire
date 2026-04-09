import { json, error } from '@sveltejs/kit';
import { db } from '$lib/server/db';
import { cards, subtasks, columns } from '$lib/server/db/schema';
import { eq, inArray } from 'drizzle-orm';
import type { RequestHandler } from './$types';

export const POST: RequestHandler = async ({ params, locals }) => {
	if (!locals.user || (locals.user.role !== 'admin' && locals.user.role !== 'superadmin')) {
		throw error(403, 'Forbidden');
	}

	const boardId = Number(params.id);
	// Get all column IDs for this board
	const boardCols = db.select({ id: columns.id }).from(columns).where(eq(columns.boardId, boardId)).all();
	const colIds = boardCols.map((c) => c.id);

	if (colIds.length > 0) {
		// Delete all cards in those columns (subtasks cascade)
		for (const colId of colIds) {
			db.delete(cards).where(eq(cards.columnId, colId)).run();
		}
	}

	return json({ success: true });
};
