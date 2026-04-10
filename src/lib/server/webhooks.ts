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

const log = createLogger('Webhooks');

/** Supported webhook event types. */
export type WebhookEvent =
	| 'card.created'
	| 'card.updated'
	| 'card.moved'
	| 'card.completed'
	| 'card.deleted'
	| 'comment.added';

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
