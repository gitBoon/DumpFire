/**
 * decision-visibility.ts — who may view which decisions, as one SQL predicate
 * (card 2680, decision 1): `visibleWhere`, the scope it is worked out from
 * (`scopeOf`), and `visibleDecisionIdsOf`, built on it for every list that
 * must filter decisions by `view`. Moved here from decision-register.ts by
 * card 2689, unchanged, which re-exports `visibleDecisionIdsOf` and reads
 * the rest from here.
 *
 * A module of its own so that `webhooks.ts` can ask it at sending (card 2689,
 * R7) without an import loop: decision-register.ts reaches `logActivity.ts`
 * and `webhooks.ts` through `route-guards.ts`, and `upstream.ts` reads
 * `ACTIONS` at its top level, so a loop through it breaks whichever module
 * loads first. This one imports no module that reaches either; keep it so.
 *
 * A plain read module: it writes nothing and imports no `inWrite`.
 */
import { error } from '@sveltejs/kit';
import { and, eq, inArray, isNull, ne, or, sql, type SQL } from 'drizzle-orm';
import { db } from './db';
import { decisionParticipants, decisions } from './db/schema';
import { editableBoardIds, getAccessibleBoardIds, isAdmin, isDisabledActor, ownedBoardIds, type Actor } from './board-access';
import { IDS_AT_ONCE } from './decision-record';

/**
 * What the caller's visibility is made from, read once: every board for an
 * administrator (null); otherwise the boards they can open, own and edit now.
 */
export type Scope = { admin: true } | { admin: false; accessible: Set<number>; owned: Set<number>; editable: Set<number> };

export function scopeOf(user: Actor): Scope {
	if (isAdmin(user)) return { admin: true };
	return {
		admin: false,
		accessible: new Set(getAccessibleBoardIds(user) ?? []),
		owned: ownedBoardIds(user) ?? new Set(),
		editable: editableBoardIds(user) ?? new Set()
	};
}

/** The decisions on which the account holds exactly one live participant row: `decisionAccess`'s participant role (decision 29). */
export function oneLiveRowWhere(userId: number): SQL {
	return inArray(
		decisions.id,
		db
			.select({ id: decisionParticipants.decisionId })
			.from(decisionParticipants)
			.where(and(eq(decisionParticipants.userId, userId), isNull(decisionParticipants.removedAt)))
			.groupBy(decisionParticipants.decisionId)
			.having(sql`count(*) = 1`)
	);
}

/**
 * `mayDo(decisionAccess(user, d), 'view', d)` as one condition on
 * `decisions` (decision 1): nothing for an administrator; otherwise the
 * caller's own decisions as author or decider; one that is not a draft on a
 * board they can open now, or holding exactly one live participant row of
 * theirs; and a draft on a board they own. The board-edit rule never limits
 * `view`.
 */
export function visibleWhere(user: Actor, scope: Scope): SQL | undefined {
	if (scope.admin) return undefined;
	return or(
		eq(decisions.authorUserId, user.id),
		eq(decisions.deciderUserId, user.id),
		and(ne(decisions.status, 'draft'), or(inArray(decisions.boardId, [...scope.accessible]), oneLiveRowWhere(user.id))),
		and(eq(decisions.status, 'draft'), inArray(decisions.boardId, [...scope.owned]))
	);
}

/**
 * The ids among `ids` of the decisions `user` may view (decision 1): one
 * query per `IDS_AT_ONCE`, by `visibleWhere`, and never `decisionAccess` per
 * row. For every list that must filter decisions by `view`, and for a
 * decision webhook's setter at sending (card 2689, R7).
 *
 * Card 2687 (E-M1, S-L1): it takes any `Actor`, as the plan's viewer is one,
 * and answers 401 to none, as it did. A disabled account, an administrator's
 * included, may view no decision (card 2671's rule): it is given the empty
 * set before its role is asked.
 */
export function visibleDecisionIdsOf(user: Actor | null | undefined, ids: readonly number[]): Set<number> {
	if (!user) error(401, 'Not authenticated');
	if (isDisabledActor(user)) return new Set();
	const visible = visibleWhere(user, scopeOf(user));
	const unique = [...new Set(ids)];
	const found = new Set<number>();
	for (let from = 0; from < unique.length; from += IDS_AT_ONCE) {
		const rows = db
			.select({ id: decisions.id })
			.from(decisions)
			.where(and(inArray(decisions.id, unique.slice(from, from + IDS_AT_ONCE)), visible))
			.all();
		for (const row of rows) found.add(row.id);
	}
	return found;
}
