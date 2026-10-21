import { error } from '@sveltejs/kit';
import { json } from '$lib/server/v1-json';
import { queryAuditLog, readAuditParams } from '$lib/server/audit-log';
import { isAdmin } from '$lib/server/board-access';
import type { RequestHandler } from './$types';

/**
 * GET /api/v1/audit-log — Query system-wide activity log.
 *
 * Read through `queryAuditLog` (`$lib/server/audit-log`), which the web
 * application's `GET /api/audit` shares (card 2294); this route asks for
 * canonical actions, and its answer is as it was.
 *
 * Filters:
 *   ?boardId=N       — Filter by board (the board at the time of the event)
 *   ?action=string   — Action type. Matches the canonical name regardless of
 *                      source, so `card_moved` finds both UI and API moves;
 *                      a trailing `*` is a prefix match, and nothing else is
 *                      a wildcard: `card_*` does not find `cards_purged`.
 *   ?source=ui|api   — Where the action came from
 *   ?userId=N        — Filter by user
 *   ?cardId=N        — Filter by card
 *   ?from=ISO        — From date (inclusive)
 *   ?to=ISO          — To date (inclusive). Each is a date, a timestamp in
 *                      ISO 8601 or `YYYY-MM-DD HH:MM:SS` (UTC), or a 400
 *                      (`from is not a date`); a bare `to` is the whole day.
 *                      A `from` after its `to` is a 400 (`` `from` is after
 *                      `to` ``); equal bounds name one second.
 *   ?limit=N         — Max results (default 100, max 500). A whole number,
 *                      rounded down and held between 1 and 500: -1 is 1, and
 *                      not every row, which is what SQLite gave for it.
 *   ?offset=N        — Pagination offset: rounded down, and 0 or more.
 *   ?before=T,N      — The createdAt and id of the last entry held (card
 *                      2387): the entries older than it, so one written
 *                      between pages is not given twice. Optional; offset
 *                      works as it did. With it, total and hasMore count
 *                      from the cursor. Anything else is a 400.
 *
 * The three ids are read as an id in the path is read: `2.5` and `abc` are
 * `400 Invalid <thing> ID`, where they matched nothing, or a row they did not
 * name.
 *
 * Every response carries `pagination.total` and `pagination.hasMore`, so a
 * truncated page is obvious. It was not before: the default limit of 100 was
 * undocumented and a full page looked exactly like a complete result, which is
 * how a 2,500-entry scan quietly became a 100-entry one.
 *
 * Requires admin role.
 */
export const GET: RequestHandler = async ({ url, locals }) => {
	if (!locals.user) throw error(401, 'Not authenticated');
	// isAdmin, not `role !== 'admin'`: the bare comparison locked superadmin out.
	if (!isAdmin(locals.user)) throw error(403, 'Admin access required');

	return json(queryAuditLog(readAuditParams(url.searchParams), { canonical: true }));
};
