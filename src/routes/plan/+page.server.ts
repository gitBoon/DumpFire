import { redirect } from '@sveltejs/kit';
import { listMilestones } from '$lib/server/milestones';
import { db } from '$lib/server/db';
import { boards } from '$lib/server/db/schema';
import { isNull } from 'drizzle-orm';
import { getAccessibleBoardIds } from '$lib/server/board-access';
import type { PageServerLoad } from './$types';

export const load: PageServerLoad = async ({ locals, url }) => {
	if (!locals.user) throw redirect(303, '/login');

	const accessible = getAccessibleBoardIds(locals.user);
	const allBoards = db.select().from(boards).where(isNull(boards.parentCardId)).all();

	// `?board=` arrives from a board's Planning button. 'touching' rather than
	// 'scoped' so a cross-board goal that this board is half of still shows —
	// that goal is exactly what was being asked about, and hiding it because it
	// also covers another project would make the filter lie.
	const boardParam = url.searchParams.get('board');
	const boardId = boardParam === null || boardParam === '' ? undefined : Number(boardParam);
	const filterBoard =
		boardId !== undefined && !isNaN(boardId) && (accessible === null || accessible.includes(boardId))
			? boardId
			: undefined;

	return {
		user: locals.user,
		filterBoard: filterBoard ?? null,
		filterBoardName: filterBoard === undefined ? null : (allBoards.find((b) => b.id === filterBoard)?.name ?? null),
		milestones: listMilestones(locals.user, filterBoard, undefined, 'touching'),
		// Offered in the "new milestone" form; a goal can also be cross-board,
		// which is the default because that is the case the Kanban cannot express.
		boards: allBoards
			.filter((b) => accessible === null || accessible.includes(b.id))
			.map((b) => ({ id: b.id, name: b.name, emoji: b.emoji ?? '📋' }))
	};
};
