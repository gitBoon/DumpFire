import { json, error } from '@sveltejs/kit';
import { db } from '$lib/server/db';
import { boards, columns, boardMembers, cards } from '$lib/server/db/schema';
import { desc, inArray, eq } from 'drizzle-orm';
import { getAccessibleBoardIds, canEditBoard } from '$lib/server/board-access';
import { logActivity } from '$lib/server/logActivity';
import type { RequestHandler } from './$types';

/** GET /api/v1/boards — List all boards accessible to the API key's user. */
export const GET: RequestHandler = async ({ locals }) => {
	if (!locals.user) throw error(401, 'Not authenticated');

	const accessibleIds = getAccessibleBoardIds(locals.user);

	let allBoards: (typeof boards.$inferSelect)[];
	if (accessibleIds === null) {
		// Admin — sees everything
		allBoards = db.select().from(boards).orderBy(desc(boards.createdAt)).all();
	} else if (accessibleIds.length === 0) {
		allBoards = [];
	} else {
		allBoards = db.select().from(boards)
			.where(inArray(boards.id, accessibleIds))
			.orderBy(desc(boards.createdAt))
			.all();
	}

	return json(allBoards);
};

/**
 * POST /api/v1/boards — Create a new board.
 *
 * Body: { name, emoji?, parentCardId? }
 *
 * If parentCardId is provided, the board is created as a sub-board
 * linked to that card. The user must have edit access to the parent
 * card's board.
 *
 * Default columns (To Do, On Hold, In Progress, Complete) are
 * created automatically. The API key's user is added as board owner.
 */
export const POST: RequestHandler = async ({ request, locals }) => {
	if (!locals.user) throw error(401, 'Not authenticated');

	const body = await request.json();
	const { name, emoji, parentCardId } = body;

	if (!name || !name.trim()) throw error(400, 'name is required');
	if (name.length > 200) throw error(400, 'Board name too long (max 200 chars)');

	// If linking to a parent card, verify access to that card's board
	if (parentCardId) {
		const parentCard = db.select().from(cards).where(eq(cards.id, parentCardId)).get();
		if (!parentCard) throw error(404, 'Parent card not found');

		const parentCol = db.select({ boardId: columns.boardId }).from(columns).where(eq(columns.id, parentCard.columnId)).get();
		if (!parentCol) throw error(404, 'Parent card column not found');

		if (!canEditBoard(locals.user, parentCol.boardId)) {
			throw error(403, 'No edit access to the parent card\'s board');
		}
	}

	const board = db
		.insert(boards)
		.values({
			name: name.trim(),
			emoji: emoji || '📋',
			parentCardId: parentCardId || null,
			createdBy: locals.user.id
		})
		.returning()
		.get();

	// Create default columns
	db.insert(columns)
		.values([
			{ boardId: board.id, title: 'To Do', position: 0, color: '#6366f1' },
			{ boardId: board.id, title: 'On Hold', position: 1, color: '#ef4444' },
			{ boardId: board.id, title: 'In Progress', position: 2, color: '#f59e0b' },
			{ boardId: board.id, title: 'Complete', position: 3, color: '#10b981' }
		])
		.run();

	// Auto-add creator as board owner
	db.insert(boardMembers)
		.values({ boardId: board.id, userId: locals.user.id, role: 'owner' })
		.run();

	logActivity({
		boardId: board.id,
		userId: locals.user.id,
		action: 'api:board_created',
		detail: `Created board "${board.name}"`,
		userName: locals.user.username,
		userEmoji: locals.user.emoji || '👤'
	});

	// Return the board with its columns
	const boardColumns = db.select().from(columns).where(eq(columns.boardId, board.id)).all();

	return json({ ...board, columns: boardColumns }, { status: 201 });
};
