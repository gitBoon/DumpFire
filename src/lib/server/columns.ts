/**
 * columns.ts — a column added to a board, changed, deleted, and a board's
 * columns put in order: one function for each, which both API trees call
 * (card 2012, part A, slice A4).
 *
 * `/api/columns`, `/api/columns/:id` and `/api/columns/reorder` (the board
 * page) and their twins `/api/v1/boards/:boardId/columns` and
 * `/api/v1/columns/:columnId` had the same middle written twice, the WIP
 * limit's reading among it, copied with a note to keep the two alike. Each
 * tree keeps its path, its body, its single `writeAs`, its answer and,
 * through its options, what it does differently today: where a new column
 * sent with no position goes (first from the page, after the last through v1,
 * `placeAfterLast`) and the order a new column's fields are read in
 * (`colorBeforePosition`, v1). The reorder is the page's alone. R2 of
 * `docs/planning/card-2012-service-layer-and-pages.md`.
 *
 * Each write has the one shape of a service (`ServiceOptions` in
 * `write-as.ts`): `inWrite()` first, then `requireUser(caller)` (401), the
 * guard (404, then 403), then every field read from the body (400), and the
 * write; but the page's `createColumn` reads the board's id from the body
 * before the guard, as the row the guard is asked of, so its `400 Invalid
 * board ID` comes before a 404, and the reorder reads its list and each id
 * before it asks of any column. No column write records an entry but a
 * column deleted (`deletes.ts`). Every event waits for the commit. Refusals
 * are kit `error()`s.
 */
import { error } from '@sveltejs/kit';
import { asc, eq } from 'drizzle-orm';
import { db } from './db';
import { columns, type Column } from './db/schema';
import type { SessionUser } from './auth';
import { completionRoleRefusal } from './card-completion';
import { deleteColumn } from './deletes';
import { emit } from './events';
import { readBoolean, readColour, readId, readNumber, readObjects, readText, type RequestBody } from './request-body';
import { requireBoard, requireColumn, requireUser } from './route-guards';
import { inWrite, type ServiceOptions } from './write-as';

/** The functions here that only read. None: every export but this list is a write, and starts with `inWrite()`. */
export const READS: readonly string[] = [];

/**
 * A WIP limit as the database takes it: a whole number, 0 or more, where 0
 * means no limit.
 *
 * `columns.wip_limit` is NOT NULL, so a limit is cleared by storing 0. A null
 * was once passed straight to the database, which refused it, and clearing a
 * limit answered 500. Here a null, or anything else that is not a finite
 * number, becomes 0; so does a negative number; and a fraction loses its
 * fractional part. A number sent as text ("5") is read as that number.
 */
function wipLimitOf(value: unknown): number {
	const number = typeof value === 'string' && value.trim() !== '' ? Number(value) : value;
	if (typeof number !== 'number' || !Number.isFinite(number)) return 0;
	return Math.min(Number.MAX_SAFE_INTEGER, Math.max(0, Math.trunc(number)));
}

/** What each tree's new column does differently today (R2). */
export type CreateColumnOptions = {
	/** A column sent with no position goes after the board's last (v1). From the page it goes at 0. */
	placeAfterLast?: boolean;
	/** `color` is read before `position` (v1); the page reads `position` first. */
	colorBeforePosition?: boolean;
};

/**
 * Add a column to a board: `POST /api/columns` with the board in its body,
 * read first as the row the guard is asked of, and `POST
 * /api/v1/boards/:boardId/columns` with `at.boardId`. The board is looked for
 * and the caller checked (404, then 403), and then the other fields are read
 * (card 2117, R1): `title` text, trimmed, of 1 to 200 characters; `position`
 * a number; `color` a colour written `#rrggbb`. A title that was missing gave
 * "New Column", text was stored as a position, and any colour was stored.
 * The answer is the column as written.
 */
export function createColumn(caller: SessionUser | null, at: { boardId?: number }, body: RequestBody, opts: ServiceOptions & CreateColumnOptions): Column {
	inWrite();
	const user = requireUser(caller);
	// The board the column is being added to, so it is the right one to
	// check, and it has to exist.
	const boardId = requireBoard(user, at.boardId ?? readId(body, 'boardId', { required: true, says: 'Invalid board ID' }), 'edit').id;

	const title = readText(body, 'title', {
		required: true,
		trim: true,
		min: 1,
		max: 200,
		says: { missing: 'title is required', empty: 'title is required' }
	});
	let position: number | undefined;
	let color: string | undefined;
	if (opts.colorBeforePosition) {
		color = readColour(body, 'color', {});
		position = readNumber(body, 'position', {});
	} else {
		position = readNumber(body, 'position', {});
		color = readColour(body, 'color', {});
	}

	// No position sent: at 0 from the page, after the board's last through v1.
	let unplaced = 0;
	if (opts.placeAfterLast) {
		const existingCols = db.select({ position: columns.position }).from(columns).where(eq(columns.boardId, boardId)).orderBy(asc(columns.position)).all();
		unplaced = (existingCols.length > 0 ? Math.max(...existingCols.map((c) => c.position)) : -1) + 1;
	}

	const column = db
		.insert(columns)
		.values({
			boardId,
			title,
			position: position ?? unplaced,
			color: color ?? '#6366f1'
		})
		.returning()
		.get();
	emit(boardId, 'update', { type: 'column' });
	return column;
}

