import { json, error } from '@sveltejs/kit';
import { db } from '$lib/server/db';
import { columns } from '$lib/server/db/schema';
import { eq } from 'drizzle-orm';
import { emit } from '$lib/server/events';
import { canEditBoard } from '$lib/server/board-access';
import { completionRoleRefusal } from '$lib/server/card-completion';
import { inTransaction } from '$lib/server/db/transaction';
import { deleteColumn } from '$lib/server/deletes';
import { pathId, readBody, readBoolean, readColour, readNumber, readText } from '$lib/server/request-body';
import { requireColumn, requireUser } from '$lib/server/route-guards';
import type { RequestHandler } from './$types';

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
 * The same function is in `api/v1/columns/[columnId]/+server.ts`. Keep the two
 * alike.
 */
function wipLimitOf(value: unknown): number {
	const number = typeof value === 'string' && value.trim() !== '' ? Number(value) : value;
	if (typeof number !== 'number' || !Number.isFinite(number)) return 0;
	return Math.min(Number.MAX_SAFE_INTEGER, Math.max(0, Math.trunc(number)));
}

/**
 * PUT /api/columns/:id — change a column.
 *
 * The column is looked for and the caller checked (404, then 403), and then
 * every field is read (card 2117): `title` text, trimmed, of 1 to 200
 * characters; `color` a colour written `#rrggbb`; `position` a number;
 * `showAddCard` true or false, as `PUT /api/v1/columns/:columnId` takes it.
 * The WIP limit keeps its own reading. A value the column already holds, sent
 * back unchanged, is accepted as it is. A body with none of them is
 * `400 No valid fields to update`.
 *
 * `showAddCard` was left out, so the board page's "Show Add Task" was a 500
 * on every press; its page changed its own copy and the toggle looked saved
 * until the next load.
 *
 * A title that would make the column a Complete column, or stop it being
 * one, is `409` while the column holds any card, archived ones included, and
 * nothing is written (card 2134): see `completionRoleRefusal`.
 */
export const PUT: RequestHandler = async ({ params, request, locals }) => {
	const user = requireUser(locals.user);
	const id = pathId(params.id, 'column');
	const body = await readBody(request);

	// The column is read and the caller checked in the transaction that changes
	// it, once the body has arrived. The board is the column's own: a `boardId`
	// in the body is ignored.
	const updated = inTransaction(() => {
		const { column, boardId } = requireColumn(user, id, 'edit');

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

		const row = db.update(columns).set(updates).where(eq(columns.id, id)).returning().get();
		// Decided on the title as stored. A refusal throws, and the write goes
		// with the transaction.
		const refusal = completionRoleRefusal(column, row.title);
		if (refusal) throw error(409, refusal);
		emit(boardId, 'update', { type: 'column' });
		return row;
	});
	return json(updated);
};

export const DELETE: RequestHandler = async ({ params, locals }) => {
	if (!locals.user) throw error(401, 'Not authenticated');

	const id = pathId(params.id, 'column');
	const user = locals.user;

	// One transaction: the column is read and the caller checked in the same
	// one that deletes it. Its cards go with it, and what goes with them is in
	// $lib/server/deletes.ts.
	inTransaction(() => {
		// Always resolve the board from the database — never trust the client
		const column = db.select().from(columns).where(eq(columns.id, id)).get();
		if (!column) throw error(404, 'Column not found');

		if (!canEditBoard(user, column.boardId)) {
			throw error(403, 'No edit access to this board');
		}

		deleteColumn(id, user, 'ui');
		emit(column.boardId, 'update', { type: 'column' });
	});
	return json({ success: true });
};
