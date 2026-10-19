import { error } from '@sveltejs/kit';
import { json } from '$lib/server/v1-json';
import { db } from '$lib/server/db';
import { webhooks } from '$lib/server/db/schema';
import { eq } from 'drizzle-orm';
import { requireBoard, requireUser, type Need } from '$lib/server/route-guards';
import { canSeeWebhookSecret, forgetDelivery, presentWebhook, storedEvents, WEBHOOK_EVENTS } from '$lib/server/webhooks';
import { pathId, readBody, readBoolean, readChoices, readText } from '$lib/server/request-body';
import { readWebhookUrl } from '$lib/server/webhook-address';
import type { SessionUser } from '$lib/server/auth';
import { writeAs } from '$lib/server/write-as';
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
 * the secret or the address.
 *
 * Who may change what (card 2154). An editor may change `events`, switch the
 * webhook off, and send `active: true` for one already on. Changing the
 * address or the secret, and switching a webhook on, are for the board's owner
 * or an administrator, the people who may read the address: an editor who
 * sends `url` or `secret` at all is refused 403, whatever the value, because
 * accepting the stored value unchanged would let them test guesses at an
 * address they cannot read; and starting deliveries again is choosing again to
 * send the board's events to an address they cannot see, perhaps an
 * intruder's that a password reset switched off. Both 403s come after the
 * edit guard and before any field is read.
 *
 * A new address is held to card 2161's rules (`readWebhookUrl`); the stored
 * one sent back unchanged is accepted. Whoever changes the address or the
 * secret, or switches the webhook on, becomes its setter (`set_by`, card
 * 2168).
 */
export const PUT: RequestHandler = async ({ params, request, locals }) => {
	requireUser(locals.user);
	const webhookId = pathId(params.webhookId, 'webhook');
	const body = await readBody(request);

	// The key is asked again, and who its account is now, the webhook read and
	// the caller checked in the transaction that changes it, once the body has
	// arrived. A key a reset ended meanwhile is 401, and an administrator
	// lowered meanwhile is refused as they now are (card 2253). A webhook
	// deleted meanwhile is 404: the update found nothing, and the answer was
	// a 500.
	const { updated, reveal } = writeAs(locals, (caller) => {
		const user = requireUser(caller);
		const { hook, reveal } = requireWebhook(user, webhookId, 'edit');

		if (!reveal && (Object.hasOwn(body, 'url') || Object.hasOwn(body, 'secret'))) {
			throw error(403, "Only the board's owner or an administrator can change a webhook's address or secret. Ask the board's owner.");
		}
		const active = readBoolean(body, 'active', { keep: hook.active });
		const switchedOn = active === true && !hook.active;
		if (!reveal && switchedOn) {
			throw error(403, "Only the board's owner or an administrator can switch a webhook on. Ask the board's owner.");
		}

		const updates: Partial<typeof webhooks.$inferInsert> = {};
		const url = readWebhookUrl(body, { keep: hook.url });
		if (url !== undefined) updates.url = url;
		const secret = readText(body, 'secret', { max: 256, keep: hook.secret });
		if (secret !== undefined) updates.secret = secret;
		// Each name trimmed; an empty list is every event.
		const events = readChoices(body, 'events', { from: WEBHOOK_EVENTS, trim: true, keep: storedEvents(hook.events) });
		if (events !== undefined) updates.events = JSON.stringify(events);
		if (active !== undefined) updates.active = active;
		// Only a change: the address or the secret sent back as stored sets nothing.
		// Switching it on does (the review, S2): whoever starts its deliveries
		// again answers for them, and their reset is what switches it off.
		if ((url !== undefined && url !== hook.url) || (secret !== undefined && secret !== hook.secret) || switchedOn) {
			updates.setBy = user.id;
		}

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

/**
 * DELETE /api/v1/webhooks/:webhookId — Delete a webhook.
 *
 * Its last delivery result, held in memory (card 2178), is forgotten once the
 * delete has committed. The webhook is read, the caller checked and the row
 * deleted in one transaction that asks first whether the key is still open,
 * and who its account is now (card 2253).
 */
export const DELETE: RequestHandler = async ({ params, locals }) => {
	const webhookId = pathId(params.webhookId, 'webhook');
	writeAs(locals, (caller) => {
		requireWebhook(caller, webhookId, 'edit');
		db.delete(webhooks).where(eq(webhooks.id, webhookId)).run();
	});
	forgetDelivery(webhookId);

	return json({ success: true });
};
