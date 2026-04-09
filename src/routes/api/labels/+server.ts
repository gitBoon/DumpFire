import { json, error } from '@sveltejs/kit';
import { db } from '$lib/server/db';
import { labels, cardLabels } from '$lib/server/db/schema';
import { eq, and } from 'drizzle-orm';
import { emit } from '$lib/server/events';
import { canViewBoard, canEditBoard } from '$lib/server/board-access';
import type { RequestHandler } from './$types';

// Get all labels for a board
export const GET: RequestHandler = async ({ url, locals }) => {
	if (!locals.user) throw error(401, 'Not authenticated');

	const boardId = Number(url.searchParams.get('boardId'));
	if (!boardId) return json([]);

	if (!canViewBoard(locals.user, boardId)) throw error(403, 'No access to this board');

	const result = db.select().from(labels).where(eq(labels.boardId, boardId)).all();
	return json(result);
};

// Create a new label
export const POST: RequestHandler = async ({ request, locals }) => {
	if (!locals.user) throw error(401, 'Not authenticated');

	const { boardId, name, color } = await request.json();

	if (!canEditBoard(locals.user, boardId)) throw error(403, 'No edit access to this board');

	const label = db
		.insert(labels)
		.values({ boardId, name, color: color || '#6366f1' })
		.returning()
		.get();
	if (boardId) emit(boardId, 'update', { type: 'label' });
	return json(label, { status: 201 });
};

// Toggle a label on a card
export const PUT: RequestHandler = async ({ request, locals }) => {
	if (!locals.user) throw error(401, 'Not authenticated');

	const { cardId, labelId, boardId } = await request.json();

	if (!canEditBoard(locals.user, boardId)) throw error(403, 'No edit access to this board');

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
export const DELETE: RequestHandler = async ({ request, locals }) => {
	if (!locals.user) throw error(401, 'Not authenticated');

	const { id, boardId } = await request.json();

	if (!canEditBoard(locals.user, boardId)) throw error(403, 'No edit access to this board');

	db.delete(labels).where(eq(labels.id, id)).run();
	if (boardId) emit(boardId, 'update', { type: 'label' });
	return json({ success: true });
};
