import { json } from '$lib/server/v1-json';
import { linkedCardsFor } from '$lib/server/decision-cards';
import { linkCard, unlinkCard } from '$lib/server/decision-card-link-writes';
import { pathId } from '$lib/server/request-body';
import { requireUser } from '$lib/server/route-guards';
import { writeAs } from '$lib/server/write-as';
import type { RequestHandler } from './$types';

/**
 * PUT /api/v1/decisions/:decisionId/cards/:cardId — link a card to a decision
 * (card 2682, D18; card 2680, decisions 17 to 22): edit access to the
 * decision's board, or an administrator's where it has none, and edit access
 * to the card's. No body is read: the relation is `relates`. Linking a card
 * already linked writes nothing. A link written is recorded on the card's
 * board's activity, through the API. The answer is `{ outcome, linkedCards }`,
 * the cards as v1's card routes answer cards: board cards, not marked.
 */
export const PUT: RequestHandler = async ({ params, locals }) => {
	requireUser(locals.user);
	const id = pathId(params.decisionId, 'decision');
	const cardId = pathId(params.cardId, 'card');

	const answer = writeAs(locals, (caller) => {
		const { outcome } = linkCard(caller, { decisionId: id, cardId, relation: 'relates' }, null, { source: 'api' });
		return { outcome, linkedCards: linkedCardsFor(requireUser(caller), { id }) };
	});
	return json(answer);
};

/**
 * DELETE /api/v1/decisions/:decisionId/cards/:cardId — unlink a card from a
 * decision: the same access as linking, and a link that is not there is 404
 * `Link not found`. Recorded on the card's board's activity, through the API.
 * The answer is `{ linkedCards }`.
 */
export const DELETE: RequestHandler = async ({ params, locals }) => {
	requireUser(locals.user);
	const id = pathId(params.decisionId, 'decision');
	const cardId = pathId(params.cardId, 'card');

	const answer = writeAs(locals, (caller) => {
		unlinkCard(caller, { decisionId: id, cardId }, null, { source: 'api' });
		return { linkedCards: linkedCardsFor(requireUser(caller), { id }) };
	});
	return json(answer);
};
