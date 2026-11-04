import { json } from '@sveltejs/kit';
import { db } from '$lib/server/db';
import { categories } from '$lib/server/db/schema';
import { eq } from 'drizzle-orm';
import { whilePasswordHolds } from '$lib/server/auth';
import { pathId, readBody } from '$lib/server/request-body';
import { requireAdmin, requireBoard } from '$lib/server/route-guards';
import { confirmStepUp } from '$lib/server/step-up';
import { writeAs } from '$lib/server/write-as';
import type { RequestHandler } from './$types';

export const POST: RequestHandler = async ({ params, request, locals, cookies }) => {
	requireAdmin(locals.user);

	const boardId = pathId(params.id, 'board');
	const body = await readBody(request);

	// The caller's password, asked for again (card 2701): every card of the
	// board loses its category. A board that is not there, or one the caller
	// cannot edit, is refused first, with no password checked or counted.
	const { userId, hash } = await confirmStepUp(
		locals,
		cookies,
		body,
		'POST /api/admin/boards/[id]/clear-categories',
		(caller) => requireBoard(requireAdmin(caller), boardId, 'edit')
	);

	// One statement, which takes every category of the board, and with each the
	// category of every card that had it: the key on `cards.category_id` sets
	// it to NULL. In a transaction so that it is all of that or none of it,
	// which asks first whether the session is still open and who its account is
	// now (card 2253), and runs only while the stored hash is the one the
	// password was checked against. The board is looked for in it first: one
	// that is not there is `404 Board not found` (card 2211), where it was 200
	// for clearing nothing.
	await whilePasswordHolds(userId, hash, () =>
		writeAs(locals, (caller) => {
			const admin = requireAdmin(caller);
			requireBoard(admin, boardId, 'edit');
			db.delete(categories).where(eq(categories.boardId, boardId)).run();
		}));
	return json({ success: true });
};
