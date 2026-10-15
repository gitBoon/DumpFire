/**
 * subtask-dependencies.ts — the handler body shared by both subtask dependency
 * routes.
 *
 * There are two of them for the same reason as everywhere else in this codebase:
 * the UI runs on a session cookie, the API on a bearer token. The rules are
 * identical, so they live here and the routes are auth-and-shape wrappers.
 * What differs is where the request came from, `source`, which the activity
 * entry records.
 */

import { error } from '@sveltejs/kit';
import { canViewBoard, canEditBoard } from './board-access';
import { inTransaction } from './db/transaction';
import { getWorkDependencies, type WorkKind, type WorkRef } from './planning';
import {
	addDependencyLink,
	removeDependencyLink,
	type CycleRefusal,
	type LinkRequest
} from './dependency-refusals';
import { readId, type RequestBody } from './request-body';
import { getWorkBoardId, getSubtaskCardId } from './work-access';
import type { SessionUser } from './auth';

/**
 * The ends of a subtask's links as both routes answer them. An end on a board
 * the caller cannot open comes withheld from planning.ts: its id, kind and
 * whether it is finished, and text in place of its title and board (card 2129).
 */
export function shapeEnds(refs: ReturnType<typeof getWorkDependencies>['blockedBy']) {
	return refs.map((r) => ({
		kind: r.kind,
		cardId: r.id,
		parentCardId: r.parentCardId ?? null,
		title: r.title,
		boardId: r.boardId,
		boardName: r.boardName,
		columnName: r.columnTitle,
		priority: r.priority,
		resolved: r.isComplete,
		withheld: r.withheld
	}));
}

/** Resolve the subtask and check the caller may see it. */
function requireSubtask(user: SessionUser, subtaskId: number, forEdit: boolean) {
	const cardId = getSubtaskCardId(subtaskId);
	if (cardId === null) throw error(404, 'Subtask not found');
	const boardId = getWorkBoardId({ kind: 'subtask', id: subtaskId });
	if (boardId === null) throw error(404, 'Subtask not found');
	if (forEdit ? !canEditBoard(user, boardId) : !canViewBoard(user, boardId)) {
		throw error(403, forEdit ? 'No edit access to this subtask\'s board' : 'No access');
	}
	return { cardId, boardId };
}

export function readSubtaskDependencies(user: SessionUser, subtaskId: number) {
	const { cardId } = requireSubtask(user, subtaskId, false);
	const state = getWorkDependencies({ kind: 'subtask', id: subtaskId }, user);
	return {
		subtaskId,
		cardId,
		isBlocked: state.isBlocked,
		blockedBy: shapeEnds(state.blockedBy),
		blocks: shapeEnds(state.blocks)
	};
}

/**
 * The two ends from the body.
 *
 * Mirrors the card route's spellings so the same four field names mean the same
 * thing whichever end you are editing from. Each is read as an id: a whole
 * number of 1 or more, or the same written as text. `null` is the same as not
 * sent.
 */
function resolveEnds(subtaskId: number, body: RequestBody): { blocked: WorkRef; blocker: WorkRef } {
	const self: WorkRef = { kind: 'subtask', id: subtaskId };
	const given = [
		{ id: readId(body, 'dependsOnCardId', { nullable: true }), kind: 'card' as WorkKind, waits: true },
		{ id: readId(body, 'dependsOnSubtaskId', { nullable: true }), kind: 'subtask' as WorkKind, waits: true },
		{ id: readId(body, 'blocksCardId', { nullable: true }), kind: 'card' as WorkKind, waits: false },
		{ id: readId(body, 'blocksSubtaskId', { nullable: true }), kind: 'subtask' as WorkKind, waits: false }
	].filter((g): g is { id: number; kind: WorkKind; waits: boolean } => typeof g.id === 'number');

	if (given.length === 0) {
		throw error(
			400,
			'Provide one of dependsOnCardId, dependsOnSubtaskId (this subtask waits on it), blocksCardId or blocksSubtaskId (it waits on this subtask)'
		);
	}
	if (given.length > 1) throw error(400, 'Provide only one end');

	const g = given[0];
	const other: WorkRef = { kind: g.kind, id: g.id };

	return g.waits ? { blocked: self, blocker: other } : { blocked: other, blocker: self };
}

/**
 * Record the link, and return the subtask's dependencies as they then are.
 *
 * One transaction, in this order: the subtask in the path (404, then 403 for a
 * caller who may not edit its board), the ends in the body (400), then what
 * `addDependencyLink` does for all four routes: the other end, the check, the
 * link, the `dependency_added` entry from `source`, and the live events. The
 * answer's list is read in it too.
 *
 * A link that would close a loop is not thrown: it is returned, with its
 * chain, for the route to answer with `cycleAnswer`. Every other refusal is
 * thrown, with the statuses dependency-refusals.ts gives all four routes.
 */
export function addSubtaskDependency(
	user: SessionUser,
	subtaskId: number,
	body: RequestBody,
	source: LinkRequest['source']
): CycleRefusal | { rejected: false; state: ReturnType<typeof readSubtaskDependencies> } {
	return inTransaction(() => {
		requireSubtask(user, subtaskId, true);
		const { blocked, blocker } = resolveEnds(subtaskId, body);

		const added = addDependencyLink(user, blocked, blocker, { at: { kind: 'subtask', id: subtaskId }, source });
		if (added.rejected) return added;

		return { rejected: false as const, state: readSubtaskDependencies(user, subtaskId) };
	});
}

/**
 * Remove the link, and return the subtask's dependencies as they then are.
 *
 * The subtask in the path is whichever end the caller is looking at, and they
 * are answered with its links, so they must be able to read it. Whether they
 * may remove the link is not asked of this subtask's board: it is asked of the
 * board of the end that waits, in removeDependencyLink, as it is for a card.
 * One transaction, from the subtask to the answer's list.
 */
export function removeSubtaskDependency(
	user: SessionUser,
	subtaskId: number,
	body: RequestBody,
	source: LinkRequest['source']
) {
	return inTransaction(() => {
		requireSubtask(user, subtaskId, false);
		const { blocked, blocker } = resolveEnds(subtaskId, body);

		// Throws 403 for a caller who may not edit the board of the end that
		// waits, and then 404 for a link that is not there. It writes the
		// `dependency_removed` entry, and sends the live event to both ends'
		// boards: the subtask in the path may be on either.
		removeDependencyLink(user, blocked, blocker, { at: { kind: 'subtask', id: subtaskId }, source });

		return readSubtaskDependencies(user, subtaskId);
	});
}
