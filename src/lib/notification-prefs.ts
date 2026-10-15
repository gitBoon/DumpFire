/**
 * notification-prefs.ts — the kinds of mail a person can switch off, in one list.
 *
 * The account page drew its switches from a list of its own, the route that
 * saves them kept another, and each mail read whatever key it was written
 * with. The three came apart: the page offered Request Progress, which the
 * route did not save, so the switch went back on at every reload; and the
 * mention mail read `email_mentions`, which neither offered, so it could be
 * stopped only by switching all mail off (card 2146).
 *
 * Now the route makes its defaults and its save from this list, the page
 * draws its switches from it, and the functions in
 * `$lib/server/notifications.ts` that read a preference take a key of it as
 * their type, so `npm run check` refuses a mail that reads a key nobody can
 * save. This module has no server imports, so the browser and the server
 * share it.
 *
 * Every key is on unless it is stored as `false`, and the master key, when it
 * is stored as `false`, stops every kind.
 */

/** The switch that stops all mail, whatever each kind says. */
export const MASTER_PREF = 'email_all';

/** Each kind of mail a person can switch off: its stored key, and what the account page says of it. */
export const NOTIFICATION_PREFS = [
	{ key: 'email_assigned', label: 'Task Assignments', description: 'When you are assigned to a card' },
	{ key: 'email_comments', label: 'Comments', description: 'When someone comments on a board you belong to' },
	{ key: 'email_mentions', label: 'Mentions', description: 'When someone @mentions you in a comment' },
	{ key: 'email_moved', label: 'Card Moves', description: 'When a card you are assigned to is moved' },
	{ key: 'email_requests', label: 'Task Requests', description: 'When someone submits or replies to a request' },
	{ key: 'email_request_progress', label: 'Request Progress', description: 'Updates on tasks you requested until completion' },
	{ key: 'email_board_shared', label: 'Board Sharing', description: 'When a board is shared with you' },
	{ key: 'email_planning', label: 'Planning', description: 'When a new plan is created from cards that depend on each other' }
] as const;

/** The key of one kind of mail. */
export type NotificationPref = (typeof NOTIFICATION_PREFS)[number]['key'];

/** Every key that can be saved: the master key, then each kind's. */
export type NotificationPrefKey = typeof MASTER_PREF | NotificationPref;

/** Every key, each on: what a person who has saved nothing is sent. */
export function defaultPrefs(): Record<NotificationPrefKey, boolean> {
	const prefs = { [MASTER_PREF]: true } as Record<NotificationPrefKey, boolean>;
	for (const kind of NOTIFICATION_PREFS) prefs[kind.key] = true;
	return prefs;
}
