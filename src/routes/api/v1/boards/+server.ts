import { error } from '@sveltejs/kit';
import { json } from '$lib/server/v1-json';
import { db } from '$lib/server/db';
import { boards, columns, boardMembers } from '$lib/server/db/schema';
import { desc, inArray, eq } from 'drizzle-orm';
import { getAccessibleBoardIds } from '$lib/server/board-access';
import { emit } from '$lib/server/events';
import { logActivity } from '$lib/server/logActivity';
import { requireParentCard, requireUser } from '$lib/server/route-guards';
import { tooDeepToMake, tooDeepUnder } from '$lib/server/sub-boards';
import { readBody, readId, readText } from '$lib/server/request-body';
import { writeAs } from '$lib/server/write-as';
import type { RequestHandler } from './$types';

/** GET /api/v1/boards — List all boards accessible to the API key's user. */
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
 * POST /api/v1/boards — Create a new board.
 *
 * Body: { name, emoji?, parentCardId? }
 *
 * If parentCardId is provided, the board is created as a sub-board
 * linked to that card. The user must have edit access to the parent
 * card's board.
 *
 * Default columns (To Do, On Hold, In Progress, Complete) are
 * created automatically. The API key's user is added as board owner.
 *
 * A new board has no row to guard, so its fields are read first (card 2117,
 * R1): `name` text, trimmed, of 1 to 200 characters; `emoji` text of 1 to 32;
 * `parentCardId` an id, or null for none. The parent card is looked for after.
 */
export const POST: RequestHandler = async ({ request, locals }) => {
	requireUser(locals.user);
	const body = await readBody(request);

	const name = readText(body, 'name', {
		required: true,
		trim: true,
		min: 1,
		max: 200,
		says: { missing: 'name is required', empty: 'name is required' }
	});
	const emoji = readText(body, 'emoji', { min: 1, max: 32 });
	const parentCardId = readId(body, 'parentCardId', { nullable: true });

	// One transaction: the parent card is read and the caller checked in the
	// one that makes the board, its columns, its owner and its activity entry.
	// A failure after the first used to leave a board with no columns, or one
	// that nobody owned. It asks first whether the key or session is still
	// open, and who its account is now (card 2253).
	const created = writeAs(locals, (caller) => {
		const user = requireUser(caller);
		// If linking to a parent card, verify access to that card's board. The
		// check is the one POST /api/boards makes, so that the two cannot differ.
		const parent = parentCardId != null ? requireParentCard(user, parentCardId) : null;
		// And no deeper than sub-boards may nest (card 2172): 409, nothing made.
		if (parent && tooDeepUnder(parent)) error(409, tooDeepToMake());

		const board = db
			.insert(boards)
			.values({
				name,
				emoji: emoji ?? '📋',
				parentCardId: parent?.id ?? null,
				createdBy: user.id
			})
			.returning()
			.get();

		// Create default columns
		db.insert(columns)
			.values([
				{ boardId: board.id, title: 'To Do', position: 0, color: '#6366f1' },
				{ boardId: board.id, title: 'On Hold', position: 1, color: '#ef4444' },
				{ boardId: board.id, title: 'In Progress', position: 2, color: '#f59e0b' },
				{ boardId: board.id, title: 'Complete', position: 3, color: '#10b981' }
			])
			.run();

		// Auto-add creator as board owner
		db.insert(boardMembers)
			.values({ boardId: board.id, userId: user.id, role: 'owner' })
			.run();

		logActivity({
			boardId: board.id,
			userId: user.id,
			action: 'api:board_created',
			detail: `Created board "${board.name}"`,
			userName: user.username,
			userEmoji: user.emoji || '👤'
		});

		// A sub-board is drawn on its card, so the pages open on that card's
		// board are told, as `POST /api/boards` tells them (card 2143): neither
		// did, and the sub-board was not seen there until a reload. Nothing is
		// sent for a top-level board.
		if (parent) {
			const parentBoardId = db
				.select({ boardId: columns.boardId })
				.from(columns)
				.where(eq(columns.id, parent.columnId))
				.get()!.boardId;
			emit(parentBoardId, 'update', { type: 'board', action: 'created' });
		}

		// Return the board with its columns
		const boardColumns = db.select().from(columns).where(eq(columns.boardId, board.id)).all();

		return { ...board, columns: boardColumns };
	});

	return json(created, { status: 201 });
};
