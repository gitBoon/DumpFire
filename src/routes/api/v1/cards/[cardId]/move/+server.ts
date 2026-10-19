import { json } from '$lib/server/v1-json';
import { requireUser } from '$lib/server/route-guards';
import { writeAs } from '$lib/server/write-as';
import { leftMilestoneOf } from '$lib/server/card-moves';
import { moveCard } from '$lib/server/cards';
import { linkBaseUrl } from '$lib/server/email';
import { pathId, readBody } from '$lib/server/request-body';
import type { RequestHandler } from './$types';

/**
 * PUT /api/v1/cards/:cardId/move — Move a card to a different column.
 *
 * Body: { columnId: number, position?: number }
 *
 * Supports both within-board and cross-board moves. For cross-board moves,
 * the user must have edit access to both the source and target boards. The
 * source board's labels are removed from the card, and so is a category that
 * belongs to another board; a shared category stays.
 *
 * Completion, reopening, XP and the activity entry are handled by the same
 * service as a drag in the web UI — see `$lib/server/card-moves`.
 *
 * `columnId` is an id and `position` a number, or one written as text: a
 * position that was not a number used to be ignored, and the card kept the
 * position it had (`request.position ?? before.position` in card-moves.ts).
 * It is a 400 now.
 *
 * A move to another board takes the card out of a milestone of the board it
 * left (card 2155), and the answer names that milestone as `leftMilestone`,
 * null otherwise (the review's O3).
 *
 * The work is `moveCard` in `$lib/server/cards`, which shares its moves with
 * the internal reorder (card 2012).
 */
export const PUT: RequestHandler = async ({ params, request, locals, url }) => {
	requireUser(locals.user);
	const cardId = pathId(params.cardId, 'card');

	const body = await readBody(request);
	const baseUrl = linkBaseUrl(url);

	// One transaction: both access checks read the rows the move then changes,
	// and the move, its activity entry and the "Unblocked" notices are saved
	// together or not at all. It asks first whether the key or session is
	// still open, and who its account is now (card 2253). The answer is made
	// in it too, from the move.
	const moved = writeAs(locals, (caller) => {
		const move = moveCard(caller, { cardId }, body, { source: 'api', baseUrl });
		return {
			...move.card,
			columnTitle: move.toColumn.title,
			boardId: move.toBoardId,
			leftMilestone: leftMilestoneOf(move)
		};
	});

	return json(moved);
};
