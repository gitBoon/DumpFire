import { json } from '@sveltejs/kit';
import { db } from '$lib/server/db';
import { activityLog } from '$lib/server/db/schema';
import { desc, eq } from 'drizzle-orm';
import type { RequestHandler } from './$types';

export const GET: RequestHandler = async ({ url }) => {
	const boardId = Number(url.searchParams.get('boardId'));
	if (!boardId) return json([]);

	const activities = db
		.select()
		.from(activityLog)
		.where(eq(activityLog.boardId, boardId))
		.orderBy(desc(activityLog.createdAt))
		.limit(50)
		.all();

	return json(activities);
};

export const POST: RequestHandler = async ({ request }) => {
	const { boardId, cardId, action, detail, userName, userEmoji } = await request.json();
	const entry = db
		.insert(activityLog)
		.values({
			boardId,
			cardId: cardId || null,
			action,
			detail: detail || '',
			userName: userName || '',
			userEmoji: userEmoji || '👤'
		})
		.returning()
		.get();
	return json(entry, { status: 201 });
};
