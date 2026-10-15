/**
 * webhooks.ts — Webhook dispatch engine.
 *
 * Fires HTTP POST requests to registered webhook URLs when board events occur.
 * Includes HMAC-SHA256 signature for verification. Fire-and-forget.
 */

import { db } from './db';
import { webhooks } from './db/schema';
import { eq, and } from 'drizzle-orm';
import { createHmac } from 'crypto';
import { createLogger } from './logger';
import { getBoardRole, type Actor } from './board-access';

const log = createLogger('Webhooks');

type Webhook = typeof webhooks.$inferSelect;

/**
 * True if the caller may be shown a webhook's signing secret and its address:
 * the board's owner or an administrator.
 *
 * The secret is what lets a receiver trust that a delivery came from here, so
 * anyone holding it can forge one. Viewing the board is not a reason to hold it.
 * The address goes with it (card 2133): it can name a server inside the
 * network, or carry credentials before the host.
 */
export function canSeeWebhookSecret(user: Actor, boardId: number): boolean {
	const role = getBoardRole(user, boardId);
	return role === 'owner' || role === 'admin';
}

/**
 * A webhook as an API response.
 *
 * The secret and the address are left out, with no key, unless `reveal` is
 * set; `hasSecret` says whether a secret exists, which is all most callers
 * need to know. The address was given to every viewer of the board, and to an
 * editor in the answer to their own change (card 2133). Every route returning
 * a webhook goes through here so that none of them can return the raw row.
 */
export function presentWebhook(hook: Webhook, reveal: boolean) {
	const { secret, url, events, ...rest } = hook;
	return {
		...rest,
		events: JSON.parse(events || '[]') as string[],
		hasSecret: secret !== '',
		...(reveal ? { url, secret } : {})
	};
}

/** Supported webhook event types. */
export type WebhookEvent =
	| 'card.created'
	| 'card.updated'
	| 'card.moved'
	| 'card.completed'
	| 'card.deleted'
	| 'comment.added';

/** Every event a webhook can ask for, as the two routes that save one read `events`. */
export const WEBHOOK_EVENTS: readonly WebhookEvent[] = [
	'card.created',
	'card.updated',
	'card.moved',
	'card.completed',
	'card.deleted',
	'comment.added'
];

/**
 * A webhook's stored `events` as a list, for an update to compare what it is
 * sent with. Undefined when what is stored is not a list: then nothing sent is
 * the same as it.
 */
export function storedEvents(events: string): unknown[] | undefined {
	try {
		const parsed: unknown = JSON.parse(events);
		return Array.isArray(parsed) ? parsed : undefined;
	} catch {
		return undefined;
	}
}

/**
 * Dispatch a webhook event to all active webhooks for a board.
 * Fire-and-forget — errors are logged but never propagate.
 */
export function dispatchWebhook(
	boardId: number,
	event: WebhookEvent,
	payload: Record<string, unknown>
): void {
	try {
		const hooks = db.select()
			.from(webhooks)
			.where(and(
				eq(webhooks.boardId, boardId),
				eq(webhooks.active, true)
			))
			.all();

		for (const hook of hooks) {
			// Check if this webhook subscribes to this event
			const events: string[] = JSON.parse(hook.events || '[]');
			if (events.length > 0 && !events.includes(event)) continue;

			// Build payload
			const body = JSON.stringify({
				event,
				timestamp: new Date().toISOString(),
				boardId,
				data: payload
			});

			// Compute HMAC signature
			const signature = hook.secret
				? createHmac('sha256', hook.secret).update(body).digest('hex')
				: '';

			// Fire-and-forget
			fetch(hook.url, {
				method: 'POST',
				headers: {
					'Content-Type': 'application/json',
					'X-DumpFire-Event': event,
					'X-DumpFire-Signature': signature ? `sha256=${signature}` : '',
					'User-Agent': 'DumpFire-Webhook/1.0'
				},
				body,
				signal: AbortSignal.timeout(10000)
			}).catch(err => {
				log.error(`Webhook delivery failed for hook ${hook.id} → ${hook.url}`, err);
			});
		}
	} catch (err) {
		log.error('Webhook dispatch error', err);
	}
}
