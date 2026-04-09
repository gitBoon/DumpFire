import { json, error } from '@sveltejs/kit';
import { db } from '$lib/server/db';
import { boards, columns } from '$lib/server/db/schema';
import { desc, inArray, eq } from 'drizzle-orm';
import { getAccessibleBoardIds } from '$lib/server/board-access';
import type { RequestHandler } from './$types';

/** GET /api/v1/boards — List all boards accessible to the API key's user. */
export const GET: RequestHandler = async ({ locals }) => {
	if (!locals.user) throw error(401, 'Not authenticated');

	const accessibleIds = getAccessibleBoardIds(locals.user);

	let allBoards: (typeof boards.$inferSelect)[];
	if (accessibleIds === null) {
		// Admin — sees everything
		allBoards = db.select().from(boards).orderBy(desc(boards.createdAt)).all();
	} else if (accessibleIds.length === 0) {
		allBoards = [];
	} else {
		allBoards = db.select().from(boards)
			.where(inArray(boards.id, accessibleIds))
			.orderBy(desc(boards.createdAt))
			.all();
	}

	return json(allBoards);
};
