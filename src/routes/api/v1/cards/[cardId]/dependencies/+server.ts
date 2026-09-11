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
import { getCardBoardId, getWorkBoardId, describeWork as describe } from '$lib/server/work-access';
import { logActivity } from '$lib/server/logActivity';
import { emit } from '$lib/server/events';
import type { RequestHandler } from './$types';

/**
 * GET /api/v1/cards/:cardId/dependencies — what blocks this card and what it blocks.
 *
 * `?direction=blocked-by|blocks|both` (default `both`). Each entry carries its
 * `kind`, because "#32" is ambiguous between card 32 and subtask 32, and the
 * board it lives on so a cross-board dependency shows as "Board / #id".
 */
export const GET: RequestHandler = async ({ params, url, locals }) => {
	if (!locals.user) throw error(401, 'Not authenticated');

	const cardId = Number(params.cardId);
	if (isNaN(cardId)) throw error(400, 'Invalid card ID');

	const boardId = getCardBoardId(cardId);
	if (!boardId) throw error(404, 'Card not found');
	if (!canViewBoard(locals.user, boardId)) throw error(403, 'No access to this card\'s board');

	const direction = url.searchParams.get('direction') ?? 'both';
	if (!['blocked-by', 'blocks', 'both'].includes(direction)) {
		throw error(400, 'direction must be one of: blocked-by, blocks, both');
	}

	const state = getWorkDependencies({ kind: 'card', id: cardId });
	const shape = (refs: typeof state.blockedBy) =>
		refs.map((r) => ({
			id: r.dependencyId,
			kind: r.kind,
			cardId: r.id,
			parentCardId: r.parentCardId ?? null,
			title: r.title,
			boardId: r.boardId,
			boardName: r.boardName,
			columnName: r.columnTitle,
			priority: r.priority,
			resolved: r.isComplete,
			createdByUserId: r.createdByUserId,
			createdAt: r.createdAt
		}));

	return json({
		cardId,
		isBlocked: state.isBlocked,
		...(direction !== 'blocks' ? { blockedBy: shape(state.blockedBy) } : {}),
		...(direction !== 'blocked-by' ? { blocks: shape(state.blocks) } : {})
	});
};

/**
 * Work out the two ends from the request body.
 *
 * `dependsOnCardId` / `blocksCardId` are the long-standing card-only spellings
 * and keep working untouched. `dependsOnSubtaskId` / `blocksSubtaskId` are their
 * subtask equivalents, so linking to a subtask needs no new endpoint.
 */
function resolveEnds(cardId: number, body: Record<string, unknown>): { blocked: WorkRef; blocker: WorkRef } {
	const self: WorkRef = { kind: 'card', id: cardId };
	const given = [
		{ field: 'dependsOnCardId', kind: 'card' as WorkKind, thisCardWaits: true },
		{ field: 'dependsOnSubtaskId', kind: 'subtask' as WorkKind, thisCardWaits: true },
		{ field: 'blocksCardId', kind: 'card' as WorkKind, thisCardWaits: false },
		{ field: 'blocksSubtaskId', kind: 'subtask' as WorkKind, thisCardWaits: false }
	].filter((g) => body[g.field] !== undefined && body[g.field] !== null);

	if (given.length === 0) {
		throw error(
			400,
			'Provide one of dependsOnCardId, dependsOnSubtaskId (this card waits on it), blocksCardId or blocksSubtaskId (it waits on this card)'
		);
	}
	if (given.length > 1) throw error(400, 'Provide only one of the dependsOn*/blocks* fields');

	const g = given[0];
	const otherId = Number(body[g.field]);
	if (isNaN(otherId)) throw error(400, `${g.field} must be an id`);
	const other: WorkRef = { kind: g.kind, id: otherId };

	return g.thisCardWaits ? { blocked: self, blocker: other } : { blocked: other, blocker: self };
}

