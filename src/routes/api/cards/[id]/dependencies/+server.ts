/**
 * Session-authenticated sibling of /api/v1/cards/:cardId/dependencies.
 *
 * The board UI runs on the session cookie and cannot send a bearer token, so
 * the card modal talks to this route. The rules — cycle rejection, edit access
 * on both ends, cross-board allowed — are the same; only the auth differs.
 */
import { json, error } from '@sveltejs/kit';
import { db } from '$lib/server/db';
import { cardDependencies, cards, columns } from '$lib/server/db/schema';
import { eq, and } from 'drizzle-orm';
import { canViewBoard, canEditBoard } from '$lib/server/board-access';
import { getCardDependencies, findDependencyCycle } from '$lib/server/planning';
import { emit } from '$lib/server/events';
import type { RequestHandler } from './$types';

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

/** Shape a dependency end for the card modal. */
function shape(refs: ReturnType<typeof getCardDependencies>['blockedBy']) {
	return refs.map((r) => ({
		cardId: r.id,
		title: r.title,
		boardId: r.boardId,
		boardName: r.boardName,
		columnName: r.columnTitle,
		priority: r.priority,
		resolved: r.isComplete
	}));
}

export const GET: RequestHandler = async ({ params, locals }) => {
	if (!locals.user) throw error(401, 'Not authenticated');

	const cardId = Number(params.id);
	if (isNaN(cardId)) throw error(400, 'Invalid card ID');

	const boardId = getCardBoardId(cardId);
	if (!boardId) throw error(404, 'Card not found');
	if (!canViewBoard(locals.user, boardId)) throw error(403, 'No access');

	const state = getCardDependencies(cardId);
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

	const { dependsOnCardId, blocksCardId } = await request.json();
	if (!dependsOnCardId && !blocksCardId) throw error(400, 'Nothing to link');

	const blockedId = dependsOnCardId ? cardId : Number(blocksCardId);
	const blockerId = dependsOnCardId ? Number(dependsOnCardId) : cardId;
	if (blockedId === blockerId) throw error(400, 'A card cannot depend on itself');

	const otherId = blockedId === cardId ? blockerId : blockedId;
	const otherBoardId = getCardBoardId(otherId);
	if (!otherBoardId) throw error(404, 'Target card not found');
	if (!canEditBoard(locals.user, otherBoardId)) throw error(403, 'No edit access to the other card\'s board');

	const existing = db
		.select({ id: cardDependencies.id })
		.from(cardDependencies)
		.where(and(eq(cardDependencies.cardId, blockedId), eq(cardDependencies.dependsOnCardId, blockerId)))
		.get();
	if (existing) throw error(409, 'That dependency already exists');

	const cycle = findDependencyCycle(blockedId, blockerId);
	if (cycle) {
		throw error(409, `That would create a cycle: ${cycle.map((id) => `#${id}`).join(' → ')} → #${cycle[0]}`);
	}

	db.insert(cardDependencies)
		.values({ cardId: blockedId, dependsOnCardId: blockerId, createdByUserId: locals.user.id })
		.run();

	emit(boardId, 'update', { type: 'card' });
	if (otherBoardId !== boardId) emit(otherBoardId, 'update', { type: 'card' });

	const state = getCardDependencies(cardId);
	return json({ blockedBy: shape(state.blockedBy), blocks: shape(state.blocks), isBlocked: state.isBlocked }, { status: 201 });
};

export const DELETE: RequestHandler = async ({ params, request, locals }) => {
	if (!locals.user) throw error(401, 'Not authenticated');

	const cardId = Number(params.id);
	if (isNaN(cardId)) throw error(400, 'Invalid card ID');

	const boardId = getCardBoardId(cardId);
	if (!boardId) throw error(404, 'Card not found');
	if (!canEditBoard(locals.user, boardId)) throw error(403, 'No edit access');

	const { dependsOnCardId, blocksCardId } = await request.json();
	if (!dependsOnCardId && !blocksCardId) throw error(400, 'Nothing to remove');

	const blockedId = dependsOnCardId ? cardId : Number(blocksCardId);
	const blockerId = dependsOnCardId ? Number(dependsOnCardId) : cardId;

	db.delete(cardDependencies)
		.where(and(eq(cardDependencies.cardId, blockedId), eq(cardDependencies.dependsOnCardId, blockerId)))
		.run();

	emit(boardId, 'update', { type: 'card' });

	const state = getCardDependencies(cardId);
	return json({ blockedBy: shape(state.blockedBy), blocks: shape(state.blocks), isBlocked: state.isBlocked });
};
