import { json } from '$lib/server/v1-json';
import { leftMilestoneOf } from '$lib/server/card-moves';
import { sendCard } from '$lib/server/cards';
import { linkBaseUrl } from '$lib/server/email';
import { pathId, readBody } from '$lib/server/request-body';
import { requireUser } from '$lib/server/route-guards';
import { writeAs } from '$lib/server/write-as';
import type { RequestHandler } from './$types';

/**
 * POST /api/v1/cards/:cardId/send — send an option to another delivery board,
 * to its Options column or to its To Do (milestone 22, card 2463).
 *
 * Body: `{ boardId, to: "options" | "todo", position? }`. The card is an
 * option, in an upstream column; committed work is moved with PUT
 * /cards/{cardId}/move instead. Edit access to both boards. Sent to To Do it
 * is committed on arrival. The work, its refusals and its entries are
 * `sendCard` in `$lib/server/cards`, which `POST /api/cards/:id/send` shares.
 *
 * Answered as the move is (`MovedCard`): the card with `columnTitle`,
 * `boardId` and `leftMilestone`.
 */
export const POST: RequestHandler = async ({ params, request, locals, url }) => {
	requireUser(locals.user);
	const cardId = pathId(params.cardId, 'card');

	const body = await readBody(request);
	const baseUrl = linkBaseUrl(url);

	// One transaction, which asks first whether the key or session is still
	// open, and who its account is now (card 2253). The answer is made in it
	// too, from the move.
	const sent = writeAs(locals, (caller) => {
		const move = sendCard(caller, { cardId }, body, { source: 'api', baseUrl });
		return {
			...move.card,
			columnTitle: move.toColumn.title,
			boardId: move.toBoardId,
			leftMilestone: leftMilestoneOf(move)
		};
	});

	return json(sent);
};
