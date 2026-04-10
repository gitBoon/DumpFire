import { json, error } from '@sveltejs/kit';
import { db } from '$lib/server/db';
import { labels } from '$lib/server/db/schema';
import { eq } from 'drizzle-orm';
import { canViewBoard, canEditBoard } from '$lib/server/board-access';
import { emit } from '$lib/server/events';
import type { RequestHandler } from './$types';

/** GET /api/v1/labels/:labelId — Get a single label. */
export const GET: RequestHandler = async ({ params, locals }) => {
	if (!locals.user) throw error(401, 'Not authenticated');

	const labelId = Number(params.labelId);
	if (isNaN(labelId)) throw error(400, 'Invalid label ID');

	const label = db.select().from(labels).where(eq(labels.id, labelId)).get();
	if (!label) throw error(404, 'Label not found');

	if (!canViewBoard(locals.user, label.boardId)) {
		throw error(403, 'No access to this board');
	}

	return json(label);
};

/** PUT /api/v1/labels/:labelId — Update a label. */
export const PUT: RequestHandler = async ({ params, request, locals }) => {
	if (!locals.user) throw error(401, 'Not authenticated');

	const labelId = Number(params.labelId);
	if (isNaN(labelId)) throw error(400, 'Invalid label ID');

	const label = db.select().from(labels).where(eq(labels.id, labelId)).get();
	if (!label) throw error(404, 'Label not found');

	if (!canEditBoard(locals.user, label.boardId)) {
		throw error(403, 'No edit access to this board');
	}

	const body = await request.json();
	const updates: Record<string, unknown> = {};

	if ('name' in body) {
		if (!body.name || !String(body.name).trim()) throw error(400, 'name cannot be empty');
		if (String(body.name).length > 200) throw error(400, 'Label name too long (max 200 chars)');
		updates.name = String(body.name).trim();
	}
	if ('color' in body) {
		updates.color = body.color;
	}

	if (Object.keys(updates).length === 0) {
		throw error(400, 'No valid fields to update');
	}

	const updated = db.update(labels)
		.set(updates)
		.where(eq(labels.id, labelId))
		.returning()
		.get();

	emit(label.boardId, 'update', { type: 'label' });

	return json(updated);
};

/** DELETE /api/v1/labels/:labelId — Delete a label. */
export const DELETE: RequestHandler = async ({ params, locals }) => {
	if (!locals.user) throw error(401, 'Not authenticated');

	const labelId = Number(params.labelId);
	if (isNaN(labelId)) throw error(400, 'Invalid label ID');

	const label = db.select().from(labels).where(eq(labels.id, labelId)).get();
	if (!label) throw error(404, 'Label not found');

	if (!canEditBoard(locals.user, label.boardId)) {
		throw error(403, 'No edit access to this board');
	}

	db.delete(labels).where(eq(labels.id, labelId)).run();
	emit(label.boardId, 'update', { type: 'label' });

	return json({ success: true });
};
