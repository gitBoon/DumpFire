import { error } from '@sveltejs/kit';
import { json } from '$lib/server/v1-json';
import { db } from '$lib/server/db';
import { webhooks } from '$lib/server/db/schema';
import { eq } from 'drizzle-orm';
import { requireBoard, requireUser, type Need } from '$lib/server/route-guards';
import {
	answerWebhook,
	canSeeWebhookSecret,
	forgetDelivery,
	forgetReveals,
	keyOfWrite,
	NEW_SECRET_REASONS,
	openedSecret,
	receiverOf,
	storedEvents,
	WEBHOOK_EVENTS,
	withHoldRecorded
} from '$lib/server/webhooks';
import { pathId, readBody, readBoolean, readChoices, readText } from '$lib/server/request-body';
import { readWebhookUrl } from '$lib/server/webhook-address';
import type { SessionUser } from '$lib/server/auth';
import { revealAs, writeAs } from '$lib/server/write-as';
import { randomBytes } from 'node:crypto';
import { TYPED_SECRET_LOOKS_SEALED, looksSealed, openedUrl, sealStored, webhookSecretAad, webhookUrlAad } from '$lib/server/stored-secrets';
import type { RequestHandler } from './$types';

/** Said to a `secret` sent with the switch-on that gives a webhook a new one (card 2752, D3). */
const NEW_SECRET_ON_SWITCH_ON =
	'A webhook switched off this way is given a new secret when it is switched on: send active true alone, and read the new secret from the answer.';

/** Said to a switch-on of a webhook with no address it can send to and no url sent (card 2928, R7). */
const NO_ADDRESS_ON_SWITCH_ON = 'This webhook has no address it can send to: send url with active true.';

/** Said to a new secret for a webhook whose address is empty or cannot be opened, sent without url (card 2928, R5). */
const SECRET_NEEDS_URL =
	"This webhook's address is empty or cannot be opened, so a secret cannot be bound to it: send url with the secret.";

/** Said to a new url for a webhook whose secret cannot be opened, sent without a secret (card 2928, R5). */
const URL_NEEDS_SECRET =
	"This webhook's secret cannot be opened, so it cannot be kept for a new address: send a new secret with the url, or '' for none.";

/** Said to an editor deleting a webhook switched off for good (the code review's CS1). */
const HELD_OFF_DELETE =
	"Only the board's owner or an administrator can delete a webhook that was switched off this way. Ask the board's owner.";

/** The webhook, if the caller may view or edit the board it belongs to. */
function requireWebhook(user: SessionUser | null, webhookId: number, need: Need) {
	const caller = requireUser(user);
	if (!Number.isInteger(webhookId)) throw error(400, 'Invalid webhook ID');

	const hook = db.select().from(webhooks).where(eq(webhooks.id, webhookId)).get();
	if (!hook) throw error(404, 'Webhook not found');

	// One on a board the caller cannot open is answered as one that is not there (card 2719).
	requireBoard(caller, hook.boardId, need, undefined, 'Webhook not found');
	return { hook, reveal: canSeeWebhookSecret(caller, hook.boardId) };
}

/**
 * GET /api/v1/webhooks/:webhookId — Get a single webhook.
 *
 * The signing secret and the address are included only for the board's owner
 * or an administrator (the address since card 2133).
 *
 * The key and its account are asked again, in the transaction that reads the
 * webhook, before anything is revealed (card 2935, P5): a key ended, or a role
 * lowered, after the gate let the request in is answered as it is now, as a
 * write is (`writeAs`). Never a secret to an account whose access has ended.
 *
 * The API key it was given to is recorded in the same transaction (card 2947,
 * `answerWebhook`), so that the key's revoke, expiry or deadline holds the
 * webhook. Answered with `Cache-Control: no-store` (R11): it may carry a secret.
 */
export const GET: RequestHandler = async ({ params, locals }) => {
	const webhookId = pathId(params.webhookId, 'webhook');
	const answer = revealAs(locals, (caller) => {
		const { hook, reveal } = requireWebhook(caller, webhookId, 'view');
		return answerWebhook(hook, reveal, locals.credential);
	});
	return json(answer, { headers: NO_STORE });
};

