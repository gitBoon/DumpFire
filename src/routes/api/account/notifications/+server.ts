import { json, error } from '@sveltejs/kit';
import { db } from '$lib/server/db';
import { users } from '$lib/server/db/schema';
import { eq } from 'drizzle-orm';
import { getUserNotifPrefs } from '$lib/server/notifications';
import { defaultPrefs } from '$lib/notification-prefs';
import { readBody, readBoolean } from '$lib/server/request-body';
import type { RequestHandler } from './$types';

/**
 * Default notification prefs (all enabled): every key of the one list in
 * `$lib/notification-prefs` (card 2146). This route kept a list of its own,
 * without `email_request_progress` and `email_mentions`, which the mail reads:
 * neither was answered or saved, so neither could be switched off.
 */
const DEFAULTS: Record<string, boolean> = defaultPrefs();

/** GET — Return current user's notification preferences. */
export const GET: RequestHandler = async ({ locals }) => {
	if (!locals.user) throw error(401, 'Not authenticated');

	// Stored preferences that cannot be read are the defaults (`getUserNotifPrefs`).
	const stored = getUserNotifPrefs(locals.user.id);
	return json({ ...DEFAULTS, ...stored });
};

/** PUT — Update notification preferences (partial merge). */
export const PUT: RequestHandler = async ({ request, locals }) => {
	if (!locals.user) throw error(401, 'Not authenticated');

	const body = await readBody(request);

	// Read existing. Unreadable ones are the defaults, so this save replaces
	// them with something that can be read.
	const existing = getUserNotifPrefs(locals.user.id);

	// Merge: only known keys, each `true` or `false`. A known key sent as
	// anything else (`"false"`, 0, null) was left out without a word, and is a
	// 400 that names it now (card 2117). An unknown key is left alone.
	const merged = { ...existing };
	for (const key of Object.keys(DEFAULTS)) {
		const on = readBoolean(body, key, {});
		if (on !== undefined) merged[key] = on;
	}

	db.update(users)
		.set({ notificationPrefs: JSON.stringify(merged) })
		.where(eq(users.id, locals.user.id))
		.run();

	return json({ ...DEFAULTS, ...merged });
};
