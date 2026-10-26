import { json } from '@sveltejs/kit';
import { convertColumnFor } from '$lib/server/columns';
import { pathId, readBody } from '$lib/server/request-body';
import { requireUser } from '$lib/server/route-guards';
import { writeAs } from '$lib/server/write-as';
import type { RequestHandler } from './$types';

/**
 * POST /api/columns/:id/convert — make a column the board's Options column,
 * cards and all, once the page has asked (milestone 22, ruling i).
 *
 * Body: `{ role: "options", cards }`, `cards` being how many cards, live and
 * archived, the page's question named. Only the board's owner or an
 * administrator may. Every card in the column becomes an option (its
 * commitment is cleared), the column goes to the left of the board with no WIP
 * limit, and one activity entry says how many cards became options. A count
 * that no longer matches, an ideas board, a board that has an Options column,
 * a column called To Do, On Hold or Complete and a card with sub-boards are
 * each 409. The work is `convertColumnFor` in `$lib/server/columns`, which
 * the v1 route shares.
 */
export const POST: RequestHandler = async ({ params, request, locals }) => {
	requireUser(locals.user);
	const id = pathId(params.id, 'column');
	const body = await readBody(request);

	// One transaction: the column read, the caller checked, the count compared
	// and every card changed, which asks first whether the session is still
	// open, and who its account is now (card 2253).
	const converted = writeAs(locals, (caller) => convertColumnFor(caller, { columnId: id }, body, { source: 'ui' }));
	return json(converted);
};
