import { json } from '@sveltejs/kit';
import { linkedCardsFor } from '$lib/server/decision-cards';
import { linkCard, unlinkCard } from '$lib/server/decision-card-link-writes';
import { pathId, readOptionalBody } from '$lib/server/request-body';
import { requireUser } from '$lib/server/route-guards';
import { writeAs } from '$lib/server/write-as';
import type { RequestHandler } from './$types';

/**
 * PUT /api/decisions/:id/cards/:cardId — link a card to a decision (card
 * 2680, decisions 17 to 22): edit access to the decision's board, or an
 * administrator's where it has none, and edit access to the card's. Card
 * 2687 (R7): an optional body, `{ relation: 'relates' | 'waits' }`, read only
 * when one is sent; with none, a new link is `relates` and a link already
 * there is left as it is. A body sent with any content type but
 * `application/json`, or one the server never read (chunked, or a length
 * declared, with no content type), is 400, not a 200 that ignored it (S-L3,
 * `readOptionalBody`). Linking a card
 * already linked with the same relation writes nothing. The answer is
 * `{ outcome, linkedCards }`, the cards as the decision page lists them to
 * the caller.
 */
export const PUT: RequestHandler = async ({ params, request, locals }) => {
	requireUser(locals.user);
	const id = pathId(params.id, 'decision');
	const cardId = pathId(params.cardId, 'card');
	// Null when none was sent; a body sent other than as application/json, or one the server never read (chunked, or a
	// length declared, with no content type), is 400 (card 2687, S-L3; review C-S-L1, C-S-L2).
	const body = await readOptionalBody(request);

	const answer = writeAs(locals, (caller) => {
		const { outcome } = linkCard(caller, { decisionId: id, cardId }, body, { source: 'ui' });
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
