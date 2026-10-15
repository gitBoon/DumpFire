/**
 * activity-labels.ts — what each action in the activity log is called on a page.
 *
 * The board page's Activity Log and the All Tasks activity panel each made
 * their own words from the stored name. The board page took `api:` off,
 * turned underscores into spaces and capitalised every word ("Card Moved
 * In"); All Tasks had a table of its own that knew 25 names and showed the
 * rest raw, the `api:` prefix included ("api:card completed"). Now both ask
 * here, so an action reads the same on both, whichever way it was done
 * (card 2212). All Tasks marks one done through the API with a badge of its
 * own (`isApiAction` there); the words are the same.
 *
 * The table is keyed by the canonical name, the one `ACTIONS` in
 * `$lib/server/logActivity` holds: an action done in the web application is
 * stored under it, and the same action done through the API under it with
 * `api:` in front. `tests/activity-twins.test.ts` holds every name written to
 * the log, read from the source, to a label here. This module has no server
 * imports, so the pages can use it.
 */

/** The words for each action, by its canonical name. */
export const ACTIVITY_LABELS: Readonly<Record<string, string>> = Object.freeze({
	card_created: 'Created card',
	card_updated: 'Updated card',
	card_moved: 'Moved card',
	card_completed: 'Completed card',
	card_reopened: 'Reopened card',
	card_archived: 'Archived card',
	card_restored: 'Restored card',
	card_deleted: 'Deleted card',
	card_moved_away: 'Moved card to another board',
	card_moved_in: 'Moved card from another board',
	cards_purged: 'Purged archived cards',
	cards_cleared: 'Cleared cards',
	column_deleted: 'Deleted column',
	subtask_created: 'Created subtask',
	subtask_updated: 'Updated subtask',
	subtask_completed: 'Completed subtask',
	subtask_deleted: 'Deleted subtask',
	// Written by older versions, and still in the log.
	subtask_toggled: 'Updated subtask',
	comment_added: 'Added comment',
	comment_edited: 'Edited comment',
	assignee_added: 'Assigned user',
	assignee_removed: 'Unassigned user',
	dependency_added: 'Added dependency',
	dependency_removed: 'Removed dependency',
	dependencies_bulk_added: 'Added dependencies',
	board_created: 'Created board',
	board_updated: 'Updated board',
	milestone_created: 'Created milestone'
});

/**
 * The words for an action as it is stored, `api:` or not. A name with no
 * label, which only an entry older than today's names can have, reads as
 * that name in words: "time_logged" is "Time logged".
 */
export function activityLabel(action: string): string {
	const name = action.startsWith('api:') ? action.slice(4) : action;
	if (Object.prototype.hasOwnProperty.call(ACTIVITY_LABELS, name)) return ACTIVITY_LABELS[name];
	const words = name.replace(/_/g, ' ');
	return words.charAt(0).toUpperCase() + words.slice(1);
}
