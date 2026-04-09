import { json, error } from '@sveltejs/kit';
import { db } from '$lib/server/db';
import { boards, columns, cards } from '$lib/server/db/schema';
import { eq, inArray } from 'drizzle-orm';
import { canEditBoard, getBoardRole } from '$lib/server/board-access';
import type { RequestHandler } from './$types';

export const PUT: RequestHandler = async ({ params, request, locals }) => {
	if (!locals.user) throw error(401, 'Not authenticated');

	const id = Number(params.id);

	if (!canEditBoard(locals.user, id)) {
		throw error(403, 'No edit access to this board');
	}

	const data = await request.json();

	// Whitelist allowed fields to prevent mass assignment
	const updateData: Record<string, unknown> = {};
	const allowed = ['name', 'emoji', 'isPublic', 'categoryId'];
	for (const key of allowed) {
		if (key in data) updateData[key] = data[key];
	}
	updateData.updatedAt = new Date().toISOString();

	const updated = db
		.update(boards)
		.set(updateData)
		.where(eq(boards.id, id))
		.returning()
		.get();
	if (!updated) throw error(404, 'Board not found');
	return json(updated);
};

export const DELETE: RequestHandler = async ({ params, locals }) => {
	if (!locals.user) throw error(401, 'Not authenticated');

	const id = Number(params.id);

	// Only owners and admins can delete boards
	const role = getBoardRole(locals.user, id);
	if (role !== 'owner' && role !== 'admin') {
		throw error(403, 'Only board owners and admins can delete boards');
	}

	deleteBoardCascade(id);
	return json({ success: true });
};

function deleteBoardCascade(boardId: number) {
	// Find all cards on this board
	const boardCols = db.select().from(columns).where(eq(columns.boardId, boardId)).all();
	const colIds = boardCols.map(c => c.id);

	if (colIds.length > 0) {
		const boardCards = db.select().from(cards).where(inArray(cards.columnId, colIds)).all();
		const cardIds = boardCards.map(c => c.id);

		if (cardIds.length > 0) {
			// Find sub-boards linked to these cards and recursively delete them
			const childBoards = db.select().from(boards).where(inArray(boards.parentCardId, cardIds)).all();
			for (const child of childBoards) {
				deleteBoardCascade(child.id);
			}
		}
	}

	// Now delete the board itself (columns, cards, subtasks etc. cascade via SQLite FK)
	db.delete(boards).where(eq(boards.id, boardId)).run();
}
