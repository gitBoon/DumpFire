import { json, error } from '@sveltejs/kit';
import { db } from '$lib/server/db';
import { activityLog, boards } from '$lib/server/db/schema';
import { eq, desc, and, gte, lte, like, notLike, sql } from 'drizzle-orm';
import { actionCondition } from '$lib/server/logActivity';
import { readLimit, readOffset, readQueryDate, readQueryId, refuseReversedRange } from '$lib/server/request-body';
import type { RequestHandler } from './$types';

/**
 * GET /api/audit — Query the system-wide activity log (session auth).
 *
 * Internal twin of /api/v1/audit-log for the /audit page.
 * Filters: ?boardId=N &action=string (suffix * for prefix match) &source=ui|api
 *          &userId=N &from=ISO &to=ISO &limit=N (default 100, max 500) &offset=N
 *
 * `from` and `to` are each a date or a timestamp (`400 from is not a date`),
 * read as `readQueryDate` reads them; a bare `to` includes its whole day. A
 * `from` after its `to` is a 400 (`` `from` is after `to` ``), as the v1 twin
 * answers it (card 2262); it was a 200 with an empty page.
 *
 * The action filter finds the action however it was done (card 2127):
 * `card_completed` finds the page's `card_completed` and the API's
 * `api:card_completed`, which the filter used to leave out. Written with
 * `api:` in front it means done through the API, as the page has always
 * offered `api:*` to mean, so `api:*` and `api:card_completed` answer as they
 * did. `source` asks the same of every action, from the stored spelling as the
 * v1 route reads it. The v1 route reads the prefix as no more than a spelling:
 * that is a documented answer of the public API, and is left as it is.
 *
 * As the v1 twin reads them (card 2117, decision 17): `limit` is a whole
 * number held between 1 and 500, so -1 is 1 and not every entry, and `offset`
 * one of 0 or more; text is the default. The ids are ids: `2.5` and `5abc`
 * were read as another, or as none.
 *
 * Requires admin or superadmin role.
 */
export const GET: RequestHandler = async ({ url, locals }) => {
	if (!locals.user) throw error(401, 'Not authenticated');
	if (locals.user.role !== 'admin' && locals.user.role !== 'superadmin') {
		throw error(403, 'Admin access required');
	}

	const boardId = readQueryId(url.searchParams.get('boardId'), 'board', 'Invalid boardId');
	const action = url.searchParams.get('action');
	const source = url.searchParams.get('source');
	const userId = readQueryId(url.searchParams.get('userId'), 'user', 'Invalid userId');
	// Each bound a date or a timestamp, in the stored form, a bare `to` the
	// whole of its day (card 2095, decision 10). They were compared as sent,
	// so a bound in the other form gained or lost the day at its end, a bare
	// `to` lost the whole of its day, and `from=yesterday` was taken.
	const from = readQueryDate(url.searchParams.get('from'), 'from', 'lower');
	const to = readQueryDate(url.searchParams.get('to'), 'to', 'upper');
	refuseReversedRange(from, to);
	const limit = readLimit(url.searchParams.get('limit'), { max: 500, fallback: 100 });
	const offset = readOffset(url.searchParams.get('offset'));

	if (source && source !== 'ui' && source !== 'api') {
		throw error(400, 'source must be "ui" or "api"');
	}

	const conditions = [];
	if (boardId !== undefined) conditions.push(eq(activityLog.boardId, boardId));
	// With a board as well, the person is asked as `+user_id`, which no index
	// can answer, so SQLite reads the board's entries by the board's index.
	// Asked plainly, it took the person's index for its order and read every
	// entry of theirs to find the few on that board.
	if (userId !== undefined) {
		conditions.push(boardId !== undefined ? eq(sql`+${activityLog.userId}`, userId) : eq(activityLog.userId, userId));
	}
	if (action) {
		conditions.push(actionCondition(action));
		// Written with `api:` in front, it was done through the API.
		if (action.startsWith('api:')) conditions.push(like(activityLog.action, 'api:%'));
	}
	// From the stored spelling and not the `source` column, which rows written
	// before it existed have null: the prefix is the same fact for every row.
	if (source === 'api') conditions.push(like(activityLog.action, 'api:%'));
	if (source === 'ui') conditions.push(notLike(activityLog.action, 'api:%'));
	if (from) conditions.push(gte(activityLog.createdAt, from));
	if (to) conditions.push(lte(activityLog.createdAt, to));

	const where = conditions.length > 0 ? and(...conditions) : undefined;

	const entries = db.select()
		.from(activityLog)
		.where(where)
		// Newest first, and by id within a second (card 2217), so a page
		// boundary inside one second neither repeats nor skips an entry.
		.orderBy(desc(activityLog.createdAt), desc(activityLog.id))
		.limit(limit)
		.offset(offset)
		.all();

	// Enrich with board names
	const boardNames = new Map<number, string>();
	for (const entry of entries) {
		if (!boardNames.has(entry.boardId)) {
			const b = db.select({ name: boards.name }).from(boards).where(eq(boards.id, entry.boardId)).get();
			boardNames.set(entry.boardId, b?.name || 'Unknown');
		}
	}

	const enriched = entries.map(e => ({
		...e,
		boardName: boardNames.get(e.boardId) || 'Unknown'
	}));

	return json({
		data: enriched,
		pagination: { limit, offset, count: enriched.length }
	});
};
