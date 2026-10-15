import { json } from '@sveltejs/kit';
import { db } from '$lib/server/db';
import { boardFavourites } from '$lib/server/db/schema';
import { and, eq } from 'drizzle-orm';
import { requireBoard, requireUser } from '$lib/server/route-guards';
import { pathId } from '$lib/server/request-body';
import type { RequestHandler } from './$types';

export const POST: RequestHandler = async ({ params, locals }) => {
	const user = requireUser(locals.user);
	const boardId = pathId(params.id, 'board');

	const existing = db.select().from(boardFavourites)
		.where(and(eq(boardFavourites.userId, user.id), eq(boardFavourites.boardId, boardId)))
		.get();

	if (existing) {
		// Removing your own favourite never needs access: a board you have since
		// lost access to should not be stuck in your list.
		db.delete(boardFavourites)
			.where(and(eq(boardFavourites.userId, user.id), eq(boardFavourites.boardId, boardId)))
			.run();
		return json({ favourited: false });
	}

	// You can only favourite a board you can open.
	requireBoard(user, boardId, 'view');
	db.insert(boardFavourites)
		.values({ userId: user.id, boardId })
		.run();
	return json({ favourited: true });
};
