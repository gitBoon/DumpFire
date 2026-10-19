import { json, error } from '@sveltejs/kit';
import { db } from '$lib/server/db';
import { boards } from '$lib/server/db/schema';
import { eq } from 'drizzle-orm';
import { deleteBoard } from '$lib/server/deletes';
import { emit } from '$lib/server/events';
import { ACTIONS, actorOf, logUiActivity } from '$lib/server/logActivity';
import { pathId, readBody, readBoolean, readId, readText } from '$lib/server/request-body';
import { requireBoard, requireBoardCategory, requireBoardOwner, requireSubBoardLink, requireUser } from '$lib/server/route-guards';
import { getCardBoardId } from '$lib/server/work-access';
import { stamp } from '$lib/timestamps';
import { writeAs } from '$lib/server/write-as';
import type { RequestHandler } from './$types';

export const PUT: RequestHandler = async ({ params, request, locals }) => {
	requireUser(locals.user);
	const id = pathId(params.id, 'board');
	const body = await readBody(request);

	// One transaction, entered once the body has arrived: the board is read,
	// the caller checked, and who may make it public asked, in the one that
	// changes it. A board that is not there is 404 to everyone; it was 403 to
	// all but an administrator. It asks first whether the session is still
	// open, and who its account is now (card 2253).
	const updated = writeAs(locals, (caller) => {
		const user = requireUser(caller);
		const board = requireBoard(user, id, 'edit');

		// An editor changes what is on a board, and not who can see it. Sent by
		// anyone but the owner or an administrator, `isPublic` refuses the whole
		// request: the name that came with it is not saved either. It is asked
		// before the value is read, so an editor is answered 403 whatever it is.
		if ('isPublic' in body) requireBoardOwner(user, id);

		// Read in the order `PUT /api/v1/boards/{id}` reads them, which is the
		// order the entry below names them in, as that route's does (card 2143).
		const updates: Partial<typeof boards.$inferInsert> = {};
		const name = readText(body, 'name', { trim: true, min: 1, max: 200, keep: board.name });
		if (name !== undefined) updates.name = name;
		const emoji = readText(body, 'emoji', { min: 1, max: 32, keep: board.emoji });
		if (emoji !== undefined) updates.emoji = emoji;
		// The dashboard grouping the board is filed under, or null for none.
		const categoryId = readId(body, 'categoryId', { nullable: true, keep: board.categoryId });
		if (categoryId !== undefined) updates.categoryId = categoryId;
		const isPublic = readBoolean(body, 'isPublic', { keep: board.isPublic });
		if (isPublic !== undefined) updates.isPublic = isPublic;

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

		const fields = Object.keys(updates);
		updates.updatedAt = stamp();
		const row = db.update(boards).set(updates).where(eq(boards.id, id)).returning().get();

		// What was sent is recorded, with the fields named, and the board's own
		// pages are told, as `PUT /api/v1/boards/{id}` does both (card 2143): a
		// rename or a grouping changed on screen had neither. A body that set no
		// field changed nothing to record or show.
		const told = new Set<number>();
		if (fields.length > 0) {
			logUiActivity({
				boardId: id,
				action: ACTIONS.boardUpdated,
				detail: `Updated board "${row.name}" (fields: ${fields.join(', ')})`,
				...actorOf(user)
			});
			told.add(id);
		}

		// The board moved, and the cards it left and joined show it, or stop
		// showing it: those boards' pages are told as well, each once.
		if (moving) {
			if (parent) told.add(parent.boardId);
			const left = board.parentCardId === null ? null : getCardBoardId(board.parentCardId);
			if (left !== null) told.add(left);
		}
		for (const boardId of told) emit(boardId, 'update', { type: 'board' });
		return row;
	});
	return json(updated);
};

export const DELETE: RequestHandler = async ({ params, locals }) => {
	requireUser(locals.user);

	const id = pathId(params.id, 'board');

	// One transaction: the caller is checked in the same one that deletes the
	// board. Every sub-board at every depth goes with it, and what else goes
	// is in $lib/server/deletes.ts. It asks first whether the session is still
	// open, and who its account is now (card 2253).
	writeAs(locals, (caller) => {
		const user = requireUser(caller);
		// Only owners and admins can delete boards. A board that is not there
		// is 404 to everyone, before who is asking is looked at, as
		// `DELETE /api/v1/boards/{id}` answers it (card 2211): an administrator
		// was answered 200 for deleting nothing, and anyone else 403.
		requireBoardOwner(user, id, 'Only board owners and admins can delete boards');

		if (!deleteBoard(id, user)) throw error(404, 'Board not found');
	});
	return json({ success: true });
};
