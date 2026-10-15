import { json, error } from '@sveltejs/kit';
import { db } from '$lib/server/db';
import { inTransaction } from '$lib/server/db/transaction';
import { categories } from '$lib/server/db/schema';
import { eq } from 'drizzle-orm';
import { pathId } from '$lib/server/request-body';
import { requireBoard } from '$lib/server/route-guards';
import type { RequestHandler } from './$types';

export const POST: RequestHandler = async ({ params, locals }) => {
	if (!locals.user || (locals.user.role !== 'admin' && locals.user.role !== 'superadmin')) {
		throw error(403, 'Forbidden');
	}
	const admin = locals.user;

	const boardId = pathId(params.id, 'board');
	// One statement, which takes every category of the board, and with each the
	// category of every card that had it: the key on `cards.category_id` sets
	// it to NULL. In a transaction so that it is all of that or none of it.
	// The board is looked for in it first: one that is not there is
	// `404 Board not found` (card 2211), where it was 200 for clearing nothing.
	inTransaction(() => {
		requireBoard(admin, boardId, 'edit');
		db.delete(categories).where(eq(categories.boardId, boardId)).run();
	});
	return json({ success: true });
};
