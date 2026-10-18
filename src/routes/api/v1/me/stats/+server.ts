import { error } from '@sveltejs/kit';
import { json } from '$lib/server/v1-json';
import { db } from '$lib/server/db';
import { activityLog, cards, columns } from '$lib/server/db/schema';
import { eq, and, count, sql, gte, inArray } from 'drizzle-orm';
import { ACTIONS, storedActions } from '$lib/server/logActivity';
import { recentActivityFor } from '$lib/server/list-access';
import { stamp } from '$lib/timestamps';
import type { RequestHandler } from './$types';

/**
 * GET /api/v1/me/stats — Personal productivity metrics.
 *
 * Returns:
 * - cardsCompleted (total + last 7/30 days)
 * - avgCycleTime (days, based on created→completed)
 * - streak (consecutive days with at least one completion)
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

	// Average cycle time from completed cards assigned to user
	const cycleResult = db.all(sql`
		SELECT AVG(julianday(c.completed_at) - julianday(c.created_at)) as avg_days
		FROM cards c
		INNER JOIN card_assignees ca ON ca.card_id = c.id
		WHERE ca.user_id = ${userId}
			AND c.completed_at IS NOT NULL
	`) as { avg_days: number | null }[];
	// Null when no card has been completed; an average of 0, cards completed
	// the moment they were raised, is 0. It was answered as null.
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
	const recentActivity = recentActivityFor(locals.user, 20).map(({ id, action, detail, boardId, createdAt }) => ({
		id,
		action,
		detail,
		boardId,
		createdAt
	}));

	// Cards currently assigned
	const assignedCards = db.all(sql`
		SELECT COUNT(*) as cnt
		FROM card_assignees ca
		INNER JOIN cards c ON c.id = ca.card_id
		WHERE ca.user_id = ${userId}
			AND c.completed_at IS NULL
			AND c.archived_at IS NULL
	`) as { cnt: number }[];

	return json({
		cardsCompleted: {
			total: completedAll?.cnt || 0,
			last7Days: completed7d?.cnt || 0,
			last30Days: completed30d?.cnt || 0
		},
		avgCycleTimeDays: avgCycleTime,
		streak,
		activeCards: assignedCards[0]?.cnt || 0,
		recentActivity
	});
};
