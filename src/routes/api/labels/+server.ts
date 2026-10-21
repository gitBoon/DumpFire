import { json, error } from '@sveltejs/kit';
import { TOGGLE_LABEL_PAGE_OPTIONS, toggleCardLabel } from '$lib/server/card-labels';
import { createLabel, deleteLabel, labelsOfBoard, updateLabel } from '$lib/server/labels';
import { readBody, readQueryId } from '$lib/server/request-body';
import { requireUser } from '$lib/server/route-guards';
import { writeAs } from '$lib/server/write-as';
import type { RequestHandler } from './$types';

// Get all labels for a board (`labelsOfBoard`, which the v1 twin shares, card
// 2012). A `boardId` that is no id is a 400, where `2.5` and `5abc` were read
// as another board or as none (card 2117).
export const GET: RequestHandler = async ({ url, locals }) => {
	if (!locals.user) throw error(401, 'Not authenticated');

	const boardId = readQueryId(url.searchParams.get('boardId'), 'board', 'Invalid boardId');
	if (boardId === undefined) return json([]);

	return json(labelsOfBoard(locals.user, { boardId }, {}));
};

/**
 * Create a new label. `boardId` names the row guarded, so it is read first;
 * then `name` and `color`. A label with no name was a 500, and any colour was
 * stored. The work is `createLabel` in `$lib/server/labels`, which the v1
 * route shares (card 2012).
 *
 * Each write of this file asks first, in its transaction, whether the session
 * is still open, and who its account is now (card 2253).
 */
export const POST: RequestHandler = async ({ request, locals }) => {
	requireUser(locals.user);
	const body = await readBody(request);

	const label = writeAs(locals, (caller) => createLabel(caller, {}, body, { source: 'ui' }));
	return json(label, { status: 201 });
};

/**
 * Rename or recolour a label, as the card window's label picker does (card
 * 2010). Body: `{ id, name?, color? }`. A page cannot call
 * `PUT /api/v1/labels/{labelId}`, which needs an API key, so this is the
 * session's own.
 *
 * The label is looked for and the caller checked first (400 for an id that is
 * no id, 404, then 403: edit access to the label's own board), then the
 * fields are read (400), in the transaction that writes them. A body that
 * names neither field is `400 Send name or color to change`, this route's
 * words (`sendNameOrColor`). Open pages are told after the commit. No
 * activity entry is written, as no label route writes one. The work is
 * `updateLabel` in `$lib/server/labels`, which the v1 route shares (card 2012).
 */
export const PATCH: RequestHandler = async ({ request, locals }) => {
	requireUser(locals.user);
	const body = await readBody(request);

	const updated = writeAs(locals, (caller) => updateLabel(caller, {}, body, { source: 'ui', sendNameOrColor: true }));
	return json(updated);
};

/**
 * Toggle a label on a card. `cardId` and `labelId` are ids (card 2117): one
 * that was not was read with `Number()`, and looked for as a card or a label.
 * The work is `toggleCardLabel` in `$lib/server/card-labels`, beside v1's add
 * and remove (card 2012), with that module's `TOGGLE_LABEL_PAGE_OPTIONS`
 * (`{ source: 'ui' }`), which a new card's labels are put on with too (card 2296).
 */
export const PUT: RequestHandler = async ({ request, locals }) => {
	requireUser(locals.user);
	const body = await readBody(request);

	const toggled = writeAs(locals, (caller) => toggleCardLabel(caller, {}, body, TOGGLE_LABEL_PAGE_OPTIONS));
	return json({ toggled });
};

/** Delete a label. Body: `{ id }`, an id (card 2117). The work is `deleteLabel` in `$lib/server/labels` (card 2012). */
export const DELETE: RequestHandler = async ({ request, locals }) => {
	requireUser(locals.user);
	const body = await readBody(request);

	writeAs(locals, (caller) => deleteLabel(caller, {}, body, { source: 'ui' }));
	return json({ success: true });
};
