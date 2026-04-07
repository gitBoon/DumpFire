import { json } from '@sveltejs/kit';
import { db } from '$lib/server/db';
import { cards } from '$lib/server/db/schema';
import { emit } from '$lib/server/events';
import type { RequestHandler } from './$types';

export const POST: RequestHandler = async ({ request }) => {
	const { columnId, title, description, position, priority, colorTag, categoryId, dueDate, boardId, businessValue } = await request.json();
	const card = db
		.insert(cards)
		.values({
			columnId,
			categoryId: categoryId || null,
			title: title || 'Untitled',
			description: description || '',
			position: position ?? 0,
			priority: priority || 'medium',
			colorTag: colorTag || '',
			dueDate: dueDate || null,
			businessValue: businessValue || ''
		})
		.returning()
		.get();
	if (boardId) emit(boardId, 'update', { type: 'card' });
	return json(card, { status: 201 });
};
