import { json, error } from '@sveltejs/kit';
import { db } from '$lib/server/db';
import { cards, columns } from '$lib/server/db/schema';
import { emit } from '$lib/server/events';
import { canEditBoard } from '$lib/server/board-access';
import { eq } from 'drizzle-orm';
import type { RequestHandler } from './$types';

export const POST: RequestHandler = async ({ request, locals }) => {
	if (!locals.user) throw error(401, 'Not authenticated');

	const { columnId, title, description, position, priority, colorTag, categoryId, dueDate, boardId, businessValue } = await request.json();

	// Input length validation
	if (title && title.length > 500) throw error(400, 'Title too long (max 500 chars)');
	if (description && description.length > 50000) throw error(400, 'Description too long (max 50000 chars)');
	if (businessValue && businessValue.length > 10000) throw error(400, 'Business value too long (max 10000 chars)');

	// Verify board access via the column's board
	let resolvedBoardId = boardId;
	if (!resolvedBoardId) {
		const col = db.select({ boardId: columns.boardId }).from(columns).where(eq(columns.id, columnId)).get();
		if (!col) throw error(404, 'Column not found');
		resolvedBoardId = col.boardId;
	}

	if (!canEditBoard(locals.user, resolvedBoardId)) {
		throw error(403, 'No edit access to this board');
	}

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
	if (resolvedBoardId) emit(resolvedBoardId, 'update', { type: 'card' });
	return json(card, { status: 201 });
};
