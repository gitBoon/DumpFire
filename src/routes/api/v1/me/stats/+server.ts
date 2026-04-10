import { json, error } from '@sveltejs/kit';
import { db } from '$lib/server/db';
import { activityLog, cards, columns } from '$lib/server/db/schema';
import { eq, and, desc, count, sql, gte } from 'drizzle-orm';
import type { RequestHandler } from './$types';

/**
 * GET /api/v1/me/stats — Personal productivity metrics.
 *
 * Returns:
 * - cardsCompleted (total + last 7/30 days)
 * - avgCycleTime (days, based on created→completed)
 * - streak (consecutive days with at least one completion)
 * - recentActivity (last 20 actions)
 */
export const GET: RequestHandler = async ({ locals }) => {
	if (!locals.user) throw error(401, 'Not authenticated');

	const userId = locals.user.id;
	const now = new Date();
	const d7 = new Date(now.getTime() - 7 * 86400000).toISOString();
	const d30 = new Date(now.getTime() - 30 * 86400000).toISOString();

	// Cards completed (by action log matching this user)
	const completedAll = db.select({ cnt: count() })
		.from(activityLog)
		.where(and(
			eq(activityLog.userId, userId),
			eq(activityLog.action, 'card_completed')
		)).get();

	const completed7d = db.select({ cnt: count() })
		.from(activityLog)
		.where(and(
			eq(activityLog.userId, userId),
			eq(activityLog.action, 'card_completed'),
			gte(activityLog.createdAt, d7)
		)).get();

	const completed30d = db.select({ cnt: count() })
		.from(activityLog)
		.where(and(
			eq(activityLog.userId, userId),
			eq(activityLog.action, 'card_completed'),
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
	const avgCycleTime = cycleResult[0]?.avg_days
		? Math.round(cycleResult[0].avg_days * 10) / 10
		: null;

	// Activity streak — consecutive days with completions
	const completionDays = db.all(sql`
		SELECT DISTINCT date(created_at) as day
		FROM activity_log
		WHERE user_id = ${userId}
			AND action = 'card_completed'
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

	// Recent activity
	const recentActivity = db.select({
		id: activityLog.id,
		action: activityLog.action,
		detail: activityLog.detail,
		boardId: activityLog.boardId,
		createdAt: activityLog.createdAt
	})
	.from(activityLog)
	.where(eq(activityLog.userId, userId))
	.orderBy(desc(activityLog.createdAt))
	.limit(20)
	.all();

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
