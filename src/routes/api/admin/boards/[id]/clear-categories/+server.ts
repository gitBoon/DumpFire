import { json } from '@sveltejs/kit';
import { db } from '$lib/server/db';
import { categories } from '$lib/server/db/schema';
import { eq } from 'drizzle-orm';
import { pathId } from '$lib/server/request-body';
import { requireAdmin, requireBoard } from '$lib/server/route-guards';
import { writeAs } from '$lib/server/write-as';
import type { RequestHandler } from './$types';

export const POST: RequestHandler = async ({ params, locals }) => {
	requireAdmin(locals.user);

	const boardId = pathId(params.id, 'board');
	// One statement, which takes every category of the board, and with each the
	// category of every card that had it: the key on `cards.category_id` sets
	// it to NULL. In a transaction so that it is all of that or none of it,
	// which asks first whether the session is still open and who its account is
	// now (card 2253). The board is looked for in it first: one that is not
	// there is `404 Board not found` (card 2211), where it was 200 for clearing
	// nothing.
	writeAs(locals, (caller) => {
		const admin = requireAdmin(caller);
		requireBoard(admin, boardId, 'edit');
		db.delete(categories).where(eq(categories.boardId, boardId)).run();
	});
	return json({ success: true });
};
