import { json, error } from '@sveltejs/kit';
import { db } from '$lib/server/db';
import { systemLogs } from '$lib/server/db/schema';
import { eq, desc, and, gte, lte, like } from 'drizzle-orm';
import type { RequestHandler } from './$types';

/**
 * GET /api/logs — Query the persisted system log history.
 *
 * Filters: ?level=INFO &context=AUTH &q=text (LIKE on message)
 *          &from=ISO &to=ISO &limit=N (default 200, max 1000) &offset=N
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
	const from = url.searchParams.get('from');
	const to = url.searchParams.get('to');
	const limit = Math.min(Number(url.searchParams.get('limit')) || 200, 1000);
	const offset = Number(url.searchParams.get('offset')) || 0;

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
