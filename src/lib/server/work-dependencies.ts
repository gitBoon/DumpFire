/**
 * work-dependencies.ts — what a card or a subtask waits on and what waits on
 * it: read, a link made and a link taken away, one function for each, which
 * both API trees call for a card and for a subtask (card 2012, part A, slice
 * A3). It takes the place of subtask-dependencies.ts, which held the subtask
 * routes' middle, and holds the card routes' too.
 *
 * `/api/cards/:id/dependencies` and `/api/subtasks/:id/dependencies` (the card
 * window and the subtask window) and their twins under `/api/v1/` had the same
 * middle: the card or subtask in the address looked for and the caller
 * checked, the two ends read from the body, then `addDependencyLink` or
 * `removeDependencyLink` (dependency-refusals.ts, which asks of the other end,
 * checks the link, writes it, records the entry and tells both ends' boards,
 * for all four), then the links as they now are. Each tree keeps its path,
 * its body, its single `writeAs`, its answer and, through its options, its
 * own words: `says` for a caller refused the card in its address, and
 * `nothingToLink` for the card window's words for a body that names no end,
 * or more than one (R2 of `docs/planning/card-2012-service-layer-and-pages.md`).
 *
 * Each write has the one shape of a service (`ServiceOptions` in
 * `write-as.ts`): `inWrite()` first, then `requireUser(caller)` (401), the
 * card or subtask in the address (404, then 403), then the ends read from the
 * body (400), and the link. It opens no transaction of its own: it runs in
 * the caller's `writeAs`, where the graph the link is checked against is read
 * in the transaction that writes it. A link that would close a loop is
 * returned, not thrown, for the handler to answer with `cycleAnswer`; every
 * other refusal is a kit `error()`. The entry and the live events wait for
 * the commit.
 */

import { error } from '@sveltejs/kit';
import { canViewBoard, canEditBoard } from './board-access';
import { getWorkDependencies, type WorkKind, type WorkRef } from './planning';
import { addDependencyLink, removeDependencyLink, type CycleRefusal } from './dependency-refusals';
import { readId, type RequestBody } from './request-body';
import { requireUser, type Need } from './route-guards';
import { getCardBoardId, getSubtaskCardId, getWorkBoardId } from './work-access';
import type { SessionUser } from './auth';
import { inWrite, type ServiceOptions } from './write-as';

/** The functions here that only read. Every other export is a write, and starts with `inWrite()`. */
export const READS: readonly string[] = ['readWorkDependencies'];

/** What each tree's link writes do differently today (R2). */
export type DependencyOptions = ServiceOptions & {
	/**
	 * The card window's words for a body that names no end, `Nothing to link`,
	 * and for one that names more than one, `Provide only one end` (the page's
	 * card route). v1's card route names the four fields; both subtask routes
	 * name them for a subtask.
	 */
	nothingToLink?: boolean;
};

/** The links of a card or subtask, as every route answers them for its caller. */
type Links = {
	isBlocked: boolean;
	blockedBy: ReturnType<typeof shapeEnds>;
	blocks: ReturnType<typeof shapeEnds>;
};

/**
 * The ends of the links, as the routes answer them. An end on a board the
 * caller cannot open comes withheld from planning.ts: its id, kind and
 * whether it is finished, and text in place of its title and board (card
 * 2129). `withDetails` (v1's card read) adds each link's id, who made it and
 * when.
 */
function shapeEnds(refs: ReturnType<typeof getWorkDependencies>['blockedBy'], withDetails: boolean) {
	return refs.map((r) => ({
		...(withDetails ? { id: r.dependencyId } : {}),
		kind: r.kind,
		cardId: r.id,
		parentCardId: r.parentCardId ?? null,
		title: r.title,
		boardId: r.boardId,
		boardName: r.boardName,
		columnName: r.columnTitle,
		priority: r.priority,
		resolved: r.isComplete,
		withheld: r.withheld,
		...(withDetails ? { createdByUserId: r.createdByUserId, createdAt: r.createdAt } : {})
	}));
}

/** The links of `at` as they now are, for `user`. */
function linksOf(at: WorkRef, user: SessionUser, withDetails: boolean): Links {
	const state = getWorkDependencies({ kind: at.kind, id: at.id }, user);
	return { isBlocked: state.isBlocked, blockedBy: shapeEnds(state.blockedBy, withDetails), blocks: shapeEnds(state.blocks, withDetails) };
}

/**
 * The card or subtask in the address, for a caller who may view (`need`
 * 'view') or edit the board it is on: `404 Card not found` or `404 Subtask
 * not found`, then 403 in the tree's words (`says`), or these routes' own.
 * Answers the card it is, or the card the subtask belongs to.
 */
function requireWork(user: SessionUser, at: WorkRef, need: Need, says: string | undefined): { cardId: number } {
	if (at.kind === 'card') {
		const boardId = getCardBoardId(at.id);
		if (!boardId) throw error(404, 'Card not found');
		if (need === 'edit' ? !canEditBoard(user, boardId) : !canViewBoard(user, boardId)) {
			throw error(403, says ?? (need === 'edit' ? 'No edit access' : 'No access'));
		}
		return { cardId: at.id };
	}
	const cardId = getSubtaskCardId(at.id);
	if (cardId === null) throw error(404, 'Subtask not found');
	const boardId = getWorkBoardId({ kind: 'subtask', id: at.id });
	if (boardId === null) throw error(404, 'Subtask not found');
	if (need === 'edit' ? !canEditBoard(user, boardId) : !canViewBoard(user, boardId)) {
		throw error(403, says ?? (need === 'edit' ? "No edit access to this subtask's board" : 'No access'));
	}
	return { cardId };
}

