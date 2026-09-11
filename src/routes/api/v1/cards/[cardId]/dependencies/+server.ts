import { json, error } from '@sveltejs/kit';
import { db } from '$lib/server/db';
import { cardDependencies, cards, columns } from '$lib/server/db/schema';
import { eq, and } from 'drizzle-orm';
import { canViewBoard, canEditBoard } from '$lib/server/board-access';
import { getCardDependencies, findDependencyCycle } from '$lib/server/planning';
import { logActivity } from '$lib/server/logActivity';
import { emit } from '$lib/server/events';
import type { RequestHandler } from './$types';

/** Resolve the board a card belongs to. */
function getCardBoardId(cardId: number): number | null {
	const card = db.select({ columnId: cards.columnId }).from(cards).where(eq(cards.id, cardId)).get();
	if (!card) return null;
	const col = db
		.select({ boardId: columns.boardId })
		.from(columns)
		.where(eq(columns.id, card.columnId))
		.get();
	return col?.boardId ?? null;
}

/**
 * GET /api/v1/cards/:cardId/dependencies — what blocks this card and what it blocks.
 *
 * `?direction=blocked-by|blocks|both` (default `both`). Each entry carries the
 * board it lives on so a cross-board dependency can be shown as "Board / #id",
 * and `resolved` says whether that end is already in a Complete column.
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

	const state = getCardDependencies(cardId);
	const shape = (refs: typeof state.blockedBy) =>
		refs.map((r) => ({
			id: r.dependencyId,
			cardId: r.id,
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
 * POST /api/v1/cards/:cardId/dependencies — record that this card is blocked by another.
 *
 * Body: `{ dependsOnCardId }` (this card waits on that one), or
 *       `{ blocksCardId }`    (that card waits on this one).
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

	const body = await request.json();
	const { dependsOnCardId, blocksCardId } = body;

	if (!dependsOnCardId && !blocksCardId) {
		throw error(400, 'Provide either dependsOnCardId (this card waits on it) or blocksCardId (it waits on this card)');
	}
	if (dependsOnCardId && blocksCardId) {
		throw error(400, 'Provide only one of dependsOnCardId or blocksCardId');
	}

	// Normalise to the stored direction: blockedId waits on blockerId.
	const blockedId = dependsOnCardId ? cardId : Number(blocksCardId);
	const blockerId = dependsOnCardId ? Number(dependsOnCardId) : cardId;

	if (isNaN(blockedId) || isNaN(blockerId)) throw error(400, 'Invalid target card ID');
	if (blockedId === blockerId) throw error(400, 'A card cannot depend on itself');

	const otherId = blockedId === cardId ? blockerId : blockedId;
	const otherBoardId = getCardBoardId(otherId);
	if (!otherBoardId) throw error(404, 'Target card not found');
	if (!canEditBoard(locals.user, otherBoardId)) {
		throw error(403, 'No edit access to the other card\'s board');
	}

	const existing = db
		.select({ id: cardDependencies.id })
		.from(cardDependencies)
		.where(
			and(eq(cardDependencies.cardId, blockedId), eq(cardDependencies.dependsOnCardId, blockerId))
		)
		.get();
	if (existing) throw error(409, 'That dependency already exists');

	const cycle = findDependencyCycle(blockedId, blockerId);
	if (cycle) {
		// 409 with the chain named: "rejected" is not useful on its own when the
		// loop runs through five cards on three boards.
		return json(
			{
				error: 'That dependency would create a cycle',
				cycle,
				message: `Cycle: ${cycle.map((id) => `#${id}`).join(' → ')} → #${cycle[0]}`
			},
			{ status: 409 }
		);
	}

	const dep = db
		.insert(cardDependencies)
		.values({ cardId: blockedId, dependsOnCardId: blockerId, createdByUserId: locals.user.id })
		.returning()
		.get();

	const titles = db
		.select({ id: cards.id, title: cards.title })
		.from(cards)
		.where(eq(cards.id, blockedId))
		.get();
	const blockerTitle = db
		.select({ title: cards.title })
		.from(cards)
		.where(eq(cards.id, blockerId))
		.get();

	logActivity({
		boardId,
		cardId,
		userId: locals.user.id,
		action: 'api:dependency_added',
		detail: `#${blockedId} "${titles?.title ?? ''}" now waits on #${blockerId} "${blockerTitle?.title ?? ''}"`,
		userName: locals.user.username,
		userEmoji: locals.user.emoji || '👤'
	});

	emit(boardId, 'update', { type: 'card' });
	if (otherBoardId !== boardId) emit(otherBoardId, 'update', { type: 'card' });

	return json(
		{
			id: dep.id,
			blockedCardId: blockedId,
			blockerCardId: blockerId,
			title: blockerTitle?.title ?? '',
			createdAt: dep.createdAt
		},
		{ status: 201 }
	);
};

/**
 * DELETE /api/v1/cards/:cardId/dependencies — remove a dependency.
 *
 * Body: `{ dependsOnCardId }` or `{ blocksCardId }` — the same two spellings
 * POST accepts, so a caller never has to work out which end stores the row.
 */
export const DELETE: RequestHandler = async ({ params, request, locals }) => {
	if (!locals.user) throw error(401, 'Not authenticated');

	const cardId = Number(params.cardId);
	if (isNaN(cardId)) throw error(400, 'Invalid card ID');

	const boardId = getCardBoardId(cardId);
	if (!boardId) throw error(404, 'Card not found');
	if (!canEditBoard(locals.user, boardId)) throw error(403, 'No edit access to this card\'s board');

	const body = await request.json();
	const { dependsOnCardId, blocksCardId } = body;

	if (!dependsOnCardId && !blocksCardId) {
		throw error(400, 'Provide either dependsOnCardId or blocksCardId');
	}

	const blockedId = dependsOnCardId ? cardId : Number(blocksCardId);
	const blockerId = dependsOnCardId ? Number(dependsOnCardId) : cardId;

	const removed = db
		.delete(cardDependencies)
		.where(
			and(eq(cardDependencies.cardId, blockedId), eq(cardDependencies.dependsOnCardId, blockerId))
		)
		.returning()
		.all();

	if (removed.length === 0) throw error(404, 'Dependency not found');

	logActivity({
		boardId,
		cardId,
		userId: locals.user.id,
		action: 'api:dependency_removed',
		detail: `#${blockedId} no longer waits on #${blockerId}`,
		userName: locals.user.username,
		userEmoji: locals.user.emoji || '👤'
	});

	emit(boardId, 'update', { type: 'card' });

	return json({ success: true, removed: removed.length });
};
