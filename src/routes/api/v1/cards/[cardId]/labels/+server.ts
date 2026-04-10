import { json, error } from '@sveltejs/kit';
import { db } from '$lib/server/db';
import { cards, columns, labels, cardLabels } from '$lib/server/db/schema';
import { eq, and, inArray } from 'drizzle-orm';
import { canViewBoard, canEditBoard } from '$lib/server/board-access';
import { emit } from '$lib/server/events';
import type { RequestHandler } from './$types';

/** Resolve a card ID to its board ID. */
function getCardBoardId(cardId: number): number {
	const card = db.select({ columnId: cards.columnId }).from(cards).where(eq(cards.id, cardId)).get();
	if (!card) throw error(404, 'Card not found');
	const col = db.select({ boardId: columns.boardId }).from(columns).where(eq(columns.id, card.columnId)).get();
	if (!col) throw error(404, 'Column not found');
	return col.boardId;
}

/** GET /api/v1/cards/:cardId/labels — List all labels assigned to a card. */
export const GET: RequestHandler = async ({ params, locals }) => {
	if (!locals.user) throw error(401, 'Not authenticated');

	const cardId = Number(params.cardId);
	if (isNaN(cardId)) throw error(400, 'Invalid card ID');

	const boardId = getCardBoardId(cardId);
	if (!canViewBoard(locals.user, boardId)) throw error(403, 'No access to this board');

	const assignments = db.select({ labelId: cardLabels.labelId })
		.from(cardLabels)
		.where(eq(cardLabels.cardId, cardId))
		.all();

	const labelIds = assignments.map(a => a.labelId);
	if (labelIds.length === 0) return json([]);

	const cardLabelsList = db.select().from(labels).where(inArray(labels.id, labelIds)).all();
	return json(cardLabelsList);
};

/** POST /api/v1/cards/:cardId/labels — Assign a label to a card. */
export const POST: RequestHandler = async ({ params, request, locals }) => {
	if (!locals.user) throw error(401, 'Not authenticated');

	const cardId = Number(params.cardId);
	if (isNaN(cardId)) throw error(400, 'Invalid card ID');

	const boardId = getCardBoardId(cardId);
	if (!canEditBoard(locals.user, boardId)) throw error(403, 'No edit access to this board');

	const body = await request.json();
	const { labelId } = body;
	if (!labelId) throw error(400, 'labelId is required');

	// Verify label exists and belongs to the same board
	const label = db.select().from(labels).where(eq(labels.id, labelId)).get();
	if (!label) throw error(404, 'Label not found');
	if (label.boardId !== boardId) throw error(400, 'Label does not belong to this card\'s board');

	// Check if already assigned
	const existing = db.select().from(cardLabels)
		.where(and(eq(cardLabels.cardId, cardId), eq(cardLabels.labelId, labelId)))
		.get();
	if (existing) return json({ message: 'Label already assigned' });

	db.insert(cardLabels).values({ cardId, labelId }).run();
	emit(boardId, 'update', { type: 'label' });

	return json({ cardId, labelId }, { status: 201 });
};

/** DELETE /api/v1/cards/:cardId/labels — Remove a label from a card. */
export const DELETE: RequestHandler = async ({ params, request, locals }) => {
	if (!locals.user) throw error(401, 'Not authenticated');

	const cardId = Number(params.cardId);
	if (isNaN(cardId)) throw error(400, 'Invalid card ID');

	const boardId = getCardBoardId(cardId);
	if (!canEditBoard(locals.user, boardId)) throw error(403, 'No edit access to this board');

	const body = await request.json();
	const { labelId } = body;
	if (!labelId) throw error(400, 'labelId is required');

	db.delete(cardLabels)
		.where(and(eq(cardLabels.cardId, cardId), eq(cardLabels.labelId, labelId)))
		.run();

	emit(boardId, 'update', { type: 'label' });

	return json({ success: true });
};
