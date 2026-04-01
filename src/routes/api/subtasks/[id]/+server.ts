import { json, error } from '@sveltejs/kit';
import { db } from '$lib/server/db';
import { subtasks, cards, activityLog } from '$lib/server/db/schema';
import { eq } from 'drizzle-orm';
import { emit } from '$lib/server/events';
import type { RequestHandler } from './$types';

export const PUT: RequestHandler = async ({ params, request }) => {
	const id = Number(params.id);
	const data = await request.json();
	const { boardId, ...updateData } = data;
	const existing = db.select().from(subtasks).where(eq(subtasks.id, id)).get();
	const updated = db.update(subtasks).set(updateData).where(eq(subtasks.id, id)).returning().get();
	if (!updated) throw error(404, 'Subtask not found');
	if (boardId) emit(boardId, 'update', { type: 'subtask' });

	// Log activity when subtask is completed
	if (boardId && updateData.completed === true && existing && !existing.completed) {
		const parentCard = db.select().from(cards).where(eq(cards.id, updated.cardId)).get();
		db.insert(activityLog).values({
			boardId,
			cardId: updated.cardId,
			action: 'subtask_completed',
			detail: `${updated.title} (on ${parentCard?.title || 'Unknown'})`,
			userName: '',
			userEmoji: '👤'
		}).run();
	}

	return json(updated);
};

export const DELETE: RequestHandler = async ({ params, request }) => {
	const id = Number(params.id);
	let boardId: number | undefined;
	try {
		const data = await request.json();
		boardId = data.boardId;
	} catch {}
	db.delete(subtasks).where(eq(subtasks.id, id)).run();
	if (boardId) emit(boardId, 'update', { type: 'subtask' });
	return json({ success: true });
};
