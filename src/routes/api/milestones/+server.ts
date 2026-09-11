/**
 * Session-authenticated milestone list/create for the planning view and the
 * card modal. Same rules as /api/v1/milestones — both call into
 * $lib/server/milestones — only the auth differs.
 */
import { json, error } from '@sveltejs/kit';
import { listMilestones, createMilestone, milestonesForBoard, MilestoneError } from '$lib/server/milestones';
import type { RequestHandler } from './$types';

export const GET: RequestHandler = async ({ url, locals }) => {
	if (!locals.user) throw error(401, 'Not authenticated');

	// `?forBoard=` is the card modal asking "which goals can this card join",
	// which is a different question from "list the goals on this board".
	const forBoard = url.searchParams.get('forBoard');
	if (forBoard !== null) {
		const boardId = Number(forBoard);
		if (isNaN(boardId)) throw error(400, 'Invalid forBoard');
		return json(milestonesForBoard(locals.user, boardId));
	}

	const boardIdParam = url.searchParams.get('boardId');
	const boardId = boardIdParam === null ? undefined : Number(boardIdParam);
	if (boardId !== undefined && isNaN(boardId)) throw error(400, 'Invalid boardId');

	const status = url.searchParams.get('status') ?? undefined;
	return json(listMilestones(locals.user, boardId, status));
};

export const POST: RequestHandler = async ({ request, locals }) => {
	if (!locals.user) throw error(401, 'Not authenticated');

	const body = await request.json();
	try {
		return json(
			createMilestone(locals.user, {
				name: body.name,
				boardId: body.boardId ?? null,
				description: body.description,
				targetDate: body.targetDate
			}),
			{ status: 201 }
		);
	} catch (e) {
		if (e instanceof MilestoneError) throw error(e.status, e.message);
		throw e;
	}
};
