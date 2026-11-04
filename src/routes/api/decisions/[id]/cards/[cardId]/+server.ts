import { json } from '@sveltejs/kit';
import { linkedCardsFor } from '$lib/server/decision-cards';
import { linkCard, unlinkCard } from '$lib/server/decisions';
import { pathId } from '$lib/server/request-body';
import { requireUser } from '$lib/server/route-guards';
import { writeAs } from '$lib/server/write-as';
import type { RequestHandler } from './$types';

/**
 * PUT /api/decisions/:id/cards/:cardId — link a card to a decision (card
 * 2680, decisions 17 to 22): edit access to the decision's board, or an
 * administrator's where it has none, and edit access to the card's. It reads
 * no body: the relation is `relates`, the only one until card 2687 reads one
 * through `CARD_LINK_RELATIONS`. Linking a card already linked writes
 * nothing. The answer is `{ outcome, linkedCards }`, the cards as the
 * decision page lists them to the caller.
 */
export const PUT: RequestHandler = async ({ params, locals }) => {
	requireUser(locals.user);
	const id = pathId(params.id, 'decision');
	const cardId = pathId(params.cardId, 'card');

	const answer = writeAs(locals, (caller) => {
		const { outcome } = linkCard(caller, { decisionId: id, cardId, relation: 'relates' }, null, { source: 'ui' });
		return { outcome, linkedCards: linkedCardsFor(requireUser(caller), { id }) };
	});
	return json(answer);
};

/**
 * DELETE /api/decisions/:id/cards/:cardId — unlink a card from a decision:
 * the same access as linking, and a link that is not there is 404 `Link not
 * found`. The answer is `{ linkedCards }`.
 */
export const DELETE: RequestHandler = async ({ params, locals }) => {
	requireUser(locals.user);
	const id = pathId(params.id, 'decision');
	const cardId = pathId(params.cardId, 'card');

	const answer = writeAs(locals, (caller) => {
		unlinkCard(caller, { decisionId: id, cardId }, null, { source: 'ui' });
		return { linkedCards: linkedCardsFor(requireUser(caller), { id }) };
	});
	return json(answer);
};
