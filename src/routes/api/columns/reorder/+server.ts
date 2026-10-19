import { json } from '@sveltejs/kit';
import { db } from '$lib/server/db';
import { columns } from '$lib/server/db/schema';
import { eq } from 'drizzle-orm';
import { emit } from '$lib/server/events';
import { readBody, readId, readNumber, readObjects } from '$lib/server/request-body';
import { requireColumn, requireUser } from '$lib/server/route-guards';
import { writeAs } from '$lib/server/write-as';
import type { RequestHandler } from './$types';

/**
 * PUT /api/columns/reorder — save the order of a board's columns.
 *
 * Body: `{ updates: [{ id, position }] }`. Each entry is an object, its `id`
 * an id and its `position` a number (card 2117): `updates[<n>].position must
 * be a number`. Text was stored as a position, a missing one was a 500, and an
 * entry that was not an object was a 500.
 */
export const PUT: RequestHandler = async ({ request, locals }) => {
	requireUser(locals.user);
	const body = await readBody(request);

	const updates = readObjects(body, 'updates', {
		required: true,
		says: { missing: 'updates must be an array', type: 'updates must be an array' }
	});

	// One transaction from the first check to the last write: every column
	// gets its new position or none does, and a board is told only once they
	// all have. A write that failed half way used to leave the columns in an
	// order nobody had asked for. It asks first whether the session is still
	// open, and who its account is now (card 2253).
	writeAs(locals, (caller) => {
		const user = requireUser(caller);
		// Every column is looked up and checked before anything is written. The
		// body's `boardId` is ignored: it used to be the only thing checked, and
		// with it left out any signed-in user could reorder any board's columns.
		const boardIds = new Set<number>();
		const ids = updates.map((update, i) => readId(update, 'id', { required: true, says: `updates[${i}].id must be an id` }));
		for (const id of ids) boardIds.add(requireColumn(user, id, 'edit').boardId);

		// Then each position, once every column is known to be the caller's.
		const positions = updates.map((update, i) =>
			readNumber(update, 'position', { required: true, says: `updates[${i}].position must be a number` })
		);

		for (const [i, id] of ids.entries()) {
			db.update(columns).set({ position: positions[i] }).where(eq(columns.id, id)).run();
		}
		for (const boardId of boardIds) emit(boardId, 'update', { type: 'column' });
	});
	return json({ success: true });
};
