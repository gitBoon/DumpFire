import { db } from '$lib/server/db';
import { boards, boardCategories, reportSchedules } from '$lib/server/db/schema';
import { eq, desc, isNull } from 'drizzle-orm';
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

	const isAdmin = user.role === 'admin' || user.role === 'superadmin';

	return {
		boards: userBoards.map(b => ({ id: b.id, name: b.name, emoji: b.emoji || '📋', categoryId: b.categoryId })),
		categories: allCategories,
		schedules: userSchedules,
		isAdmin
	};
};
