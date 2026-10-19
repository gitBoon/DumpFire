import { error } from '@sveltejs/kit';
import { json } from '$lib/server/v1-json';
import { db } from '$lib/server/db';
import { labels } from '$lib/server/db/schema';
import { eq } from 'drizzle-orm';
import { canViewBoard, canEditBoard } from '$lib/server/board-access';
import { emit } from '$lib/server/events';
import { inTransaction } from '$lib/server/db/transaction';
import { pathId, readBody, readColour, readText } from '$lib/server/request-body';
import { requireLabel, requireUser } from '$lib/server/route-guards';
import type { RequestHandler } from './$types';

/** GET /api/v1/labels/:labelId — Get a single label. */
export const GET: RequestHandler = async ({ params, locals }) => {
	if (!locals.user) throw error(401, 'Not authenticated');

	const labelId = pathId(params.labelId, 'label');

	const label = db.select().from(labels).where(eq(labels.id, labelId)).get();
	if (!label) throw error(404, 'Label not found');

	if (!canViewBoard(locals.user, label.boardId)) {
		throw error(403, 'No access to this board');
	}

	return json(label);
};

/** PUT /api/v1/labels/:labelId — Update a label. */
export const PUT: RequestHandler = async ({ params, request, locals }) => {
	const user = requireUser(locals.user);
	const labelId = pathId(params.labelId, 'label');
	const body = await readBody(request);

	// The label is read and the caller checked in the transaction that changes
	// it, once the body has arrived: someone taken off the board while the
	// body was arriving is refused, and a label deleted meanwhile is 404, where
	// the update found nothing and answered 200 with no body.
	const updated = inTransaction(() => {
		const { label, boardId } = requireLabel(user, labelId, 'edit');

		const updates: Partial<typeof labels.$inferInsert> = {};
		const name = readText(body, 'name', {
			trim: true,
			min: 1,
			max: 200,
			keep: label.name,
			says: { empty: 'name cannot be empty' }
		});
		if (name !== undefined) updates.name = name;
		const color = readColour(body, 'color', { keep: label.color });
		if (color !== undefined) updates.color = color;

		if (Object.keys(updates).length === 0) {
			throw error(400, 'No valid fields to update');
		}

		const row = db.update(labels)
			.set(updates)
			.where(eq(labels.id, labelId))
			.returning()
			.get();

		emit(boardId, 'update', { type: 'label' });
		return row;
	});

	return json(updated);
};

/** DELETE /api/v1/labels/:labelId — Delete a label. */
export const DELETE: RequestHandler = async ({ params, locals }) => {
	if (!locals.user) throw error(401, 'Not authenticated');

	const labelId = pathId(params.labelId, 'label');

	const label = db.select().from(labels).where(eq(labels.id, labelId)).get();
	if (!label) throw error(404, 'Label not found');

	if (!canEditBoard(locals.user, label.boardId)) {
		throw error(403, 'No edit access to this board');
	}

	db.delete(labels).where(eq(labels.id, labelId)).run();
	emit(label.boardId, 'update', { type: 'label' });

	return json({ success: true });
};
