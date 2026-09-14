import { json, error } from '@sveltejs/kit';
import { db } from '$lib/server/db';
import { cards, columns } from '$lib/server/db/schema';
import { emit } from '$lib/server/events';
import { canEditBoard } from '$lib/server/board-access';
import { logUiActivity, actorOf, ACTIONS } from '$lib/server/logActivity';
import { normaliseReportingFields } from '$lib/server/reporting-fields';
import { eq } from 'drizzle-orm';
import type { RequestHandler } from './$types';

export const POST: RequestHandler = async ({ request, locals }) => {
	if (!locals.user) throw error(401, 'Not authenticated');

	const body = await request.json();
	const { columnId, title, description, position, priority, colorTag, categoryId, dueDate, boardId, businessValue } = body;
	const reporting = normaliseReportingFields(body);

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
			businessValue: businessValue || '',
			createdBy: locals.user.id,
			...reporting
		})
		.returning()
		.get();

	if (resolvedBoardId) {
		// A creation event at last. There was none — `card_created` never appeared
		// in ~2,500 scanned entries — so "raised but not yet touched" work could
		// not be found, and nothing recorded who raised it.
		logUiActivity({
			boardId: resolvedBoardId,
			cardId: card.id,
			action: ACTIONS.cardCreated,
			detail: card.title,
			...actorOf(locals.user)
		});
		emit(resolvedBoardId, 'update', { type: 'card', action: 'created', cardTitle: card.title, userName: locals.user.username, userEmoji: locals.user.emoji || '👤' });
	}
	return json(card, { status: 201 });
};
