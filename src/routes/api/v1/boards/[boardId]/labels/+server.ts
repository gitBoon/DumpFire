import { json } from '$lib/server/v1-json';
import { createLabel, labelsOfBoard } from '$lib/server/labels';
import { pathId, readBody } from '$lib/server/request-body';
import { requireUser } from '$lib/server/route-guards';
import { writeAs } from '$lib/server/write-as';
import type { RequestHandler } from './$types';

/** GET /api/v1/boards/:boardId/labels — List all labels for a board (`labelsOfBoard`, card 2012). */
export const GET: RequestHandler = async ({ params, locals }) => {
	const boardId = pathId(params.boardId, 'board');
	// A board that is not there is 404 to everyone, then one the caller cannot open 403.
	return json(labelsOfBoard(locals.user, { boardId }, {}));
};

/**
 * POST /api/v1/boards/:boardId/labels — Create a new label on a board. The
 * work is `createLabel` in `$lib/server/labels`, which `POST /api/labels`
 * shares (card 2012).
 */
export const POST: RequestHandler = async ({ params, request, locals }) => {
	requireUser(locals.user);
	const boardId = pathId(params.boardId, 'board');
	const body = await readBody(request);

	// The board is looked for and the caller checked in the transaction that
	// adds the label, once the body has arrived. A board that is not there is
	// 404 to everyone: it was 403, and for an administrator a 500. The
	// transaction asks first whether the key or session is still open, and who
	// its account is now (card 2253).
	const label = writeAs(locals, (caller) => createLabel(caller, { boardId }, body, { source: 'api' }));

	return json(label, { status: 201 });
};
