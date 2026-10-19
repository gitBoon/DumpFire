import { json } from '@sveltejs/kit';
import { db } from '$lib/server/db';
import { boardFavourites } from '$lib/server/db/schema';
import { and, eq } from 'drizzle-orm';
import { requireBoard, requireUser } from '$lib/server/route-guards';
import { pathId } from '$lib/server/request-body';
import { writeAs } from '$lib/server/write-as';
import type { RequestHandler } from './$types';

export const POST: RequestHandler = async ({ params, locals }) => {
	requireUser(locals.user);
	const boardId = pathId(params.id, 'board');

	// The favourite read and turned over in one transaction that asks first
	// whether the session is still open, and who its account is now (card
	// 2253). The read and the write were steps with no transaction around them.
	const favourited = writeAs(locals, (caller) => {
		const user = requireUser(caller);
		const existing = db.select().from(boardFavourites)
			.where(and(eq(boardFavourites.userId, user.id), eq(boardFavourites.boardId, boardId)))
			.get();

		if (existing) {
			// Removing your own favourite never needs access: a board you have since
			// lost access to should not be stuck in your list.
			db.delete(boardFavourites)
				.where(and(eq(boardFavourites.userId, user.id), eq(boardFavourites.boardId, boardId)))
				.run();
			return false;
		}

		// You can only favourite a board you can open.
		requireBoard(user, boardId, 'view');
		db.insert(boardFavourites)
			.values({ userId: user.id, boardId })
			.run();
		return true;
	});
	return json({ favourited });
};
