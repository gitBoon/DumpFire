import { json, error } from '@sveltejs/kit';
import { db } from '$lib/server/db';
import { cards, columns, subtasks, cardLabels, cardAssignees, users } from '$lib/server/db/schema';
import { eq } from 'drizzle-orm';
import { canViewBoard, canEditBoard } from '$lib/server/board-access';
import { emit } from '$lib/server/events';
import type { RequestHandler } from './$types';

/** Resolve the board that a card belongs to. */
function getCardBoardId(cardId: number): number | null {
	const card = db.select({ columnId: cards.columnId }).from(cards).where(eq(cards.id, cardId)).get();
	if (!card) return null;
	const col = db.select({ boardId: columns.boardId }).from(columns).where(eq(columns.id, card.columnId)).get();
	return col?.boardId ?? null;
}

/** GET /api/v1/cards/:cardId — Get a single card with subtasks and assignees. */
export const GET: RequestHandler = async ({ params, locals }) => {
	if (!locals.user) throw error(401, 'Not authenticated');

	const cardId = Number(params.cardId);
	if (isNaN(cardId)) throw error(400, 'Invalid card ID');

	const boardId = getCardBoardId(cardId);
	if (!boardId) throw error(404, 'Card not found');

	if (!canViewBoard(locals.user, boardId)) {
		throw error(403, 'No access to this card\'s board');
	}

	const card = db.select().from(cards).where(eq(cards.id, cardId)).get();
	if (!card) throw error(404, 'Card not found');

	// Fetch subtasks
	const cardSubtasks = db.select().from(subtasks)
		.where(eq(subtasks.cardId, cardId))
		.all();

	// Fetch label IDs
	const labelRows = db.select({ labelId: cardLabels.labelId })
		.from(cardLabels)
		.where(eq(cardLabels.cardId, cardId))
		.all();

	// Fetch assignees
	const assigneeRows = db.select({
		id: users.id,
		username: users.username,
		emoji: users.emoji
	})
		.from(cardAssignees)
		.innerJoin(users, eq(cardAssignees.userId, users.id))
		.where(eq(cardAssignees.cardId, cardId))
		.all();

	// Column info
	const col = db.select({ title: columns.title, boardId: columns.boardId })
		.from(columns)
		.where(eq(columns.id, card.columnId))
		.get();

	return json({
		...card,
		boardId,
		columnTitle: col?.title || 'Unknown',
		subtasks: cardSubtasks,
		labelIds: labelRows.map(r => r.labelId),
		assignees: assigneeRows
	});
};

/** PUT /api/v1/cards/:cardId — Update card fields. */
export const PUT: RequestHandler = async ({ params, request, locals }) => {
	if (!locals.user) throw error(401, 'Not authenticated');

	const cardId = Number(params.cardId);
	if (isNaN(cardId)) throw error(400, 'Invalid card ID');

	const boardId = getCardBoardId(cardId);
	if (!boardId) throw error(404, 'Card not found');

	if (!canEditBoard(locals.user, boardId)) {
		throw error(403, 'No edit access to this card\'s board');
	}

	const data = await request.json();

	// Whitelist allowed fields
	const updateData: Record<string, unknown> = {};
	const allowed = ['title', 'description', 'priority', 'colorTag', 'categoryId', 'dueDate',
		'onHoldNote', 'businessValue', 'pinned', 'coverUrl'];
	for (const key of allowed) {
		if (key in data) updateData[key] = data[key];
	}

	if (Object.keys(updateData).length === 0) {
		throw error(400, 'No valid fields to update');
	}

	// Validate lengths
	if (updateData.title && typeof updateData.title === 'string' && updateData.title.length > 500) {
		throw error(400, 'Title too long (max 500 chars)');
	}
	if (updateData.description && typeof updateData.description === 'string' && updateData.description.length > 50000) {
		throw error(400, 'Description too long (max 50000 chars)');
	}

	updateData.updatedAt = new Date().toISOString();

	const updated = db.update(cards)
		.set(updateData)
		.where(eq(cards.id, cardId))
		.returning()
		.get();

	if (!updated) throw error(404, 'Card not found');

	emit(boardId, 'update', { type: 'card' });

	return json(updated);
};

/** DELETE /api/v1/cards/:cardId — Archive (soft-delete) a card. Use ?permanent=true for hard delete. */
export const DELETE: RequestHandler = async ({ params, url, locals }) => {
	if (!locals.user) throw error(401, 'Not authenticated');

	const cardId = Number(params.cardId);
	if (isNaN(cardId)) throw error(400, 'Invalid card ID');

	const boardId = getCardBoardId(cardId);
	if (!boardId) throw error(404, 'Card not found');

	if (!canEditBoard(locals.user, boardId)) {
		throw error(403, 'No edit access to this card\'s board');
	}

	const permanent = url.searchParams.get('permanent') === 'true';

	if (permanent) {
		db.delete(cards).where(eq(cards.id, cardId)).run();
	} else {
		db.update(cards)
			.set({ archivedAt: new Date().toISOString(), updatedAt: new Date().toISOString() })
			.where(eq(cards.id, cardId))
			.run();
	}

	emit(boardId, 'update', { type: 'card' });

	return json({ success: true });
};
