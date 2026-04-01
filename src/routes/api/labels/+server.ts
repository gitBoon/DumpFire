import { json } from '@sveltejs/kit';
import { db } from '$lib/server/db';
import { labels, cardLabels } from '$lib/server/db/schema';
import { eq, and } from 'drizzle-orm';
import { emit } from '$lib/server/events';
import type { RequestHandler } from './$types';

// Get all labels for a board
export const GET: RequestHandler = async ({ url }) => {
	const boardId = Number(url.searchParams.get('boardId'));
	if (!boardId) return json([]);
	const result = db.select().from(labels).where(eq(labels.boardId, boardId)).all();
	return json(result);
};

// Create a new label
export const POST: RequestHandler = async ({ request }) => {
	const { boardId, name, color } = await request.json();
	const label = db
		.insert(labels)
		.values({ boardId, name, color: color || '#6366f1' })
		.returning()
		.get();
	if (boardId) emit(boardId, 'update', { type: 'label' });
	return json(label, { status: 201 });
};

// Toggle a label on a card
export const PUT: RequestHandler = async ({ request }) => {
	const { cardId, labelId, boardId } = await request.json();
	// Check if it exists
	const existing = db
		.select()
		.from(cardLabels)
		.where(and(eq(cardLabels.cardId, cardId), eq(cardLabels.labelId, labelId)))
		.get();

	if (existing) {
		db.delete(cardLabels)
			.where(and(eq(cardLabels.cardId, cardId), eq(cardLabels.labelId, labelId)))
			.run();
	} else {
		db.insert(cardLabels).values({ cardId, labelId }).run();
	}
	if (boardId) emit(boardId, 'update', { type: 'label' });
	return json({ toggled: !existing });
};

// Delete a label
export const DELETE: RequestHandler = async ({ request }) => {
	const { id, boardId } = await request.json();
	db.delete(labels).where(eq(labels.id, id)).run();
	if (boardId) emit(boardId, 'update', { type: 'label' });
	return json({ success: true });
};
