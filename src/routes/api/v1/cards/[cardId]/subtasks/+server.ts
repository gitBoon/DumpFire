import { json, error } from '@sveltejs/kit';
import { db } from '$lib/server/db';
import { cards, columns, subtasks } from '$lib/server/db/schema';
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

/** GET /api/v1/cards/:cardId/subtasks — List all subtasks for a card. */
export const GET: RequestHandler = async ({ params, locals }) => {
	if (!locals.user) throw error(401, 'Not authenticated');

	const cardId = Number(params.cardId);
	if (isNaN(cardId)) throw error(400, 'Invalid card ID');

	const boardId = getCardBoardId(cardId);
	if (!boardId) throw error(404, 'Card not found');

	if (!canViewBoard(locals.user, boardId)) {
		throw error(403, 'No access to this card\'s board');
	}

	const cardSubtasks = db.select()
		.from(subtasks)
		.where(eq(subtasks.cardId, cardId))
		.all();

	return json(cardSubtasks);
};

/** POST /api/v1/cards/:cardId/subtasks — Create a new subtask on a card. */
export const POST: RequestHandler = async ({ params, request, locals }) => {
	if (!locals.user) throw error(401, 'Not authenticated');

	const cardId = Number(params.cardId);
	if (isNaN(cardId)) throw error(400, 'Invalid card ID');

	const boardId = getCardBoardId(cardId);
	if (!boardId) throw error(404, 'Card not found');

	if (!canEditBoard(locals.user, boardId)) {
		throw error(403, 'No edit access to this card\'s board');
	}

	const body = await request.json();
	const { title, description, priority, colorTag, dueDate, position } = body;

	if (!title || !title.trim()) throw error(400, 'title is required');
	if (title.length > 500) throw error(400, 'Title too long (max 500 chars)');

	const subtask = db.insert(subtasks)
		.values({
			cardId,
			title: title.trim(),
			description: description || '',
			priority: priority || 'medium',
			colorTag: colorTag || '',
			dueDate: dueDate || null,
			position: position ?? 0
		})
		.returning()
		.get();

	emit(boardId, 'update', { type: 'card' });

	return json(subtask, { status: 201 });
};
