import { json, error } from '@sveltejs/kit';
import { db } from '$lib/server/db';
import { inTransaction } from '$lib/server/db/transaction';
import { boards, columns, boardMembers } from '$lib/server/db/schema';
import { desc, eq, inArray } from 'drizzle-orm';
import { getAccessibleBoardIds } from '$lib/server/board-access';
import { emit } from '$lib/server/events';
import { ACTIONS, actorOf, logUiActivity } from '$lib/server/logActivity';
import { readBody, readId, readText } from '$lib/server/request-body';
import { requireBoardCategory, requireParentCard, requireUser } from '$lib/server/route-guards';
import { tooDeepToMake, tooDeepUnder } from '$lib/server/sub-boards';
import type { RequestHandler } from './$types';

export const GET: RequestHandler = async ({ locals }) => {
	if (!locals.user) throw error(401, 'Not authenticated');

	const accessibleIds = getAccessibleBoardIds(locals.user);

	let allBoards: (typeof boards.$inferSelect)[];
	if (accessibleIds === null) {
		// Admin — sees everything
		allBoards = db.select().from(boards).orderBy(desc(boards.createdAt)).all();
	} else if (accessibleIds.length === 0) {
		allBoards = [];
	} else {
		allBoards = db.select().from(boards)
			.where(inArray(boards.id, accessibleIds))
			.orderBy(desc(boards.createdAt))
			.all();
	}

	return json(allBoards);
};

/**
 * POST /api/boards — make a board, with its four columns and its owner.
 *
 * A new board has no row to guard, so its fields are read first (card 2117,
 * R1): `name` text, trimmed, of 1 to 200 characters; `emoji` text of 1 to
 * 32; `parentCardId` an id, or null for none; `categoryId`, the dashboard
 * grouping, an id or null. `{}` made "Untitled Board", and a grouping that
 * was not there was stored as sent: `boards.category_id` has no foreign key.
 */
export const POST: RequestHandler = async ({ request, locals }) => {
	const user = requireUser(locals.user);
	const body = await readBody(request);
	const userId = user.id;

	const name = readText(body, 'name', {
		required: true,
		trim: true,
		min: 1,
		max: 200,
		says: { missing: 'name is required', empty: 'name is required', invalid: 'Board name too long (max 200 chars)' }
	});
	const emoji = readText(body, 'emoji', { min: 1, max: 32 });
	const parentCardId = readId(body, 'parentCardId', { nullable: true });
	const categoryId = readId(body, 'categoryId', { nullable: true });

	// One transaction: the board, its columns and its owner are made together.
	// A failure after the first used to leave a board with no columns, or one
	// that nobody owned. The parent card is read and the caller checked in it.
	// With them the `board_created` entry `POST /api/v1/boards` writes, and for
	// a sub-board the live update that shows it on its card (card 2143).
	const board = inTransaction(() => {
		// A sub-board hangs under a card, and is shown on it to everybody who
		// can open that card's board. The id used to be written as it was sent,
		// so anyone could hang a board under a card of a board they cannot open.
		const parent = parentCardId != null ? requireParentCard(user, parentCardId) : null;
		// And no deeper than sub-boards may nest (card 2172).
		if (parent && tooDeepUnder(parent)) error(409, tooDeepToMake());

		// A grouping the caller is listed (card 2128, R2): 404 for none, and 403
		// for one all of whose boards they cannot open, which filing a board
		// under would put in their lists.
		if (categoryId != null) requireBoardCategory(user, categoryId);

		const board = db
			.insert(boards)
			.values({
				name,
				emoji: emoji ?? '📋',
				parentCardId: parent?.id ?? null,
				categoryId: categoryId ?? null,
				createdBy: userId
			})
			.returning()
			.get();

		// Always create default columns
		db.insert(columns)
			.values([
				{ boardId: board.id, title: 'To Do', position: 0, color: '#6366f1' },
				{ boardId: board.id, title: 'On Hold', position: 1, color: '#ef4444' },
				{ boardId: board.id, title: 'In Progress', position: 2, color: '#f59e0b' },
				{ boardId: board.id, title: 'Complete', position: 3, color: '#10b981' }
			])
			.run();

		// Auto-add the creator as board owner
		db.insert(boardMembers)
			.values({ boardId: board.id, userId, role: 'owner' })
			.run();

		logUiActivity({
			boardId: board.id,
			action: ACTIONS.boardCreated,
			detail: `Created board "${board.name}"`,
			...actorOf(user)
		});

		// A sub-board is drawn on its card, so the pages open on that card's
		// board are told. A top-level board is shown to nobody else who has a
		// page open: its maker and the administrators, and the maker's page
		// moves to it.
		if (parent) {
			const parentBoardId = db
				.select({ boardId: columns.boardId })
				.from(columns)
				.where(eq(columns.id, parent.columnId))
				.get()!.boardId;
			emit(parentBoardId, 'update', { type: 'board', action: 'created' });
		}

		return board;
	});

	return json(board, { status: 201 });
};
