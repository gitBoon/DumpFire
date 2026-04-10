import { json, error } from '@sveltejs/kit';
import { db } from '$lib/server/db';
import { boards, columns, cards } from '$lib/server/db/schema';
import { eq, asc, inArray } from 'drizzle-orm';
import { canViewBoard, canEditBoard, getBoardRole } from '$lib/server/board-access';
import { emit } from '$lib/server/events';
import { logActivity } from '$lib/server/logActivity';
import type { RequestHandler } from './$types';

/** GET /api/v1/boards/:boardId — Get board details with its columns. */
export const GET: RequestHandler = async ({ params, locals }) => {
	if (!locals.user) throw error(401, 'Not authenticated');

	const boardId = Number(params.boardId);
	if (isNaN(boardId)) throw error(400, 'Invalid board ID');

	if (!canViewBoard(locals.user, boardId)) {
		throw error(403, 'No access to this board');
	}

	const board = db.select().from(boards).where(eq(boards.id, boardId)).get();
	if (!board) throw error(404, 'Board not found');

	const cols = db.select()
		.from(columns)
		.where(eq(columns.boardId, boardId))
		.orderBy(asc(columns.position))
		.all();

	return json({ ...board, columns: cols });
};

/** PUT /api/v1/boards/:boardId — Update board name, emoji, categoryId, or isPublic. */
export const PUT: RequestHandler = async ({ params, request, locals }) => {
	if (!locals.user) throw error(401, 'Not authenticated');

	const boardId = Number(params.boardId);
	if (isNaN(boardId)) throw error(400, 'Invalid board ID');

	if (!canEditBoard(locals.user, boardId)) {
		throw error(403, 'No edit access to this board');
	}

	const board = db.select().from(boards).where(eq(boards.id, boardId)).get();
	if (!board) throw error(404, 'Board not found');

	const body = await request.json();
	const updates: Record<string, unknown> = {};
	const allowed = ['name', 'emoji', 'categoryId', 'isPublic'];

	for (const key of allowed) {
		if (key in body) {
			if (key === 'name') {
				if (!body.name || !String(body.name).trim()) throw error(400, 'name cannot be empty');
				if (String(body.name).length > 200) throw error(400, 'Board name too long (max 200 chars)');
				updates.name = String(body.name).trim();
			} else {
				updates[key] = body[key];
			}
		}
	}

	if (Object.keys(updates).length === 0) {
		throw error(400, 'No valid fields to update');
	}

	updates.updatedAt = new Date().toISOString();

	const updated = db.update(boards)
		.set(updates)
		.where(eq(boards.id, boardId))
		.returning()
		.get();

	emit(boardId, 'update', { type: 'board' });

	logActivity({
		boardId,
		userId: locals.user.id,
		action: 'api:board_updated',
		detail: `Updated board "${updated.name}" (fields: ${Object.keys(updates).filter(k => k !== 'updatedAt').join(', ')})`,
		userName: locals.user.username,
		userEmoji: locals.user.emoji || '👤'
	});

	return json(updated);
};

/** DELETE /api/v1/boards/:boardId — Delete a board and all its data. */
export const DELETE: RequestHandler = async ({ params, locals }) => {
	if (!locals.user) throw error(401, 'Not authenticated');

	const boardId = Number(params.boardId);
	if (isNaN(boardId)) throw error(400, 'Invalid board ID');

	// Only owners and admins can delete boards
	const role = getBoardRole(locals.user, boardId);
	if (role !== 'admin' && role !== 'owner') {
		throw error(403, 'Only board owners and admins can delete boards');
	}

	const board = db.select().from(boards).where(eq(boards.id, boardId)).get();
	if (!board) throw error(404, 'Board not found');

	// Check for sub-boards that would be orphaned
	const boardCols = db.select({ id: columns.id }).from(columns).where(eq(columns.boardId, boardId)).all();
	const colIds = boardCols.map(c => c.id);
	if (colIds.length > 0) {
		const boardCards = db.select({ id: cards.id }).from(cards).where(inArray(cards.columnId, colIds)).all();
		const cardIds = boardCards.map(c => c.id);
		if (cardIds.length > 0) {
			const subBoards = db.select({ id: boards.id }).from(boards).where(inArray(boards.parentCardId, cardIds)).all();
			if (subBoards.length > 0) {
				// Cascade — delete sub-boards first
				for (const sb of subBoards) {
					db.delete(boards).where(eq(boards.id, sb.id)).run();
				}
			}
		}
	}

	db.delete(boards).where(eq(boards.id, boardId)).run();

	return json({ success: true });
};
