import { json, error } from '@sveltejs/kit';
import { listMilestones, createMilestone, MilestoneError } from '$lib/server/milestones';
import { logActivity } from '$lib/server/logActivity';
import type { RequestHandler } from './$types';

/**
 * GET /api/v1/milestones — list milestones the caller can see.
 *
 * `?boardId=` limits to one board's milestones; `?status=open|closed` filters.
 * Cross-board milestones (boardId null) are always included unless a boardId
 * filter is given, because that is the case the filter is asking about.
 */
export const GET: RequestHandler = async ({ url, locals }) => {
	if (!locals.user) throw error(401, 'Not authenticated');

	const boardIdParam = url.searchParams.get('boardId');
	const status = url.searchParams.get('status') ?? undefined;
	if (status && !['open', 'closed'].includes(status)) {
		throw error(400, 'status must be open or closed');
	}

	const boardId = boardIdParam === null ? undefined : Number(boardIdParam);
	if (boardId !== undefined && isNaN(boardId)) throw error(400, 'Invalid boardId');

	return json(listMilestones(locals.user, boardId, status));
};

/**
 * POST /api/v1/milestones — create a milestone.
 *
 * Body: `{ name, boardId?, description?, targetDate? }`. Omit `boardId` (or
 * send null) for a goal that spans several boards.
 */
export const POST: RequestHandler = async ({ request, locals }) => {
	if (!locals.user) throw error(401, 'Not authenticated');

	const body = await request.json();
	try {
		const created = createMilestone(locals.user, {
			name: body.name,
			boardId: body.boardId ?? null,
			description: body.description,
			targetDate: body.targetDate
		});

		if (created.boardId !== null) {
			logActivity({
				boardId: created.boardId,
				userId: locals.user.id,
				action: 'api:milestone_created',
				detail: `Created milestone "${created.name}"`,
				userName: locals.user.username,
				userEmoji: locals.user.emoji || '👤'
			});
		}

		return json(created, { status: 201 });
	} catch (e) {
		if (e instanceof MilestoneError) throw error(e.status, e.message);
		throw e;
	}
};
