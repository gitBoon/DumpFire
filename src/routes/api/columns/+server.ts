import { json } from '@sveltejs/kit';
import { db } from '$lib/server/db';
import { columns } from '$lib/server/db/schema';
import { emit } from '$lib/server/events';
import type { RequestHandler } from './$types';

export const POST: RequestHandler = async ({ request }) => {
	const { boardId, title, position, color } = await request.json();
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
