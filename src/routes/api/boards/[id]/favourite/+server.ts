import { json } from '@sveltejs/kit';
import { db } from '$lib/server/db';
import { boardFavourites } from '$lib/server/db/schema';
import { and, eq } from 'drizzle-orm';
import type { RequestHandler } from './$types';

export const POST: RequestHandler = async ({ params, locals }) => {
	const boardId = Number(params.id);
	const user = locals.user!;

	const existing = db.select().from(boardFavourites)
		.where(and(eq(boardFavourites.userId, user.id), eq(boardFavourites.boardId, boardId)))
		.get();

	if (existing) {
		db.delete(boardFavourites)
			.where(and(eq(boardFavourites.userId, user.id), eq(boardFavourites.boardId, boardId)))
			.run();
		return json({ favourited: false });
	} else {
		db.insert(boardFavourites)
			.values({ userId: user.id, boardId })
			.run();
		return json({ favourited: true });
	}
};
