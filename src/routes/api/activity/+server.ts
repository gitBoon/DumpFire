import { json, error } from '@sveltejs/kit';
import { db } from '$lib/server/db';
import { activityLog } from '$lib/server/db/schema';
import { desc, eq } from 'drizzle-orm';
import { canViewBoard, canEditBoard } from '$lib/server/board-access';
import type { RequestHandler } from './$types';

export const GET: RequestHandler = async ({ url, locals }) => {
	if (!locals.user) throw error(401, 'Not authenticated');

	const boardId = Number(url.searchParams.get('boardId'));
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
