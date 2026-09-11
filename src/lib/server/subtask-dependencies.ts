/**
 * subtask-dependencies.ts — the handler body shared by both subtask dependency
 * routes.
 *
 * There are two of them for the same reason as everywhere else in this codebase:
 * the UI runs on a session cookie, the API on a bearer token. The rules are
 * identical, so they live here and the routes are auth-and-shape wrappers.
 */

import { error } from '@sveltejs/kit';
import { sqlite } from './db';
import { canViewBoard, canEditBoard } from './board-access';
import {
	getWorkDependencies,
	validateDependencyBatch,
	createDependencyBatch,
	type WorkKind,
	type WorkRef
} from './planning';
import { getWorkBoardId, getSubtaskCardId, describeWork } from './work-access';
import { emit } from './events';
import type { SessionUser } from './auth';

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
		resolved: r.isComplete
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
	const state = getWorkDependencies({ kind: 'subtask', id: subtaskId });
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
 * thing whichever end you are editing from.
 */
function resolveEnds(subtaskId: number, body: Record<string, unknown>): { blocked: WorkRef; blocker: WorkRef } {
	const self: WorkRef = { kind: 'subtask', id: subtaskId };
	const given = [
		{ field: 'dependsOnCardId', kind: 'card' as WorkKind, waits: true },
		{ field: 'dependsOnSubtaskId', kind: 'subtask' as WorkKind, waits: true },
		{ field: 'blocksCardId', kind: 'card' as WorkKind, waits: false },
		{ field: 'blocksSubtaskId', kind: 'subtask' as WorkKind, waits: false }
	].filter((g) => body[g.field] !== undefined && body[g.field] !== null);

	if (given.length === 0) {
		throw error(
			400,
			'Provide one of dependsOnCardId, dependsOnSubtaskId (this subtask waits on it), blocksCardId or blocksSubtaskId (it waits on this subtask)'
		);
	}
	if (given.length > 1) throw error(400, 'Provide only one end');

	const g = given[0];
	const otherId = Number(body[g.field]);
	if (isNaN(otherId)) throw error(400, `${g.field} must be an id`);
	const other: WorkRef = { kind: g.kind, id: otherId };

	return g.waits ? { blocked: self, blocker: other } : { blocked: other, blocker: self };
}

export function addSubtaskDependency(user: SessionUser, subtaskId: number, body: Record<string, unknown>) {
	const { boardId } = requireSubtask(user, subtaskId, true);
	const { blocked, blocker } = resolveEnds(subtaskId, body);

	const other = blocked.kind === 'subtask' && blocked.id === subtaskId ? blocker : blocked;
	const otherBoardId = getWorkBoardId(other);
	if (otherBoardId === null) throw error(404, `${describeWork(other)} not found`);
	if (!canEditBoard(user, otherBoardId)) {
		throw error(403, `No edit access to the board holding ${describeWork(other)}`);
	}

	// Same validation as the card route and the bulk endpoint — one definition of
	// what is allowed, so they cannot drift.
	const v = validateDependencyBatch([
		{ blocked: blocked.id, blockedType: blocked.kind, blocker: blocker.id, blockerType: blocker.kind }
	]);
	if (v.duplicates.length > 0) throw error(409, 'That dependency already exists');
	if (v.rejected.length > 0) throw error(409, v.rejected[0].message);

	createDependencyBatch(v.valid, user.id);

	emit(boardId, 'update', { type: 'card' });
	if (otherBoardId !== boardId) emit(otherBoardId, 'update', { type: 'card' });

	return readSubtaskDependencies(user, subtaskId);
}

export function removeSubtaskDependency(user: SessionUser, subtaskId: number, body: Record<string, unknown>) {
	const { boardId } = requireSubtask(user, subtaskId, true);
	const { blocked, blocker } = resolveEnds(subtaskId, body);

	sqlite
		.prepare(
			`DELETE FROM work_dependencies
			 WHERE blocked_type = ? AND blocked_id = ? AND blocker_type = ? AND blocker_id = ?`
		)
		.run(blocked.kind, blocked.id, blocker.kind, blocker.id);

	emit(boardId, 'update', { type: 'card' });
	return readSubtaskDependencies(user, subtaskId);
}
