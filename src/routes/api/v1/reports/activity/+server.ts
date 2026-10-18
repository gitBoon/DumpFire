import { error } from '@sveltejs/kit';
import { json } from '$lib/server/v1-json';
import { buildActivityReport } from '$lib/server/activity-report';
import { isAdmin } from '$lib/server/board-access';
import { pathId, readQueryCount, readQueryDate, readQueryId } from '$lib/server/request-body';
import { stamp } from '$lib/timestamps';
import type { RequestHandler } from './$types';

/**
 * GET /api/v1/reports/activity — one call, one management activity report.
 *
 * Query parameters:
 *   ?userId=N            Report on one person's activity. Omit for everyone.
 *   ?from=ISO&to=ISO     Window. Bare dates are whole days, `to` inclusive.
 *                        Defaults to the last 30 days. Each is a date, a
 *                        timestamp in ISO 8601 or `YYYY-MM-DD HH:MM:SS`
 *                        (`400 from is not a date`); a timestamp with an
 *                        offset is moved to UTC, and one with no zone is UTC.
 *   ?boardIds=1,2,3      Restrict to these boards. Omit for every board the
 *                        caller can see. Each is an id.
 *   ?include=subtasks,comments   Opt in to per-card detail.
 *   ?commentLimit=N      Most recent N comments per card (default 3, max 20).
 *                        0 gives each card an empty `comments` list; a
 *                        negative number, or one that is not whole, is a 400.
 *
 * Boards the caller cannot view are excluded, and the count of them is reported
 * in `meta.boardsExcludedForAccess` rather than silently dropped — a report with
 * a hole in it should say so.
 */
export const GET: RequestHandler = async ({ url, locals }) => {
	if (!locals.user) throw error(401, 'Not authenticated');

	const userId = readQueryId(url.searchParams.get('userId'), 'user', 'userId must be an integer') ?? null;

	// Reporting on someone else is an admin act: these payloads carry every card
	// title and comment that person touched.
	// isAdmin, not `role !== 'admin'`: the bare comparison locked superadmin out.
	if (userId && userId !== locals.user.id && !isAdmin(locals.user)) {
		throw error(403, 'Only an admin can report on another user');
	}

	// Both ends in the stored form (card 2095, decision 10), a bare date the
	// whole of its day, so they compare as text. A bound in the stored form
	// was read in the server's own zone by this check, and one it could not
	// read at all passed it (A18).
	const to = readQueryDate(url.searchParams.get('to'), 'to', 'upper') ?? stamp();
	const from =
		readQueryDate(url.searchParams.get('from'), 'from', 'lower') ??
		stamp(new Date(Date.now() - 30 * 86_400_000));

	if (from > to) {
		throw error(400, '`from` is after `to`');
	}

	const boardIdsParam = url.searchParams.get('boardIds');
	let boardIds: number[] | null = null;
	if (boardIdsParam) {
		// Each an id, as an id in the path is read. One that was not was left out,
		// so a report asked for of board `2.5` was a report of the others.
		boardIds = boardIdsParam
			.split(',')
			.map((s) => s.trim())
			.filter((s) => s !== '')
			.map((s) => pathId(s, 'board', 'boardIds must be a comma-separated list of ids'));
		if (boardIds.length === 0) throw error(400, 'boardIds must be a comma-separated list of ids');
	}

	const include = (url.searchParams.get('include') || '')
		.split(',')
		.map((s) => s.trim().toLowerCase())
		.filter(Boolean);

	// Capped rather than rejected: a caller asking for 500 comments a card wants
	// as much context as possible, and silently returning fewer is kinder than a
	// 400 — but the cap is stated in the docs so the truncation is expected.
	// 0 is no comments, where it was read as 3, and a negative number a 400.
	const commentLimit = readQueryCount(url.searchParams.get('commentLimit'), 'commentLimit', { fallback: 3, max: 20 });

	const report = buildActivityReport({
		actor: locals.user,
		userId,
		from,
		to,
		boardIds,
		includeSubtasks: include.includes('subtasks'),
		includeComments: include.includes('comments'),
		commentLimit
	});

	return json(report);
};
