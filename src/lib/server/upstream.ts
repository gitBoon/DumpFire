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
import { boards, columns } from '$lib/server/db/schema';
import { eq, inArray } from 'drizzle-orm';
import { isUpstreamColumn } from '$lib/column-role';

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
