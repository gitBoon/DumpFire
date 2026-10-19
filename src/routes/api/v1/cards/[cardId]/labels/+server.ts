import { error } from '@sveltejs/kit';
import { json } from '$lib/server/v1-json';
import { db } from '$lib/server/db';
import { cards, columns, labels, cardLabels } from '$lib/server/db/schema';
import { eq, and, inArray } from 'drizzle-orm';
import { canViewBoard } from '$lib/server/board-access';
import { emit } from '$lib/server/events';
import { pathId, readBody, readId } from '$lib/server/request-body';
import { requireCard, requireUser } from '$lib/server/route-guards';
import { writeAs } from '$lib/server/write-as';
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

	const cardId = pathId(params.cardId, 'card');

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
	requireUser(locals.user);
	const cardId = pathId(params.cardId, 'card');
	const body = await readBody(request);

	// The card and the label are read, and the caller checked, in the
	// transaction that puts the label on, once the body has arrived. It asks
	// first whether the key or session is still open, and who its account is
	// now (card 2253), and answers whether the label was already on; the
	// answer is made once it has committed.
	const done = writeAs(locals, (caller) => {
		const { boardId } = requireCard(caller, cardId, 'edit');

		const labelId = readId(body, 'labelId', { required: true, says: { missing: 'labelId is required' } });

		// Verify label exists and belongs to the same board
		const label = db.select().from(labels).where(eq(labels.id, labelId)).get();
		if (!label) throw error(404, 'Label not found');
		if (label.boardId !== boardId) throw error(400, 'Label does not belong to this card\'s board');

		// Check if already assigned
		const existing = db.select().from(cardLabels)
			.where(and(eq(cardLabels.cardId, cardId), eq(cardLabels.labelId, labelId)))
			.get();
		if (existing) return { already: true, labelId };

		db.insert(cardLabels).values({ cardId, labelId }).run();
		emit(boardId, 'update', { type: 'label' });

		return { already: false, labelId };
	});

	if (done.already) return json({ message: 'Label already assigned' });
	return json({ cardId, labelId: done.labelId }, { status: 201 });
};

/**
 * DELETE /api/v1/cards/:cardId/labels — Remove a label from a card.
 *
 * A label that is not on the card is 404: it was answered 200, as if it had
 * been taken off.
 */
export const DELETE: RequestHandler = async ({ params, request, locals }) => {
	requireUser(locals.user);
	const cardId = pathId(params.cardId, 'card');
	const body = await readBody(request);

	// The card read, the caller checked and the label taken off in one
	// transaction that asks first whether the key or session is still open,
	// and who its account is now (card 2253).
	writeAs(locals, (caller) => {
		const { boardId } = requireCard(caller, cardId, 'edit');

		const labelId = readId(body, 'labelId', { required: true, says: { missing: 'labelId is required' } });

		const removed = db.delete(cardLabels)
			.where(and(eq(cardLabels.cardId, cardId), eq(cardLabels.labelId, labelId)))
			.run();
		if (removed.changes === 0) throw error(404, 'Label not found on this card');

		emit(boardId, 'update', { type: 'label' });
	});

	return json({ success: true });
};
