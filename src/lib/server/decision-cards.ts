/**
 * decision-cards.ts — what is read of the links between cards and decisions
 * (card 2680, decisions 17 to 23, 32): the decision page's linked cards, the
 * card window's linked decisions, and the batch read card 2687's plan view
 * builds on; and the limits the writes in decisions.ts ask.
 *
 * Each side shows only what the viewer can see of the other (decision 18):
 * the decision page lists a linked card only on a board the viewer can open
 * now, and the card window a linked decision only where the viewer may view
 * it (`visibleDecisionIdsOf`). The rest are left out, with no count, and
 * neither side names who linked it. A link holder is given no linked cards.
 *
 * `decisionLinksOfCardsUnchecked` checks no access: it is the shared read
 * behind the card window and card 2687's plan view, which ask
 * `visibleDecisionIdsOf` of what it answers. A scan pins its callers to this
 * file (tests/decision-card-links.test.ts, case 111); each later caller adds
 * itself there.
 *
 * A plain read module, not a service: it takes the signed-in account, `user:
 * SessionUser`, never `caller`, imports no `inWrite` and writes nothing, so
 * that a page load may call it (tests/check-at-the-write.test.ts, rule 4).
 */
import { and, asc, count, eq, inArray } from 'drizzle-orm';
import { db } from './db';
import { boards, cards, columns, decisionCardLinks, decisions, type Decision } from './db/schema';
import type { SessionUser } from './auth';
import { getAccessibleBoardIds } from './board-access';
import { IDS_AT_ONCE } from './decision-record';
import { visibleDecisionIdsOf } from './decision-register';
import { listedStatusOf } from './decision-status';
import { requireCard, requireUser } from './route-guards';
import type { LinkedCardView, LinkedDecisionView } from '$lib/decision-register-types';
import type { ShownStatus } from '$lib/decision-view-types';
import { stamp, type Stamp } from '$lib/timestamps';

/** The most cards one decision may be linked to (decision 21). */
export const LINKS_PER_DECISION = 100;

/** The most decisions one card may be linked to (decision 21). */
export const LINKS_PER_CARD = 20;

/** The relations a link may hold (decision 21, D2): `relates` alone until card 2687 adds `waits`. */
export const CARD_LINK_RELATIONS = ['relates'] as const;

export type CardLinkRelation = (typeof CARD_LINK_RELATIONS)[number];

/** A stored relation as it is read back: one outside `CARD_LINK_RELATIONS` is `relates` (decision 21). */
export function relationOf(stored: string): CardLinkRelation {
	return (CARD_LINK_RELATIONS as readonly string[]).includes(stored) ? (stored as CardLinkRelation) : 'relates';
}

/**
 * The cards linked to the decision on boards `user` can open now (decision
 * 18), by title: each with its board's current name, and whether it is
 * archived. A card on any other board is left out, with no count.
 */
export function linkedCardsFor(user: SessionUser, decision: Pick<Decision, 'id'>): LinkedCardView[] {
	const caller = requireUser(user);
	const accessible = getAccessibleBoardIds(caller);
	const open = accessible === null ? null : new Set(accessible);
	return db
		.select({ id: cards.id, title: cards.title, boardId: columns.boardId, boardName: boards.name, archivedAt: cards.archivedAt })
		.from(decisionCardLinks)
		.innerJoin(cards, eq(cards.id, decisionCardLinks.cardId))
		.innerJoin(columns, eq(columns.id, cards.columnId))
		.innerJoin(boards, eq(boards.id, columns.boardId))
		.where(eq(decisionCardLinks.decisionId, decision.id))
		.orderBy(asc(cards.title), asc(cards.id))
		.all()
		.filter((row) => open === null || open.has(row.boardId))
		.map((row) => ({ id: row.id, title: row.title, boardId: row.boardId, boardName: row.boardName, archived: row.archivedAt !== null }));
}

/** How many cards the decision is linked to: the cap's count (decision 21), counted in SQL (code review F9). */
export function linkCountOf(decisionId: number): number {
	return db.select({ n: count() }).from(decisionCardLinks).where(eq(decisionCardLinks.decisionId, decisionId)).get()?.n ?? 0;
}

/** How many decisions the card is linked to: the card's cap's count (decision 21), counted in SQL (code review F9). */
export function cardLinkCountOf(cardId: number): number {
	return db.select({ n: count() }).from(decisionCardLinks).where(eq(decisionCardLinks.cardId, cardId)).get()?.n ?? 0;
}

/**
 * Every link of the cards asked, by card, each with its decision's title,
 * relation, and status and closing time through `listedStatusOf` (decision
 * 32, S4), in as few queries as `IDS_AT_ONCE` allows. **It checks no
 * access**: every caller asks `visibleDecisionIdsOf` of what it answers.
 */
export function decisionLinksOfCardsUnchecked(
	cardIds: readonly number[]
): { cardId: number; decisionId: number; title: string; relation: CardLinkRelation; shownStatus: ShownStatus; closesAt: Stamp | null }[] {
	const unique = [...new Set(cardIds)];
	const now = stamp();
	const found: ReturnType<typeof decisionLinksOfCardsUnchecked> = [];
	for (let from = 0; from < unique.length; from += IDS_AT_ONCE) {
		const rows = db
			.select({
				cardId: decisionCardLinks.cardId,
				decisionId: decisions.id,
				title: decisions.title,
				relation: decisionCardLinks.relation,
				status: decisions.status,
				closesAt: decisions.closesAt
			})
			.from(decisionCardLinks)
			.innerJoin(decisions, eq(decisions.id, decisionCardLinks.decisionId))
			.where(and(inArray(decisionCardLinks.cardId, unique.slice(from, from + IDS_AT_ONCE))))
			.orderBy(asc(decisionCardLinks.cardId), asc(decisions.id))
			.all();
		for (const row of rows) {
			const listed = listedStatusOf(row, now);
			found.push({ cardId: row.cardId, decisionId: row.decisionId, title: row.title, relation: relationOf(row.relation), ...listed });
		}
	}
	return found;
}

/**
 * The decisions linked to a card, as its card window lists them (decision
 * 18): `requireCard(…, 'view')` first, refusing as it refuses, then only the
 * decisions `user` may view, newest first. Read only.
 */
export function readCardDecisions(user: SessionUser, cardId: number, opts: { source: 'ui' | 'api' }): LinkedDecisionView[] {
	const caller = requireUser(user);
	requireCard(caller, cardId, 'view');
	const links = decisionLinksOfCardsUnchecked([cardId]);
	const visible = visibleDecisionIdsOf(
		caller,
		links.map((link) => link.decisionId)
	);
	return links
		.filter((link) => visible.has(link.decisionId))
		.sort((a, b) => b.decisionId - a.decisionId)
		.map((link) => ({ id: link.decisionId, title: link.title, shownStatus: link.shownStatus, closesAt: link.closesAt, relation: link.relation }));
}
