import { error } from '@sveltejs/kit';
import { json } from '$lib/server/v1-json';
import { inTransaction } from '$lib/server/db/transaction';
import { listMilestones, createMilestone, requireMilestoneBoard, MilestoneError } from '$lib/server/milestones';
import { logActivity } from '$lib/server/logActivity';
import { readBody, readDate, readId, readQueryId, readText } from '$lib/server/request-body';
import { requireUser } from '$lib/server/route-guards';
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

	const status = url.searchParams.get('status') ?? undefined;
	if (status && !['open', 'closed'].includes(status)) {
		throw error(400, 'status must be open or closed');
	}

	// An id, as an id in the path is read: `2.5` and `5abc` named no board.
	const boardId = readQueryId(url.searchParams.get('boardId'), 'board', 'Invalid boardId');

	return json(listMilestones(locals.user, boardId, status));
};

/**
 * POST /api/v1/milestones — create a milestone.
 *
 * Body: `{ name, boardId?, description?, targetDate? }`. Omit `boardId` (or
 * send null) for a goal that spans several boards.
 *
 * `boardId` is read first, because it says whose milestone this is: the
 * board is looked for and the caller checked (404, then 403), and then the
 * other fields are read (400). A milestone of no board has nothing to guard.
 * `name` is text, trimmed, of 1 to 200 characters; `description` text of at
 * most 50,000; `targetDate` a date written `YYYY-MM-DD`, or null.
 */
export const POST: RequestHandler = async ({ request, locals }) => {
	const user = requireUser(locals.user);
	const body = await readBody(request);
	try {
		// One transaction: the board is read and the caller checked in the one
		// that creates the milestone and writes its entry.
		const created = inTransaction(() => {
			const boardId = readId(body, 'boardId', { nullable: true }) ?? null;
			if (boardId !== null) requireMilestoneBoard(user, boardId);

			const name = readText(body, 'name', {
				required: true,
				trim: true,
				min: 1,
				max: 200,
				says: { missing: 'name is required', empty: 'name is required', invalid: 'name too long (max 200 chars)' }
			});
			const description = readText(body, 'description', { max: 50000 });
			const targetDate = readDate(body, 'targetDate', { nullable: true });

			const created = createMilestone(user, { name, boardId, description, targetDate });

			if (created.boardId !== null) {
				logActivity({
					boardId: created.boardId,
					userId: user.id,
					action: 'api:milestone_created',
					detail: `Created milestone "${created.name}"`,
					userName: user.username,
					userEmoji: user.emoji || '👤'
				});
			}

			return created;
		});

		return json(created, { status: 201 });
	} catch (e) {
		if (e instanceof MilestoneError) throw error(e.status, e.message);
		throw e;
	}
};
