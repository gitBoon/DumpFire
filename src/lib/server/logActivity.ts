/**
 * logActivity — Shared utility for inserting activity log entries.
 *
 * Used by both internal UI-driven actions and external API endpoints.
 * External API actions are prefixed with "api:" to distinguish them.
 */

import { db } from './db';
import { activityLog } from './db/schema';

export interface ActivityEntry {
	boardId: number;
	cardId?: number | null;
	userId?: number | null;
	action: string;
	detail?: string;
	userName?: string;
	userEmoji?: string;
}

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
}
