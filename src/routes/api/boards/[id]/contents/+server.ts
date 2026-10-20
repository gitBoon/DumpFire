import { json, error } from '@sveltejs/kit';
import { pathId } from '$lib/server/request-body';
import { readBoardContents } from '$lib/server/board-contents';
import type { RequestHandler } from './$types';

/**
 * GET /api/boards/[id]/contents — everything the board page draws, for the
 * page to refresh itself with instead of re-running its whole load (card
 * 2280, slice B1 of card 2012's part B).
 *
 * The same reader as the page's load, so the same answer and the same
 * refusals: 404 for a board that is not there, administrators included, then
 * 403 for one the caller cannot open. The page takes either, or a 401, as the
 * board refused, and shows its load's refusal page.
 *
 * It names what this caller may see on the board and their role on it, so no
 * browser or proxy keeps it: the next caller of the address, or the same one
 * after a role was taken away, is answered afresh.
 */
export const GET: RequestHandler = async ({ params, locals }) => {
	if (!locals.user) throw error(401, 'Not authenticated');
	const boardId = pathId(params.id, 'board');

	return json(readBoardContents(locals.user, boardId), {
		headers: { 'cache-control': 'private, no-store' }
	});
};
