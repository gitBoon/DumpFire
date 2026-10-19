import { error } from '@sveltejs/kit';
import { json } from '$lib/server/v1-json';
import { deleteLabel, updateLabel } from '$lib/server/labels';
import { pathId, readBody } from '$lib/server/request-body';
import { requireLabel, requireUser } from '$lib/server/route-guards';
import { writeAs } from '$lib/server/write-as';
import type { RequestHandler } from './$types';

/**
 * GET /api/v1/labels/:labelId — Get a single label. A label that is not
 * there is 404, then one on a board the caller cannot open 403
 * (`requireLabel`, in the words its own lookup had).
 */
export const GET: RequestHandler = async ({ params, locals }) => {
	if (!locals.user) throw error(401, 'Not authenticated');

	const labelId = pathId(params.labelId, 'label');

	return json(requireLabel(locals.user, labelId, 'view').label);
};

/** PUT /api/v1/labels/:labelId — Update a label (`updateLabel`, which `PATCH /api/labels` shares, card 2012). */
export const PUT: RequestHandler = async ({ params, request, locals }) => {
	requireUser(locals.user);
	const labelId = pathId(params.labelId, 'label');
	const body = await readBody(request);

	// The label is read and the caller checked in the transaction that changes
	// it, once the body has arrived: someone taken off the board while the
	// body was arriving is refused, and a label deleted meanwhile is 404, where
	// the update found nothing and answered 200 with no body. The transaction
	// asks first whether the key or session is still open, and who its account
	// is now (card 2253).
	const updated = writeAs(locals, (caller) => updateLabel(caller, { labelId }, body, { source: 'api' }));

	return json(updated);
};

/** DELETE /api/v1/labels/:labelId — Delete a label (`deleteLabel`, card 2012). */
export const DELETE: RequestHandler = async ({ params, locals }) => {
	requireUser(locals.user);

	const labelId = pathId(params.labelId, 'label');

	// The label read, the caller checked and the label deleted in one
	// transaction that asks first whether the key or session is still open, and
	// who its account is now (card 2253). The live update waits for the
	// commit.
	writeAs(locals, (caller) => deleteLabel(caller, { labelId }, null, { source: 'api' }));

	return json({ success: true });
};
