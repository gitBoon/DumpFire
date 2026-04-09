import { json, error } from '@sveltejs/kit';
import { db } from '$lib/server/db';
import { cards, columns, subtasks, cardLabels, cardAssignees, users } from '$lib/server/db/schema';
import { eq, asc, and, isNull } from 'drizzle-orm';
import { canViewBoard, canEditBoard } from '$lib/server/board-access';
import { emit } from '$lib/server/events';
import type { RequestHandler } from './$types';

/** GET /api/v1/boards/:boardId/cards — List all cards on a board. */
export const GET: RequestHandler = async ({ params, url, locals }) => {
	if (!locals.user) throw error(401, 'Not authenticated');

	const boardId = Number(params.boardId);
	if (isNaN(boardId)) throw error(400, 'Invalid board ID');

	if (!canViewBoard(locals.user, boardId)) {
		throw error(403, 'No access to this board');
	}

	// Get all columns for this board
	const boardColumns = db.select()
		.from(columns)
		.where(eq(columns.boardId, boardId))
		.all();

	if (boardColumns.length === 0) {
		return json([]);
	}

	const columnFilter = url.searchParams.get('columnId');
	const includeArchived = url.searchParams.get('archived') === 'true';

	let allCards: (typeof cards.$inferSelect)[] = [];
	for (const col of boardColumns) {
		if (columnFilter && col.id !== Number(columnFilter)) continue;

		let colCards;
		if (includeArchived) {
			colCards = db.select().from(cards)
				.where(eq(cards.columnId, col.id))
				.orderBy(asc(cards.position))
				.all();
		} else {
			colCards = db.select().from(cards)
				.where(and(eq(cards.columnId, col.id), isNull(cards.archivedAt)))
				.orderBy(asc(cards.position))
				.all();
		}
		allCards = allCards.concat(colCards);
	}

	// Enrich with column title for convenience
	const columnMap = new Map(boardColumns.map(c => [c.id, c.title]));
	const enriched = allCards.map(card => ({
		...card,
		columnTitle: columnMap.get(card.columnId) || 'Unknown'
	}));

	return json(enriched);
};

/** POST /api/v1/boards/:boardId/cards — Create a new card on a board. */
export const POST: RequestHandler = async ({ params, request, locals }) => {
	if (!locals.user) throw error(401, 'Not authenticated');

	const boardId = Number(params.boardId);
	if (isNaN(boardId)) throw error(400, 'Invalid board ID');

	if (!canEditBoard(locals.user, boardId)) {
		throw error(403, 'No edit access to this board');
	}

	const body = await request.json();
	const { columnId, title, description, priority, colorTag, categoryId, dueDate, businessValue, position } = body;

	if (!columnId) throw error(400, 'columnId is required');
	if (!title || !title.trim()) throw error(400, 'title is required');
	if (title.length > 500) throw error(400, 'Title too long (max 500 chars)');
	if (description && description.length > 50000) throw error(400, 'Description too long (max 50000 chars)');

	// Verify the column belongs to this board
	const col = db.select().from(columns).where(eq(columns.id, columnId)).get();
	if (!col || col.boardId !== boardId) {
		throw error(400, 'Column does not belong to this board');
	}

	const card = db.insert(cards)
		.values({
			columnId,
			categoryId: categoryId || null,
			title: title.trim(),
			description: description || '',
			position: position ?? 0,
			priority: priority || 'medium',
			colorTag: colorTag || '',
			dueDate: dueDate || null,
			businessValue: businessValue || ''
		})
		.returning()
		.get();

	emit(boardId, 'update', { type: 'card', action: 'created', cardTitle: card.title, userName: locals.user.username, userEmoji: locals.user.emoji || '\ud83d\udc64' });

	return json(card, { status: 201 });
};
