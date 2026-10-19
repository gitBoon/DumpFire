import { json } from '@sveltejs/kit';
import { db } from '$lib/server/db';
import { columns } from '$lib/server/db/schema';
import { emit } from '$lib/server/events';
import { readBody, readColour, readId, readNumber, readText } from '$lib/server/request-body';
import { requireBoard, requireUser } from '$lib/server/route-guards';
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
 * and any colour was stored.
 */
export const POST: RequestHandler = async ({ request, locals }) => {
	requireUser(locals.user);
	const body = await readBody(request);

	// The session is asked again, and who its account is now, in the
	// transaction that adds the column (card 2253).
	const column = writeAs(locals, (caller) => {
		const user = requireUser(caller);
		// The body's board id is the board the column is being added to, so it is
		// the right one to check — and it has to exist.
		const boardId = requireBoard(user, readId(body, 'boardId', { required: true, says: 'Invalid board ID' }), 'edit').id;

		const title = readText(body, 'title', {
			required: true,
			trim: true,
			min: 1,
			max: 200,
			says: { missing: 'title is required', empty: 'title is required' }
		});
		const position = readNumber(body, 'position', {});
		const color = readColour(body, 'color', {});

		const column = db
			.insert(columns)
			.values({
				boardId,
				title,
				position: position ?? 0,
				color: color ?? '#6366f1'
			})
			.returning()
			.get();
		emit(boardId, 'update', { type: 'column' });
		return column;
	});
	return json(column, { status: 201 });
};
