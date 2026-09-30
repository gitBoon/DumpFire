import { json, error } from '@sveltejs/kit';
import { getBurndown, parseBurndownQuery, BurndownError } from '$lib/server/burndown';
import type { RequestHandler } from './$types';

/**
 * GET /api/v1/burndown — how much work was open on each day, and where it is heading.
 *
 * Scope — pick at most one of the first two, optionally narrowed by a milestone:
 *   boardIds=1,2        explicit boards (view access to each is required)
 *   boardCategoryId=3   every board in a board category that you can see
 *   milestoneId=16      the milestone's cards, wherever they live
 *   (none)              every board you can see
 *
 * Filters — values within one are alternatives, separate filters all apply:
 *   categoryIds=4,none  card categories; "none" = uncategorised
 *   labelIds=7
 *   assigneeIds=2,me    "me" = you, "none" = unassigned
 *   priorities=critical,high
 *
 * Window — UTC days, at most 730:
 *   from=YYYY-MM-DD&to=YYYY-MM-DD, or days=N ending at `to` (default today).
 *   Defaults to the last 30 days, or since creation for a milestone.
 *
 *   target=YYYY-MM-DD   draw an ideal line to zero on this day (a milestone's
 *                       own target date is used otherwise; target=none hides it)
 *   groupBy=board|category|label|assignee|priority   per-group series
 *   options=true        filter values present in scope, with counts
 *
 * The series is rebuilt from each card's own timestamps, not from daily
 * snapshots, so any filter works over any window. Read `meta.notes` before
 * quoting a figure: it names every assumption that bears on this result.
 */
export const GET: RequestHandler = async ({ url, locals }) => {
	if (!locals.user) throw error(401, 'Not authenticated');
	try {
		return json(getBurndown(locals.user, parseBurndownQuery(url.searchParams, locals.user)));
	} catch (e) {
		if (e instanceof BurndownError) throw error(e.status, e.message);
		throw e;
	}
};
