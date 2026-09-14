import { json, error } from '@sveltejs/kit';
import { db } from '$lib/server/db';
import { cards, columns, subtasks, cardLabels, cardAssignees, users } from '$lib/server/db/schema';
import { eq, asc, and, isNull, sql } from 'drizzle-orm';
import { canViewBoard, canEditBoard } from '$lib/server/board-access';
import { emit } from '$lib/server/events';
import { logActivity, actorOf, ACTIONS } from '$lib/server/logActivity';
import { normaliseReportingFields, ReportingFieldError } from '$lib/server/reporting-fields';
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

	// Subtask counts, in one grouped query rather than one call per card.
	// Reports need "3 of 7 done" for every card on a board; without this a
	// 196-card report had to fetch each card individually, which is most of what
	// made the first one cost 229 API calls.
	const subtaskCounts = new Map<number, { total: number; completed: number }>();
	if (allCards.length > 0) {
		const rows = db
			.select({
				cardId: subtasks.cardId,
				total: sql<number>`COUNT(*)`,
				completed: sql<number>`SUM(CASE WHEN ${subtasks.completed} THEN 1 ELSE 0 END)`
			})
			.from(subtasks)
			.innerJoin(cards, eq(subtasks.cardId, cards.id))
			.innerJoin(columns, eq(cards.columnId, columns.id))
			.where(eq(columns.boardId, boardId))
			.groupBy(subtasks.cardId)
			.all();
		for (const r of rows) {
			subtaskCounts.set(r.cardId, { total: Number(r.total), completed: Number(r.completed ?? 0) });
		}
	}

	const enriched = allCards.map(card => ({
		...card,
		columnTitle: columnMap.get(card.columnId) || 'Unknown',
		subtaskCount: subtaskCounts.get(card.id)?.total ?? 0,
		subtaskCompleted: subtaskCounts.get(card.id)?.completed ?? 0
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

	let reporting;
	try {
		reporting = normaliseReportingFields(body);
	} catch (e) {
		if (e instanceof ReportingFieldError) throw error(400, e.message);
		throw e;
	}

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
			businessValue: businessValue || '',
			createdBy: locals.user.id,
			...reporting
		})
		.returning()
		.get();

	// The creation event that never existed. Without it there was no way to find
	// work that had been raised but not yet started, and no record of who raised
	// it — `createdBy` answers the second half.
	logActivity({
		boardId,
		cardId: card.id,
		action: ACTIONS.cardCreated,
		detail: card.title,
		source: 'api',
		...actorOf(locals.user)
	});

	emit(boardId, 'update', { type: 'card', action: 'created', cardTitle: card.title, userName: locals.user.username, userEmoji: locals.user.emoji || '\ud83d\udc64' });

	return json(card, { status: 201 });
};
