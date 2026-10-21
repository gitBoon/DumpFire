import { redirect } from '@sveltejs/kit';
import { listMilestones } from '$lib/server/milestones';
import { db } from '$lib/server/db';
import { boards } from '$lib/server/db/schema';
import { and, asc, inArray, isNull } from 'drizzle-orm';
import { getAccessibleBoardIds } from '$lib/server/board-access';
import { readQueryIdOrNone } from '$lib/server/request-body';
import type { PageServerLoad } from './$types';

export const load: PageServerLoad = async ({ locals, url }) => {
	if (!locals.user) throw redirect(303, '/login');

	const accessible = getAccessibleBoardIds(locals.user);
	// The caller's top-level boards, in the order of their ids, as the table
	// gave them; every one for an administrator; none read for a caller with
	// none (card 2400). The whole table was read and each looked for in the list.
	const topBoards =
		accessible === null
			? db.select().from(boards).where(isNull(boards.parentCardId)).all()
			: accessible.length === 0
				? []
				: db
						.select()
						.from(boards)
						.where(and(isNull(boards.parentCardId), inArray(boards.id, accessible)))
						.orderBy(asc(boards.id))
						.all();

	// `?board=` arrives from a board's Planning button. 'touching' rather than
	// 'scoped' so a cross-board goal that this board is half of still shows —
	// that goal is exactly what was being asked about, and hiding it because it
	// also covers another project would make the filter lie.
	// A value that is no board id (`2.5`, `abc`, `0`) is no filter, as a board
	// the caller cannot open is: the page shows every goal rather than a 400 for
	// a hand-edited link. `Number` let `2.5` and `0` through, and an
	// administrator was shown no goal and no word why (card 2403).
	const boardId = readQueryIdOrNone(url.searchParams.get('board'));
	const filterBoard =
		boardId !== undefined && (accessible === null || accessible.includes(boardId))
			? boardId
			: undefined;

	return {
		user: locals.user,
		filterBoard: filterBoard ?? null,
		filterBoardName: filterBoard === undefined ? null : (topBoards.find((b) => b.id === filterBoard)?.name ?? null),
		// The boards read above, handed on: the list read them again (card 2399).
		milestones: listMilestones(locals.user, filterBoard, undefined, 'touching', accessible),
		// Offered in the "new milestone" form; a goal can also be cross-board,
		// which is the default because that is the case the Kanban cannot express.
		boards: topBoards.map((b) => ({ id: b.id, name: b.name, emoji: b.emoji ?? '📋' }))
	};
};
