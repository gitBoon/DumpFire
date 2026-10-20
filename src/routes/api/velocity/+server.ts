import { json, error } from '@sveltejs/kit';
import { db } from '$lib/server/db';
import { columns, cards, cardAssignees } from '$lib/server/db/schema';
import { eq, inArray, isNull, and } from 'drizzle-orm';
import { completeColumnIds } from '$lib/column-role';
import { getAccessibleBoardIds } from '$lib/server/board-access';
import { stamp } from '$lib/timestamps';
import type { RequestHandler } from './$types';

/**
 * GET /api/velocity?days=N — Personal velocity data for the current user.
 *
 * Returns completion counts bucketed per day (ranges ≤ 31 days) or per
 * 7-day week (longer ranges), plus summary stats and a comparison with
 * the preceding period of equal length. "Completed" matches the dashboard
 * definition: assigned to the user, on a board they can open, not
 * archived, sitting in a Complete/Done column, with a completedAt timestamp.
 */

const ALLOWED_RANGES = new Set([14, 28, 91, 182, 365]);

export const GET: RequestHandler = async ({ url, locals }) => {
	const user = locals.user;
	if (!user) throw error(401, 'Not authenticated');

	const days = Number(url.searchParams.get('days')) || 28;
	if (!ALLOWED_RANGES.has(days)) {
		throw error(400, `Invalid range. Allowed: ${[...ALLOWED_RANGES].join(', ')}`);
	}

	// Cards assigned to this user, not archived
	const assignments = db.select({ cardId: cardAssignees.cardId })
		.from(cardAssignees)
		.where(eq(cardAssignees.userId, user.id))
		.all();
	const cardIds = assignments.map(a => a.cardId);

	// Only cards on boards the caller can open now (card 2292), as the
	// dashboard's tiles beside this window count them since card 2130: someone
	// taken off a board went on seeing its completions here. Filtered here, as
	// the dashboard load filters, rather than in the query: the rows are read
	// anyway, and a caller who opens no board simply keeps none. `null` is an
	// administrator, who opens every board.
	let myCards: typeof cards.$inferSelect[] = [];
	if (cardIds.length > 0) {
		const accessible = getAccessibleBoardIds(user);
		const opens = accessible === null ? null : new Set(accessible);
		myCards = db.select({ card: cards, boardId: columns.boardId })
			.from(cards)
			.innerJoin(columns, eq(cards.columnId, columns.id))
			.where(and(inArray(cards.id, cardIds), isNull(cards.archivedAt)))
			.all()
			.filter(row => opens === null || opens.has(row.boardId))
			.map(row => row.card);
	}

	// Identify done columns among the cards' columns
	const colIds = [...new Set(myCards.map(c => c.columnId))];
	let doneColIds = new Set<number>();
	if (colIds.length > 0) {
		const cols = db.select({ id: columns.id, title: columns.title })
			.from(columns)
			.where(inArray(columns.id, colIds))
			.all();
		doneColIds = completeColumnIds(cols);
	}

	const completed = myCards.filter(c => doneColIds.has(c.columnId) && c.completedAt);

	// Period boundaries (UTC day boundaries, matching the dashboard's date
	// maths), in the stored form, as `completedAt` is (card 2095), so the two
	// compare as text.
	const startOfTomorrow = new Date();
	startOfTomorrow.setUTCHours(0, 0, 0, 0);
	startOfTomorrow.setUTCDate(startOfTomorrow.getUTCDate() + 1);
	const periodEnd = startOfTomorrow.getTime();
	const periodStart = periodEnd - days * 86400000;
	const prevPeriodStart = periodStart - days * 86400000;

	const inPeriod = completed.filter(c =>
		c.completedAt! >= stamp(new Date(periodStart)) &&
		c.completedAt! < stamp(new Date(periodEnd))
	);
	const inPrevPeriod = completed.filter(c =>
		c.completedAt! >= stamp(new Date(prevPeriodStart)) &&
		c.completedAt! < stamp(new Date(periodStart))
	);

	// Bucket: daily for short ranges, weekly for long ones
	const bucketDays = days <= 31 ? 1 : 7;
	const bucketCount = Math.ceil(days / bucketDays);
	const buckets: { start: string; label: string; count: number }[] = [];

	for (let i = bucketCount - 1; i >= 0; i--) {
		const bStart = periodEnd - (i + 1) * bucketDays * 86400000;
		const bEnd = periodEnd - i * bucketDays * 86400000;
		const startStamp = stamp(new Date(bStart));
		const endStamp = stamp(new Date(bEnd));
		const count = inPeriod.filter(c => c.completedAt! >= startStamp && c.completedAt! < endStamp).length;

		const d = new Date(bStart);
		const label = bucketDays === 1
			? d.toLocaleDateString('en-GB', { day: 'numeric', month: 'short', timeZone: 'UTC' })
			: `${d.toLocaleDateString('en-GB', { day: 'numeric', month: 'short', timeZone: 'UTC' })}`;

		buckets.push({ start: startStamp.slice(0, 10), label, count });
	}

	const total = inPeriod.length;
	const prevTotal = inPrevPeriod.length;
	const avgPerWeek = Math.round((total / (days / 7)) * 10) / 10;
	const best = buckets.reduce(
		(b, cur) => (cur.count > b.count ? cur : b),
		{ start: '', label: '—', count: 0 }
	);
	const trendPct = prevTotal > 0 ? Math.round(((total - prevTotal) / prevTotal) * 100) : null;

	return json({
		days,
		bucketDays,
		buckets,
		summary: { total, prevTotal, trendPct, avgPerWeek, best: { label: best.label, count: best.count } }
	});
};
