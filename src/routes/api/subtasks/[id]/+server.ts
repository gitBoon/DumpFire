import { json } from '@sveltejs/kit';
import { requireUser } from '$lib/server/route-guards';
import { linkBaseUrl } from '$lib/server/email';
import { deleteSubtask, updateSubtask } from '$lib/server/subtasks';
import { pathId, readBody } from '$lib/server/request-body';
import { writeAs } from '$lib/server/write-as';
import type { RequestHandler } from './$types';

/**
 * PUT /api/subtasks/:id — change a subtask, and tick it off or on.
 *
 * The subtask is looked for and the caller checked (404, then 403), then
 * every field is read (card 2117), as `PUT /api/v1/subtasks/:subtaskId` reads
 * them: `title` text, trimmed, of 1 to 500 characters; `description` at most
 * 50,000; `priority` one of the four; `colorTag` a colour written `#rrggbb`
 * or empty; `dueDate` a date written `YYYY-MM-DD`, or null; `completed` true
 * or false; `position` a number. A value the subtask already holds, sent back
 * unchanged, is accepted as it is (decision 8). Nothing else is written: the
 * whole body once was, so a caller could set `cardId` and move a subtask onto
 * a card on a board they could not open.
 *
 * `completed: "false"` was stored as true, with the completion's entry and
 * notices left out.
 */
export const PUT: RequestHandler = async ({ params, request, locals, url }) => {
	requireUser(locals.user);
	const id = pathId(params.id, 'subtask');

	const body = await readBody(request);
	const baseUrl = linkBaseUrl(url);

	// One transaction: the update, the activity entry and the "Unblocked"
	// notices are saved together or not at all. The subtask is read in here and
	// not before the body was awaited, where two requests ticking the same
	// subtask both found it open and both wrote a notice. So is the caller: the
	// session is asked again, and who its account is now (card 2253). The work
	// is `updateSubtask` in `$lib/server/subtasks`, which the v1 route shares
	// (card 2012): this route tells the board as `subtask`, straight after the
	// write.
	const updated = writeAs(locals, (caller) =>
		updateSubtask(caller, { subtaskId: id }, body, { source: 'ui', baseUrl, tellBeforeEntry: true, eventType: 'subtask' })
	);

	return json(updated);
};

export const DELETE: RequestHandler = async ({ params, locals }) => {
	const id = pathId(params.id, 'subtask');

	// One transaction: the subtask's dependency links, the subtask and the
	// activity entry go together or not at all. A failure after the first used
	// to leave the subtask in place with its links gone. It asks first whether
	// the session is still open, and who its account is now (card 2253). The
	// work is `deleteSubtask`, which the v1 route shares (card 2012).
	writeAs(locals, (caller) => deleteSubtask(caller, { subtaskId: id }, null, { source: 'ui', eventType: 'subtask' }));
	return json({ success: true });
};