/**
 * POST /api/v1/cards/:cardId/dependencies — record that this card waits on
 * something, or that something waits on it.
 *
 * Cross-board dependencies are allowed — a migration touches several projects —
 * so edit access is required on both ends. A dependency that would close a loop
 * is rejected with 409 and the offending chain listed.
 */
export const POST: RequestHandler = async ({ params, request, locals }) => {
	if (!locals.user) throw error(401, 'Not authenticated');

	const cardId = Number(params.cardId);
	if (isNaN(cardId)) throw error(400, 'Invalid card ID');

	const boardId = getCardBoardId(cardId);
	if (!boardId) throw error(404, 'Card not found');
	if (!canEditBoard(locals.user, boardId)) throw error(403, 'No edit access to this card\'s board');

	const { blocked, blocker } = resolveEnds(cardId, await request.json());

	const other = blocked.kind === 'card' && blocked.id === cardId ? blocker : blocked;
	const otherBoardId = getWorkBoardId(other);
	if (!otherBoardId) throw error(404, `${describe(other)} not found`);
	if (!canEditBoard(locals.user, otherBoardId)) {
		throw error(403, `No edit access to the board holding ${describe(other)}`);
	}

	// One validation path shared with the bulk endpoint, so a single link and a
	// batch can never disagree about what is allowed.
	const v = validateDependencyBatch([
		{ blocked: blocked.id, blockedType: blocked.kind, blocker: blocker.id, blockerType: blocker.kind }
	]);

	if (v.duplicates.length > 0) throw error(409, 'That dependency already exists');
	if (v.rejected.length > 0) {
		const r = v.rejected[0];
		if (r.reason === 'cycle') {
			return json({ error: 'That dependency would create a cycle', cycle: r.cycle, message: r.message }, { status: 409 });
		}
		throw error(400, r.message);
	}

	createDependencyBatch(v.valid, locals.user.id);

	logActivity({
		boardId,
		cardId,
		userId: locals.user.id,
		action: 'api:dependency_added',
		detail: `${describe(blocked)} now waits on ${describe(blocker)}`,
		userName: locals.user.username,
		userEmoji: locals.user.emoji || '👤'
	});

	emit(boardId, 'update', { type: 'card' });
	if (otherBoardId !== boardId) emit(otherBoardId, 'update', { type: 'card' });

	const state = getWorkDependencies({ kind: 'card', id: cardId });
	return json(
		{
			blocked: { kind: blocked.kind, id: blocked.id },
			blocker: { kind: blocker.kind, id: blocker.id },
			isBlocked: state.isBlocked
		},
		{ status: 201 }
	);
};

/**
 * DELETE /api/v1/cards/:cardId/dependencies — remove a dependency.
 *
 * Takes the same body spellings as POST, so a caller never has to work out
 * which end of the pair stores the row.
 */
export const DELETE: RequestHandler = async ({ params, request, locals }) => {
	if (!locals.user) throw error(401, 'Not authenticated');

	const cardId = Number(params.cardId);
	if (isNaN(cardId)) throw error(400, 'Invalid card ID');

	const boardId = getCardBoardId(cardId);
	if (!boardId) throw error(404, 'Card not found');
	if (!canEditBoard(locals.user, boardId)) throw error(403, 'No edit access to this card\'s board');

	const { blocked, blocker } = resolveEnds(cardId, await request.json());

	const removed = sqlite
		.prepare(
			`DELETE FROM work_dependencies
			 WHERE blocked_type = ? AND blocked_id = ? AND blocker_type = ? AND blocker_id = ?`
		)
		.run(blocked.kind, blocked.id, blocker.kind, blocker.id).changes;

	if (removed === 0) throw error(404, 'Dependency not found');

	logActivity({
		boardId,
		cardId,
		userId: locals.user.id,
		action: 'api:dependency_removed',
		detail: `${describe(blocked)} no longer waits on ${describe(blocker)}`,
		userName: locals.user.username,
		userEmoji: locals.user.emoji || '👤'
	});

	emit(boardId, 'update', { type: 'card' });

	return json({ success: true, removed });
};
