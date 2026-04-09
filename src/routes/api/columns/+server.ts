import { json, error } from '@sveltejs/kit';
import { db } from '$lib/server/db';
import { columns } from '$lib/server/db/schema';
import { emit } from '$lib/server/events';
import { canEditBoard } from '$lib/server/board-access';
import type { RequestHandler } from './$types';

export const POST: RequestHandler = async ({ request, locals }) => {
	if (!locals.user) throw error(401, 'Not authenticated');

	const { boardId, title, position, color } = await request.json();

	if (!canEditBoard(locals.user, boardId)) {
		throw error(403, 'No edit access to this board');
	}

	const column = db
		.insert(columns)
		.values({
			boardId,
			title: title || 'New Column',
			position: position ?? 0,
			color: color || '#6366f1'
		})
		.returning()
		.get();
	emit(boardId, 'update', { type: 'column' });
	return json(column, { status: 201 });
};
