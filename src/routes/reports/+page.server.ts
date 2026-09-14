import { db } from '$lib/server/db';
import { boards, boardCategories, reportSchedules, users, cardAssignees, cards, columns } from '$lib/server/db/schema';
import { eq, desc, isNull, inArray, and } from 'drizzle-orm';
import { getAccessibleBoardIds } from '$lib/server/board-access';
import type { PageServerLoad } from './$types';

export const load: PageServerLoad = async ({ locals }) => {
	const user = locals.user!;

	// Get accessible boards
	const accessibleIds = getAccessibleBoardIds(user);
	let userBoards: (typeof boards.$inferSelect)[];
	if (accessibleIds === null) {
		userBoards = db.select().from(boards).where(isNull(boards.parentCardId)).all();
	} else if (accessibleIds.length === 0) {
		userBoards = [];
	} else {
		userBoards = db.select().from(boards)
			.where(isNull(boards.parentCardId))
			.all()
			.filter(b => accessibleIds.includes(b.id));
	}

	// Get board categories
	const allCategories = db.select().from(boardCategories).all();

	// Get user's schedules
	const userSchedules = db.select().from(reportSchedules)
		.where(eq(reportSchedules.userId, user.id))
		.orderBy(desc(reportSchedules.createdAt))
		.all();

	// People who can be filtered on: anyone actually assigned work on a board
	// this user can see. Listing every account would offer filters that return
	// an empty report, which reads as a fault rather than an empty set.
	const visibleBoardIds = accessibleIds === null
		? db.select({ id: boards.id }).from(boards).all().map(b => b.id)
		: accessibleIds;
	let assignableUsers: { id: number; username: string; emoji: string }[] = [];
	if (visibleBoardIds.length > 0) {
		const colIds = db.select({ id: columns.id }).from(columns)
			.where(inArray(columns.boardId, visibleBoardIds)).all().map(c => c.id);
		if (colIds.length > 0) {
			const cardIds = db.select({ id: cards.id }).from(cards)
				.where(and(inArray(cards.columnId, colIds), isNull(cards.archivedAt)))
				.all().map(c => c.id);
			if (cardIds.length > 0) {
				const ids = [...new Set(
					db.select({ userId: cardAssignees.userId }).from(cardAssignees)
						.where(inArray(cardAssignees.cardId, cardIds)).all().map(a => a.userId)
				)];
				if (ids.length > 0) {
					assignableUsers = db.select({ id: users.id, username: users.username, emoji: users.emoji })
						.from(users).where(inArray(users.id, ids)).all()
						.map(u => ({ id: u.id, username: u.username, emoji: u.emoji || '👤' }))
						.sort((a, b) => a.username.localeCompare(b.username));
				}
			}
		}
	}

	const isAdmin = user.role === 'admin' || user.role === 'superadmin';

	return {
		boards: userBoards.map(b => ({ id: b.id, name: b.name, emoji: b.emoji || '📋', categoryId: b.categoryId })),
		categories: allCategories,
		schedules: userSchedules,
		assignableUsers,
		isAdmin
	};
};
