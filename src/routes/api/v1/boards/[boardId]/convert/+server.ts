import { json } from '$lib/server/v1-json';
import { convertBoardFor } from '$lib/server/boards';
import { pathId, readBody } from '$lib/server/request-body';
import { requireUser } from '$lib/server/route-guards';
import { writeAs } from '$lib/server/write-as';
import type { RequestHandler } from './$types';

/**
 * POST /api/v1/boards/:boardId/convert — make a board an ideas board, cards
 * and all (milestone 22, card 2463, ruling i). Body `{ kind: "ideas", cards
 * }`, `cards` being how many cards, live and archived, the board was seen to
 * hold. The work, its refusals and its one activity entry are
 * `convertBoardFor` in `$lib/server/boards`, which `POST
 * /api/boards/:id/convert` shares. The answer is the board with its columns
 * (`BoardDetail`).
 */
export const POST: RequestHandler = async ({ params, request, locals }) => {
	requireUser(locals.user);
	const boardId = pathId(params.boardId, 'board');
	const body = await readBody(request);

	// One transaction, which asks first whether the key or session is still
	// open, and who its account is now (card 2253).
	const converted = writeAs(locals, (caller) => convertBoardFor(caller, { boardId }, body, { source: 'api' }));

	return json(converted);
};
