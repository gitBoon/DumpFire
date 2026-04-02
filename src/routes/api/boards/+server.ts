import { json } from '@sveltejs/kit';
import { db } from '$lib/server/db';
import { boards, columns, boardMembers } from '$lib/server/db/schema';
import { desc } from 'drizzle-orm';
import type { RequestHandler } from './$types';

export const GET: RequestHandler = async () => {
	const allBoards = db.select().from(boards).orderBy(desc(boards.createdAt)).all();
	return json(allBoards);
};

export const POST: RequestHandler = async ({ request, locals }) => {
	const { name, emoji, parentCardId } = await request.json();
	const userId = locals.user?.id || null;

	const board = db
		.insert(boards)
		.values({
			name: name || 'Untitled Board',
			emoji: emoji || '📋',
			parentCardId: parentCardId || null,
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
	if (userId) {
		db.insert(boardMembers)
			.values({ boardId: board.id, userId, role: 'owner' })
			.run();
	}

	return json(board, { status: 201 });
};
