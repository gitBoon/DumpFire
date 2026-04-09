import { json, error } from '@sveltejs/kit';
import { db } from '$lib/server/db';
import { subtasks, cards, columns } from '$lib/server/db/schema';
import { eq } from 'drizzle-orm';
import { canEditBoard } from '$lib/server/board-access';
import { emit } from '$lib/server/events';
import type { RequestHandler } from './$types';

/** Resolve the board that a subtask belongs to (via card → column → board). */
function getSubtaskBoardId(subtaskId: number): { boardId: number; cardId: number } | null {
	const sub = db.select({ cardId: subtasks.cardId }).from(subtasks).where(eq(subtasks.id, subtaskId)).get();
	if (!sub) return null;
	const card = db.select({ columnId: cards.columnId }).from(cards).where(eq(cards.id, sub.cardId)).get();
	if (!card) return null;
	const col = db.select({ boardId: columns.boardId }).from(columns).where(eq(columns.id, card.columnId)).get();
	if (!col) return null;
	return { boardId: col.boardId, cardId: sub.cardId };
}

/** PUT /api/v1/subtasks/:subtaskId — Update a subtask. */
export const PUT: RequestHandler = async ({ params, request, locals }) => {
	if (!locals.user) throw error(401, 'Not authenticated');

	const subtaskId = Number(params.subtaskId);
	if (isNaN(subtaskId)) throw error(400, 'Invalid subtask ID');

	const ctx = getSubtaskBoardId(subtaskId);
	if (!ctx) throw error(404, 'Subtask not found');

	if (!canEditBoard(locals.user, ctx.boardId)) {
		throw error(403, 'No edit access to this subtask\'s board');
	}

	const data = await request.json();

	// Whitelist allowed fields
	const updateData: Record<string, unknown> = {};
	const allowed = ['title', 'description', 'priority', 'colorTag', 'dueDate', 'completed', 'position'];
	for (const key of allowed) {
		if (key in data) updateData[key] = data[key];
	}

	if (Object.keys(updateData).length === 0) {
		throw error(400, 'No valid fields to update');
	}

	if (updateData.title && typeof updateData.title === 'string' && updateData.title.length > 500) {
		throw error(400, 'Title too long (max 500 chars)');
	}

	const updated = db.update(subtasks)
		.set(updateData)
		.where(eq(subtasks.id, subtaskId))
		.returning()
		.get();

	if (!updated) throw error(404, 'Subtask not found');

	emit(ctx.boardId, 'update', { type: 'card' });

	return json(updated);
};

/** DELETE /api/v1/subtasks/:subtaskId — Delete a subtask permanently. */
export const DELETE: RequestHandler = async ({ params, locals }) => {
	if (!locals.user) throw error(401, 'Not authenticated');

	const subtaskId = Number(params.subtaskId);
	if (isNaN(subtaskId)) throw error(400, 'Invalid subtask ID');

	const ctx = getSubtaskBoardId(subtaskId);
	if (!ctx) throw error(404, 'Subtask not found');

	if (!canEditBoard(locals.user, ctx.boardId)) {
		throw error(403, 'No edit access to this subtask\'s board');
	}

	db.delete(subtasks).where(eq(subtasks.id, subtaskId)).run();

	emit(ctx.boardId, 'update', { type: 'card' });

	return json({ success: true });
};
