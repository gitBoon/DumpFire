/**
 * decision-card-link-writes.ts — a card linked to a decision and unlinked
 * from it (`linkCard`, `unlinkCard`) (card 2680), by an editor of the
 * decision's board who can edit the card's. Card 2713 moved them here from
 * the former decision service, unchanged (D1), beside decision-cards.ts,
 * which reads both
 * sides of a link and holds the limits these writes ask.
 *
 * Each writes its activity entry on the card's board, naming the card and no
 * decision, and touches no decision row, so that no revision moves. Deleting
 * a linked decision leaves an entry on each linked card's board
 * (decision-lifecycle-writes.ts's `deleteDecision`).
 *
 * Card 2682 adds the API v1 routes, which call `linkCard` and `unlinkCard`
 * with `source: 'api'`.
 *
 * Each write has the one shape of a service, and the record, the activity
 * entry, the live event and the mail are written as decision-write-shared.ts's
 * header says.
 */
import { error } from '@sveltejs/kit';
import { and, eq } from 'drizzle-orm';
import { db } from './db';
import { decisionCardLinks } from './db/schema';
import type { SessionUser } from './auth';
import { requireTransition } from './decision-status';
import { ACTIONS, logActivity } from './logActivity';
import { CARD_LINK_RELATIONS, cardLinkCountOf, LINKS_PER_CARD, LINKS_PER_DECISION, linkCountOf, type CardLinkRelation } from './decision-cards';
import type { LinkOutcome } from '$lib/decision-register-types';
import { requireCard, requireDecision, requireUser } from './route-guards';
import { stamp } from '$lib/timestamps';
import { inWrite, type ServiceOptions } from './write-as';
import { decisionEntry } from './decision-write-shared';

/** Neither card-link write has a guard of its own: every export here is a write, and starts with `inWrite()`. */
export const READS: readonly string[] = [];

/**
 * Link a card to the decision (card 2680, decisions 17, 20 to 22). The order
 * of refusals (D11): the decision (`linkCard`: 404, 403), the card
 * (`requireCard(…, 'edit')`: 404, 403), the status (409), the card archived
 * (409, before the link already there is looked for, so that linking an
 * archived card again is refused, not answered as nothing to do), the link
 * already there (the same relation: `unchanged`, nothing written; another:
 * the relation changed, `relation_changed`, the caps not asked), the caps
 * (409, a new link alone), then the link.
 *
 * Neither the link nor the change touches the decision's row, so neither of
 * its revisions moves (decision 20), and neither is on the decision's record.
 * One `decision_card_linked` on the **card's** board with its card, detail "a
 * decision" (S7): no id and no title, which the card's board's readers may
 * not view. No live event, no mail, no webhook.
 */
export function linkCard(
	caller: SessionUser | null,
	at: { decisionId: number; cardId: number; relation: CardLinkRelation },
	body: null,
	opts: ServiceOptions
): { outcome: LinkOutcome } {
	inWrite();
	const user = requireUser(caller);
	const { decision } = requireDecision(user, at.decisionId, 'linkCard');
	const { card, boardId } = requireCard(user, at.cardId, 'edit');

	const now = stamp();
	requireTransition(decision, 'linkCard', now);
	if (card.archivedAt !== null) error(409, 'This card is archived: it cannot be linked to a decision');
	if (!(CARD_LINK_RELATIONS as readonly string[]).includes(at.relation)) error(400, `relation must be one of: ${CARD_LINK_RELATIONS.join(', ')}`);

	const where = and(eq(decisionCardLinks.decisionId, decision.id), eq(decisionCardLinks.cardId, card.id));
	const existing = db.select({ relation: decisionCardLinks.relation }).from(decisionCardLinks).where(where).get();
	if (existing !== undefined) {
		if (existing.relation === at.relation) return { outcome: 'unchanged' };
		db.update(decisionCardLinks).set({ relation: at.relation }).where(where).run();
		logActivity({ action: ACTIONS.decisionCardLinked, ...decisionEntry(boardId, 'a decision', user, opts, card.id) });
		return { outcome: 'relation_changed' };
	}

	// S8: the decision's cap says a count, to an editor of the decision's board alone, and only at the cap.
	if (linkCountOf(decision.id) >= LINKS_PER_DECISION) error(409, `This decision is linked to ${LINKS_PER_DECISION} cards, the most it may be`);
	// Code review S3: the card's cap says no count. The card's links may be to decisions the caller cannot view, and a
	// count would tell them how many there are.
	if (cardLinkCountOf(card.id) >= LINKS_PER_CARD) error(409, 'This card has reached its limit of linked decisions');

	db.insert(decisionCardLinks).values({ decisionId: decision.id, cardId: card.id, relation: at.relation, createdBy: user.id, createdAt: now }).run();
	logActivity({ action: ACTIONS.decisionCardLinked, ...decisionEntry(boardId, 'a decision', user, opts, card.id) });
	return { outcome: 'linked' };
}

/**
 * Unlink a card from the decision (card 2680, decisions 17 and 20): the
 * decision (`unlinkCard`: 404, 403), the card (`requireCard(…, 'edit')`: 404,
 * 403), the status (409: every status but a draft, which holds none), and a
 * link that is not there (404). An archived card may be unlinked. One
 * `decision_card_unlinked` on the card's board with its card, detail "a
 * decision". The decision's row is not touched.
 */
export function unlinkCard(caller: SessionUser | null, at: { decisionId: number; cardId: number }, body: null, opts: ServiceOptions): void {
	inWrite();
	const user = requireUser(caller);
	const { decision } = requireDecision(user, at.decisionId, 'unlinkCard');
	const { card, boardId } = requireCard(user, at.cardId, 'edit');

	requireTransition(decision, 'unlinkCard', stamp());
	const removed = db
		.delete(decisionCardLinks)
		.where(and(eq(decisionCardLinks.decisionId, decision.id), eq(decisionCardLinks.cardId, card.id)))
		.run();
	if (removed.changes === 0) error(404, 'Link not found');
	logActivity({ action: ACTIONS.decisionCardUnlinked, ...decisionEntry(boardId, 'a decision', user, opts, card.id) });
}
