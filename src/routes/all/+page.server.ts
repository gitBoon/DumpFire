import type { columns } from '$lib/server/db/schema';
import { getCardTokenTotals } from '$lib/server/tokens';
import { readCrossBoardCards } from '$lib/server/cross-board-cards';
import { columnRole } from '$lib/column-role';
import type { PageServerLoad } from './$types';

const DEFAULT_COMPLETED_LIMIT = 50;
/** The most completed cards the page is given, however many it asks for. */
const MAX_COMPLETED_LIMIT = 500;

export const load: PageServerLoad = async ({ locals, url }) => {
	const user = locals.user!;
	const completedLimit = Math.max(1, Math.min(MAX_COMPLETED_LIMIT, Number(url.searchParams.get('completedLimit')) || DEFAULT_COMPLETED_LIMIT));

	// The boards the caller can open, their columns and every live card on
	// them, read as All To Do reads them (card 2240).
	const { boards: allBoards, columns: allColumns, upstreamColumnIds, cards: crossBoardCards, labels: allLabels, categories: allCategories,
		boardCategories: allBoardCategories, users: allUsers, blockedState, milestoneNames } = readCrossBoardCards(user);

	/**
	 * The key of the bucket of every upstream column, an Options column or any
	 * column of an ideas board (milestone 22), keyed by the column's role and
	 * the board's kind, never by a title (the S4a review's H11): no title-cased
	 * column title starts with a small letter, so an ordinary column called
	 * Options keeps its own bucket. Its title is `OPTIONS_TITLE`.
	 */
	const OPTIONS = 'options:upstream';
	const OPTIONS_TITLE = 'Options';

	// Normalize column titles into buckets. An upstream column's cards are
	// options, whatever the column is called: they go in the Options bucket,
	// placed first, and are not in the header's figures.
	function getBucket(colTitle: string, columnId: number): string {
		if (upstreamColumnIds.has(columnId)) return OPTIONS;
		const t = colTitle.toLowerCase().trim();
		const role = columnRole(colTitle);
		if (role === 'complete') return 'Complete';
		if (t === 'in progress' || t === 'in-progress' || t === 'doing') return 'In Progress';
		if (role === 'hold') return 'On Hold';
		if (role === 'todo') return 'To Do';
		// Title case for consistent merging of custom columns
		return t.replace(/\b\w/g, c => c.toUpperCase());
	}

	// Each card in the bucket of its column, by the bucket's key; each card
	// carries the bucket's title. Every card was read through one of these
	// columns, so each has one.
	const columnTitles = new Map(allColumns.map(c => [c.id, c.title]));
	const bucketOf = new Map(crossBoardCards.map(card => [card.id, getBucket(columnTitles.get(card.columnId)!, card.columnId)]));
	const enrichedCards = crossBoardCards.map(card => {
		const key = bucketOf.get(card.id)!;
		return { ...card, bucket: key === OPTIONS ? OPTIONS_TITLE : key };
	});

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
		// In the board's order, ties by id (card 2372's column order).
		boardCols.sort((a, b) => a.position - b.position || a.id - b.id);
		
		boardCols.forEach((col, index) => {
			const bucketName = getBucket(col.title, col.id);
			
			
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
	// Options before everything, where there are any: no board without an
	// upstream column gains the bucket.
	if (upstreamColumnIds.size > 0) bucketAvg.set(OPTIONS, -2);

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
	// More to load only below the cap (card 2366): at it, Load more asked for
	// 550, was given 500, and stayed. The page says the list stops there
	// instead, from `totalCompletedCount` over `completedLimit`.
	const hasMoreCompleted = totalCompletedCount > completedLimit && completedLimit < MAX_COMPLETED_LIMIT;

	// The Options bucket says it is the upstream one, so that a page can tell
	// it from an ordinary column called Options, whose bucket has its title.
	const grouped = buckets.map(bucket => bucket === OPTIONS
		? { title: OPTIONS_TITLE, upstream: true as const, cards: enrichedCards.filter(c => bucketOf.get(c.id) === OPTIONS) }
		: {
			title: bucket,
			cards: bucket === 'Complete'
				? cappedCompleted
				: enrichedCards.filter(c => bucketOf.get(c.id) === bucket)
		});

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
		// Committed work only (milestone 22): the header's total, complete and
		// remaining leave the Options bucket out.
		totalCards: enrichedCards.filter(c => !upstreamColumnIds.has(c.columnId)).length,
		completedCards: totalCompletedCount,
		hasMoreCompleted,
		totalCompletedCount,
		completedLimit
	};
};
