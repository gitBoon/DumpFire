/**
 * Session-authenticated milestone list/create for the planning view and the
 * card modal. Same rules as /api/v1/milestones — both call into
 * $lib/server/milestones — only the auth differs.
 */
import { json, error } from '@sveltejs/kit';
import { listMilestones, milestonesForBoard } from '$lib/server/milestones';
import { createMilestoneFor } from '$lib/server/milestone-service';
import { pathId, readBody, readQueryId } from '$lib/server/request-body';
import { requireUser } from '$lib/server/route-guards';
import { writeAs } from '$lib/server/write-as';
import type { RequestHandler } from './$types';

export const GET: RequestHandler = async ({ url, locals }) => {
	if (!locals.user) throw error(401, 'Not authenticated');

	// `?forBoard=` is the card modal asking "which goals can this card join",
	// which is a different question from "list the goals on this board".
	// Each is an id, as an id in the path is read (card 2117): `2.5` and `5abc`
	// were read as another board, or as none.
	const forBoard = url.searchParams.get('forBoard');
	if (forBoard !== null) {
		return json(milestonesForBoard(locals.user, pathId(forBoard, 'board', 'Invalid forBoard')));
	}

	const boardId = readQueryId(url.searchParams.get('boardId'), 'board', 'Invalid boardId');

	// `open` or `closed`, as the v1 twin reads it: any other text matched no
	// milestone, and was an empty list (card 2117).
	const status = url.searchParams.get('status') ?? undefined;
	if (status && !['open', 'closed'].includes(status)) {
		throw error(400, 'status must be open or closed');
	}
	return json(listMilestones(locals.user, boardId, status));
};

/**
 * POST /api/milestones — make a milestone, as `POST /api/v1/milestones` does.
 *
 * `boardId` is read first, because it says whose milestone this is: the
 * board is looked for and the caller checked (404, then 403), and then the
 * other fields are read (card 2117, R1). A milestone of no board has nothing
 * to guard. `name` is text, trimmed, of 1 to 200 characters; `description`
 * text of at most 50,000; `targetDate` a date written `YYYY-MM-DD`, or null.
 *
 * The work, with the entry `POST /api/v1/milestones` writes too (card 2143),
 * is `createMilestoneFor` in `$lib/server/milestone-service` (card 2012).
 */
export const POST: RequestHandler = async ({ request, locals }) => {
	requireUser(locals.user);
	const body = await readBody(request);
	// Asked first: whether the session is still open, and who its account
	// is now (card 2253).
	const created = writeAs(locals, (caller) => createMilestoneFor(caller, {}, body, { source: 'ui' }));
	return json(created, { status: 201 });
};
