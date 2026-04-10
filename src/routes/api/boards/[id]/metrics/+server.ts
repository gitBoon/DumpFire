import { json, error } from '@sveltejs/kit';
import { db } from '$lib/server/db';
import { boards, columns, cards, activityLog } from '$lib/server/db/schema';
import { eq, and, isNotNull, inArray, gte, sql } from 'drizzle-orm';
import { getBoardRole } from '$lib/server/board-access';
import type { RequestHandler } from './$types';

/**
 * GET /api/boards/:id/metrics — Board performance metrics.
 *
 * Returns lead time, cycle time, and throughput data for completed cards.
 * Query params: ?days=N (default: 30)
 */
export const GET: RequestHandler = async ({ params, locals, url }) => {
	const boardId = Number(params.id);
	const user = locals.user!;

	const board = db.select().from(boards).where(eq(boards.id, boardId)).get();
	if (!board) throw error(404, 'Board not found');

	const role = getBoardRole(user, boardId);
	if (!role) throw error(403, 'No access to this board');

	const days = Math.min(Math.max(Number(url.searchParams.get('days')) || 30, 1), 365);
	const cutoff = new Date(Date.now() - days * 86400000).toISOString();

	// Get columns for this board
	const boardCols = db.select().from(columns)
		.where(eq(columns.boardId, boardId))
		.all();
	const colIds = boardCols.map(c => c.id);
	if (colIds.length === 0) return json({ leadTime: null, cycleTime: null, completed: 0, cards: [] });

	// Find complete columns
	const completeCols = boardCols.filter(c =>
		c.title.toLowerCase() === 'complete' || c.title.toLowerCase() === 'done'
	);
	const completeColIds = completeCols.map(c => c.id);

	if (completeColIds.length === 0) return json({ leadTime: null, cycleTime: null, completed: 0, cards: [] });

	// Get completed cards within the time window
	const completedCards = db.select().from(cards)
		.where(and(
			inArray(cards.columnId, completeColIds),
			isNotNull(cards.completedAt),
			gte(cards.completedAt, cutoff)
		))
		.all();

	if (completedCards.length === 0) return json({ leadTime: null, cycleTime: null, completed: 0, cards: [] });

	const cardIds = completedCards.map(c => c.id);

	// Get first "card_moved" activity for each card (for cycle time)
	// Query gets the earliest card_moved event per card
	const firstMoves = db.select({
		cardId: activityLog.cardId,
		firstMovedAt: sql<string>`MIN(${activityLog.createdAt})`
	})
	.from(activityLog)
	.where(and(
		inArray(activityLog.cardId, cardIds),
		eq(activityLog.action, 'card_moved')
	))
	.groupBy(activityLog.cardId)
	.all();

	const firstMoveMap = new Map(firstMoves.map(m => [m.cardId, m.firstMovedAt]));

	// Calculate metrics per card
	const cardMetrics = completedCards.map(card => {
		const createdMs = new Date(card.createdAt).getTime();
		const completedMs = new Date(card.completedAt!).getTime();
		const leadTimeMs = completedMs - createdMs;
		const leadTimeHours = Math.round(leadTimeMs / 3600000);

		const firstMoved = card.id ? firstMoveMap.get(card.id) : null;
		let cycleTimeHours: number | null = null;
		if (firstMoved) {
			const firstMovedMs = new Date(firstMoved).getTime();
			cycleTimeHours = Math.round((completedMs - firstMovedMs) / 3600000);
		}

		return {
			id: card.id,
			title: card.title,
			leadTimeHours,
			cycleTimeHours,
			createdAt: card.createdAt,
			completedAt: card.completedAt
		};
	});

	// Calculate aggregates
	const leadTimes = cardMetrics.map(c => c.leadTimeHours);
	const cycleTimes = cardMetrics.filter(c => c.cycleTimeHours !== null).map(c => c.cycleTimeHours!);

	function median(arr: number[]): number {
		if (arr.length === 0) return 0;
		const sorted = [...arr].sort((a, b) => a - b);
		const mid = Math.floor(sorted.length / 2);
		return sorted.length % 2 ? sorted[mid] : (sorted[mid - 1] + sorted[mid]) / 2;
	}

	function avg(arr: number[]): number {
		if (arr.length === 0) return 0;
		return Math.round(arr.reduce((a, b) => a + b, 0) / arr.length);
	}

	/** Format hours into a human-readable string. */
	function formatHours(hours: number): string {
		if (hours < 24) return `${hours}h`;
		const d = Math.floor(hours / 24);
		const h = hours % 24;
		return h > 0 ? `${d}d ${h}h` : `${d}d`;
	}

	return json({
		days,
		completed: completedCards.length,
		leadTime: {
			avgHours: avg(leadTimes),
			medianHours: median(leadTimes),
			avgFormatted: formatHours(avg(leadTimes)),
			medianFormatted: formatHours(median(leadTimes))
		},
		cycleTime: cycleTimes.length > 0 ? {
			avgHours: avg(cycleTimes),
			medianHours: median(cycleTimes),
			avgFormatted: formatHours(avg(cycleTimes)),
			medianFormatted: formatHours(median(cycleTimes))
		} : null,
		cards: cardMetrics
	});
};
