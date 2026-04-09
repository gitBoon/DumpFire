import { json, error } from '@sveltejs/kit';
import { db } from '$lib/server/db';
import { boards, columns, boardMembers } from '$lib/server/db/schema';
import { desc, inArray } from 'drizzle-orm';
import { getAccessibleBoardIds } from '$lib/server/board-access';
import type { RequestHandler } from './$types';

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

export const POST: RequestHandler = async ({ request, locals }) => {
	if (!locals.user) throw error(401, 'Not authenticated');

	const { name, emoji, parentCardId, categoryId } = await request.json();
	const userId = locals.user.id;

	const board = db
		.insert(boards)
		.values({
			name: name || 'Untitled Board',
			emoji: emoji || '📋',
			parentCardId: parentCardId || null,
			categoryId: categoryId || null,
			createdBy: userId
		})
		.returning()
		.get();

	// Always create default columns
	db.insert(columns)
		.values([
			{ boardId: board.id, title: 'To Do', position: 0, color: '#6366f1' },
			{ boardId: board.id, title: 'On Hold', position: 1, color: '#ef4444' },
			{ boardId: board.id, title: 'In Progress', position: 2, color: '#f59e0b' },
			{ boardId: board.id, title: 'Complete', position: 3, color: '#10b981' }
		])
		.run();

	// Auto-add the creator as board owner
	db.insert(boardMembers)
		.values({ boardId: board.id, userId, role: 'owner' })
		.run();

	return json(board, { status: 201 });
};
