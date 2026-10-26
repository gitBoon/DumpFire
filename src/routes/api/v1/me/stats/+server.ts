import { error } from '@sveltejs/kit';
import { json } from '$lib/server/v1-json';
import { db } from '$lib/server/db';
import { activityLog, cards, columns } from '$lib/server/db/schema';
import { eq, and, count, sql, gte, inArray } from 'drizzle-orm';
import { ACTIONS, storedActions } from '$lib/server/logActivity';
import { recentActivityFor } from '$lib/server/list-access';
import { getAccessibleBoardIds } from '$lib/server/board-access';
import { UPSTREAM } from '$lib/server/upstream';
import { stamp } from '$lib/timestamps';
import type { RequestHandler } from './$types';

/**
 * GET /api/v1/me/stats — Personal productivity metrics.
 *
 * Returns:
 * - cardsCompleted (total + last 7/30 days)
 * - avgCycleTimeDays and avgLeadTimeDays (one figure under two names: days
 *   from commitment to completion, on boards the caller can open)
 * - streak (consecutive days with at least one completion)
 * - activeCards (assigned, open and committed, on boards the caller can open)
 * - recentActivity (last 20 actions, on boards the caller can open)
 */
/**
 * A completion is stored as `card_completed` from the web UI and
 * `api:card_completed` from the API. Comparing to the bare name counted only
 * the UI ones, so someone who completes their cards through the API saw zero.
 */
const COMPLETED = storedActions(ACTIONS.cardCompleted);

export const GET: RequestHandler = async ({ locals }) => {
	if (!locals.user) throw error(401, 'Not authenticated');

	const userId = locals.user.id;
	const now = new Date();
	// In the stored form, as `activity_log.created_at` is (card 2095): an ISO
	// bound sorts after every stored value of its day, so each completion on
	// the cutoff day was left out (A1).
	const d7 = stamp(new Date(now.getTime() - 7 * 86400000));
	const d30 = stamp(new Date(now.getTime() - 30 * 86400000));

	// Cards completed (by action log matching this user)
	const completedAll = db.select({ cnt: count() })
		.from(activityLog)
		.where(and(
			eq(activityLog.userId, userId),
			inArray(activityLog.action, COMPLETED)
		)).get();

	const completed7d = db.select({ cnt: count() })
		.from(activityLog)
		.where(and(
			eq(activityLog.userId, userId),
			inArray(activityLog.action, COMPLETED),
			gte(activityLog.createdAt, d7)
		)).get();

	const completed30d = db.select({ cnt: count() })
		.from(activityLog)
		.where(and(
			eq(activityLog.userId, userId),
			inArray(activityLog.action, COMPLETED),
			gte(activityLog.createdAt, d30)
		)).get();

	// The two figures read from the caller's assignments, the cycle time and the
	// open count, count only cards on boards the caller can open now (card
	// 2292), as the dashboard and My Tasks have since card 2130. Both counted
	// every board, so someone taken off a board saw them move as work went on
	// there. `null` is an administrator, who opens every board. A caller who
	// opens none is answered 0 and null without the two queries: SQLite would
	// take the empty `IN ()` this builds, so the early return only saves the
	// queries and keeps the empty list out of them. Read once and handed to
	// the recent activity below, which read it again (card 2394).
	const boardIds = getAccessibleBoardIds(locals.user);
	const opensNone = boardIds !== null && boardIds.length === 0;
	const onBoardsTheyOpen = boardIds === null
		? sql``
		: sql`AND col.board_id IN (${sql.join(boardIds.map((id) => sql`${id}`), sql`, `)})`;

	// Average cycle time from completed cards assigned to user, from the
	// commitment to completion (milestone 22, card 2462): for a card made
	// before the milestone the commitment is its creation, as it was. Both
	// figures count committed work only: an option, in a board's Options
	// column or on an ideas board, is neither finished work nor open work.
	const cycleResult = opensNone ? [] : db.all(sql`
		SELECT AVG(julianday(c.completed_at) - julianday(COALESCE(c.committed_at, c.created_at))) as avg_days
		FROM cards c
		INNER JOIN card_assignees ca ON ca.card_id = c.id
		INNER JOIN columns col ON col.id = c.column_id
		INNER JOIN boards b ON b.id = col.board_id
		WHERE ca.user_id = ${userId}
			AND c.completed_at IS NOT NULL
			AND NOT ${sql.raw(UPSTREAM)}
			${onBoardsTheyOpen}
	`) as { avg_days: number | null }[];
	// Null when no card has been completed; an average of 0, cards completed
	// the moment they were raised, is 0. It was answered as null.
	//
	// From the commitment to completion this is a lead time, "commitment to
	// done", not a cycle time, which starts with the work. It is answered as
	// `avgLeadTimeDays` and, at the same value, as `avgCycleTimeDays`, the name
	// it has always had, kept for the callers that read it (milestone 22, the
	// S4a review).
	const avgDays = cycleResult[0]?.avg_days ?? null;
	const avgCycleTime = avgDays === null ? null : Math.round(avgDays * 10) / 10;

	// Activity streak — consecutive days with completions
	const completionDays = db.all(sql`
		SELECT DISTINCT date(created_at) as day
		FROM activity_log
		WHERE user_id = ${userId}
			AND action IN (${sql.join(COMPLETED.map((a) => sql`${a}`), sql`, `)})
		ORDER BY day DESC
		LIMIT 365
	`) as { day: string }[];

	let streak = 0;
	const today = now.toISOString().split('T')[0];
	let checkDate = today;
	for (const row of completionDays) {
		if (row.day === checkDate) {
			streak++;
			// Move to previous day
			const d = new Date(checkDate + 'T00:00:00Z');
			d.setUTCDate(d.getUTCDate() - 1);
			checkDate = d.toISOString().split('T')[0];
		} else if (streak === 0 && row.day === new Date(new Date(today + 'T00:00:00Z').getTime() - 86400000).toISOString().split('T')[0]) {
			// Allow streak starting from yesterday
			streak++;
			const d = new Date(row.day + 'T00:00:00Z');
			d.setUTCDate(d.getUTCDate() - 1);
			checkDate = d.toISOString().split('T')[0];
		} else {
			break;
		}
	}

	// Recent activity, on the boards the caller can open (card 2126): every
	// entry of theirs was listed, so a board they were taken off went on
	// showing here, card titles included.
	const recentActivity = recentActivityFor(locals.user, 20, boardIds).map(({ id, action, detail, boardId, createdAt }) => ({
		id,
		action,
		detail,
		boardId,
		createdAt
	}));

	// Cards currently assigned, on boards the caller can open (card 2292, above)
	const assignedCards = opensNone ? [] : db.all(sql`
		SELECT COUNT(*) as cnt
		FROM card_assignees ca
		INNER JOIN cards c ON c.id = ca.card_id
		INNER JOIN columns col ON col.id = c.column_id
		INNER JOIN boards b ON b.id = col.board_id
		WHERE ca.user_id = ${userId}
			AND c.completed_at IS NULL
			AND c.archived_at IS NULL
			AND NOT ${sql.raw(UPSTREAM)}
			${onBoardsTheyOpen}
	`) as { cnt: number }[];

	return json({
		cardsCompleted: {
			total: completedAll?.cnt || 0,
			last7Days: completed7d?.cnt || 0,
			last30Days: completed30d?.cnt || 0
		},
		avgCycleTimeDays: avgCycleTime,
		avgLeadTimeDays: avgCycleTime,
		streak,
		activeCards: assignedCards[0]?.cnt || 0,
		recentActivity
	});
};
