import { json } from '@sveltejs/kit';
import { whilePasswordHolds } from '$lib/server/auth';
import { clearBoardCards } from '$lib/server/deletes';
import { pathId, readBody } from '$lib/server/request-body';
import { requireAdmin, requireBoard } from '$lib/server/route-guards';
import { confirmStepUp } from '$lib/server/step-up';
import { writeAs } from '$lib/server/write-as';
import type { RequestHandler } from './$types';

export const POST: RequestHandler = async ({ params, request, locals, cookies }) => {
	requireAdmin(locals.user);

	const boardId = pathId(params.id, 'board');
	const body = await readBody(request);

	// The caller's password, asked for again (card 2701): the cards cannot be
	// brought back. A board that is not there, or one the caller cannot edit,
	// is refused first, with no password checked or counted.
	const { userId, hash } = await confirmStepUp(
		locals,
		cookies,
		body,
		'POST /api/admin/boards/[id]/clear-cards',
		(caller) => requireBoard(requireAdmin(caller), boardId, 'edit')
	);

	// One transaction, in which the board is looked for and its cards are found
	// and deleted with their dependency links, their sub-boards and everything
	// on those (`clearBoardCards` runs its own as a part of it). A board that is
	// not there is `404 Board not found`, as every board route answers it (card
	// 2211): it was 200, and the admin page said its cards were cleared. Anyone
	// but an administrator is refused above, before anything is read, and again
	// in the transaction, which asks first whether the session is still open and
	// who its account is now (card 2253). It runs only while the stored hash is
	// the one the password was checked against. The files of their attachments
	// go to the trash once it is committed. See $lib/server/deletes.ts.
	await whilePasswordHolds(userId, hash, () =>
		writeAs(locals, (caller) => {
			const admin = requireAdmin(caller);
			requireBoard(admin, boardId, 'edit');
			clearBoardCards(boardId, admin);
		}));

	return json({ success: true });
};
