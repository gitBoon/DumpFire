import { json } from '@sveltejs/kit';
import { convertBoardFor } from '$lib/server/boards';
import { pathId, readBody } from '$lib/server/request-body';
import { requireUser } from '$lib/server/route-guards';
import { writeAs } from '$lib/server/write-as';
import type { RequestHandler } from './$types';

/**
 * POST /api/boards/:id/convert — make a board an ideas board, cards and all,
 * once the page has asked (milestone 22, card 2463, ruling i).
 *
 * Body: `{ kind: "ideas", cards }`, `cards` being how many cards, live and
 * archived, the page's question named. Only the board's owner or an
 * administrator may. Every card on it becomes an option (its commitment is
 * cleared), its Complete columns, which must be empty, are deleted, and one
 * activity entry says how many cards became ideas. An ideas board already, a
 * card with sub-boards, a sub-board, a card in a Complete column and a count
 * that no longer matches are each 409. The work is `convertBoardFor` in
 * `$lib/server/boards`, which the v1 route shares. The answer is the board
 * with its columns.
 */
export const POST: RequestHandler = async ({ params, request, locals }) => {
	requireUser(locals.user);
	const id = pathId(params.id, 'board');
	const body = await readBody(request);

	// One transaction: the board read, the caller checked, the count compared
	// and every card changed, which asks first whether the session is still
	// open, and who its account is now (card 2253).
	const converted = writeAs(locals, (caller) => convertBoardFor(caller, { boardId: id }, body, { source: 'ui' }));
	return json(converted);
};
