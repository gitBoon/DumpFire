/**
 * logActivity — Shared utility for inserting activity log entries.
 *
 * Used by both internal UI-driven actions and external API endpoints.
 * External API actions are prefixed with "api:" to distinguish them.
 */

import { db } from './db';
import { activityLog } from './db/schema';
import { dispatchWebhook, type WebhookEvent } from './webhooks';

export interface ActivityEntry {
	boardId: number;
	cardId?: number | null;
	userId?: number | null;
	action: string;
	detail?: string;
	userName?: string;
	userEmoji?: string;
}

/** Map activity actions to webhook event types. */
const ACTION_TO_EVENT: Record<string, WebhookEvent> = {
	'card_created': 'card.created',
	'api:card_created': 'card.created',
	'card_moved': 'card.moved',
	'api:card_moved': 'card.moved',
	'card_completed': 'card.completed',
	'card_deleted': 'card.deleted',
	'api:card_deleted': 'card.deleted',
	'api:card_updated': 'card.updated',
	'api:comment_added': 'comment.added'
};

export function logActivity(entry: ActivityEntry): void {
	db.insert(activityLog).values({
		boardId: entry.boardId,
		cardId: entry.cardId ?? null,
		userId: entry.userId ?? null,
		action: entry.action,
		detail: entry.detail || '',
		userName: entry.userName || '',
		userEmoji: entry.userEmoji || '👤'
	}).run();

	// Dispatch webhook if this action has a mapped event type
	const event = ACTION_TO_EVENT[entry.action];
	if (event) {
		dispatchWebhook(entry.boardId, event, {
			cardId: entry.cardId ?? null,
			action: entry.action,
			detail: entry.detail || '',
			user: entry.userName || ''
		});
	}
}
