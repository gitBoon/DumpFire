import { json } from '@sveltejs/kit';
import { createColumn } from '$lib/server/columns';
import { readBody } from '$lib/server/request-body';
import { requireUser } from '$lib/server/route-guards';
import { writeAs } from '$lib/server/write-as';
import type { RequestHandler } from './$types';

/**
 * POST /api/columns — add a column to a board.
 *
 * `boardId` is read first, because it names the row guarded: the board is
 * looked for and the caller checked (404, then 403), and then the other
 * fields are read (card 2117, R1): `title` text, trimmed, of 1 to 200
 * characters; `position` a number; `color` a colour written `#rrggbb`. A
 * title that was missing gave "New Column", text was stored as a position,
 * and any colour was stored. A column sent with no position goes at 0, as it
 * did (R2 of card 2012's plan; v1 puts it after the last).
 *
 * The work is `createColumn` in `$lib/server/columns`, which the v1 route
 * shares (card 2012).
 */
export const POST: RequestHandler = async ({ request, locals }) => {
	requireUser(locals.user);
	const body = await readBody(request);

	// The session is asked again, and who its account is now, in the
	// transaction that adds the column (card 2253).
	const column = writeAs(locals, (caller) => createColumn(caller, {}, body, { source: 'ui' }));
	return json(column, { status: 201 });
};
