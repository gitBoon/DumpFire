import { json, error } from '@sveltejs/kit';
import { db } from '$lib/server/db';
import { users } from '$lib/server/db/schema';
import { eq } from 'drizzle-orm';
import type { RequestHandler } from './$types';

/** Default notification prefs (all enabled). */
const DEFAULTS: Record<string, boolean> = {
	email_all: true,
	email_assigned: true,
	email_comments: true,
	email_moved: true,
	email_requests: true,
	email_board_shared: true
};

/** GET — Return current user's notification preferences. */
export const GET: RequestHandler = async ({ locals }) => {
	if (!locals.user) throw error(401, 'Not authenticated');

	const user = db.select({ notificationPrefs: users.notificationPrefs })
		.from(users).where(eq(users.id, locals.user.id)).get();

	const stored = user?.notificationPrefs ? JSON.parse(user.notificationPrefs) : {};
	return json({ ...DEFAULTS, ...stored });
};

/** PUT — Update notification preferences (partial merge). */
export const PUT: RequestHandler = async ({ request, locals }) => {
	if (!locals.user) throw error(401, 'Not authenticated');

	const body = await request.json();

	// Read existing
	const user = db.select({ notificationPrefs: users.notificationPrefs })
		.from(users).where(eq(users.id, locals.user.id)).get();

	const existing = user?.notificationPrefs ? JSON.parse(user.notificationPrefs) : {};

	// Merge — only accept known keys with boolean values
	const merged = { ...existing };
	for (const key of Object.keys(DEFAULTS)) {
		if (typeof body[key] === 'boolean') {
			merged[key] = body[key];
		}
	}

	db.update(users)
		.set({ notificationPrefs: JSON.stringify(merged) })
		.where(eq(users.id, locals.user.id))
		.run();

	return json({ ...DEFAULTS, ...merged });
};
