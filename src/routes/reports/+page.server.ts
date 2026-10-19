import { db } from '$lib/server/db';
import { boards, reportSchedules, users, cardAssignees, cards, columns } from '$lib/server/db/schema';
import { eq, desc, isNull, inArray, and } from 'drizzle-orm';
import { getAccessibleBoardIds } from '$lib/server/board-access';
import { boardCategoriesFor } from '$lib/server/list-access';
import type { PageServerLoad } from './$types';

export const load: PageServerLoad = async ({ locals }) => {
	const user = locals.user!;

	// The boards a report can be chosen of: the top-level boards the caller
	// can open, and each board they can open whose parent board they cannot
	// (card 2150). A board report takes in only the sub-boards its reader can
	// open, and does not walk through one they cannot, so a board shared with
	// them under one they were not given would be in no report they could
	// choose. An administrator opens every parent: top-level boards only.
	const accessibleIds = getAccessibleBoardIds(user);
	let userBoards: (typeof boards.$inferSelect)[];
	if (accessibleIds === null) {
		userBoards = db.select().from(boards).where(isNull(boards.parentCardId)).all();
	} else if (accessibleIds.length === 0) {
		userBoards = [];
	} else {
		const open = new Set(accessibleIds);
		const openBoards = db.select().from(boards).where(inArray(boards.id, accessibleIds)).all();
		const parentCardIds = openBoards.map(b => b.parentCardId).filter((id): id is number => id !== null);
		const parentBoardOf = new Map(
			parentCardIds.length === 0
				? []
				: db.select({ cardId: cards.id, boardId: columns.boardId })
					.from(cards)
					.innerJoin(columns, eq(columns.id, cards.columnId))
					.where(inArray(cards.id, parentCardIds))
					.all()
					.map(row => [row.cardId, row.boardId] as const)
		);
		userBoards = openBoards.filter(b => {
			if (b.parentCardId === null) return true;
			const parentBoardId = parentBoardOf.get(b.parentCardId);
			return parentBoardId === undefined || !open.has(parentBoardId);
		});
	}

	// The groupings the caller is listed: those holding a board they can open,
	// and the empty ones (card 2128). A report of any other is refused.
	const allCategories = boardCategoriesFor(user);

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
