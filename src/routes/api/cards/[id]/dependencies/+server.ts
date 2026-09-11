/**
 * Session-authenticated sibling of /api/v1/cards/:cardId/dependencies.
 *
 * The board UI runs on the session cookie and cannot send a bearer token, so
 * the card modal talks to this route. The rules — cycle rejection, edit access
 * on both ends, cross-board allowed, subtasks as valid ends — are the same;
 * only the auth differs.
 */
import { json, error } from '@sveltejs/kit';
import { sqlite } from '$lib/server/db';
import { canViewBoard, canEditBoard } from '$lib/server/board-access';
import {
	getWorkDependencies,
	validateDependencyBatch,
	createDependencyBatch,
	type WorkKind,
	type WorkRef
} from '$lib/server/planning';
import { getCardBoardId, getWorkBoardId, describeWork } from '$lib/server/work-access';
import { emit } from '$lib/server/events';
import type { RequestHandler } from './$types';

/** Shape a dependency end for the card modal. */
function shape(refs: ReturnType<typeof getWorkDependencies>['blockedBy']) {
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

/**
 * The two ends, from the modal's body.
 *
 * `dependsOnCardId` / `blocksCardId` are the card-only spellings the modal has
 * always sent; the `*SubtaskId` pair is their subtask equivalent.
 */
function resolveEnds(cardId: number, body: Record<string, unknown>): { blocked: WorkRef; blocker: WorkRef } {
	const self: WorkRef = { kind: 'card', id: cardId };
	const given = [
		{ field: 'dependsOnCardId', kind: 'card' as WorkKind, waits: true },
		{ field: 'dependsOnSubtaskId', kind: 'subtask' as WorkKind, waits: true },
		{ field: 'blocksCardId', kind: 'card' as WorkKind, waits: false },
		{ field: 'blocksSubtaskId', kind: 'subtask' as WorkKind, waits: false }
	].filter((g) => body[g.field] !== undefined && body[g.field] !== null);

	if (given.length === 0) throw error(400, 'Nothing to link');
	if (given.length > 1) throw error(400, 'Provide only one end');

	const g = given[0];
	const otherId = Number(body[g.field]);
	if (isNaN(otherId)) throw error(400, `${g.field} must be an id`);
	const other: WorkRef = { kind: g.kind, id: otherId };

	return g.waits ? { blocked: self, blocker: other } : { blocked: other, blocker: self };
}

export const GET: RequestHandler = async ({ params, locals }) => {
	if (!locals.user) throw error(401, 'Not authenticated');

	const cardId = Number(params.id);
	if (isNaN(cardId)) throw error(400, 'Invalid card ID');

	const boardId = getCardBoardId(cardId);
	if (!boardId) throw error(404, 'Card not found');
	if (!canViewBoard(locals.user, boardId)) throw error(403, 'No access');

	const state = getWorkDependencies({ kind: 'card', id: cardId });
	return json({
		cardId,
		isBlocked: state.isBlocked,
		blockedBy: shape(state.blockedBy),
		blocks: shape(state.blocks)
	});
};

export const POST: RequestHandler = async ({ params, request, locals }) => {
	if (!locals.user) throw error(401, 'Not authenticated');

	const cardId = Number(params.id);
	if (isNaN(cardId)) throw error(400, 'Invalid card ID');

	const boardId = getCardBoardId(cardId);
	if (!boardId) throw error(404, 'Card not found');
	if (!canEditBoard(locals.user, boardId)) throw error(403, 'No edit access');

	const { blocked, blocker } = resolveEnds(cardId, await request.json());

	const other = blocked.kind === 'card' && blocked.id === cardId ? blocker : blocked;
	const otherBoardId = getWorkBoardId(other);
	if (!otherBoardId) throw error(404, `${describeWork(other)} not found`);
	if (!canEditBoard(locals.user, otherBoardId)) {
		throw error(403, `No edit access to the board holding ${describeWork(other)}`);
	}

	// Same validation path as the bulk endpoint, so one link and a batch can
	// never disagree about what is allowed.
	const v = validateDependencyBatch([
		{ blocked: blocked.id, blockedType: blocked.kind, blocker: blocker.id, blockerType: blocker.kind }
	]);

	if (v.duplicates.length > 0) throw error(409, 'That dependency already exists');
	if (v.rejected.length > 0) throw error(409, v.rejected[0].message);

	createDependencyBatch(v.valid, locals.user.id);

	emit(boardId, 'update', { type: 'card' });
	if (otherBoardId !== boardId) emit(otherBoardId, 'update', { type: 'card' });

	const state = getWorkDependencies({ kind: 'card', id: cardId });
	return json(
		{ blockedBy: shape(state.blockedBy), blocks: shape(state.blocks), isBlocked: state.isBlocked },
		{ status: 201 }
	);
};

export const DELETE: RequestHandler = async ({ params, request, locals }) => {
	if (!locals.user) throw error(401, 'Not authenticated');

	const cardId = Number(params.id);
	if (isNaN(cardId)) throw error(400, 'Invalid card ID');

	const boardId = getCardBoardId(cardId);
	if (!boardId) throw error(404, 'Card not found');
	if (!canEditBoard(locals.user, boardId)) throw error(403, 'No edit access');

	const { blocked, blocker } = resolveEnds(cardId, await request.json());

	sqlite
		.prepare(
			`DELETE FROM work_dependencies
			 WHERE blocked_type = ? AND blocked_id = ? AND blocker_type = ? AND blocker_id = ?`
		)
		.run(blocked.kind, blocked.id, blocker.kind, blocker.id);

	emit(boardId, 'update', { type: 'card' });

	const state = getWorkDependencies({ kind: 'card', id: cardId });
	return json({ blockedBy: shape(state.blockedBy), blocks: shape(state.blocks), isBlocked: state.isBlocked });
};
