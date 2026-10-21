import { db } from '$lib/server/db';
import { boards, columns, cards, cardAssignees, taskRequests, teamMembers, users, boardFavourites, subtasks, type Board } from '$lib/server/db/schema';
import { count, desc, eq, inArray, isNull, and, or, sql } from 'drizzle-orm';
import { getAccessibleBoardIds } from '$lib/server/board-access';
import { boardCategoriesFor, recentActivityFor, subBoardsFor } from '$lib/server/list-access';
import { subBoardProgress } from '$lib/server/card-completion';
import { completionPercent } from '$lib/progress';
import { getBoardTokenTotals, getUserSpendByPeriod } from '$lib/server/tokens';
import { completeColumnIds, holdColumnIds, isCompleteColumnTitle } from '$lib/column-role';
import { parseStamp, stamp } from '$lib/timestamps';
import { daysFromDay, todayIn } from '$lib/utils/date-utils';
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

	// Every sub-board the caller can open, in one query. One they cannot open is
	// left out of everything below that reads this: the tiles, the sub-board
	// count, the All Tasks walk, its cost and the spend by person (card 2130). A
	// sub-board inherits nothing from its parent board, and a member of the
	// parent was shown the name, progress and cost of one they were never given.
	const allSubBoards = subBoardsFor(user);

	// Map: cardId -> sub-board
	const subBoardsByCard = new Map<number, typeof allSubBoards>();
	for (const sb of allSubBoards) {
		if (!sb.parentCardId) continue;
		const list = subBoardsByCard.get(sb.parentCardId) || [];
		list.push(sb);
		subBoardsByCard.set(sb.parentCardId, list);
	}
	// Each one's progress, in one query: non-archived cards only, the rule of
	// the parent board, the reports and the completion check (card 2205).
	const subBoardFigures = subBoardProgress(allSubBoards.map(sb => sb.id));

	// The groupings the caller is listed, to group boards and to file one under:
	// those holding a board they can open, and the empty ones (card 2128).
	const allCategories = boardCategoriesFor(user);

	// Every board this page reads: the top-level boards shown and the
	// sub-boards the caller can open. The tiles, the All Tasks walk and the
	// leaderboard read nothing outside them (card 2298).
	const shownBoardIds = [...allBoards.map(b => b.id), ...allSubBoards.map(sb => sb.id)];

	// What each board has cost. A board absent from this map has nothing
	// recorded, which surfaces as null and renders as "—" — deliberately not 0,
	// because every board predating the token ledger is in that state and we
	// cannot know what its work cost.
	// Sub-boards are boards too: the tiles and the walk below read those the
	// caller can open, and no other. Every board in the installation was
	// asked for (card 2298).
	const boardTokenTotals = getBoardTokenTotals(shownBoardIds);
	const tokensFor = (id: number) => boardTokenTotals.get(id)?.total ?? null;
	const costFor = (id: number) => boardTokenTotals.get(id)?.costUsd ?? null;

	// Those boards' columns, and their cards, archived ones too, each read once
	// for all of them (card 2298). They were two queries a top-level board and
	// two a level of sub-boards in the walk. A board's columns are in the order
	// of their ids and a column's cards in the order of theirs, as each board's
	// own reads gave them, so a board's sub-boards are listed as they were.
	const shownColumns = shownBoardIds.length > 0
		? db.select({ id: columns.id, boardId: columns.boardId, title: columns.title })
			.from(columns)
			.where(inArray(columns.boardId, shownBoardIds))
			.orderBy(columns.id)
			.all()
		: [];
	const columnsByBoard = new Map<number, typeof shownColumns>();
	for (const col of shownColumns) {
		const list = columnsByBoard.get(col.boardId) ?? [];
		list.push(col);
		columnsByBoard.set(col.boardId, list);
	}
	const shownCards = shownBoardIds.length > 0
		? db.select({ id: cards.id, columnId: cards.columnId, title: cards.title, archivedAt: cards.archivedAt, updatedAt: cards.updatedAt })
			.from(cards)
			.innerJoin(columns, eq(cards.columnId, columns.id))
			.where(inArray(columns.boardId, shownBoardIds))
			.orderBy(cards.columnId, cards.id)
			.all()
		: [];
	const cardsByColumn = new Map<number, typeof shownCards>();
	for (const card of shownCards) {
		const list = cardsByColumn.get(card.columnId) ?? [];
		list.push(card);
		cardsByColumn.set(card.columnId, list);
	}
	/** The cards of `cols`, column by column. */
	const cardsOf = (cols: { id: number }[]) => cols.flatMap(col => cardsByColumn.get(col.id) ?? []);

	// Enrich each board with card stats and sub-board info
	const enriched = allBoards.map(board => {
		const boardCols = columnsByBoard.get(board.id) ?? [];
		const colIds = boardCols.map(c => c.id);
		if (colIds.length === 0) {
			const cat = board.categoryId ? allCategories.find(c => c.id === board.categoryId) : null;
			return { ...board, totalCards: 0, completedCards: 0, tokenTotal: tokensFor(board.id), costUsd: costFor(board.id), lastActivity: board.updatedAt, subBoards: [] as any[], categoryName: cat?.name || null, categoryColor: cat?.color || null };
		}

		const boardCards = cardsOf(boardCols).filter(c => !c.archivedAt);
		const completeColIds = completeColumnIds(boardCols);
		const completedCards = boardCards.filter(c => completeColIds.has(c.columnId)).length;

		// The latest of the board's and its cards' edits. Every one is in the
		// stored form (card 2095), so the greater text is the later moment; one
		// value in the ISO form, which sorts after any stored value of its day,
		// made an earlier edit win (A6).
		let lastActivity = board.updatedAt;
		for (const c of boardCards) {
			if (c.updatedAt > lastActivity) lastActivity = c.updatedAt;
		}

		// Find sub-boards for cards on this board
		const subBoardsForBoard: { id: number; name: string; emoji: string; parentCardTitle: string; done: number; total: number; tokenTotal: number | null; costUsd: number | null }[] = [];
		for (const card of boardCards) {
			const subs = subBoardsByCard.get(card.id);
			if (!subs) continue;
			for (const sb of subs) {
				const { done, total } = subBoardFigures.get(sb.id)!;
				subBoardsForBoard.push({
					id: sb.id,
					name: sb.name,
					emoji: sb.emoji || '🗂️',
					parentCardTitle: card.title,
					done,
					total,
					tokenTotal: tokensFor(sb.id),
					costUsd: costFor(sb.id)
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
			tokenTotal: tokensFor(board.id),
			costUsd: costFor(board.id),
			lastActivity,
			subBoards: subBoardsForBoard,
			categoryName,
			categoryColor
		};
	});

	// ─── All Tasks totals ───────────────────────────────────────────────────
	// The All Tasks row quotes the figures of the All Boards report and the /all
	// page, both of which take in sub-boards. Start from the accessible
	// top-level boards and follow board → cards → sub-boards to any depth — the
	// same walk the report engine does. Cards: non-archived only. Tasks: cards
	// plus the subtasks hanging off them.
	//
	// The walk follows only the sub-boards the caller can open (card 2130), so
	// the three can differ. It cannot reach one shared with the caller under a
	// card of a board they cannot open, which /all counts, since /all lists
	// every board they can open. The report walks as this does, stopping at a
	// sub-board its reader cannot open (card 2150).
	//
	// Every board it reaches is one of `shownBoardIds`, so it walks the columns
	// and cards read above and reads nothing as it goes (card 2298).
	const isDoneTitle = isCompleteColumnTitle;
	const walkedBoardIds = new Set<number>(allBoards.map(b => b.id));
	const countedCardIds = new Set<number>();
	let allTasksCards = 0;
	let allTasksCompleted = 0;
	let frontier = allBoards.map(b => b.id);
	while (frontier.length > 0) {
		const frontierCols = frontier.flatMap(id => columnsByBoard.get(id) ?? []);
		if (frontierCols.length === 0) break;
		const frontierDoneCols = new Set(frontierCols.filter(c => isDoneTitle(c.title)).map(c => c.id));
		const frontierCards = cardsOf(frontierCols);
		const next: number[] = [];
		for (const c of frontierCards) {
			if (!c.archivedAt) {
				countedCardIds.add(c.id);
				allTasksCards++;
				if (frontierDoneCols.has(c.columnId)) allTasksCompleted++;
			}
			// Sub-boards hang off cards, archived or not — the report follows both
			for (const sb of subBoardsByCard.get(c.id) || []) {
				if (walkedBoardIds.has(sb.id)) continue;
				walkedBoardIds.add(sb.id);
				next.push(sb.id);
			}
		}
		frontier = next;
	}
	// The subtasks of the cards counted: those of the open cards on the boards
	// walked, counted where they are, where the whole table was read (card 2298).
	const allTasksSubtasks = countedCardIds.size === 0
		? 0
		: db.select({ count: count() })
			.from(subtasks)
			.innerJoin(cards, eq(subtasks.cardId, cards.id))
			.innerJoin(columns, eq(cards.columnId, columns.id))
			.where(and(inArray(columns.boardId, [...walkedBoardIds]), isNull(cards.archivedAt)))
			.get()!.count;
	// Token cost over exactly the boards this walk covered, so the All Tasks row
	// quotes the same scope as its card and task counts. Null — not zero — when
	// nothing has been recorded anywhere yet.
	const walkedTokenTotals = [...walkedBoardIds]
		.map(id => boardTokenTotals.get(id))
		.filter(t => t !== undefined);
	// Cost sums only the boards that could actually be priced; tokens whose model
	// is unknown are carried separately so the figure is never quietly short.
	const pricedBoards = walkedTokenTotals.filter(t => t.costUsd !== null);
	// Who the spend was reported under, over exactly the same boards as the
	// headline figure so the breakdown adds up to it rather than to some other set.
	const spendByUser = getUserSpendByPeriod([...walkedBoardIds]);

	const allTasksTotals = {
		cards: allTasksCards,
		completedCards: allTasksCompleted,
		subtasks: allTasksSubtasks,
		tasks: allTasksCards + allTasksSubtasks,
		tokenTotal: walkedTokenTotals.length > 0
			? walkedTokenTotals.reduce((sum, t) => sum + t.total, 0)
			: null,
		costUsd: pricedBoards.length > 0
			? pricedBoards.reduce((sum, t) => sum + (t.costUsd ?? 0), 0)
			: null,
		unpricedTokens: walkedTokenTotals.reduce((sum, t) => sum + t.unpricedTokens, 0)
	};

	// ─── Personal Analytics ──────────────────────────────────────────────────

	// All non-archived cards assigned to this user, on boards they can open
	// (card 2130), as My Tasks counts them. Being assigned a card does not
	// outlive access to its board: someone taken off a board went on seeing its
	// cards here, their titles in Upcoming Deadlines. Every figure below comes
	// from these: assigned, active, the due cards, the trends and on hold.
	const myAssignments = db.select({ cardId: cardAssignees.cardId })
		.from(cardAssignees)
		.where(eq(cardAssignees.userId, user.id))
		.all();
	const myCardIds = myAssignments.map(a => a.cardId);

	let myCards: typeof cards.$inferSelect[] = [];
	if (myCardIds.length > 0) {
		const opens = accessibleIds === null ? null : new Set(accessibleIds);
		myCards = db.select({ card: cards, boardId: columns.boardId })
			.from(cards)
			.innerJoin(columns, eq(cards.columnId, columns.id))
			.where(and(inArray(cards.id, myCardIds), isNull(cards.archivedAt)))
			.all()
			.filter(row => opens === null || opens.has(row.boardId))
			.map(row => row.card);
	}

	// The columns my cards are in, read once for which are done and which on
	// hold (On Hold count, below): the same query was made for each.
	const allColumnIds = [...new Set(myCards.map(c => c.columnId))];
	const myColumns = allColumnIds.length > 0
		? db.select({ id: columns.id, title: columns.title })
			.from(columns)
			.where(inArray(columns.id, allColumnIds))
			.all()
		: [];
	const doneColumnIds = completeColumnIds(myColumns);

	const myCompletedCards = myCards.filter(c => doneColumnIds.has(c.columnId));
	const myActiveCards = myCards.filter(c => !doneColumnIds.has(c.columnId));

	// The open cards with a due date, by due date then id (card 2258). The page
	// counts overdue, due soon and Upcoming Deadlines from them itself, in the
	// viewer's own day: this server runs in UTC and has no viewer's zone. Until
	// the page has loaded it counts them from the UTC day at `asOf`, the moment
	// this load ran, so the page drawn here and the page as it loads agree.
	//
	// Every zone's day is within one of UTC's (the furthest west is UTC-12), so
	// a card due on or before the UTC day minus 2 is overdue wherever the
	// viewer is: those are counted here, as `longOverdue`, and only the cards
	// from the UTC day minus 1 on are sent, where every open dated card was
	// sent on each live refresh (group B's review). A due date that is not a
	// day counted nowhere, and is sent in neither.
	const asOf = new Date();
	const utcToday = todayIn(asOf, 'UTC');
	let longOverdue = 0;
	const dueCards: { title: string; dueDate: string; priority: string }[] = [];
	for (const c of [...myActiveCards].sort((a, b) => (a.dueDate ?? '').localeCompare(b.dueDate ?? '') || a.id - b.id)) {
		const days = daysFromDay(c.dueDate, utcToday);
		if (days === null) continue;
		if (days <= -2) longOverdue++;
		else dueCards.push({ title: c.title, dueDate: c.dueDate!, priority: c.priority });
	}

	// Priority breakdown (active only)
	const priorityCounts = { critical: 0, high: 0, medium: 0, low: 0 };
	for (const c of myActiveCards) {
		const p = c.priority as keyof typeof priorityCounts;
		if (p in priorityCounts) priorityCounts[p]++;
	}

	// Completed this week. The bounds are in the stored form, as `completedAt`
	// is (card 2095): text compares moments only within one form.
	const weekAgo = new Date();
	weekAgo.setDate(weekAgo.getDate() - 7);
	const weekAgoStr = stamp(weekAgo);
	const completedThisWeek = myCompletedCards.filter(c => c.completedAt && c.completedAt >= weekAgoStr).length;

	// Completed this month
	const monthAgo = new Date();
	monthAgo.setDate(monthAgo.getDate() - 30);
	const monthAgoStr = stamp(monthAgo);
	const completedThisMonth = myCompletedCards.filter(c => c.completedAt && c.completedAt >= monthAgoStr).length;

	// Recent activity: the last 10 entries of this user's, on boards they can
	// open (card 2126). A board they were taken off went on showing here.
	const recentActivity = recentActivityFor(user, 10);

	// Pending inbox requests
	const userTeamRows = db.select({ teamId: teamMembers.teamId })
		.from(teamMembers)
		.where(eq(teamMembers.userId, user.id))
		.all();
	const userTeamIds = userTeamRows.map(r => r.teamId);

	// The pending ones the caller is to answer: every one for an administrator,
	// else those to them or to a team of theirs. Counted where they are: the
	// whole table was read and filtered here (card 2298).
	let pendingRequests = 0;
	try {
		const everyOne = user.role === 'admin' || user.role === 'superadmin';
		pendingRequests = db.select({ count: count() })
			.from(taskRequests)
			.where(and(
				eq(taskRequests.status, 'pending'),
				everyOne
					? undefined
					: or(
						and(eq(taskRequests.targetType, 'user'), eq(taskRequests.targetId, user.id)),
						userTeamIds.length > 0 ? and(eq(taskRequests.targetType, 'team'), inArray(taskRequests.targetId, userTeamIds)) : undefined
					)
			))
			.get()!.count;
	} catch { /* table may not exist yet */ }

	// ─── Weekly Activity Sparkline (last 7 days) ────────────────────────────
	const weeklyActivity: { day: string; count: number }[] = [];
	for (let i = 6; i >= 0; i--) {
		const d = new Date();
		d.setDate(d.getDate() - i);
		const dayStr = d.toISOString().split('T')[0];
		const dayLabel = d.toLocaleDateString('en-GB', { weekday: 'short' });
		const done = myCompletedCards.filter(c => c.completedAt && c.completedAt.startsWith(dayStr)).length;
		weeklyActivity.push({ day: dayLabel, count: done });
	}

	// The sub-boards the caller can open (card 2130): every one in the
	// installation was counted.
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
			pct: completionPercent(b.completedCards, b.totalCards)
		}))
		.sort((a, b) => b.pct - a.pct)
		.slice(0, 8);

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
		const created = parseStamp(c.createdAt)?.getTime() ?? NaN;
		const days = Math.floor((nowMs - created) / 86400000);
		if (days <= 2) agingBuckets.fresh++;
		else if (days <= 7) agingBuckets.week++;
		else if (days <= 14) agingBuckets.fortnight++;
		else if (days <= 30) agingBuckets.month++;
		else agingBuckets.stale++;
	}

	// ─── Team Leaderboard (top assignees on YOUR boards) ────────────────
	// Only count cards on boards the user has access to: the top-level boards
	// shown, and their cards that are not archived, as every other figure on
	// this page counts them (card 2391): an archived card scored here, as done
	// or active, and someone whose every card was archived stayed on the board.
	// Each assignee row comes with its card's column's title, in one query
	// (card 2298): the whole table was read and filtered here, and each row's
	// card and column read after, two queries a row. In the order the rows
	// were made, as the table was read, since that order breaks a tie on the
	// board.
	const myBoardIds = allBoards.map(b => b.id);
	const scopedAssigneeRows = myBoardIds.length > 0
		? db.select({ userId: cardAssignees.userId, columnTitle: columns.title })
			.from(cardAssignees)
			.innerJoin(cards, eq(cardAssignees.cardId, cards.id))
			.innerJoin(columns, eq(cards.columnId, columns.id))
			.where(and(inArray(columns.boardId, myBoardIds), isNull(cards.archivedAt)))
			.orderBy(sql`${cardAssignees}.rowid`)
			.all()
		: [];

	const leaderMap = new Map<number, { completed: number; active: number }>();
	for (const row of scopedAssigneeRows) {
		if (!leaderMap.has(row.userId)) leaderMap.set(row.userId, { completed: 0, active: 0 });
		if (isCompleteColumnTitle(row.columnTitle)) leaderMap.get(row.userId)!.completed++;
		else leaderMap.get(row.userId)!.active++;
	}

	// The names of the people on the board alone: every user was read.
	const leaderIds = [...leaderMap.keys()];
	const allUsersList = leaderIds.length > 0
		? db.select({ id: users.id, username: users.username, emoji: users.emoji }).from(users).where(inArray(users.id, leaderIds)).all()
		: [];
	const userLookup = new Map(allUsersList.map(u => [u.id, u]));

	const teamLeaderboard = Array.from(leaderMap.entries())
		.map(([userId, stats]) => {
			const u = userLookup.get(userId);
			return { username: u?.username || 'Unknown', emoji: u?.emoji || '👤', completed: stats.completed, active: stats.active };
		})
		.sort((a, b) => b.completed - a.completed)
		.slice(0, 5);

	// ─── 4-Week Trend (weekly completed counts) ─────────────────────────
	const weeklyTrend: { label: string; count: number }[] = [];
	for (let w = 3; w >= 0; w--) {
		const start = new Date();
		start.setDate(start.getDate() - (w + 1) * 7);
		const end = new Date();
		end.setDate(end.getDate() - w * 7);
		const label = w === 0 ? 'This Week' : w === 1 ? 'Last Week' : `${w + 1}w ago`;
		const done = myCompletedCards.filter(c => {
			if (!c.completedAt) return false;
			return c.completedAt >= stamp(start) && c.completedAt < stamp(end);
		}).length;
		weeklyTrend.push({ label, count: done });
	}

	// ─── On Hold count ──────────────────────────────────────────────────
	// From the columns read for the done ones, above.
	const onHoldColumnIds = holdColumnIds(myColumns);
	const onHoldCount = myCards.filter(c => onHoldColumnIds.has(c.columnId)).length;

	const analytics = {
		totalAssigned: myCards.length,
		active: myActiveCards.length,
		completed: myCompletedCards.length,
		completionRate: completionPercent(myCompletedCards.length, myCards.length),
		completedThisWeek,
		completedThisMonth,
		priorityCounts,
		pendingRequests,
		recentActivity,
		weeklyActivity,
		totalSubBoards,
		boardHealth,
		totalBoards: allBoards.length,
		categoryDistribution,
		agingBuckets,
		teamLeaderboard,
		dueCards,
		longOverdue,
		asOf: asOf.toISOString(),
		weeklyTrend,
		onHoldCount
	};

	// Get user's favourited board IDs
	const userFavourites = db.select({ boardId: boardFavourites.boardId })
		.from(boardFavourites)
		.where(eq(boardFavourites.userId, user.id))
		.all();
	const favouriteBoardIds = userFavourites.map(f => f.boardId);

	return { boards: enriched, analytics, allCategories, favouriteBoardIds, allTasksTotals, spendByUser };
};
