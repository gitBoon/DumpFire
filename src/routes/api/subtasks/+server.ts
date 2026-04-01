import { json } from '@sveltejs/kit';
import { db } from '$lib/server/db';
import { subtasks } from '$lib/server/db/schema';
import { eq, asc } from 'drizzle-orm';
import { emit } from '$lib/server/events';
import type { RequestHandler } from './$types';

export const GET: RequestHandler = async ({ url }) => {
	const cardId = Number(url.searchParams.get('cardId'));
	if (!cardId) return json([]);
	const all = db.select().from(subtasks).where(eq(subtasks.cardId, cardId)).orderBy(asc(subtasks.position)).all();
	return json(all);
};

export const POST: RequestHandler = async ({ request }) => {
	const { cardId, title, description, priority, colorTag, dueDate, boardId } = await request.json();
	const existing = db.select().from(subtasks).where(eq(subtasks.cardId, cardId)).all();
	const maxPos = existing.length > 0 ? Math.max(...existing.map((s) => s.position)) + 1 : 0;

	const subtask = db
		.insert(subtasks)
		.values({
			cardId,
			title: title || 'New subtask',
			description: description || '',
			priority: priority || 'medium',
			colorTag: colorTag || '',
			dueDate: dueDate || null,
			position: maxPos
		})
		.returning()
		.get();

	if (boardId) emit(boardId, 'update', { type: 'subtask' });
	return json(subtask, { status: 201 });
};
