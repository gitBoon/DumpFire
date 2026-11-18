import { readBoardContents } from '$lib/server/board-contents';
import type { PageServerLoad } from './$types';

/**
 * Everything the board page draws, from the one reader the page's refresh
 * reads too (`GET /api/boards/[id]/contents`, card 2280): the first draw and
 * every refresh cannot then differ. 404 `Board not found` for a board that is
 * not there and for one the caller cannot open alike (card 2719), which the
 * page's error page shows.
 */
export const load: PageServerLoad = async ({ params, locals }) => {
	return readBoardContents(locals.user!, Number(params.id));
};
