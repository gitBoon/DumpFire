import { error } from '@sveltejs/kit';
import { json } from '$lib/server/v1-json';
import { db } from '$lib/server/db';
import { cards, columns, subtasks } from '$lib/server/db/schema';
import { eq, and, isNull, sql } from 'drizzle-orm';
import { createCard } from '$lib/server/cards';
import { CARD_ORDER, COLUMN_ORDER } from '$lib/server/card-order';
import { linkBaseUrl } from '$lib/server/email';
import { choiceRefusal, pathId, readBody, readQueryId } from '$lib/server/request-body';
import { requireBoard, requireUser } from '$lib/server/route-guards';
import { writeAs } from '$lib/server/write-as';
import type { RequestHandler } from './$types';

/** The two stages a card can be listed by: upstream of the commitment point, or committed (milestone 22, card 2464). */
const STAGES = ['option', 'committed'] as const;

/**
 * GET /api/v1/boards/:boardId/cards — List all cards on a board.
 *
 * In the board's order (card 2295): by column position, ties by column id,
 * and within a column by card position, ties by card id. The columns came in
 * no set order, in practice the order they were made in, so a column moved
 * or added between two others was listed in the wrong place, and each
 * column's cards were read in a query of their own. Now one query reads them
 * all, joined to their columns.
 *
 * `stage` (milestone 22, card 2464) lists the options alone, `option`, or the
 * committed cards alone, `committed`: a card is an option when it is in the
 * board's Options column, or on an ideas board, whose every column is
 * upstream (`isUpstreamColumn` in `$lib/column-role`, the rule every measure
 * asks). Decided by the column the card is in, archived cards included when
 * `archived=true`, so a discarded card, archived from Options, is listed as
 * an option. Not sent, or empty, every card; anything else is 400, quoting
 * what was sent.
 */
export const GET: RequestHandler = async ({ params, url, locals }) => {
	const boardId = pathId(params.boardId, 'board');
	// A board that is not there is 404 to everyone, then one the caller cannot open 403.
	const board = requireBoard(locals.user, boardId, 'view');

	const columnFilter = readQueryId(url.searchParams.get('columnId'), 'column');
	const includeArchived = url.searchParams.get('archived') === 'true';
	const stage = url.searchParams.get('stage');
	if (stage !== null && stage !== '' && !(STAGES as readonly string[]).includes(stage)) error(400, choiceRefusal('stage', STAGES, stage));

	// The board is the one in the path, so its kind is known here: on an ideas
	// board every card is an option, and on a delivery board the cards in its
	// Options column are. `IS`, not `=`, as `upstreamCondition` says: an
	// ordinary column's role is NULL, and `NOT (NULL = 'options')` is NULL.
	const option = board.kind === 'ideas' ? sql`1` : sql`${columns.role} IS 'options'`;
	const byStage = stage === 'option' ? option : stage === 'committed' ? sql`NOT (${option})` : undefined;

	// The board in the path bounds the list whatever is filtered: `columnId` is
	// a condition beside it and never in its place, so a column of another
	// board, one the caller may not be able to open, gives nothing. The same
	// conditions narrow the subtask counts below to the cards listed.
	const listed = and(
		eq(columns.boardId, boardId),
		columnFilter !== undefined ? eq(cards.columnId, columnFilter) : undefined,
		includeArchived ? undefined : isNull(cards.archivedAt),
		byStage
	);

	const rows = db
		.select({ card: cards, columnTitle: columns.title })
		.from(cards)
		.innerJoin(columns, eq(cards.columnId, columns.id))
		.where(listed)
		.orderBy(...COLUMN_ORDER, ...CARD_ORDER)
		.all();

	// Subtask counts, in one grouped query rather than one call per card.
	// Reports need "3 of 7 done" for every card on a board; without this a
	// 196-card report had to fetch each card individually, which is most of what
	// made the first one cost 229 API calls.
	const subtaskCounts = new Map<number, { total: number; completed: number }>();
	if (rows.length > 0) {
		const counts = db
			.select({
				cardId: subtasks.cardId,
				total: sql<number>`COUNT(*)`,
				completed: sql<number>`SUM(CASE WHEN ${subtasks.completed} THEN 1 ELSE 0 END)`
			})
			.from(subtasks)
			.innerJoin(cards, eq(subtasks.cardId, cards.id))
			.innerJoin(columns, eq(cards.columnId, columns.id))
			.where(listed)
			.groupBy(subtasks.cardId)
			.all();
		for (const r of counts) {
			subtaskCounts.set(r.cardId, { total: Number(r.total), completed: Number(r.completed ?? 0) });
		}
	}

	const enriched = rows.map(({ card, columnTitle }) => ({
		...card,
		columnTitle: columnTitle || 'Unknown',
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
