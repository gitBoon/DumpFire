import { db } from '$lib/server/db';
import { boards, columns, cards, cardAssignees, activityLog, taskRequests, teamMembers, boardCategories, users, boardFavourites, type Board } from '$lib/server/db/schema';
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

		const boardCards = db.select().from(cards).where(and(inArray(cards.columnId, colIds), isNull(cards.archivedAt))).all();
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

	// Recent activity (last 10 entries for this user)
	const recentActivity = db.select()
		.from(activityLog)
		.where(eq(activityLog.userId, user.id))
		.orderBy(desc(activityLog.createdAt))
		.limit(10)
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

	// ─── Weekly Activity Sparkline (last 7 days) ────────────────────────────
	const weeklyActivity: { day: string; count: number }[] = [];
	for (let i = 6; i >= 0; i--) {
		const d = new Date();
		d.setDate(d.getDate() - i);
		const dayStr = d.toISOString().split('T')[0];
		const dayLabel = d.toLocaleDateString('en-GB', { weekday: 'short' });
		const count = myCompletedCards.filter(c => c.completedAt && c.completedAt.startsWith(dayStr)).length;
		weeklyActivity.push({ day: dayLabel, count });
	}

	// Total sub-boards count
	const totalSubBoards = allSubBoards.length;

	// Board health: top boards sorted by completion % for sidebar overview
	const boardHealth = enriched
		.filter(b => b.totalCards > 0)
		.map(b => ({
			id: b.id,
			name: b.name,
			emoji: b.emoji || '📋',
			totalCards: b.totalCards,
			completedCards: b.completedCards,
			pct: Math.round((b.completedCards / b.totalCards) * 100)
		}))
		.sort((a, b) => b.pct - a.pct)
		.slice(0, 8);

	// Due soon: cards due within next 3 days that aren't completed
	const threeDaysFromNow = new Date();
	threeDaysFromNow.setDate(threeDaysFromNow.getDate() + 3);
	const threeDaysStr = threeDaysFromNow.toISOString().split('T')[0];
	const dueSoon = myActiveCards
		.filter(c => c.dueDate && c.dueDate >= now && c.dueDate <= threeDaysStr)
		.length;

	// ─── Category Distribution ──────────────────────────────────────────────
	const categoryDistribution: { name: string; color: string; count: number }[] = [];
	const catCountMap = new Map<string, { color: string; count: number }>();
	for (const board of enriched) {
		const catKey = board.categoryName || 'Uncategorised';
		const existing = catCountMap.get(catKey);
		if (existing) {
			existing.count += board.totalCards;
		} else {
			catCountMap.set(catKey, { color: board.categoryColor || '#6366f1', count: board.totalCards });
		}
	}
	for (const [name, data] of catCountMap.entries()) {
		categoryDistribution.push({ name, color: data.color, count: data.count });
	}
	categoryDistribution.sort((a, b) => b.count - a.count);

	// ─── Aging Tasks (how long active cards have been open) ──────────────
	const agingBuckets = { fresh: 0, week: 0, fortnight: 0, month: 0, stale: 0 };
	const nowMs = Date.now();
	for (const c of myActiveCards) {
		const created = new Date(c.createdAt.endsWith('Z') ? c.createdAt : c.createdAt + 'Z').getTime();
		const days = Math.floor((nowMs - created) / 86400000);
		if (days <= 2) agingBuckets.fresh++;
		else if (days <= 7) agingBuckets.week++;
		else if (days <= 14) agingBuckets.fortnight++;
		else if (days <= 30) agingBuckets.month++;
		else agingBuckets.stale++;
	}

	// ─── Team Leaderboard (top assignees on YOUR boards) ────────────────
	// Only count cards on boards the user has access to
	const myBoardIds = allBoards.map(b => b.id);
	const accessibleColIds = myBoardIds.length > 0
		? db.select({ id: columns.id }).from(columns).where(inArray(columns.boardId, myBoardIds)).all().map(c => c.id)
		: [];
	const accessibleCardIds = accessibleColIds.length > 0
		? new Set(db.select({ id: cards.id }).from(cards).where(inArray(cards.columnId, accessibleColIds)).all().map(c => c.id))
		: new Set<number>();

	const scopedAssigneeRows = db.select({
		userId: cardAssignees.userId,
		cardId: cardAssignees.cardId
	}).from(cardAssignees).all().filter(r => accessibleCardIds.has(r.cardId));

	const leaderMap = new Map<number, { completed: number; active: number }>();
	for (const row of scopedAssigneeRows) {
		if (!leaderMap.has(row.userId)) leaderMap.set(row.userId, { completed: 0, active: 0 });
		const card = db.select({ columnId: cards.columnId }).from(cards).where(eq(cards.id, row.cardId)).get();
		if (card) {
			const col = db.select({ title: columns.title }).from(columns).where(eq(columns.id, card.columnId)).get();
			const isDone = col && (col.title.toLowerCase() === 'complete' || col.title.toLowerCase() === 'done');
			if (isDone) leaderMap.get(row.userId)!.completed++;
			else leaderMap.get(row.userId)!.active++;
		}
	}

	const allUsersList = db.select({ id: users.id, username: users.username, emoji: users.emoji }).from(users).all();
	const userLookup = new Map(allUsersList.map(u => [u.id, u]));

	const teamLeaderboard = Array.from(leaderMap.entries())
		.map(([userId, stats]) => {
			const u = userLookup.get(userId);
			return { username: u?.username || 'Unknown', emoji: u?.emoji || '👤', completed: stats.completed, active: stats.active };
		})
		.sort((a, b) => b.completed - a.completed)
		.slice(0, 5);

	// ─── Upcoming Deadlines ─────────────────────────────────────────────
	const upcomingDeadlines = myActiveCards
		.filter(c => c.dueDate && c.dueDate >= now)
		.sort((a, b) => a.dueDate!.localeCompare(b.dueDate!))
		.slice(0, 5)
		.map(c => ({
			title: c.title,
			dueDate: c.dueDate!,
			priority: c.priority
		}));

	// ─── 4-Week Trend (weekly completed counts) ─────────────────────────
	const weeklyTrend: { label: string; count: number }[] = [];
	for (let w = 3; w >= 0; w--) {
		const start = new Date();
		start.setDate(start.getDate() - (w + 1) * 7);
		const end = new Date();
		end.setDate(end.getDate() - w * 7);
		const label = w === 0 ? 'This Week' : w === 1 ? 'Last Week' : `${w + 1}w ago`;
		const count = myCompletedCards.filter(c => {
			if (!c.completedAt) return false;
			return c.completedAt >= start.toISOString() && c.completedAt < end.toISOString();
		}).length;
		weeklyTrend.push({ label, count });
	}

	// ─── On Hold count ──────────────────────────────────────────────────
	const onHoldColumnIds = new Set<number>();
	if (allColumnIds.length > 0) {
		const cols = db.select({ id: columns.id, title: columns.title })
			.from(columns)
			.where(inArray(columns.id, allColumnIds))
			.all();
		cols.filter(c => c.title.toLowerCase() === 'on hold' || c.title.toLowerCase() === 'blocked' || c.title.toLowerCase() === 'waiting')
			.forEach(c => onHoldColumnIds.add(c.id));
	}
	const onHoldCount = myCards.filter(c => onHoldColumnIds.has(c.columnId)).length;

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
		recentActivity,
		weeklyActivity,
		totalSubBoards,
		boardHealth,
		dueSoon,
		totalBoards: allBoards.length,
		categoryDistribution,
		agingBuckets,
		teamLeaderboard,
		upcomingDeadlines,
		weeklyTrend,
		onHoldCount
	};

	// Get user's favourited board IDs
	const userFavourites = db.select({ boardId: boardFavourites.boardId })
		.from(boardFavourites)
		.where(eq(boardFavourites.userId, user.id))
		.all();
	const favouriteBoardIds = userFavourites.map(f => f.boardId);

	return { boards: enriched, analytics, allCategories, favouriteBoardIds };
};
