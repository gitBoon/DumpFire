import { db } from '$lib/server/db';
import { boards, columns, cards, categories, subtasks, labels, cardLabels, cardAssignees, users } from '$lib/server/db/schema';
import { asc, inArray, eq } from 'drizzle-orm';
import { getAccessibleBoardIds } from '$lib/server/board-access';
import type { PageServerLoad } from './$types';

export const load: PageServerLoad = async ({ locals }) => {
	const user = locals.user!;

	// Get board IDs this user can access (null = admin, sees all)
	const accessibleIds = getAccessibleBoardIds(user);

	let allBoards: (typeof boards.$inferSelect)[];
	if (accessibleIds === null) {
		allBoards = db.select().from(boards).all();
	} else if (accessibleIds.length === 0) {
		allBoards = [];
	} else {
		allBoards = db.select().from(boards).all().filter(b => accessibleIds.includes(b.id));
	}

	const accessibleBoardIds = allBoards.map(b => b.id);
	const allColumns = accessibleBoardIds.length > 0
		? db.select().from(columns).where(inArray(columns.boardId, accessibleBoardIds)).orderBy(asc(columns.position)).all()
		: [];

	const columnIds = allColumns.map(c => c.id);
	const allCards = columnIds.length > 0
		? db.select().from(cards).where(inArray(cards.columnId, columnIds)).orderBy(asc(cards.position)).all()
		: [];

	const cardIds = allCards.map(c => c.id);
	const allSubtasks = cardIds.length > 0
		? db.select().from(subtasks).where(inArray(subtasks.cardId, cardIds)).orderBy(asc(subtasks.position)).all()
		: [];

	const allCardLabels = cardIds.length > 0
		? db.select().from(cardLabels).where(inArray(cardLabels.cardId, cardIds)).all()
		: [];

	// Fetch assignees for all cards
	const allAssignments = cardIds.length > 0
		? db.select().from(cardAssignees).where(inArray(cardAssignees.cardId, cardIds)).all()
		: [];
	const allUsers = db.select({ id: users.id, username: users.username, emoji: users.emoji }).from(users).all();
	const userMap = new Map(allUsers.map(u => [u.id, u]));

	const allCategories = accessibleBoardIds.length > 0
		? db.select().from(categories).where(inArray(categories.boardId, accessibleBoardIds)).orderBy(asc(categories.name)).all()
		: [];
	const allLabels = accessibleBoardIds.length > 0
		? db.select().from(labels).where(inArray(labels.boardId, accessibleBoardIds)).all()
		: [];

	// Build a map of column id -> column info (with board name)
	const columnMap = new Map<number, { title: string; boardId: number }>();
	for (const col of allColumns) {
		columnMap.set(col.id, { title: col.title, boardId: col.boardId });
	}

	const boardMap = new Map<number, { name: string; emoji: string }>();
	for (const b of allBoards) {
		boardMap.set(b.id, { name: b.name, emoji: b.emoji || '📋' });
	}

	// Normalize column titles into buckets
	function getBucket(colTitle: string): string {
		const t = colTitle.toLowerCase().trim();
		if (t === 'complete' || t === 'done') return 'Complete';
		if (t === 'in progress' || t === 'in-progress' || t === 'doing') return 'In Progress';
		if (t === 'on hold' || t === 'blocked' || t === 'waiting') return 'On Hold';
		if (t === 'to do' || t === 'todo') return 'To Do';
		// Title case for consistent merging of custom columns
		return t.replace(/\b\w/g, c => c.toUpperCase());
	}

	// Build enriched cards with board info
	const enrichedCards = allCards.map(card => {
		const colInfo = columnMap.get(card.columnId);
		const boardInfo = colInfo ? boardMap.get(colInfo.boardId) : null;
		const assignees = allAssignments
			.filter(a => a.cardId === card.id)
			.map(a => userMap.get(a.userId))
			.filter(Boolean) as { id: number; username: string; emoji: string | null }[];
		return {
			...card,
			subtasks: allSubtasks.filter(st => st.cardId === card.id),
			labelIds: allCardLabels.filter(cl => cl.cardId === card.id).map(cl => cl.labelId),
			assignees,
			boardName: boardInfo?.name || 'Unknown',
			boardEmoji: boardInfo?.emoji || '📋',
			boardId: colInfo?.boardId || 0,
			columnTitle: colInfo?.title || 'Unknown',
			bucket: colInfo ? getBucket(colInfo.title) : 'To Do'
		};
	});

	// Track which board has which bucket and calculate average positions
	const baseBuckets = ['To Do', 'On Hold', 'In Progress', 'Complete'];
	const bucketBoardMap = new Map<string, Set<string>>();
	const bucketPositions = new Map<string, number[]>();

	// Group columns by board
	const colsByBoard = new Map<number, (typeof columns.$inferSelect)[]>();
	for (const col of allColumns) {
		if (!colsByBoard.has(col.boardId)) colsByBoard.set(col.boardId, []);
		colsByBoard.get(col.boardId)!.push(col);
	}

	for (const [boardId, boardCols] of colsByBoard.entries()) {
		const boardInfo = boardMap.get(boardId);
		boardCols.sort((a, b) => a.position - b.position);
		
		boardCols.forEach((col, index) => {
			const bucketName = getBucket(col.title);
			
			if (!bucketBoardMap.has(bucketName)) bucketBoardMap.set(bucketName, new Set());
			if (boardInfo) bucketBoardMap.get(bucketName)!.add(`${boardInfo.emoji} ${boardInfo.name}`);
			
			if (!bucketPositions.has(bucketName)) bucketPositions.set(bucketName, []);
			// Normalize index inside the board (0.0 to 1.0)
			const pct = boardCols.length <= 1 ? 0.5 : index / (boardCols.length - 1);
			bucketPositions.get(bucketName)!.push(pct);
		});
	}

	const bucketAvg = new Map<string, number>();
	for (const [b, posArr] of bucketPositions.entries()) {
		bucketAvg.set(b, posArr.reduce((sum, val) => sum + val, 0) / posArr.length);
	}

	// Force strict anchors for base buckets requested by user
	bucketAvg.set('To Do', -1);
	bucketAvg.set('On Hold', 0.25);
	bucketAvg.set('In Progress', 0.5);
	bucketAvg.set('Complete', 2);

	const allBucketsSet = new Set([...baseBuckets, ...Array.from(bucketAvg.keys())]);
	const buckets = Array.from(allBucketsSet).sort((a, b) => {
		const weightA = bucketAvg.get(a) ?? 0.5;
		const weightB = bucketAvg.get(b) ?? 0.5;
		return weightA - weightB || a.localeCompare(b);
	});

	// Group into buckets
	const grouped = buckets.map(bucket => ({
		title: bucket,
		cards: enrichedCards.filter(c => c.bucket === bucket),
		contributingBoards: Array.from(bucketBoardMap.get(bucket) || [])
	}));

	return {
		boards: allBoards.map(b => ({ ...b, ...boardMap.get(b.id)! })),
		buckets: grouped,
		categories: allCategories,
		labels: allLabels,
		columns: allColumns,
		allUsers: allUsers.map(u => ({ id: u.id, username: u.username, emoji: u.emoji || '👤' })),
		totalCards: allCards.length,
		completedCards: enrichedCards.filter(c => c.bucket === 'Complete').length
	};
};