/** What every answer that may carry a webhook's secret is sent with (card 2947, R11): kept in no cache on the way. */
const NO_STORE = { 'Cache-Control': 'no-store' };

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
 *
 * Switching on a webhook switched off by a hold (card 2752) clears the hold
 * in the same update. One held because its setter lost the board, had their
 * access ended by a reset, an invite or a delete (the code review's CS4), or
 * its key ended (card 2893), is given a new secret there too (D3, S4): the former
 * setter knows the old one, and could sign deliveries with it. The new secret
 * is in the answer, which goes to the board's owner or an administrator, the
 * only callers who may switch it on; a `secret` sent with that switch-on is
 * refused 400 before anything is written. Since card 2923's code review (S1)
 * one held because nobody was recorded as its setter is given a new secret
 * too: its secret may have been set since by an account whose access ended.
 *
 * Whoever becomes its setter has the API key they came in with recorded too
 * (`keyOfWrite`, card 2893), so that it is switched off when that key ends;
 * a change of `events` alone keeps the key it had.
 *
 * Card 2947 (R9): the answer gives the secret only where this `PUT` set or
 * replaced it (a secret sent, or a switch-on's new one), and then records the
 * caller's key as given it; any other change is answered without `secret`. A
 * new secret forgets every key given the old one (`forgetReveals`) first.
 * Answered with `Cache-Control: no-store` (R11).
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
	const answer = writeAs(locals, (caller) => {
		const user = requireUser(caller);
		const { hook: found, reveal } = requireWebhook(user, webhookId, 'edit');
		// One on and held now is switched off for good first, and judged so
		// (card 2893's code review, CS3): an editor's change does not keep it on,
		// and the owner's switch-on gives it a new secret.
		const hook = withHoldRecorded(found, `found when ${user.username} changed it`);

		if (!reveal && (Object.hasOwn(body, 'url') || Object.hasOwn(body, 'secret'))) {
			throw error(403, "Only the board's owner or an administrator can change a webhook's address or secret. Ask the board's owner.");
		}
		const active = readBoolean(body, 'active', { keep: hook.active });
		const switchedOn = active === true && !hook.active;
		if (!reveal && switchedOn) {
			throw error(403, "Only the board's owner or an administrator can switch a webhook on. Ask the board's owner.");
		}
		// Switched off for good, for any reason: a new secret, never one sent (card 2752, D3; card 2923's code review, S1).
		const givenNewSecret = switchedOn && hook.heldBecause !== null && NEW_SECRET_REASONS.includes(hook.heldBecause);
		if (givenNewSecret && Object.hasOwn(body, 'secret')) {
			throw error(400, NEW_SECRET_ON_SWITCH_ON);
		}

		const updates: Partial<typeof webhooks.$inferInsert> = {};
		// The address as it opens (card 2928): what one sent back unchanged is
		// compared with. Kept only where it opens: '' or one that does not open is
		// never handed back unchecked (N4).
		const address = openedUrl(hook);
		const usable = address.kind === 'opened' || address.kind === 'plain';
		const url = readWebhookUrl(body, usable ? { keep: address.value } : {});
		const urlChanged = url !== undefined && (!usable || url !== address.value);
		// Never switched on with nowhere to send (card 2928, R7): only a switch-on, so a change of events alone stays allowed.
		if (switchedOn && !usable && !urlChanged) throw error(400, NO_ADDRESS_ON_SWITCH_ON);
		// Sealed, bound to its id, board and receiver (card 2928). Unchanged, it is
		// written back as stored, byte for byte: never sealed again (R3).
		if (url !== undefined) {
			if (urlChanged) {
				updates.receiver = receiverOf(url) ?? '';
				updates.url = sealStored(url, webhookUrlAad(hook.id, hook.boardId, updates.receiver));
			} else {
				updates.url = hook.url;
			}
		}
		// The secret as it opens (card 2898): what one sent back unchanged is compared with.
		const stored = openedSecret(hook, address);
		const sent = readText(body, 'secret', { max: 256, keep: stored.value });
		// One that looks sealed is refused (card 2898, S9): it would be taken for one.
		if (looksSealed(sent)) throw error(400, TYPED_SECRET_LOOKS_SEALED);
		const secret = givenNewSecret ? randomBytes(32).toString('hex') : sent;
		// One sent for a secret that does not open is always a change (the code
		// review's E6): '' clears it, unsigned, and a value replaces it.
		const secretChanged = secret !== undefined && (secret !== stored.value || stored.kind === 'unopenable');
		// No secret is ever sealed against an address that is '' or does not open
		// (card 2928, R5), and none is orphaned: a new secret on such an address
		// needs its url in the same request, and a new url beside a secret that
		// does not open needs a new secret with it.
		// A clear ('') seals nothing, and is taken (its code review, C5).
		if (secretChanged && secret !== '' && !usable && !urlChanged) throw error(400, SECRET_NEEDS_URL);
		if (urlChanged && stored.kind === 'unopenable' && !secretChanged) throw error(400, URL_NEEDS_SECRET);
		// Written sealed, bound to the id, board and address it is left with: a
		// new one; the one kept, sealed again when the address changes (S10), so
		// that it still opens there; one sent back unchanged left as it is.
		const sealedFor = (plain: string) => sealStored(plain, webhookSecretAad(hook.id, hook.boardId, urlChanged && url !== undefined ? url : address.value));
		if (secretChanged) updates.secret = sealedFor(secret);
		else if (urlChanged && (stored.kind === 'opened' || stored.kind === 'plain')) updates.secret = sealedFor(stored.value);
		else if (secret !== undefined) updates.secret = hook.secret;
		// Each name trimmed; an empty list is every event.
		const events = readChoices(body, 'events', { from: WEBHOOK_EVENTS, trim: true, keep: storedEvents(hook.events) });
		if (events !== undefined) updates.events = JSON.stringify(events);
		if (active !== undefined) updates.active = active;
		// Only a change: the address or the secret sent back as stored sets nothing.
		// Switching it on does (the review, S2): whoever starts its deliveries
		// again answers for them, and their reset is what switches it off.
		// With the setter, the key they came in with (card 2893, S11); a change
		// of events alone, or a switch-off, keeps the key it had.
		if (urlChanged || secretChanged || switchedOn) {
			updates.setBy = user.id;
			Object.assign(updates, keyOfWrite(locals.credential));
		}
		// Switched on: whatever hold switched it off is over (card 2752, D1).
		if (switchedOn) {
			updates.heldBecause = null;
			updates.heldAt = null;
		}

		if (Object.keys(updates).length === 0) throw error(400, 'No fields to update');

		// A new secret: no key given the old one is given this one (card 2947).
		if (secretChanged) forgetReveals(webhookId);
		const row = db.update(webhooks)
			.set(updates)
			.where(eq(webhooks.id, webhookId))
			.returning()
			.get();
		// The secret only where this request set or replaced it, recorded as given to the caller's key (R9).
		return answerWebhook(row, reveal, locals.credential, { secret: secretChanged });
	});

	return json(answer, { headers: NO_STORE });
};

/**
 * DELETE /api/v1/webhooks/:webhookId — Delete a webhook.
 *
 * Its last delivery result, held in memory (card 2178), is forgotten once the
 * delete has committed. The webhook is read, the caller checked and the row
 * deleted in one transaction that asks first whether the key is still open,
 * and who its account is now (card 2253). A webhook switched off for good
 * (`held_because` set) is deleted only by the board's owner or an
 * administrator: an editor is refused 403, as for switching one on (the code
 * review's CS1).
 */
export const DELETE: RequestHandler = async ({ params, locals }) => {
	const webhookId = pathId(params.webhookId, 'webhook');
	writeAs(locals, (caller) => {
		const { hook: found, reveal } = requireWebhook(caller, webhookId, 'edit');
		// One on and held now is judged as switched off for good (card 2893's code
		// review, CS3): an editor's delete is refused, which rolls the hold back
		// with it, and the owner's commit leaves nothing to tell of.
		const hook = withHoldRecorded(found, null);
		// One switched off for good is the owner's or an administrator's to
		// delete, as it is theirs to switch on (the code review's CS1): an
		// editor's delete would clear the hold off the board, and with it the
		// refusal of a new webhook to its receiver.
		if (!reveal && !hook.active && hook.heldBecause !== null) throw error(403, HELD_OFF_DELETE);
		db.delete(webhooks).where(eq(webhooks.id, webhookId)).run();
	});
	forgetDelivery(webhookId);

	return json({ success: true });
};
