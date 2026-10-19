import { json, error } from '@sveltejs/kit';
import { db } from '$lib/server/db';
import { systemLogs } from '$lib/server/db/schema';
import { eq, desc, and, gte, lte, like } from 'drizzle-orm';
import { readLimit, readOffset, readQueryDate, refuseReversedRange } from '$lib/server/request-body';
import type { RequestHandler } from './$types';

/**
 * GET /api/logs — Query the persisted system log history.
 *
 * Filters: ?level=INFO &context=AUTH &q=text (LIKE on message)
 *          &from=ISO &to=ISO &limit=N (default 200, max 1000) &offset=N
 *
 * `from` and `to` are each a date or a timestamp (`400 from is not a date`),
 * read as `readQueryDate` reads them; a bare `to` includes its whole day. A
 * `from` after its `to` is a 400 (`` `from` is after `to` ``), as
 * /api/v1/audit-log answers it (card 2262); it was a 200 with an empty page.
 *
 * `limit` is a whole number held between 1 and 1000, so -1 is 1 and not the
 * whole log, and `offset` one of 0 or more; text is the default (card 2117,
 * decision 17).
 *
 * Requires admin or superadmin role.
 */
export const GET: RequestHandler = async ({ url, locals }) => {
	if (!locals.user) throw error(401, 'Not authenticated');
	if (locals.user.role !== 'admin' && locals.user.role !== 'superadmin') {
		throw error(403, 'Admin access required');
	}

	const level = url.searchParams.get('level');
	const context = url.searchParams.get('context');
	const q = url.searchParams.get('q');
	// Each bound a date or a timestamp, in the stored form, a bare `to` the
	// whole of its day (card 2095, decision 10). They were compared as sent,
	// so a bound in the other form gained or lost the day at its end, a bare
	// `to` lost the whole of its day, and `from=yesterday` was taken.
	const from = readQueryDate(url.searchParams.get('from'), 'from', 'lower');
	const to = readQueryDate(url.searchParams.get('to'), 'to', 'upper');
	refuseReversedRange(from, to);
	const limit = readLimit(url.searchParams.get('limit'), { max: 1000, fallback: 200 });
	const offset = readOffset(url.searchParams.get('offset'));

	const conditions = [];
	if (level) conditions.push(eq(systemLogs.level, level.toUpperCase()));
	if (context) conditions.push(eq(systemLogs.context, context.toUpperCase()));
	if (q) conditions.push(like(systemLogs.message, `%${q}%`));
	if (from) conditions.push(gte(systemLogs.timestamp, from));
	if (to) conditions.push(lte(systemLogs.timestamp, to));

	const where = conditions.length > 0 ? and(...conditions) : undefined;

	const entries = db.select()
		.from(systemLogs)
		.where(where)
		.orderBy(desc(systemLogs.id))
		.limit(limit)
		.offset(offset)
		.all();

	return json({
		data: entries,
		pagination: { limit, offset, count: entries.length }
	});
};
