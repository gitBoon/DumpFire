/**
 * decision-cards.ts — what is read of the links between cards and decisions
 * (card 2680, decisions 17 to 23, 32): the decision page's linked cards, the
 * card window's linked decisions, and the batch read card 2687's plan view
 * builds on; and the limits the writes in decision-card-link-writes.ts ask.
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
 * Card 2687: `decisionWaitsFor` is the plan view's read of the waits that
 * hold its cards. It checks the cards' boards itself and asks
 * `visibleDecisionIdsOf`, and a scan beside case 111 pins its callers to this
 * file and planning.ts (T14).
 *
 * A plain read module, not a service: it takes the signed-in account, `user:
 * SessionUser`, never `caller`, imports no `inWrite` and writes nothing, so
 * that a page load may call it (tests/check-at-the-write.test.ts, rule 4).
 */
import { and, asc, count, eq, inArray } from 'drizzle-orm';
import { db } from './db';
import { boards, cards, columns, decisionCardLinks, decisions, type Decision } from './db/schema';
import type { SessionUser } from './auth';
import { getAccessibleBoardIds, type Actor } from './board-access';
import { IDS_AT_ONCE } from './decision-record';
import { visibleDecisionIdsOf } from './decision-register';
import { listedStatusOf } from './decision-status';
import { requireCard, requireUser } from './route-guards';
import type { LinkedCardView, LinkedDecisionView } from '$lib/decision-register-types';
import type { ShownStatus } from '$lib/decision-view-types';
import type { PlanDecisionWait } from '$lib/plan-table';
import { stamp, type Stamp } from '$lib/timestamps';

/** The most cards one decision may be linked to (decision 21). */
export const LINKS_PER_DECISION = 100;

/** The most decisions one card may be linked to (decision 21). */
export const LINKS_PER_CARD = 20;

/**
 * The relations a link may hold (decision 21, D2): `relates`, which says only
 * that the two are related, and `waits` (card 2687, R1), which holds the card
 * in the plan while the decision is open or awaiting its ruling.
 */
export const CARD_LINK_RELATIONS = ['relates', 'waits'] as const;

export type CardLinkRelation = (typeof CARD_LINK_RELATIONS)[number];

/** The shown statuses in which a `waits` link holds its card (card 2687, R2): ruled, superseded and withdrawn release it. */
export const WAITING_STATUSES: readonly PlanDecisionWait['shownStatus'][] = ['open', 'awaiting_ruling'];

/** A stored relation as it is read back: one outside `CARD_LINK_RELATIONS` is `relates` (decision 21). */
export function relationOf(stored: string): CardLinkRelation {
	return (CARD_LINK_RELATIONS as readonly string[]).includes(stored) ? (stored as CardLinkRelation) : 'relates';
}

/**
 * The cards linked to the decision on boards `user` can open now (decision
 * 18), by title: each with its board's current name, whether it is archived
 * and its link's relation (card 2687). A card on any other board is left out,
 * with no count.
 */
export function linkedCardsFor(user: SessionUser, decision: Pick<Decision, 'id'>): LinkedCardView[] {
	const caller = requireUser(user);
	const accessible = getAccessibleBoardIds(caller);
	const open = accessible === null ? null : new Set(accessible);
	return db
		.select({
			id: cards.id,
			title: cards.title,
			boardId: columns.boardId,
			boardName: boards.name,
			archivedAt: cards.archivedAt,
			relation: decisionCardLinks.relation
		})
		.from(decisionCardLinks)
		.innerJoin(cards, eq(cards.id, decisionCardLinks.cardId))
		.innerJoin(columns, eq(columns.id, cards.columnId))
		.innerJoin(boards, eq(boards.id, columns.boardId))
		.where(eq(decisionCardLinks.decisionId, decision.id))
		.orderBy(asc(cards.title), asc(cards.id))
		.all()
		.filter((row) => open === null || open.has(row.boardId))
		.map((row) => ({
			id: row.id,
			title: row.title,
			boardId: row.boardId,
			boardName: row.boardName,
			archived: row.archivedAt !== null,
			relation: relationOf(row.relation)
		}));
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
 * The decisions that hold each of the cards asked, for `viewer`, in the plan
 * view (card 2687, R6): links marked `waits` to a decision shown open or
 * awaiting its ruling (`WAITING_STATUSES`) that `viewer` may view, by card,
 * each by decision id, as the card window projects a decision (R11): title,
 * shown status and closing time, nothing else. A card that nothing holds has
 * no entry.
 *
 * It trusts no caller to have asked only for cards `viewer` can open (S-L2):
 * the waits are read first, and a card that has one is kept only on a board
 * the viewer can open, before any decision is asked about or answered; a
 * disabled account opens no board, and may view no decision, so is given
 * nothing (S-L1). Reading the waits first means a plan with none reads no
 * board (code review C-E-L4). A plain read, chunked by `IDS_AT_ONCE`.
 */
export function decisionWaitsFor(viewer: Actor, cardIds: readonly number[]): Map<number, PlanDecisionWait[]> {
	const waits = new Map<number, PlanDecisionWait[]>();
	const unique = [...new Set(cardIds)];
	if (unique.length === 0) return waits;

	// The waits first (card 2687's code review, C-E-L4): a plan with none reads no board. Nothing read here leaves this
	// function until the card's board is checked below.
	const linked = decisionLinksOfCardsUnchecked(unique).filter(
		(link) => link.relation === 'waits' && (WAITING_STATUSES as readonly ShownStatus[]).includes(link.shownStatus)
	);
	if (linked.length === 0) return waits;

	// Then the boards of the cards that have one, and only those on a board the viewer can open are kept (S-L2).
	const accessible = getAccessibleBoardIds(viewer);
	const open = accessible === null ? null : new Set(accessible);
	const withLinks = [...new Set(linked.map((link) => link.cardId))];
	const openCards = new Set<number>();
	for (let from = 0; from < withLinks.length; from += IDS_AT_ONCE) {
		const rows = db
			.select({ id: cards.id, boardId: columns.boardId })
			.from(cards)
			.innerJoin(columns, eq(columns.id, cards.columnId))
			.where(inArray(cards.id, withLinks.slice(from, from + IDS_AT_ONCE)))
			.all();
		for (const row of rows) if (open === null || open.has(row.boardId)) openCards.add(row.id);
	}
	const holding = linked.filter((link) => openCards.has(link.cardId));
	if (holding.length === 0) return waits;
	const visible = visibleDecisionIdsOf(
		viewer,
		holding.map((link) => link.decisionId)
	);
	for (const link of holding) {
		if (!visible.has(link.decisionId)) continue;
		const wait: PlanDecisionWait = {
			id: link.decisionId,
			title: link.title,
			shownStatus: link.shownStatus as PlanDecisionWait['shownStatus'],
			closesAt: link.closesAt
		};
		const list = waits.get(link.cardId);
		if (list) list.push(wait);
		else waits.set(link.cardId, [wait]);
	}
	for (const list of waits.values()) list.sort((a, b) => a.id - b.id);
	return waits;
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
