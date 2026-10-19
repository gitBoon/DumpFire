import { json } from '@sveltejs/kit';
import { clearBoardCards } from '$lib/server/deletes';
import { pathId } from '$lib/server/request-body';
import { requireAdmin, requireBoard } from '$lib/server/route-guards';
import { writeAs } from '$lib/server/write-as';
import type { RequestHandler } from './$types';

export const POST: RequestHandler = async ({ params, locals }) => {
	requireAdmin(locals.user);

	const boardId = pathId(params.id, 'board');

	// One transaction, in which the board is looked for and its cards are found
	// and deleted with their dependency links, their sub-boards and everything
	// on those (`clearBoardCards` runs its own as a part of it). A board that is
	// not there is `404 Board not found`, as every board route answers it (card
	// 2211): it was 200, and the admin page said its cards were cleared. Anyone
	// but an administrator is refused above, before anything is read, and again
	// in the transaction, which asks first whether the session is still open and
	// who its account is now (card 2253). The files of their attachments go to
	// the trash once it is committed. See $lib/server/deletes.ts.
	writeAs(locals, (caller) => {
		const admin = requireAdmin(caller);
		requireBoard(admin, boardId, 'edit');
		clearBoardCards(boardId, admin);
	});

	return json({ success: true });
};
