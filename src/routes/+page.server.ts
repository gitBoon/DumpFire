import { db } from '$lib/server/db';
import { boards, columns, cards, cardAssignees, activityLog, taskRequests, teamMembers, boardCategories, type Board } from '$lib/server/db/schema';
import { desc, eq, inArray, isNull, isNotNull, and, gte, sql } from 'drizzle-orm';
import { getAccessibleBoardIds } from '$lib/server/board-access';
import type { PageServerLoad } from './$types';

export const load: PageServerLoad = async ({ locals }) => {
	const user = locals.user!;

	// Get board IDs this user can access (null = admin, sees all)
	const accessibleIds = getAccessibleBoardIds(user);

	let allBoards: Board[];
	if (accessibleIds === null) {
		allBoards = db.select().from(boards).where(isNull(boards.parentCardId)).orderBy(desc(boards.createdAt)).all();
	} else if (accessibleIds.length === 0) {
		allBoards = [];
	} else {
		allBoards = db.select().from(boards)
			.where(isNull(boards.parentCardId))
			.orderBy(desc(boards.createdAt))
			.all()
			.filter(b => accessibleIds.includes(b.id));
	}

	// Get all sub-boards in one query
	const allSubBoards = db.select().from(boards).where(isNotNull(boards.parentCardId)).all();

	// Map: cardId -> sub-board
	const subBoardsByCard = new Map<number, typeof allSubBoards>();
	for (const sb of allSubBoards) {
		if (!sb.parentCardId) continue;
		const list = subBoardsByCard.get(sb.parentCardId) || [];
		list.push(sb);
		subBoardsByCard.set(sb.parentCardId, list);
	}

	// Fetch all categories for board grouping
	const allCategories = db.select().from(boardCategories).all();

	// Enrich each board with card stats and sub-board info
	const enriched = allBoards.map(board => {
		const boardCols = db.select().from(columns).where(eq(columns.boardId, board.id)).all();
		const colIds = boardCols.map(c => c.id);
	if (colIds.length === 0) {
			const cat = board.categoryId ? allCategories.find(c => c.id === board.categoryId) : null;
			return { ...board, totalCards: 0, completedCards: 0, lastActivity: board.updatedAt, subBoards: [] as any[], categoryName: cat?.name || null, categoryColor: cat?.color || null };
		}

		const boardCards = db.select().from(cards).where(inArray(cards.columnId, colIds)).all();
		const completeCols = boardCols.filter(c => c.title.toLowerCase() === 'complete' || c.title.toLowerCase() === 'done');
		const completeColIds = new Set(completeCols.map(c => c.id));
		const completedCards = boardCards.filter(c => completeColIds.has(c.columnId)).length;

		let lastActivity = board.updatedAt;
		for (const c of boardCards) {
			if (c.updatedAt > lastActivity) lastActivity = c.updatedAt;
		}

		// Find sub-boards for cards on this board
		const subBoardsForBoard: { id: number; name: string; emoji: string; parentCardTitle: string; done: number; total: number }[] = [];
		for (const card of boardCards) {
			const subs = subBoardsByCard.get(card.id);
			if (!subs) continue;
			for (const sb of subs) {
				const sbCols = db.select().from(columns).where(eq(columns.boardId, sb.id)).all();
				const sbColIds = sbCols.map(c => c.id);
				let done = 0, total = 0;
				if (sbColIds.length > 0) {
					const sbCards = db.select().from(cards).where(inArray(cards.columnId, sbColIds)).all();
					total = sbCards.length;
					const sbCompleteCols = sbCols.filter(c => c.title.toLowerCase() === 'complete' || c.title.toLowerCase() === 'done');
					const sbCompleteColIds = new Set(sbCompleteCols.map(c => c.id));
					done = sbCards.filter(c => sbCompleteColIds.has(c.columnId)).length;
				}
				subBoardsForBoard.push({
					id: sb.id,
					name: sb.name,
					emoji: sb.emoji || '🗂️',
					parentCardTitle: card.title,
					done,
					total
				});
			}
		}

		// Look up board category
		let categoryName: string | null = null;
		let categoryColor: string | null = null;
		if (board.categoryId) {
			const cat = allCategories.find(c => c.id === board.categoryId);
			if (cat) {
				categoryName = cat.name;
				categoryColor = cat.color;
			}
		}

		return {
			...board,
			totalCards: boardCards.length,
			completedCards,
			lastActivity,
			subBoards: subBoardsForBoard,
			categoryName,
			categoryColor
		};
	});

	// ─── Personal Analytics ──────────────────────────────────────────────────

	// All cards assigned to this user
	const myAssignments = db.select({ cardId: cardAssignees.cardId })
		.from(cardAssignees)
		.where(eq(cardAssignees.userId, user.id))
		.all();
	const myCardIds = myAssignments.map(a => a.cardId);

	let myCards: typeof cards.$inferSelect[] = [];
	if (myCardIds.length > 0) {
		myCards = db.select().from(cards).where(inArray(cards.id, myCardIds)).all();
	}

	// Determine which of my cards are in "done" columns
	const allColumnIds = [...new Set(myCards.map(c => c.columnId))];
	let doneColumnIds = new Set<number>();
	if (allColumnIds.length > 0) {
		const cols = db.select({ id: columns.id, title: columns.title })
			.from(columns)
			.where(inArray(columns.id, allColumnIds))
			.all();
		doneColumnIds = new Set(
			cols.filter(c => c.title.toLowerCase() === 'complete' || c.title.toLowerCase() === 'done')
				.map(c => c.id)
		);
	}

	const myCompletedCards = myCards.filter(c => doneColumnIds.has(c.columnId));
	const myActiveCards = myCards.filter(c => !doneColumnIds.has(c.columnId));

	// Overdue cards (past due date, not completed)
	const now = new Date().toISOString().split('T')[0];
	const overdueCards = myActiveCards.filter(c => c.dueDate && c.dueDate < now);

	// Priority breakdown (active only)
	const priorityCounts = { critical: 0, high: 0, medium: 0, low: 0 };
	for (const c of myActiveCards) {
		const p = c.priority as keyof typeof priorityCounts;
		if (p in priorityCounts) priorityCounts[p]++;
	}

	// Completed this week
	const weekAgo = new Date();
	weekAgo.setDate(weekAgo.getDate() - 7);
	const weekAgoStr = weekAgo.toISOString();
	const completedThisWeek = myCompletedCards.filter(c => c.completedAt && c.completedAt >= weekAgoStr).length;

	// Completed this month
	const monthAgo = new Date();
	monthAgo.setDate(monthAgo.getDate() - 30);
	const monthAgoStr = monthAgo.toISOString();
	const completedThisMonth = myCompletedCards.filter(c => c.completedAt && c.completedAt >= monthAgoStr).length;

	// Recent activity (last 8 entries for this user)
	const recentActivity = db.select()
		.from(activityLog)
		.where(eq(activityLog.userId, user.id))
		.orderBy(desc(activityLog.createdAt))
		.limit(8)
		.all();

	// Pending inbox requests
	const userTeamRows = db.select({ teamId: teamMembers.teamId })
		.from(teamMembers)
		.where(eq(teamMembers.userId, user.id))
		.all();
	const userTeamIds = userTeamRows.map(r => r.teamId);

	let pendingRequests = 0;
	try {
		const allRequests = db.select().from(taskRequests).all();
		pendingRequests = allRequests.filter(r => {
			if (r.status !== 'pending') return false;
			if (user.role === 'admin' || user.role === 'superadmin') return true;
			if (r.targetType === 'user' && r.targetId === user.id) return true;
			if (r.targetType === 'team' && userTeamIds.includes(r.targetId)) return true;
			return false;
		}).length;
	} catch { /* table may not exist yet */ }

	const analytics = {
		totalAssigned: myCards.length,
		active: myActiveCards.length,
		completed: myCompletedCards.length,
		completionRate: myCards.length > 0 ? Math.round((myCompletedCards.length / myCards.length) * 100) : 0,
		overdue: overdueCards.length,
		completedThisWeek,
		completedThisMonth,
		priorityCounts,
		pendingRequests,
		recentActivity
	};

	return { boards: enriched, analytics, allCategories };
};
