import { readBoardDecisions } from '$lib/server/decision-authoring';
import type { PageServerLoad } from './$types';

/**
 * A board's decisions (card 2676, decisions 13 and 14), from
 * `readBoardDecisions`, which guards itself with `requireBoard(…, 'view')`:
 * every decision that is not a draft to anyone who can view the board, and a
 * draft only to its author, its decider, the board's owners and
 * administrators. 404 `Board not found` for a board that is not there and
 * for one the caller cannot open alike (card 2719), which the page's error
 * page shows.
 */
export const load: PageServerLoad = async ({ params, locals }) => {
	return readBoardDecisions(locals.user!, Number(params.id));
};
