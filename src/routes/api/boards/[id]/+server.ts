import { json, error } from '@sveltejs/kit';
import { db } from '$lib/server/db';
import { boards } from '$lib/server/db/schema';
import { eq } from 'drizzle-orm';
import { getBoardRole } from '$lib/server/board-access';
import { inTransaction } from '$lib/server/db/transaction';
import { deleteBoard } from '$lib/server/deletes';
import { emit } from '$lib/server/events';
import { pathId, readBody, readBoolean, readId, readText } from '$lib/server/request-body';
import { requireBoard, requireBoardCategory, requireBoardOwner, requireSubBoardLink, requireUser } from '$lib/server/route-guards';
import { getCardBoardId } from '$lib/server/work-access';
import type { RequestHandler } from './$types';

export const PUT: RequestHandler = async ({ params, request, locals }) => {
	const user = requireUser(locals.user);
	const id = pathId(params.id, 'board');
	const body = await readBody(request);

	// One transaction, entered once the body has arrived: the board is read,
	// the caller checked, and who may make it public asked, in the one that
	// changes it. A board that is not there is 404 to everyone; it was 403 to
	// all but an administrator.
	const updated = inTransaction(() => {
		const board = requireBoard(user, id, 'edit');

		// An editor changes what is on a board, and not who can see it. Sent by
		// anyone but the owner or an administrator, `isPublic` refuses the whole
		// request: the name that came with it is not saved either. It is asked
		// before the value is read, so an editor is answered 403 whatever it is.
		if ('isPublic' in body) requireBoardOwner(user, id);

		const updates: Partial<typeof boards.$inferInsert> = {};
		const name = readText(body, 'name', { trim: true, min: 1, max: 200, keep: board.name });
		if (name !== undefined) updates.name = name;
		const emoji = readText(body, 'emoji', { min: 1, max: 32, keep: board.emoji });
		if (emoji !== undefined) updates.emoji = emoji;
		const isPublic = readBoolean(body, 'isPublic', { keep: board.isPublic });
		if (isPublic !== undefined) updates.isPublic = isPublic;
		// The dashboard grouping the board is filed under, or null for none.
		const categoryId = readId(body, 'categoryId', { nullable: true, keep: board.categoryId });
		if (categoryId !== undefined) updates.categoryId = categoryId;

		// `boards.category_id` has no foreign key, so a grouping that is not
		// there was stored as sent: 404. One all of whose boards the caller
		// cannot open is 403, as reading it is (card 2128, R2). One sent back
		// unchanged is left alone.
		if (categoryId !== undefined && categoryId !== null && categoryId !== board.categoryId) {
			requireBoardCategory(user, categoryId);
		}

		// The card the board hangs under, or null to put it back on the
		// dashboard. Linking hands the board's deletion to the parent board's
		// editors, so its owner or an administrator is asked, and the card may
		// not be on the board or beneath it (`requireSubBoardLink`). The card
		// it already hangs under, sent back, is left alone.
		const parentCardId = readId(body, 'parentCardId', { nullable: true, keep: board.parentCardId });
		const moving = parentCardId !== undefined && parentCardId !== board.parentCardId;
		const parent = moving ? requireSubBoardLink(user, id, parentCardId) : null;
		if (moving) updates.parentCardId = parentCardId;

		updates.updatedAt = new Date().toISOString();
		const row = db.update(boards).set(updates).where(eq(boards.id, id)).returning().get();

		// The board moved, and the cards it left and joined show it, or stop
		// showing it: all three boards' pages are told. Nothing is told of a
		// board that did not move, as before.
		if (moving) {
			const told = new Set([id]);
			if (parent) told.add(parent.boardId);
			const left = board.parentCardId === null ? null : getCardBoardId(board.parentCardId);
			if (left !== null) told.add(left);
			for (const boardId of told) emit(boardId, 'update', { type: 'board' });
		}
		return row;
	});
	return json(updated);
};

export const DELETE: RequestHandler = async ({ params, locals }) => {
	if (!locals.user) throw error(401, 'Not authenticated');

	const id = pathId(params.id, 'board');
	const user = locals.user;

	// One transaction: the caller is checked in the same one that deletes the
	// board. Every sub-board at every depth goes with it, and what else goes
	// is in $lib/server/deletes.ts.
	inTransaction(() => {
		// Only owners and admins can delete boards
		const role = getBoardRole(user, id);
		if (role !== 'owner' && role !== 'admin') {
			throw error(403, 'Only board owners and admins can delete boards');
		}

		deleteBoard(id, user);
	});
	return json({ success: true });
};
