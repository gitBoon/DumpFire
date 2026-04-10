import { json, error } from '@sveltejs/kit';
import { db } from '$lib/server/db';
import { webhooks, boards } from '$lib/server/db/schema';
import { eq } from 'drizzle-orm';
import { canEditBoard, canViewBoard } from '$lib/server/board-access';
import type { RequestHandler } from './$types';

/** GET /api/v1/boards/:boardId/webhooks — List all webhooks for a board. */
export const GET: RequestHandler = async ({ params, locals }) => {
	if (!locals.user) throw error(401, 'Not authenticated');

	const boardId = Number(params.boardId);
	if (!canViewBoard(locals.user, boardId)) throw error(403, 'No access');

	const hooks = db.select().from(webhooks)
		.where(eq(webhooks.boardId, boardId))
		.all()
		.map(h => ({ ...h, events: JSON.parse(h.events || '[]') }));

	return json(hooks);
};

/** POST /api/v1/boards/:boardId/webhooks — Create a webhook. */
export const POST: RequestHandler = async ({ params, request, locals }) => {
	if (!locals.user) throw error(401, 'Not authenticated');

	const boardId = Number(params.boardId);
	if (!canEditBoard(locals.user, boardId)) throw error(403, 'No edit access');

	const board = db.select().from(boards).where(eq(boards.id, boardId)).get();
	if (!board) throw error(404, 'Board not found');

	const { url, secret, events } = await request.json();
	if (!url?.trim()) throw error(400, 'URL is required');

	const hook = db.insert(webhooks)
		.values({
			boardId,
			url: url.trim(),
			secret: secret || '',
			events: JSON.stringify(events || [])
		})
		.returning()
		.get();

	return json({ ...hook, events: JSON.parse(hook.events || '[]') }, { status: 201 });
};
