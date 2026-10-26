/**
 * upstream.ts — which cards are upstream of the commitment point, asked on the
 * server (milestone 22).
 *
 * A card is upstream, an option rather than committed work, when its column is
 * the board's Options column (`columns.role = 'options'`) or its board is an
 * ideas board (`boards.kind = 'ideas'`). The rule itself is
 * `isUpstreamColumn` in `$lib/column-role`, shared with the browser; this
 * module reads what that rule needs from the database: the kinds of boards,
 * for code that already holds column rows, and one column's verdict, for a
 * write on one card. `UPSTREAM` is the same rule as SQL, for the readers that
 * write their own.
 *
 * Nothing here takes a NULL `committed_at` to mean upstream. The column and
 * the board decide it, and `committed_at` records what they decided.
 */
import { db } from '$lib/server/db';
import { activityLog, boards, columns } from '$lib/server/db/schema';
import { and, eq, inArray, like, max } from 'drizzle-orm';
import { isUpstreamColumn } from '$lib/column-role';
import { ACTIONS, storedActions } from '$lib/server/logActivity';

/**
 * How a `column_converted_to_options` entry's detail ends: ` (column <id>)`.
 * The activity log has no column of its own for a column, so the conversion
 * names it here, at the end of the detail, after the quoted title, where no
 * title can put it; `optionsSince` looks for it there (milestone 22, the S1b
 * review's B2). A `card_committed` entry ends with it too, naming the column
 * the card was committed into, for the cycle time (the S2 review's C3).
 */
export function conversionSuffix(columnId: number): string {
	return ` (column ${columnId})`;
}

/**
 * When each of these cards, all in the Options column `column`, became an
 * option, for the strip's aging (milestone 22, ruling g, amended by the S1b
 * review's B2): the latest of its creation, its latest
 * `card_returned_to_options` entry, and the latest conversion of the column,
 * each in either spelling. A card converted with its column is an option from
 * the conversion, not from its creation; a card sent here from an ideas board
 * keeps its age. Two reads, and none for no cards. Stored moments share one
 * form, so the latest is the greatest text.
 */
export function optionsSince(column: { id: number; boardId: number }, cards: readonly { id: number; createdAt: string }[]): Map<number, string> {
	const since = new Map<number, string>();
	if (cards.length === 0) return since;
	const returned = new Map(
		db
			.select({ cardId: activityLog.cardId, at: max(activityLog.createdAt) })
			.from(activityLog)
			.where(and(inArray(activityLog.cardId, cards.map((c) => c.id)), inArray(activityLog.action, storedActions('card_returned_to_options'))))
			.groupBy(activityLog.cardId)
			.all()
			.map((r) => [r.cardId, r.at])
	);
	const converted =
		db
			.select({ at: max(activityLog.createdAt) })
			.from(activityLog)
			.where(
				and(
					eq(activityLog.boardId, column.boardId),
					inArray(activityLog.action, storedActions(ACTIONS.columnConvertedToOptions)),
					like(activityLog.detail, `%${conversionSuffix(column.id)}`)
				)
			)
			.get()?.at ?? null;
	for (const card of cards) {
		const moments = [card.createdAt, returned.get(card.id), converted].filter((m): m is string => typeof m === 'string');
		since.set(card.id, moments.reduce((latest, m) => (m > latest ? m : latest)));
	}
	return since;
}

/**
 * The rule as an SQL condition, over a column and its board under the aliases
 * given: true for a card in the Options column or on an ideas board, and false,
 * never NULL, for every other card. `IS` and not `=`: an ordinary column's role
 * is NULL, and `NULL = 'options'` is NULL, so `NOT` the condition would drop
 * every committed card too (the S1a review's R1). A card with no column or no
 * board, under a LEFT JOIN, is not upstream either.
 */
export function upstreamCondition(columnAlias = 'col', boardAlias = 'b'): string {
	return `(${columnAlias}.role IS 'options' OR ${boardAlias}.kind IS 'ideas')`;
}

/** The rule over `columns` as `col` joined to `boards` as `b`: `(col.role IS 'options' OR b.kind IS 'ideas')`. */
export const UPSTREAM = upstreamCondition();

/** The kind of each board in `boardIds` that exists, by id, in one query. */
export function boardKinds(boardIds: readonly number[]): Map<number, string> {
	const kinds = new Map<number, string>();
	const ids = [...new Set(boardIds)];
	if (ids.length === 0) return kinds;
	const rows = db.select({ id: boards.id, kind: boards.kind }).from(boards).where(inArray(boards.id, ids)).all();
	for (const row of rows) kinds.set(row.id, row.kind);
	return kinds;
}

/**
 * The ids of the columns, among these rows, that are upstream: the Options
 * column, and every column of an ideas board. The boards' kinds are read in
 * one query.
 */
export function upstreamColumnIds(rows: readonly { id: number; boardId: number; role: string | null }[]): Set<number> {
	const kinds = boardKinds(rows.map((c) => c.boardId));
	return new Set(rows.filter((c) => isUpstreamColumn(c, kinds.get(c.boardId) ?? null)).map((c) => c.id));
}

/**
 * What a card just created in `column` by user `actorId` records of its
 * commitment (the S1a review's R2): created outside an upstream column, it is
 * committed as it is created, at its `createdAt` and by its creator, so the
 * start-up backfill finds nothing to fill; created in an Options column or on
 * an ideas board, it is an option and records nothing. One read, of the
 * board's kind. Every creation path asks this, through `recordCardCreated`.
 */
export function commitmentOnCreation(
	column: { id: number; boardId: number; role: string | null },
	card: { createdAt: string },
	actorId: number
): { committedAt: string; committedBy: number } | null {
	return upstreamColumnIds([column]).has(column.id) ? null : { committedAt: card.createdAt, committedBy: actorId };
}

/** True if column `columnId` is upstream; false for a column that is not there. */
export function isUpstreamColumnId(columnId: number): boolean {
	const row = db
		.select({ role: columns.role, kind: boards.kind })
		.from(columns)
		.innerJoin(boards, eq(boards.id, columns.boardId))
		.where(eq(columns.id, columnId))
		.get();
	return row ? isUpstreamColumn(row, row.kind) : false;
}
