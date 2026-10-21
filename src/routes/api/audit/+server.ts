import { json, error } from '@sveltejs/kit';
import { queryAuditLog, readAuditParams } from '$lib/server/audit-log';
import { isAdmin } from '$lib/server/board-access';
import type { RequestHandler } from './$types';

/**
 * GET /api/audit — Query the system-wide activity log (session auth).
 *
 * Internal twin of /api/v1/audit-log for the /audit page. Both read the log
 * through `queryAuditLog` (`$lib/server/audit-log`, card 2294), where the
 * filters are listed and the seven ways the two had come apart are settled.
 * Filters: ?boardId=N &action=string (suffix * for prefix match) &source=ui|api
 *          &userId=N &cardId=N &from=ISO &to=ISO &limit=N (default 100, max
 *          500) &offset=N
 *
 * A row is v1's with `action` as stored (`api:card_moved`), which the page
 * shows, its `api:` drawing the API chip; `rawAction` is the same, and
 * `source` is `ui` or `api` for every row, older ones read from the spelling.
 * The answer's `pagination` is v1's, `total` and `hasMore` with it.
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
 * that is a documented answer of the public API, and is left as it is: the
 * filter reads `api:` as each route shows the action (card 2294, ruling 1).
 *
 * As the v1 twin reads them (card 2117, decision 17): `limit` is a whole
 * number held between 1 and 500, so -1 is 1 and not every entry, and `offset`
 * one of 0 or more; text is the default. The ids are ids: `2.5` and `5abc`
 * were read as another, or as none. They are refused in v1's words, `Invalid
 * board ID` (card 2294; it was `Invalid boardId`).
 *
 * Requires admin or superadmin role (`isAdmin`, as v1).
 */
export const GET: RequestHandler = async ({ url, locals }) => {
	if (!locals.user) throw error(401, 'Not authenticated');
	if (!isAdmin(locals.user)) throw error(403, 'Admin access required');

	return json(queryAuditLog(readAuditParams(url.searchParams), { canonical: false }));
};
