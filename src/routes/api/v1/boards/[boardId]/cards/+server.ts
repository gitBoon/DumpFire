import { json } from '$lib/server/v1-json';
import { db } from '$lib/server/db';
import { cards, columns, subtasks } from '$lib/server/db/schema';
import { eq, asc, and, isNull, sql } from 'drizzle-orm';
import { createCard } from '$lib/server/cards';
import { linkBaseUrl } from '$lib/server/email';
import { pathId, readBody, readQueryId } from '$lib/server/request-body';
import { requireBoard, requireUser } from '$lib/server/route-guards';
import { writeAs } from '$lib/server/write-as';
import type { RequestHandler } from './$types';

/** GET /api/v1/boards/:boardId/cards — List all cards on a board. */
export const GET: RequestHandler = async ({ params, url, locals }) => {
	const boardId = pathId(params.boardId, 'board');
	// A board that is not there is 404 to everyone, then one the caller cannot open 403.
	requireBoard(locals.user, boardId, 'view');

	const columnFilter = readQueryId(url.searchParams.get('columnId'), 'column');

	// Get all columns for this board
	const boardColumns = db.select()
		.from(columns)
		.where(eq(columns.boardId, boardId))
		.all();

	if (boardColumns.length === 0) {
		return json([]);
	}

	const includeArchived = url.searchParams.get('archived') === 'true';

	let allCards: (typeof cards.$inferSelect)[] = [];
	for (const col of boardColumns) {
		if (columnFilter !== undefined && col.id !== columnFilter) continue;

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

/**
 * POST /api/v1/boards/:boardId/cards — Create a new card on a board.
 *
 * The board is looked for and the caller checked first (404, then 403), then
 * every field is read (400), then the column and the category the body names
 * are looked for. A card's category is one of its board's, or one that
 * belongs to no board: `404 Category not found on this board` otherwise.
 *
 * A card created in a Complete column is completed as it is created, as a
 * card moved into one is (card 2134): see `$lib/server/card-create`. The
 * answer is the card as written, with its `completedAt`.
 *
 * The work is `createCard` in `$lib/server/cards`, which the internal create
 * shares (card 2012), given this board.
 */
export const POST: RequestHandler = async ({ params, request, locals, url }) => {
	requireUser(locals.user);
	const boardId = pathId(params.boardId, 'board');
	const body = await readBody(request);
	const baseUrl = linkBaseUrl(url);

	// One transaction: the caller is checked and the column read in the one
	// that creates the card and writes its entries. A failure between the
	// writes used to leave a card that nobody was recorded as having raised.
	// It asks first whether the key or session is still open, and who its
	// account is now (card 2253): a key revoked while the body arrived is a
	// 401, with no card, no entry and no webhook.
	const card = writeAs(locals, (caller) => createCard(caller, { boardId }, body, { source: 'api', baseUrl }));

	return json(card, { status: 201 });
};
