/**
 * logActivity — the single writer for the activity log.
 *
 * The log is meant to be a complete record of who did what and when. For a long
 * time it was not: only `api:*` actions were ever written, so everything done in
 * the web UI was invisible. In one 30-day window 42 of 145 completions had no
 * event at all, and the only way to find them was to read each card's
 * `completedAt`. Anything that trusted the log under-counted delivered work by
 * roughly 30% without any sign that it was doing so.
 *
 * Two ideas fix that and keep history readable:
 *
 * 1. **One vocabulary, two sources.** UI and API record the same action names.
 *    On disk the API keeps its historic `api:` prefix so existing consumers and
 *    stored rows keep working; `source` records where it came from, and readers
 *    get the canonical (unprefixed) name via `canonicalAction`.
 * 2. **Nothing is backfilled.** Rows written before `source` existed have it
 *    null, and `readSource` derives their origin from the prefix. A derived
 *    value is honest; a guessed one stored in the column would be
 *    indistinguishable from a recorded one.
 */

import { db } from './db';
import { activityLog } from './db/schema';
import { dispatchWebhook, type WebhookEvent } from './webhooks';

/** Where an action originated. */
export type ActivitySource = 'ui' | 'api';

/**
 * The canonical action vocabulary, shared by both sources.
 *
 * Not an exhaustive enum — the log has always accepted free text and old rows
 * carry names that predate this list. It is the set callers should use, so that
 * a query for `card_moved` means the same thing whoever performed it.
 */
export const ACTIONS = {
	cardCreated: 'card_created',
	cardUpdated: 'card_updated',
	cardMoved: 'card_moved',
	cardMovedAway: 'card_moved_away',
	cardMovedIn: 'card_moved_in',
	cardCompleted: 'card_completed',
	cardReopened: 'card_reopened',
	cardDeleted: 'card_deleted',
	cardRestored: 'card_restored',
	subtaskCreated: 'subtask_created',
	subtaskUpdated: 'subtask_updated',
	subtaskCompleted: 'subtask_completed',
	subtaskDeleted: 'subtask_deleted',
	commentAdded: 'comment_added',
	commentEdited: 'comment_edited',
	assigneeAdded: 'assignee_added',
	assigneeRemoved: 'assignee_removed',
	dependencyAdded: 'dependency_added',
	dependencyRemoved: 'dependency_removed',
	boardCreated: 'board_created',
	boardUpdated: 'board_updated',
	milestoneCreated: 'milestone_created'
} as const;

export interface ActivityEntry {
	/** The board the card was on **at the time of the action**. */
	boardId: number;
	cardId?: number | null;
	userId?: number | null;
	/**
	 * Canonical action name, e.g. `card_moved`. May also be passed already
	 * prefixed (`api:card_moved`), which is how existing API callers spell it;
	 * the prefix is then taken as the source and not doubled.
	 */
	action: string;
	detail?: string;
	userName?: string;
	userEmoji?: string;
	/**
	 * Where this came from. Defaults to whatever the action's prefix implies, so
	 * existing API callers that pass `api:card_moved` need no change.
	 */
	source?: ActivitySource;
}

/** Strip the historic `api:` prefix to get the canonical action name. */
export function canonicalAction(action: string): string {
	return action.startsWith('api:') ? action.slice(4) : action;
}

/**
 * Where a stored row came from.
 *
 * Prefers the recorded column and falls back to the prefix, which is what rows
 * written before the column existed have to be read by.
 */
export function readSource(row: { action: string; source?: string | null }): ActivitySource {
	if (row.source === 'ui' || row.source === 'api') return row.source;
	return row.action.startsWith('api:') ? 'api' : 'ui';
}

/** Map canonical actions to webhook event types. */
const ACTION_TO_EVENT: Record<string, WebhookEvent> = {
	card_created: 'card.created',
	card_moved: 'card.moved',
	card_completed: 'card.completed',
	card_deleted: 'card.deleted',
	card_updated: 'card.updated',
	comment_added: 'comment.added'
};

export function logActivity(entry: ActivityEntry): void {
	const canonical = canonicalAction(entry.action);
	const source: ActivitySource =
		entry.source ?? (entry.action.startsWith('api:') ? 'api' : 'ui');

	// On disk, API actions keep their `api:` prefix. That is the vocabulary two
	// and a half thousand existing rows use, and rewriting it would break every
	// stored query and dashboard filter for no gain — `source` now carries the
	// same fact in a column, where it can be filtered on directly.
	const storedAction = source === 'api' ? `api:${canonical}` : canonical;

	db.insert(activityLog).values({
		boardId: entry.boardId,
		cardId: entry.cardId ?? null,
		userId: entry.userId ?? null,
		action: storedAction,
		detail: entry.detail || '',
		userName: entry.userName || '',
		userEmoji: entry.userEmoji || '👤',
		source
	}).run();

	// Webhooks fire off the canonical name, so a UI move and an API move deliver
	// the same event. They did not before: only the `api:` spellings were mapped,
	// so a card completed in the UI notified nobody.
	const event = ACTION_TO_EVENT[canonical];
	if (event) {
		dispatchWebhook(entry.boardId, event, {
			cardId: entry.cardId ?? null,
			action: canonical,
			source,
			detail: entry.detail || '',
			user: entry.userName || ''
		});
	}
}

/**
 * Log an action performed through the web UI.
 *
 * A thin wrapper over `logActivity`, but naming the source at the call site is
 * the point: the reason UI actions went unrecorded for so long is that logging
 * was something the API layer did, and nothing in the UI handlers mentioned it.
 */
export function logUiActivity(entry: Omit<ActivityEntry, 'source'>): void {
	logActivity({ ...entry, source: 'ui' });
}

/**
 * The actor fields, from the authenticated session user.
 *
 * Every call site was repeating this, and a couple had drifted into trusting a
 * client-supplied name.
 */
export function actorOf(user: { id: number; username: string; emoji?: string | null }) {
	return { userId: user.id, userName: user.username, userEmoji: user.emoji || '👤' };
}
