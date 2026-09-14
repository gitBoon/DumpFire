import { json, error } from '@sveltejs/kit';
import { buildActivityReport } from '$lib/server/activity-report';
import type { RequestHandler } from './$types';

/**
 * GET /api/v1/reports/activity — one call, one management activity report.
 *
 * Query parameters:
 *   ?userId=N            Report on one person's activity. Omit for everyone.
 *   ?from=ISO&to=ISO     Window. Bare dates are whole days, `to` inclusive.
 *                        Defaults to the last 30 days.
 *   ?boardIds=1,2,3      Restrict to these boards. Omit for every board the
 *                        caller can see.
 *   ?include=subtasks,comments   Opt in to per-card detail.
 *   ?commentLimit=N      Most recent N comments per card (default 3, max 20).
 *
 * Boards the caller cannot view are excluded, and the count of them is reported
 * in `meta.boardsExcludedForAccess` rather than silently dropped — a report with
 * a hole in it should say so.
 */
export const GET: RequestHandler = async ({ url, locals }) => {
	if (!locals.user) throw error(401, 'Not authenticated');

	const userIdParam = url.searchParams.get('userId');
	const userId = userIdParam ? Number(userIdParam) : null;
	if (userIdParam && !Number.isInteger(userId)) throw error(400, 'userId must be an integer');

	// Reporting on someone else is an admin act: these payloads carry every card
	// title and comment that person touched.
	if (userId && userId !== locals.user.id && locals.user.role !== 'admin') {
		throw error(403, 'Only an admin can report on another user');
	}

	const to = url.searchParams.get('to') || new Date().toISOString();
	const from =
		url.searchParams.get('from') ||
		new Date(Date.now() - 30 * 86_400_000).toISOString();

	if (Date.parse(normalise(from)) > Date.parse(normalise(to))) {
		throw error(400, '`from` is after `to`');
	}

	const boardIdsParam = url.searchParams.get('boardIds');
	let boardIds: number[] | null = null;
	if (boardIdsParam) {
		boardIds = boardIdsParam
			.split(',')
			.map((s) => Number(s.trim()))
			.filter((n) => Number.isInteger(n) && n > 0);
		if (boardIds.length === 0) throw error(400, 'boardIds must be a comma-separated list of ids');
	}

	const include = (url.searchParams.get('include') || '')
		.split(',')
		.map((s) => s.trim().toLowerCase())
		.filter(Boolean);

	// Capped rather than rejected: a caller asking for 500 comments a card wants
	// as much context as possible, and silently returning fewer is kinder than a
	// 400 — but the cap is stated in the docs so the truncation is expected.
	const commentLimit = Math.min(Math.max(Number(url.searchParams.get('commentLimit')) || 3, 0), 20);

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

/** Accept a bare date or a full ISO timestamp when sanity-checking the window. */
function normalise(value: string): string {
	return /^\d{4}-\d{2}-\d{2}$/.test(value) ? `${value}T00:00:00.000Z` : value;
}
