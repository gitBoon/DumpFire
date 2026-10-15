import { json, error } from '@sveltejs/kit';
import { db } from '$lib/server/db';
import { columns } from '$lib/server/db/schema';
import { eq } from 'drizzle-orm';
import { canViewBoard, canEditBoard } from '$lib/server/board-access';
import { completionRoleRefusal } from '$lib/server/card-completion';
import { emit } from '$lib/server/events';
import { inTransaction } from '$lib/server/db/transaction';
import { deleteColumn } from '$lib/server/deletes';
import { pathId, readBody, readBoolean, readNumber, readText } from '$lib/server/request-body';
import { requireColumn, requireUser } from '$lib/server/route-guards';
import type { RequestHandler } from './$types';

/** Look up the column and verify access. Returns the column or throws. */
function getColumnWithAccess(columnId: number, user: any, requireEdit: boolean) {
	const col = db.select().from(columns).where(eq(columns.id, columnId)).get();
	if (!col) throw error(404, 'Column not found');

	if (requireEdit) {
		if (!canEditBoard(user, col.boardId)) throw error(403, 'No edit access to this board');
	} else {
		if (!canViewBoard(user, col.boardId)) throw error(403, 'No access to this board');
	}

	return col;
}

/**
 * A WIP limit as the database takes it: a whole number, 0 or more, where 0
 * means no limit.
 *
 * `columns.wip_limit` is NOT NULL, so a limit is cleared by storing 0. A null
 * was once passed straight to the database, which refused it, and clearing a
 * limit answered 500. Here a null, or anything else that is not a finite
 * number, becomes 0; so does a negative number; and a fraction loses its
 * fractional part. A number sent as text ("5") is read as that number.
 *
 * The same function is in `api/columns/[id]/+server.ts`. Keep the two alike.
 */
function wipLimitOf(value: unknown): number {
	const number = typeof value === 'string' && value.trim() !== '' ? Number(value) : value;
	if (typeof number !== 'number' || !Number.isFinite(number)) return 0;
	return Math.min(Number.MAX_SAFE_INTEGER, Math.max(0, Math.trunc(number)));
}

/** GET /api/v1/columns/:columnId — Get a single column. */
export const GET: RequestHandler = async ({ params, locals }) => {
	if (!locals.user) throw error(401, 'Not authenticated');

	const columnId = pathId(params.columnId, 'column');

	const col = getColumnWithAccess(columnId, locals.user, false);
	return json(col);
};

/**
 * PUT /api/v1/columns/:columnId — Update a column.
 *
 * A title that would make the column a Complete column, or stop it being
 * one, is `409` while the column holds any card, archived ones included, and
 * nothing is written (card 2134): see `completionRoleRefusal`.
 */
export const PUT: RequestHandler = async ({ params, request, locals }) => {
	const user = requireUser(locals.user);
	const columnId = pathId(params.columnId, 'column');
	const body = await readBody(request);

	// The column is read and the caller checked in the transaction that
	// changes it, once the body has arrived.
	const updated = inTransaction(() => {
		const { column, boardId } = requireColumn(user, columnId, 'edit');

		const updates: Partial<typeof columns.$inferInsert> = {};
		const title = readText(body, 'title', {
			trim: true,
			min: 1,
			max: 200,
			keep: column.title,
			says: { empty: 'title cannot be empty', invalid: 'Column title too long (max 200 chars)' }
		});
		if (title !== undefined) updates.title = title;
		const color = readText(body, 'color', { min: 1, max: 32, keep: column.color });
		if (color !== undefined) updates.color = color;
		const position = readNumber(body, 'position', { keep: column.position });
		if (position !== undefined) updates.position = position;
		// The WIP limit keeps its own, wider reading: see wipLimitOf.
		if ('wipLimit' in body) updates.wipLimit = wipLimitOf(body.wipLimit);
		const showAddCard = readBoolean(body, 'showAddCard', { keep: column.showAddCard });
		if (showAddCard !== undefined) updates.showAddCard = showAddCard;

		if (Object.keys(updates).length === 0) {
			throw error(400, 'No valid fields to update');
		}

		const row = db.update(columns)
			.set(updates)
			.where(eq(columns.id, columnId))
			.returning()
			.get();

		// Decided on the title as stored. A refusal throws, and the write goes
		// with the transaction.
		const refusal = completionRoleRefusal(column, row.title);
		if (refusal) throw error(409, refusal);

		emit(boardId, 'update', { type: 'column' });
		return row;
	});

	return json(updated);
};

/** DELETE /api/v1/columns/:columnId — Delete a column and all its cards. */
export const DELETE: RequestHandler = async ({ params, locals }) => {
	if (!locals.user) throw error(401, 'Not authenticated');

	const columnId = pathId(params.columnId, 'column');

	const user = locals.user;

	// One transaction: the column is read and the caller checked in the same
	// one that deletes it. Its cards go with it, and what goes with them is in
	// $lib/server/deletes.ts.
	inTransaction(() => {
		const col = getColumnWithAccess(columnId, user, true);

		deleteColumn(columnId, user, 'api');
		emit(col.boardId, 'update', { type: 'column' });
	});

	return json({ success: true });
};
