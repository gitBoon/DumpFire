import { error } from '@sveltejs/kit';
import { json } from '$lib/server/v1-json';
import { db } from '$lib/server/db';
import { boards, columns } from '$lib/server/db/schema';
import { eq, asc } from 'drizzle-orm';
import { emit } from '$lib/server/events';
import { logActivity } from '$lib/server/logActivity';
import { inTransaction } from '$lib/server/db/transaction';
import { deleteBoard } from '$lib/server/deletes';
import { pathId, readBody, readBoolean, readId, readText } from '$lib/server/request-body';
import { requireBoard, requireBoardCategory, requireBoardOwner, requireUser } from '$lib/server/route-guards';
import { stamp } from '$lib/timestamps';
import type { RequestHandler } from './$types';

/**
 * GET /api/v1/boards/:boardId — Get board details with its columns.
 *
 * A board that is not there is 404 to everyone, and then one the caller
 * cannot open is 403 (`requireBoard`). It was 403 first, to all but an
 * administrator.
 */
export const GET: RequestHandler = async ({ params, locals }) => {
	const boardId = pathId(params.boardId, 'board');
	const board = requireBoard(locals.user, boardId, 'view');

	const cols = db.select()
		.from(columns)
		.where(eq(columns.boardId, boardId))
		.orderBy(asc(columns.position))
		.all();

	return json({ ...board, columns: cols });
};

/**
 * PUT /api/v1/boards/:boardId — Update board name, emoji, categoryId, or isPublic.
 *
 * Edit access is enough for the first three. `isPublic` is the board's
 * owner's to send, or an administrator's.
 */
export const PUT: RequestHandler = async ({ params, request, locals }) => {
	const user = requireUser(locals.user);
	const boardId = pathId(params.boardId, 'board');
	const body = await readBody(request);

	// One transaction: the board is read and the caller checked in the one that
	// changes it and writes its activity entry. A failure between the two
	// writes used to leave a board changed with nothing to say who changed it.
	const updated = inTransaction(() => {
		const board = requireBoard(user, boardId, 'edit');

		// An editor changes what is on a board, and not who can see it. Sent by
		// anyone but the owner or an administrator, `isPublic` refuses the whole
		// request: no other field that came with it is saved either. It is asked
		// before the value is read, so an editor is answered 403 whatever it is.
		if ('isPublic' in body) requireBoardOwner(user, boardId);

		const updates: Partial<typeof boards.$inferInsert> = {};
		const name = readText(body, 'name', {
			trim: true,
			min: 1,
			max: 200,
			keep: board.name,
			says: { empty: 'name cannot be empty' }
		});
		if (name !== undefined) updates.name = name;
		const emoji = readText(body, 'emoji', { min: 1, max: 32, keep: board.emoji });
		if (emoji !== undefined) updates.emoji = emoji;
		// The dashboard grouping the board is filed under, or null for none.
		const categoryId = readId(body, 'categoryId', { nullable: true, keep: board.categoryId });
		if (categoryId !== undefined) updates.categoryId = categoryId;
		const isPublic = readBoolean(body, 'isPublic', { keep: board.isPublic });
		if (isPublic !== undefined) updates.isPublic = isPublic;

		if (Object.keys(updates).length === 0) {
			throw error(400, 'No valid fields to update');
		}

		// `boards.category_id` has no foreign key, so a grouping that is not
		// there was stored as sent: 404. One all of whose boards the caller
		// cannot open is 403, as reading it is (card 2128, R2). One sent back
		// unchanged is left alone.
		if (categoryId !== undefined && categoryId !== null && categoryId !== board.categoryId) {
			requireBoardCategory(user, categoryId);
		}

		updates.updatedAt = stamp();

		const updated = db.update(boards)
			.set(updates)
			.where(eq(boards.id, boardId))
			.returning()
			.get();

		emit(boardId, 'update', { type: 'board' });

		logActivity({
			boardId,
			userId: user.id,
			action: 'api:board_updated',
			detail: `Updated board "${updated.name}" (fields: ${Object.keys(updates).filter(k => k !== 'updatedAt').join(', ')})`,
			userName: user.username,
			userEmoji: user.emoji || '👤'
		});

		return updated;
	});

	return json(updated);
};

/** DELETE /api/v1/boards/:boardId — Delete a board and all its data. */
export const DELETE: RequestHandler = async ({ params, locals }) => {
	const user = requireUser(locals.user);
	const boardId = pathId(params.boardId, 'board');

	// One transaction: the caller is checked in the same one that deletes the
	// board. Every sub-board at every depth goes with it, where this used to
	// name one level of them; what else goes is in $lib/server/deletes.ts.
	inTransaction(() => {
		// Only owners and admins can delete boards. A board that is not there
		// is 404 to everyone, before who is asking is looked at.
		requireBoardOwner(user, boardId, 'Only board owners and admins can delete boards');

		if (!deleteBoard(boardId, user)) throw error(404, 'Board not found');
	});

	return json({ success: true });
};
