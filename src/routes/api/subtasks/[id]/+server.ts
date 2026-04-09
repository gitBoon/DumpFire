import { json, error } from '@sveltejs/kit';
import { db } from '$lib/server/db';
import { subtasks, cards, columns, activityLog } from '$lib/server/db/schema';
import { eq } from 'drizzle-orm';
import { emit } from '$lib/server/events';
import { canEditBoard } from '$lib/server/board-access';
import type { RequestHandler } from './$types';

/** Resolve the board that a subtask belongs to (via card → column). */
function getSubtaskBoardId(subtaskId: number): number | null {
	const sub = db.select({ cardId: subtasks.cardId }).from(subtasks).where(eq(subtasks.id, subtaskId)).get();
	if (!sub) return null;
	const card = db.select({ columnId: cards.columnId }).from(cards).where(eq(cards.id, sub.cardId)).get();
	if (!card) return null;
	const col = db.select({ boardId: columns.boardId }).from(columns).where(eq(columns.id, card.columnId)).get();
	return col?.boardId ?? null;
}

export const PUT: RequestHandler = async ({ params, request, locals }) => {
	if (!locals.user) throw error(401, 'Not authenticated');

	const id = Number(params.id);
	const data = await request.json();
	const { boardId: clientBoardId, ...updateData } = data;

	// Resolve and verify board access
	const resolvedBoardId = clientBoardId || getSubtaskBoardId(id);
	if (resolvedBoardId && !canEditBoard(locals.user, resolvedBoardId)) {
		throw error(403, 'No edit access to this board');
	}

	const existing = db.select().from(subtasks).where(eq(subtasks.id, id)).get();
	const updated = db.update(subtasks).set(updateData).where(eq(subtasks.id, id)).returning().get();
	if (!updated) throw error(404, 'Subtask not found');
	if (resolvedBoardId) emit(resolvedBoardId, 'update', { type: 'subtask' });

	// Log activity when subtask is completed
	if (resolvedBoardId && updateData.completed === true && existing && !existing.completed) {
		const parentCard = db.select().from(cards).where(eq(cards.id, updated.cardId)).get();
		db.insert(activityLog).values({
			boardId: resolvedBoardId,
			cardId: updated.cardId,
			action: 'subtask_completed',
			detail: `${updated.title} (on ${parentCard?.title || 'Unknown'})`,
			userName: locals.user.username,
			userEmoji: locals.user.emoji || '👤'
		}).run();
	}

	return json(updated);
};

export const DELETE: RequestHandler = async ({ params, request, locals }) => {
	if (!locals.user) throw error(401, 'Not authenticated');

	const id = Number(params.id);
	let clientBoardId: number | undefined;
	try {
		const data = await request.json();
		clientBoardId = data.boardId;
	} catch {}

	// Resolve and verify board access
	const resolvedBoardId = clientBoardId || getSubtaskBoardId(id);
	if (resolvedBoardId && !canEditBoard(locals.user, resolvedBoardId)) {
		throw error(403, 'No edit access to this board');
	}

	db.delete(subtasks).where(eq(subtasks.id, id)).run();
	if (resolvedBoardId) emit(resolvedBoardId, 'update', { type: 'subtask' });
	return json({ success: true });
};
