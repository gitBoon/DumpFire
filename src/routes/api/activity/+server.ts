import { json, error } from '@sveltejs/kit';
import { db } from '$lib/server/db';
import { activityLog, boards } from '$lib/server/db/schema';
import { desc, eq, inArray } from 'drizzle-orm';
import { canViewBoard, canEditBoard, getAccessibleBoardIds } from '$lib/server/board-access';
import type { RequestHandler } from './$types';

/**
 * GET /api/activity — Fetch activity entries.
 *
 * If ?boardId=N is provided, returns activity for that specific board.
 * If no boardId is provided, returns activity across all accessible boards
 * (for use in the All Tasks activity panel).
 */
export const GET: RequestHandler = async ({ url, locals }) => {
	if (!locals.user) throw error(401, 'Not authenticated');

	const boardIdParam = url.searchParams.get('boardId');

	if (boardIdParam) {
		// Single-board mode (existing behaviour)
		const boardId = Number(boardIdParam);
		if (!boardId) return json([]);

		if (!canViewBoard(locals.user, boardId)) throw error(403, 'No access to this board');

		const activities = db
			.select()
			.from(activityLog)
			.where(eq(activityLog.boardId, boardId))
			.orderBy(desc(activityLog.createdAt))
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
			.orderBy(desc(activityLog.createdAt))
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
			.orderBy(desc(activityLog.createdAt))
			.limit(100)
			.all();
	}

	return json(activities);
};

export const POST: RequestHandler = async ({ request, locals }) => {
	if (!locals.user) throw error(401, 'Not authenticated');

	const { boardId, cardId, action, detail } = await request.json();

	if (!canEditBoard(locals.user, boardId)) throw error(403, 'No edit access to this board');

	// Use authenticated user identity — never trust client-supplied userName
	const entry = db
		.insert(activityLog)
		.values({
			boardId,
			cardId: cardId || null,
			action,
			detail: detail || '',
			userName: locals.user.username,
			userEmoji: locals.user.emoji || '👤'
		})
		.returning()
		.get();
	return json(entry, { status: 201 });
};
