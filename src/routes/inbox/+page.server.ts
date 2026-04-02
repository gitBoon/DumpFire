import { redirect } from '@sveltejs/kit';
import { db } from '$lib/server/db';
import { boards, columns, users } from '$lib/server/db/schema';
import { getAccessibleBoardIds } from '$lib/server/board-access';
import { eq, asc, inArray } from 'drizzle-orm';
import type { PageServerLoad } from './$types';

export const load: PageServerLoad = async ({ locals }) => {
	if (!locals.user) throw redirect(303, '/login');

	// Get boards accessible to this user (for the accept modal)
	const accessibleIds = getAccessibleBoardIds(locals.user);

	let userBoards: { id: number; name: string; emoji: string | null }[] = [];
	if (accessibleIds === null) {
		userBoards = db.select({ id: boards.id, name: boards.name, emoji: boards.emoji })
			.from(boards).orderBy(asc(boards.name)).all();
	} else if (accessibleIds.length > 0) {
		userBoards = db.select({ id: boards.id, name: boards.name, emoji: boards.emoji })
			.from(boards).where(inArray(boards.id, accessibleIds)).orderBy(asc(boards.name)).all();
	}

	const boardsWithColumns = userBoards.map(b => {
		const cols = db.select({ id: columns.id, title: columns.title })
			.from(columns)
			.where(eq(columns.boardId, b.id))
			.orderBy(asc(columns.position))
			.all();
		return { ...b, columns: cols };
	});

	// Get all users for assignee picker
	const allUsers = db.select({ id: users.id, username: users.username, emoji: users.emoji })
		.from(users).orderBy(asc(users.username)).all();

	return { boards: boardsWithColumns, users: allUsers };
};