/**
 * The two ends, from the body.
 *
 * `dependsOnCardId` / `blocksCardId` are the long-standing card-only
 * spellings; `dependsOnSubtaskId` / `blocksSubtaskId` are their subtask
 * equivalents, so the same four field names mean the same thing whichever
 * end the address names. Each is read as an id: a whole number of 1 or more,
 * or the same written as text. `null` is the same as not sent.
 */
function resolveEnds(at: WorkRef, body: RequestBody, opts: DependencyOptions): { blocked: WorkRef; blocker: WorkRef } {
	const self: WorkRef = { kind: at.kind, id: at.id };
	const given = [
		{ id: readId(body, 'dependsOnCardId', { nullable: true }), kind: 'card' as WorkKind, waits: true },
		{ id: readId(body, 'dependsOnSubtaskId', { nullable: true }), kind: 'subtask' as WorkKind, waits: true },
		{ id: readId(body, 'blocksCardId', { nullable: true }), kind: 'card' as WorkKind, waits: false },
		{ id: readId(body, 'blocksSubtaskId', { nullable: true }), kind: 'subtask' as WorkKind, waits: false }
	].filter((g): g is { id: number; kind: WorkKind; waits: boolean } => typeof g.id === 'number');

	if (given.length === 0) {
		if (at.kind === 'subtask') {
			throw error(
				400,
				'Provide one of dependsOnCardId, dependsOnSubtaskId (this subtask waits on it), blocksCardId or blocksSubtaskId (it waits on this subtask)'
			);
		}
		if (opts.nothingToLink) throw error(400, 'Nothing to link');
		throw error(
			400,
			'Provide one of dependsOnCardId, dependsOnSubtaskId (this card waits on it), blocksCardId or blocksSubtaskId (it waits on this card)'
		);
	}
	if (given.length > 1) {
		if (at.kind === 'card' && !opts.nothingToLink) throw error(400, 'Provide only one of the dependsOn*/blocks* fields');
		throw error(400, 'Provide only one end');
	}

	const g = given[0];
	const other: WorkRef = { kind: g.kind, id: g.id };

	return g.waits ? { blocked: self, blocker: other } : { blocked: other, blocker: self };
}

/**
 * What the card or subtask `at` waits on and what waits on it: `GET` of each
 * of the four routes. The caller must be able to read it (404, then 403 in
 * the tree's words, `says`). v1's card read passes `withLinkDetails`. Answers
 * the links and the card `at` is or belongs to; each handler shapes its own
 * answer from them.
 */
export function readWorkDependencies(
	user: SessionUser,
	at: WorkRef,
	opts: { says?: string; withLinkDetails?: boolean }
): Links & { cardId: number } {
	const { cardId } = requireWork(user, at, 'view', opts.says);
	return { cardId, ...linksOf(at, user, opts.withLinkDetails === true) };
}

/**
 * Record that one end waits on the other, one of them `at`: `POST` of each
 * of the four routes. In this order: `at` (404, then 403 for a caller who may
 * not edit its board, in the tree's words), the ends in the body (400), then
 * what `addDependencyLink` does for all four: the other end (404, 403), the
 * check (409 for a link already there, 400 for an end that waits on itself or
 * is archived), the link, the `dependency_added` entry from `opts.source` and
 * the live events. Then the links of `at` as they now are.
 *
 * A link that would close a loop writes nothing and is returned, with its
 * chain, for the handler to answer with `cycleAnswer`.
 */
export function addWorkDependency(
	caller: SessionUser | null,
	at: WorkRef,
	body: RequestBody,
	opts: DependencyOptions
): CycleRefusal | (Links & { rejected: false; blocked: WorkRef; blocker: WorkRef; cardId: number }) {
	inWrite();
	const user = requireUser(caller);
	const { cardId } = requireWork(user, at, 'edit', opts.says);
	const { blocked, blocker } = resolveEnds(at, body, opts);

	const added = addDependencyLink(user, blocked, blocker, { at: { kind: at.kind, id: at.id }, source: opts.source });
	if (added.rejected) return added;

	return { rejected: false as const, blocked, blocker, cardId, ...linksOf(at, user, false) };
}

/**
 * Take away the link by which one end waits on the other, one of them `at`:
 * `DELETE` of each of the four routes. `at` is whichever end the caller is
 * looking at, and they are answered with its links, so they must be able to
 * read it (404, then 403 in the tree's words). Whether they may remove the
 * link is not asked of `at`'s board: it is asked of the board of the end that
 * waits, in `removeDependencyLink` (403, then 404 for a link that is not
 * there), which writes the `dependency_removed` entry and tells both ends'
 * boards. Answers how many rows went, as v1's card route answers it, and the
 * links of `at` as they now are.
 */
export function removeWorkDependency(
	caller: SessionUser | null,
	at: WorkRef,
	body: RequestBody,
	opts: DependencyOptions
): Links & { removed: number; cardId: number } {
	inWrite();
	const user = requireUser(caller);
	const { cardId } = requireWork(user, at, 'view', opts.says);
	const { blocked, blocker } = resolveEnds(at, body, opts);

	const removed = removeDependencyLink(user, blocked, blocker, { at: { kind: at.kind, id: at.id }, source: opts.source });

	return { removed, cardId, ...linksOf(at, user, false) };
}
