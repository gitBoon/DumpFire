import { redirect } from '@sveltejs/kit';
import { db } from '$lib/server/db';
import { boards, columns, users } from '$lib/server/db/schema';
import { getAccessibleBoardIds } from '$lib/server/board-access';
import { asc, inArray } from 'drizzle-orm';
import { COLUMN_ORDER } from '$lib/server/card-order';
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

	// Every board's columns in one read, each board's in COLUMN_ORDER (card
	// 2399): each board was read with a query of its own, so the load grew with
	// the boards the caller can open.
	const boardIds = userBoards.map(b => b.id);
	const allColumns = boardIds.length > 0
		? db.select({ id: columns.id, title: columns.title, boardId: columns.boardId })
			.from(columns)
			.where(inArray(columns.boardId, boardIds))
			.orderBy(...COLUMN_ORDER)
			.all()
		: [];
	const columnsOf = new Map<number, { id: number; title: string }[]>();
	for (const { boardId, ...column } of allColumns) {
		const list = columnsOf.get(boardId);
		if (list) list.push(column);
		else columnsOf.set(boardId, [column]);
	}
	const boardsWithColumns = userBoards.map(b => ({ ...b, columns: columnsOf.get(b.id) ?? [] }));

	// Get all users for assignee picker
	const allUsers = db.select({ id: users.id, username: users.username, emoji: users.emoji })
		.from(users).orderBy(asc(users.username)).all();

	return { boards: boardsWithColumns, users: allUsers };
};

