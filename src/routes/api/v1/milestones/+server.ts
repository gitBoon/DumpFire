import { error } from '@sveltejs/kit';
import { json } from '$lib/server/v1-json';
import { listMilestones } from '$lib/server/milestones';
import { createMilestoneFor } from '$lib/server/milestone-service';
import { readBody, readQueryId } from '$lib/server/request-body';
import { requireUser } from '$lib/server/route-guards';
import { writeAs } from '$lib/server/write-as';
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
 *
 * The work, with its `api:milestone_created` entry, is `createMilestoneFor` in
 * `$lib/server/milestone-service`, which the internal route shares (card 2012).
 */
export const POST: RequestHandler = async ({ request, locals }) => {
	requireUser(locals.user);
	const body = await readBody(request);

	// One transaction: the board is read and the caller checked in the one
	// that creates the milestone and writes its entry, which asks first
	// whether the key or session is still open, and who its account is now
	// (card 2253).
	const created = writeAs(locals, (caller) => createMilestoneFor(caller, {}, body, { source: 'api' }));

	return json(created, { status: 201 });
};
