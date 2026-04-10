import { json, error } from '@sveltejs/kit';
import { db } from '$lib/server/db';
import { labels } from '$lib/server/db/schema';
import { eq } from 'drizzle-orm';
import { canViewBoard, canEditBoard } from '$lib/server/board-access';
import { emit } from '$lib/server/events';
import type { RequestHandler } from './$types';

/** GET /api/v1/boards/:boardId/labels — List all labels for a board. */
export const GET: RequestHandler = async ({ params, locals }) => {
	if (!locals.user) throw error(401, 'Not authenticated');

	const boardId = Number(params.boardId);
	if (isNaN(boardId)) throw error(400, 'Invalid board ID');

	if (!canViewBoard(locals.user, boardId)) {
		throw error(403, 'No access to this board');
	}

	const result = db.select().from(labels).where(eq(labels.boardId, boardId)).all();
	return json(result);
};

/** POST /api/v1/boards/:boardId/labels — Create a new label on a board. */
export const POST: RequestHandler = async ({ params, request, locals }) => {
	if (!locals.user) throw error(401, 'Not authenticated');

	const boardId = Number(params.boardId);
	if (isNaN(boardId)) throw error(400, 'Invalid board ID');

	if (!canEditBoard(locals.user, boardId)) {
		throw error(403, 'No edit access to this board');
	}

	const body = await request.json();
	const { name, color } = body;

	if (!name || !String(name).trim()) throw error(400, 'name is required');
	if (String(name).length > 200) throw error(400, 'Label name too long (max 200 chars)');

	const label = db.insert(labels)
		.values({
			boardId,
			name: String(name).trim(),
			color: color || '#6366f1'
		})
		.returning()
		.get();

	emit(boardId, 'update', { type: 'label' });

	return json(label, { status: 201 });
};
