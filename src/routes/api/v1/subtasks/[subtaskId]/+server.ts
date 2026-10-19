import { json } from '$lib/server/v1-json';
import { linkBaseUrl } from '$lib/server/email';
import { deleteSubtask, updateSubtask } from '$lib/server/subtasks';
import { pathId, readBody } from '$lib/server/request-body';
import { requireUser } from '$lib/server/route-guards';
import { writeAs } from '$lib/server/write-as';
import type { RequestHandler } from './$types';

/**
 * This tree's words for a caller who may not edit the subtask's board, which
 * it keeps (card 2012, R2): the update and the delete hand them to the service.
 */
const NO_EDIT = "No edit access to this subtask's board";

/**
 * PUT /api/v1/subtasks/:subtaskId — Update a subtask.
 *
 * The subtask is looked for and the caller checked (404, then 403), then
 * every field is read (400). A value the subtask already holds, sent back
 * unchanged, is accepted as it is (decision 8).
 *
 * A tick records what `PUT /api/subtasks/:id` records (card 2108): an
 * `api:subtask_completed` entry, `<subtask> (on <card>)`, and a mail to
 * whoever asked for the card. Through this route it wrote neither, so the
 * activity report and the audit log did not show it.
 */
export const PUT: RequestHandler = async ({ params, request, url, locals }) => {
	requireUser(locals.user);
	const subtaskId = pathId(params.subtaskId, 'subtask');
	const body = await readBody(request);
	const baseUrl = linkBaseUrl(url);

	// One transaction: the update and the "Unblocked" notices are saved
	// together or not at all. The subtask is read in here and not before the
	// body was awaited, where two requests ticking the same subtask both found
	// it open and both wrote a notice. It asks first whether the key or session
	// is still open, and who its account is now (card 2253). The work is
	// `updateSubtask` in `$lib/server/subtasks`, which the internal route
	// shares (card 2012): this route tells the board as `card`, last.
	const updated = writeAs(locals, (caller) =>
		updateSubtask(caller, { subtaskId }, body, { source: 'api', baseUrl, says: NO_EDIT, eventType: 'card' })
	);

	return json(updated);
};

/**
 * DELETE /api/v1/subtasks/:subtaskId — Delete a subtask permanently.
 *
 * Writes `api:subtask_deleted` with the subtask's title, as
 * `DELETE /api/subtasks/:id` writes `subtask_deleted` (card 2108). It wrote
 * no entry.
 */
export const DELETE: RequestHandler = async ({ params, locals }) => {
	requireUser(locals.user);
	const subtaskId = pathId(params.subtaskId, 'subtask');

	// One transaction: the subtask's dependency links, the subtask and the
	// activity entry go together or not at all. A failure between the first
	// two used to leave the subtask in place with its links gone. It asks first
	// whether the key or session is still open, and who its account is now
	// (card 2253). The work is `deleteSubtask`, which the internal route shares
	// (card 2012).
	writeAs(locals, (caller) => deleteSubtask(caller, { subtaskId }, null, { source: 'api', says: NO_EDIT, eventType: 'card' }));

	return json({ success: true });
};
