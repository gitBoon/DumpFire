import { json, error } from '@sveltejs/kit';
import { db } from '$lib/server/db';
import { webhooks, columns } from '$lib/server/db/schema';
import { eq } from 'drizzle-orm';
import { canEditBoard, canViewBoard } from '$lib/server/board-access';
import type { RequestHandler } from './$types';

/** GET /api/v1/webhooks/:webhookId — Get a single webhook. */
export const GET: RequestHandler = async ({ params, locals }) => {
	if (!locals.user) throw error(401, 'Not authenticated');

	const hook = db.select().from(webhooks)
		.where(eq(webhooks.id, Number(params.webhookId)))
		.get();
	if (!hook) throw error(404, 'Webhook not found');

	if (!canViewBoard(locals.user, hook.boardId)) throw error(403, 'No access');

	return json({ ...hook, events: JSON.parse(hook.events || '[]') });
};

/** PUT /api/v1/webhooks/:webhookId — Update a webhook. */
export const PUT: RequestHandler = async ({ params, request, locals }) => {
	if (!locals.user) throw error(401, 'Not authenticated');

	const hook = db.select().from(webhooks)
		.where(eq(webhooks.id, Number(params.webhookId)))
		.get();
	if (!hook) throw error(404, 'Webhook not found');

	if (!canEditBoard(locals.user, hook.boardId)) throw error(403, 'No edit access');

	const body = await request.json();
	const updates: Record<string, unknown> = {};
	if (body.url !== undefined) updates.url = body.url.trim();
	if (body.secret !== undefined) updates.secret = body.secret;
	if (body.events !== undefined) updates.events = JSON.stringify(body.events);
	if (body.active !== undefined) updates.active = body.active;

	if (Object.keys(updates).length === 0) throw error(400, 'No fields to update');

	db.update(webhooks)
		.set(updates)
		.where(eq(webhooks.id, Number(params.webhookId)))
		.run();

	const updated = db.select().from(webhooks)
		.where(eq(webhooks.id, Number(params.webhookId)))
		.get()!;

	return json({ ...updated, events: JSON.parse(updated.events || '[]') });
};

/** DELETE /api/v1/webhooks/:webhookId — Delete a webhook. */
export const DELETE: RequestHandler = async ({ params, locals }) => {
	if (!locals.user) throw error(401, 'Not authenticated');

	const hook = db.select().from(webhooks)
		.where(eq(webhooks.id, Number(params.webhookId)))
		.get();
	if (!hook) throw error(404, 'Webhook not found');

	if (!canEditBoard(locals.user, hook.boardId)) throw error(403, 'No edit access');

	db.delete(webhooks)
		.where(eq(webhooks.id, Number(params.webhookId)))
		.run();

	return json({ success: true });
};
