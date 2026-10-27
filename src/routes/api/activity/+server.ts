import { json, error } from '@sveltejs/kit';
import { db } from '$lib/server/db';
import { activityLog, boards } from '$lib/server/db/schema';
import { desc, eq, inArray } from 'drizzle-orm';
import { getAccessibleBoardIds } from '$lib/server/board-access';
import { readQueryId } from '$lib/server/request-body';
import { requireBoard } from '$lib/server/route-guards';
import type { RequestHandler } from './$types';

/**
 * GET /api/activity — Fetch activity entries.
 *
 * If ?boardId=N is provided, returns activity for that specific board.
 * If no boardId is provided, returns activity across all accessible boards
 * (for use in the All Tasks activity panel).
 *
 * Newest first, and by id within a second (card 2512), as the audit log and
 * the dashboard's recent activity are: entries are stored in whole seconds,
 * and a move that commits a card and completes it wrote both in one second,
 * so ordered by the time alone "Completed card" could be listed below
 * "Committed card".
 */
export const GET: RequestHandler = async ({ url, locals }) => {
	if (!locals.user) throw error(401, 'Not authenticated');

	// An id, as an id in the path is read (card 2117): `2.5` and `5abc` were
	// read as another board or as none, and `0` was an empty list.
	const boardId = readQueryId(url.searchParams.get('boardId'), 'board', 'Invalid boardId');

	if (boardId !== undefined) {
		// Single-board mode (existing behaviour). A board that is not there is
		// 404 to everyone, and then one the caller cannot see 403: everyone but
		// an administrator was answered 403, and an administrator an empty list
		// (card 2117, decision 10).
		requireBoard(locals.user, boardId, 'view');

		const activities = db
			.select()
			.from(activityLog)
			.where(eq(activityLog.boardId, boardId))
			.orderBy(desc(activityLog.createdAt), desc(activityLog.id))
			.limit(50)
			.all();

		return json(activities);
	}

	// Cross-board mode — return activity from all accessible boards
	const accessibleIds = getAccessibleBoardIds(locals.user);

	let activities;
	if (accessibleIds === null) {
		// Admin — all boards
		activities = db
			.select({
				id: activityLog.id,
				boardId: activityLog.boardId,
				cardId: activityLog.cardId,
				userId: activityLog.userId,
				action: activityLog.action,
				detail: activityLog.detail,
				userName: activityLog.userName,
				userEmoji: activityLog.userEmoji,
				createdAt: activityLog.createdAt,
				boardName: boards.name
			})
			.from(activityLog)
			.leftJoin(boards, eq(activityLog.boardId, boards.id))
			.orderBy(desc(activityLog.createdAt), desc(activityLog.id))
			.limit(100)
			.all();
	} else if (accessibleIds.length === 0) {
		return json([]);
	} else {
		activities = db
			.select({
				id: activityLog.id,
				boardId: activityLog.boardId,
				cardId: activityLog.cardId,
				userId: activityLog.userId,
				action: activityLog.action,
				detail: activityLog.detail,
				userName: activityLog.userName,
				userEmoji: activityLog.userEmoji,
				createdAt: activityLog.createdAt,
				boardName: boards.name
			})
			.from(activityLog)
			.leftJoin(boards, eq(activityLog.boardId, boards.id))
			.where(inArray(activityLog.boardId, accessibleIds))
			.orderBy(desc(activityLog.createdAt), desc(activityLog.id))
			.limit(100)
			.all();
	}

	return json(activities);
};

// There is no POST. The browser used to write its own activity entries here,
// alongside the ones the server already writes for the same change — so every
// move was logged twice, the second time with no user id and no source. The
// server-side entry is the record; see `$lib/server/logActivity`.
