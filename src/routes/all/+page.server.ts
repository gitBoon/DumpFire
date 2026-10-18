import type { columns } from '$lib/server/db/schema';
import { getCardTokenTotals } from '$lib/server/tokens';
import { readCrossBoardCards } from '$lib/server/cross-board-cards';
import { columnRole } from '$lib/column-role';
import type { PageServerLoad } from './$types';

const DEFAULT_COMPLETED_LIMIT = 50;

export const load: PageServerLoad = async ({ locals, url }) => {
	const user = locals.user!;
	const completedLimit = Math.max(1, Math.min(500, Number(url.searchParams.get('completedLimit')) || DEFAULT_COMPLETED_LIMIT));

	// The boards the caller can open, their columns and every live card on
	// them, read as All To Do reads them (card 2240).
	const { boards: allBoards, columns: allColumns, cards: crossBoardCards, labels: allLabels, categories: allCategories,
		boardCategories: allBoardCategories, users: allUsers, blockedState, milestoneNames } = readCrossBoardCards(user);

	// Normalize column titles into buckets
	function getBucket(colTitle: string): string {
		const t = colTitle.toLowerCase().trim();
		const role = columnRole(colTitle);
		if (role === 'complete') return 'Complete';
		if (t === 'in progress' || t === 'in-progress' || t === 'doing') return 'In Progress';
		if (role === 'hold') return 'On Hold';
		if (role === 'todo') return 'To Do';
		// Title case for consistent merging of custom columns
		return t.replace(/\b\w/g, c => c.toUpperCase());
	}

	// Each card in the bucket of its column. Every card was read through one of
	// these columns, so each has one.
	const columnTitles = new Map(allColumns.map(c => [c.id, c.title]));
	const enrichedCards = crossBoardCards.map(card => ({ ...card, bucket: getBucket(columnTitles.get(card.columnId)!) }));

	// Track which board has which bucket and calculate average positions
	const baseBuckets = ['To Do', 'On Hold', 'In Progress', 'Complete'];
	const bucketPositions = new Map<string, number[]>();

	// Group columns by board
	const colsByBoard = new Map<number, (typeof columns.$inferSelect)[]>();
	for (const col of allColumns) {
		if (!colsByBoard.has(col.boardId)) colsByBoard.set(col.boardId, []);
		colsByBoard.get(col.boardId)!.push(col);
	}

	for (const boardCols of colsByBoard.values()) {
		boardCols.sort((a, b) => a.position - b.position);
		
		boardCols.forEach((col, index) => {
			const bucketName = getBucket(col.title);
			
			
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

	// Group into buckets — cap completed cards for performance
	const allCompletedCards = enrichedCards.filter(c => c.bucket === 'Complete');
	const totalCompletedCount = allCompletedCards.length;

	// Sort completed cards by completedAt (most recent first), fallback to
	// updatedAt, and the newer card first within one second. Every timestamp is
	// in the stored form (card 2095), so the text orders the moments; one in
	// the ISO form sorted after every stored value of its day, and the cap
	// below could cut a newer card (A7).
	allCompletedCards.sort((a, b) => {
		const aDate = a.completedAt || a.updatedAt || a.createdAt;
		const bDate = b.completedAt || b.updatedAt || b.createdAt;
		return bDate.localeCompare(aDate) || b.id - a.id;
	});

	const cappedCompleted = allCompletedCards.slice(0, completedLimit);
	const hasMoreCompleted = totalCompletedCount > completedLimit;

	const grouped = buckets.map(bucket => ({
		title: bucket,
		cards: bucket === 'Complete'
			? cappedCompleted
			: enrichedCards.filter(c => c.bucket === bucket)
	}));

	// Cost per card across every board in scope, in one query. Cards with nothing
	// recorded are omitted, so a card face shows no badge rather than a zero.
	const allTaskTotals = getCardTokenTotals(enrichedCards.map(c => c.id));
	const cardTokens: Record<number, { tokens: number; costUsd: number | null }> = {};
	let tokenSum = 0, costSum = 0, pricedAny = false, recordedAny = false;
	for (const [id, t] of allTaskTotals) {
		if (t.entries === 0) continue;
		recordedAny = true;
		cardTokens[id] = { tokens: t.total, costUsd: t.costUsd };
		tokenSum += t.total;
		if (t.costUsd !== null) { costSum += t.costUsd; pricedAny = true; }
	}
	// Null, not zero, when nothing anywhere has been recorded.
	const allTokenSummary = recordedAny
		? { total: tokenSum, costUsd: pricedAny ? costSum : null }
		: null;

	return {
		cardTokens,
		allTokenSummary,
		boards: allBoards,
		buckets: grouped,
		blockedState,
		milestoneNames,
		categories: allCategories,
		boardCategories: allBoardCategories,
		labels: allLabels,
		columns: allColumns,
		allUsers: allUsers.map(u => ({ id: u.id, username: u.username, emoji: u.emoji || '👤' })),
		totalCards: enrichedCards.length,
		completedCards: totalCompletedCount,
		hasMoreCompleted,
		totalCompletedCount,
		completedLimit
	};
};
