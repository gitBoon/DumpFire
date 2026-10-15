import { json, error } from '@sveltejs/kit';
import { db } from '$lib/server/db';
import { webhooks } from '$lib/server/db/schema';
import { eq } from 'drizzle-orm';
import { requireBoard, requireUser, type Need } from '$lib/server/route-guards';
import { canSeeWebhookSecret, presentWebhook, storedEvents, WEBHOOK_EVENTS } from '$lib/server/webhooks';
import { inTransaction } from '$lib/server/db/transaction';
import { pathId, readBody, readBoolean, readChoices, readText, readUrl } from '$lib/server/request-body';
import type { SessionUser } from '$lib/server/auth';
import type { RequestHandler } from './$types';

/** The webhook, if the caller may view or edit the board it belongs to. */
function requireWebhook(user: SessionUser | null, webhookId: number, need: Need) {
	const caller = requireUser(user);
	if (!Number.isInteger(webhookId)) throw error(400, 'Invalid webhook ID');

	const hook = db.select().from(webhooks).where(eq(webhooks.id, webhookId)).get();
	if (!hook) throw error(404, 'Webhook not found');

	requireBoard(caller, hook.boardId, need);
	return { hook, reveal: canSeeWebhookSecret(caller, hook.boardId) };
}

/**
 * GET /api/v1/webhooks/:webhookId — Get a single webhook.
 *
 * The signing secret and the address are included only for the board's owner
 * or an administrator (the address since card 2133).
 */
export const GET: RequestHandler = async ({ params, locals }) => {
	const { hook, reveal } = requireWebhook(locals.user, pathId(params.webhookId, 'webhook'), 'view');
	return json(presentWebhook(hook, reveal));
};

/**
 * PUT /api/v1/webhooks/:webhookId — Update a webhook.
 *
 * Answered as a read is: an editor who is not the board's owner is not given
 * the secret or the address, even one they have just sent.
 */
export const PUT: RequestHandler = async ({ params, request, locals }) => {
	const user = requireUser(locals.user);
	const webhookId = pathId(params.webhookId, 'webhook');
	const body = await readBody(request);

	// The webhook is read and the caller checked in the transaction that
	// changes it, once the body has arrived. A webhook deleted meanwhile is
	// 404: the update found nothing, and the answer was a 500.
	const { updated, reveal } = inTransaction(() => {
		const { hook, reveal } = requireWebhook(user, webhookId, 'edit');

		const updates: Partial<typeof webhooks.$inferInsert> = {};
		const url = readUrl(body, 'url', { keep: hook.url });
		if (url !== undefined) updates.url = url;
		const secret = readText(body, 'secret', { max: 256, keep: hook.secret });
		if (secret !== undefined) updates.secret = secret;
		// Each name trimmed; an empty list is every event.
		const events = readChoices(body, 'events', { from: WEBHOOK_EVENTS, trim: true, keep: storedEvents(hook.events) });
		if (events !== undefined) updates.events = JSON.stringify(events);
		const active = readBoolean(body, 'active', { keep: hook.active });
		if (active !== undefined) updates.active = active;

		if (Object.keys(updates).length === 0) throw error(400, 'No fields to update');

		const row = db.update(webhooks)
			.set(updates)
			.where(eq(webhooks.id, webhookId))
			.returning()
			.get();
		return { updated: row, reveal };
	});

	return json(presentWebhook(updated, reveal));
};

/** DELETE /api/v1/webhooks/:webhookId — Delete a webhook. */
export const DELETE: RequestHandler = async ({ params, locals }) => {
	const webhookId = pathId(params.webhookId, 'webhook');
	requireWebhook(locals.user, webhookId, 'edit');

	db.delete(webhooks).where(eq(webhooks.id, webhookId)).run();

	return json({ success: true });
};
