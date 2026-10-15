import { json, error } from '@sveltejs/kit';
import { clearBoardCards } from '$lib/server/deletes';
import { pathId } from '$lib/server/request-body';
import type { RequestHandler } from './$types';

export const POST: RequestHandler = async ({ params, locals }) => {
	if (!locals.user || (locals.user.role !== 'admin' && locals.user.role !== 'superadmin')) {
		throw error(403, 'Forbidden');
	}

	const boardId = pathId(params.id, 'board');

	// One transaction, in which the board's cards are found and deleted with
	// their dependency links, their sub-boards and everything on those. The
	// files of their attachments go to the trash once it is committed. See
	// $lib/server/deletes.ts.
	clearBoardCards(boardId, locals.user);

	return json({ success: true });
};