/**
 * Change a column (`PUT /api/columns/:id`, `PUT /api/v1/columns/:columnId`).
 *
 * The column is looked for and the caller checked (404, then 403), and then
 * every field is read (card 2117): `title` text, trimmed, of 1 to 200
 * characters; `color` a colour written `#rrggbb`; `position` a number;
 * `showAddCard` true or false. The WIP limit keeps its own reading. A value
 * the column already holds, sent back unchanged, is accepted as it is. A body
 * with none of them is `400 No valid fields to update`. The board is the
 * column's own: a `boardId` in the body is ignored.
 *
 * `showAddCard` was left out of the page's route, so the board page's "Show
 * Add Task" was a 500 on every press; its page changed its own copy and the
 * toggle looked saved until the next load.
 *
 * A title that would make the column a Complete column, or stop it being
 * one, is `409` while the column holds any card, archived ones included, and
 * nothing is written (card 2134): see `completionRoleRefusal`. The answer is
 * the row.
 */
export function updateColumn(caller: SessionUser | null, at: { columnId: number }, body: RequestBody, opts: ServiceOptions): Column {
	inWrite();
	const user = requireUser(caller);
	const { column, boardId } = requireColumn(user, at.columnId, 'edit');

	const updates: Partial<typeof columns.$inferInsert> = {};
	const title = readText(body, 'title', {
		trim: true,
		min: 1,
		max: 200,
		keep: column.title,
		says: { empty: 'title cannot be empty' }
	});
	if (title !== undefined) updates.title = title;
	const color = readColour(body, 'color', { keep: column.color });
	if (color !== undefined) updates.color = color;
	const position = readNumber(body, 'position', { keep: column.position });
	if (position !== undefined) updates.position = position;
	// The WIP limit keeps its own, wider reading: see wipLimitOf.
	if ('wipLimit' in body) updates.wipLimit = wipLimitOf(body.wipLimit);
	const showAddCard = readBoolean(body, 'showAddCard', { keep: column.showAddCard });
	if (showAddCard !== undefined) updates.showAddCard = showAddCard;

	if (Object.keys(updates).length === 0) throw error(400, 'No valid fields to update');

	const row = db.update(columns).set(updates).where(eq(columns.id, at.columnId)).returning().get();
	// Decided on the title as stored. A refusal throws, and the write goes
	// with the transaction.
	const refusal = completionRoleRefusal(column, row.title);
	if (refusal) throw error(409, refusal);
	emit(boardId, 'update', { type: 'column' });
	return row;
}

/**
 * Delete a column and its cards (`DELETE /api/columns/:id`, `DELETE
 * /api/v1/columns/:columnId`). The board is always the column's own, read
 * from the database, never from the client. What goes with the cards, and
 * the `column_deleted` entry, are in `deletes.ts`. There is no body.
 */
export function deleteColumnFor(caller: SessionUser | null, at: { columnId: number }, body: null, opts: ServiceOptions): void {
	inWrite();
	const user = requireUser(caller);
	const { boardId } = requireColumn(user, at.columnId, 'edit');

	deleteColumn(at.columnId, user, opts.source);
	emit(boardId, 'update', { type: 'column' });
}

/**
 * Save the order of a board's columns (`PUT /api/columns/reorder`, the
 * page's alone).
 *
 * Body: `{ updates: [{ id, position }] }`. Each entry is an object, its `id`
 * an id and its `position` a number (card 2117): `updates[<n>].position must
 * be a number`. Text was stored as a position, a missing one was a 500, and an
 * entry that was not an object was a 500.
 *
 * Every column gets its new position or none does, and a board is told only
 * once they all have. A write that failed half way used to leave the columns
 * in an order nobody had asked for. The body's `boardId` is ignored: it used
 * to be the only thing checked, and with it left out any signed-in user could
 * reorder any board's columns.
 */
export function reorderColumns(caller: SessionUser | null, at: Record<string, never>, body: RequestBody, opts: ServiceOptions): void {
	inWrite();
	const user = requireUser(caller);
	const updates = readObjects(body, 'updates', {
		required: true,
		says: { missing: 'updates must be an array', type: 'updates must be an array' }
	});

	// Every column is looked up and checked before anything is written.
	const boardIds = new Set<number>();
	const ids = updates.map((update, i) => readId(update, 'id', { required: true, says: `updates[${i}].id must be an id` }));
	for (const id of ids) boardIds.add(requireColumn(user, id, 'edit').boardId);

	// Then each position, once every column is known to be the caller's.
	const positions = updates.map((update, i) => readNumber(update, 'position', { required: true, says: `updates[${i}].position must be a number` }));

	for (const [i, id] of ids.entries()) {
		db.update(columns).set({ position: positions[i] }).where(eq(columns.id, id)).run();
	}
	for (const boardId of boardIds) emit(boardId, 'update', { type: 'column' });
}
