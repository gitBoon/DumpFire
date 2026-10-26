import { json } from '$lib/server/v1-json';
import { convertColumnFor } from '$lib/server/columns';
import { pathId, readBody } from '$lib/server/request-body';
import { requireUser } from '$lib/server/route-guards';
import { writeAs } from '$lib/server/write-as';
import type { RequestHandler } from './$types';

/**
 * POST /api/v1/columns/:columnId/convert — make a column the board's Options
 * column, cards and all (milestone 22, ruling i). Body `{ role: "options",
 * cards }`, `cards` being how many cards, live and archived, the column was
 * seen to hold. The work, its refusals and its one activity entry are
 * `convertColumnFor` in `$lib/server/columns`, which `POST
 * /api/columns/:id/convert` shares.
 */
export const POST: RequestHandler = async ({ params, request, locals }) => {
	requireUser(locals.user);
	const columnId = pathId(params.columnId, 'column');
	const body = await readBody(request);

	// One transaction, which asks first whether the key or session is still
	// open, and who its account is now (card 2253).
	const converted = writeAs(locals, (caller) => convertColumnFor(caller, { columnId }, body, { source: 'api' }));

	return json(converted);
};
