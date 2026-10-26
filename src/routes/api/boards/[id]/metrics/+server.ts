import { json, error } from '@sveltejs/kit';
import { db } from '$lib/server/db';
import { boards, columns, cards } from '$lib/server/db/schema';
import { eq, and, isNotNull, inArray, gte } from 'drizzle-orm';
import { getBoardRole } from '$lib/server/board-access';
import { completeColumnIds } from '$lib/column-role';
import { committedAll, cycleStarts, flowTimes, timeInOptions, upstreamFigures } from '$lib/server/upstream';
import { pathId } from '$lib/server/request-body';
import { requireUser } from '$lib/server/route-guards';
import { parseStamp, stamp } from '$lib/timestamps';
import type { RequestHandler } from './$types';

/** A stored moment as milliseconds, read as UTC (card 2095); NaN for one that cannot be read. */
const ms = (value: string) => parseStamp(value)?.getTime() ?? NaN;

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

/** The average and median of some times in hours, each also as text; null for none. */
function timesOf(hours: number[]) {
	if (hours.length === 0) return null;
	return {
		avgHours: avg(hours),
		medianHours: median(hours),
		avgFormatted: formatHours(avg(hours)),
		medianFormatted: formatHours(median(hours))
	};
}

/**
 * GET /api/boards/:id/metrics — Board performance metrics.
 *
 * Returns lead time, cycle time, and throughput data for completed cards.
 * Query params: ?days=N (default: 30)
 *
 * Milestone 22 (card 2462): options are no delivery work. Only completed
 * cards are measured, and a Complete column is never upstream, so no option
 * is among them. **Lead time** runs from the commitment, `committedAt`, to
 * completion: "Lead time (commitment to done)", Complete being the delivery
 * point. For a card made before the milestone the commitment is its
 * creation, so its lead time is as it was. **Cycle time**, "time from start
 * of work to done", runs from the start `cycleStarts` finds at or after the
 * commitment (ruling a), and is never longer than the lead time. Beside
 * them, for the same window: `committed`, "Committed (all)", the cards that
 * arrived as committed work (ruling d), beside `completed`, the throughput;
 * `timeInOptions`, how long the cards committed from options waited there
 * (ruling e); and `upstream`, the board's upstream figures (`upstreamFigures`:
 * options now and their aging, committed from options, returned, discarded,
 * sent on, abandoned, the discard rate). The window runs from `days` ago to
 * now, both included. An ideas board, with no Complete column, has no lead
 * or cycle time and still has its upstream figures.
 */
export const GET: RequestHandler = async ({ params, locals, url }) => {
	// A caller who is not signed in is 401, where `locals.user!` threw and
	// only the gate stood in front of it (card 2117).
	const user = requireUser(locals.user);
	const boardId = pathId(params.id, 'board');

	const board = db.select().from(boards).where(eq(boards.id, boardId)).get();
	if (!board) throw error(404, 'Board not found');

	const role = getBoardRole(user, boardId);
	if (!role) throw error(403, 'No access to this board');

	const days = Math.min(Math.max(Number(url.searchParams.get('days')) || 30, 1), 365);
	// In the stored form, as `completed_at` is (card 2095), so the two compare
	// as text.
	const cutoff = stamp(new Date(Date.now() - days * 86400000));
	const now = stamp(new Date());

	// What arrived and what happened upstream in the same window, whatever
	// was completed in it (milestone 22, rulings d, e and g).
	const waits = timeInOptions([boardId], cutoff, now).map(t => Math.round((ms(t.committedAt) - ms(t.optionSince)) / 3600000));
	const flow = {
		committed: committedAll([boardId], cutoff, now),
		timeInOptions: timesOf(waits),
		upstream: upstreamFigures([boardId], cutoff, now)
	};
	const nothingCompleted = { leadTime: null, cycleTime: null, completed: 0, cards: [], days, ...flow };

	// Get columns for this board
	const boardCols = db.select().from(columns)
		.where(eq(columns.boardId, boardId))
		.all();
	const colIds = boardCols.map(c => c.id);
	if (colIds.length === 0) return json(nothingCompleted);

	// Find complete columns
	const completeColIds = [...completeColumnIds(boardCols)];

	if (completeColIds.length === 0) return json(nothingCompleted);

	// Get completed cards within the time window
	const completedCards = db.select().from(cards)
		.where(and(
			inArray(cards.columnId, completeColIds),
			isNotNull(cards.completedAt),
			gte(cards.completedAt, cutoff)
		))
		.all();

	if (completedCards.length === 0) return json(nothingCompleted);

	// When work started on each, at or after its commitment (ruling a). Every
	// entry in either spelling: a move made through the API is stored as
	// `api:card_moved`, and matching only the bare name meant cycle time
	// ignored every card moved by the API.
	const starts = cycleStarts(completedCards);

	// Calculate metrics per card. Every stored moment is UTC and is read as
	// such with parseStamp (card 2095): `new Date()` read the stored form in
	// the server's own zone, and lead and cycle time were out by its offset
	// from UTC (A11).
	const cardMetrics = completedCards.map(card => {
		// From the commitment; the cycle time never longer than the lead time.
		const { leadTimeHours, cycleTimeHours } = flowTimes({ ...card, completedAt: card.completedAt! }, starts.get(card.id));

		return {
			id: card.id,
			title: card.title,
			leadTimeHours,
			cycleTimeHours,
			createdAt: card.createdAt,
			committedAt: card.committedAt,
			completedAt: card.completedAt
		};
	});

	// Calculate aggregates
	const leadTimes = cardMetrics.map(c => c.leadTimeHours);
	const cycleTimes = cardMetrics.filter(c => c.cycleTimeHours !== null).map(c => c.cycleTimeHours!);

	return json({
		days,
		completed: completedCards.length,
		leadTime: timesOf(leadTimes),
		cycleTime: timesOf(cycleTimes),
		cards: cardMetrics,
		...flow
	});
};
