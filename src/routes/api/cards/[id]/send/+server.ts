import { json } from '@sveltejs/kit';
import { leftMilestoneOf } from '$lib/server/card-moves';
import { sendCard } from '$lib/server/cards';
import { linkBaseUrl } from '$lib/server/email';
import { pathId, readBody } from '$lib/server/request-body';
import { requireUser } from '$lib/server/route-guards';
import { writeAs } from '$lib/server/write-as';
import type { RequestHandler } from './$types';

/**
 * POST /api/cards/:id/send — send an option to another delivery board, to its
 * Options column or to its To Do (milestone 22, card 2463).
 *
 * Body: `{ boardId, to: "options" | "todo", position? }`. The card is an
 * option, in an upstream column: a column of an ideas board or a delivery
 * board's Options column. Edit access to both boards. Sent to To Do it is
 * committed on arrival. The board it leaves records `card_sent`, the one it
 * joins `card_moved_in`. Every rule and refusal is `sendCard` in
 * `$lib/server/cards`, which the v1 route shares.
 *
 * Answered as the v1 move is, the card as it now is with `columnTitle`,
 * `boardId` and `leftMilestone`, and `committed`, whether it crossed the
 * commitment point on arrival, for the page to say so.
 */
export const POST: RequestHandler = async ({ params, request, url, locals }) => {
	requireUser(locals.user);
	const id = pathId(params.id, 'card');
	const body = await readBody(request);
	const baseUrl = linkBaseUrl(url);

	// One transaction: both access checks read the rows the move then changes,
	// and the move and its entries are saved together or not at all. It asks
	// first whether the session is still open, and who its account is now
	// (card 2253).
	const sent = writeAs(locals, (caller) => {
		const move = sendCard(caller, { cardId: id }, body, { source: 'ui', baseUrl });
		return { ...move.card, columnTitle: move.toColumn.title, boardId: move.toBoardId, leftMilestone: leftMilestoneOf(move), committed: move.committed };
	});

	return json(sent);
};
