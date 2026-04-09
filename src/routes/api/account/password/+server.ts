import { json, error } from '@sveltejs/kit';
import { db } from '$lib/server/db';
import { users, sessions } from '$lib/server/db/schema';
import { eq } from 'drizzle-orm';
import { hashPassword, verifyPassword, createSession, setSessionCookie, SESSION_COOKIE_NAME } from '$lib/server/auth';
import type { RequestHandler } from './$types';

/** PUT — Change own password. Requires current password verification. */
export const PUT: RequestHandler = async ({ request, locals, cookies }) => {
	if (!locals.user) throw error(401, 'Not authenticated');

	const { currentPassword, newPassword } = await request.json();

	if (!currentPassword) throw error(400, 'Current password is required');
	if (!newPassword || newPassword.length < 8) throw error(400, 'New password must be at least 8 characters');

	// Get full user with password hash
	const user = db.select().from(users).where(eq(users.id, locals.user.id)).get();
	if (!user) throw error(404, 'User not found');

	// Verify current password
	if (!verifyPassword(currentPassword, user.passwordHash)) {
		throw error(403, 'Current password is incorrect');
	}

	// Update password
	const newHash = hashPassword(newPassword);
	db.update(users)
		.set({ passwordHash: newHash })
		.where(eq(users.id, locals.user.id))
		.run();

	// Invalidate all existing sessions for this user
	db.delete(sessions).where(eq(sessions.userId, locals.user.id)).run();

	// Create a fresh session so the current user stays logged in
	const newToken = createSession(locals.user.id);
	setSessionCookie(cookies, newToken);

	return json({ success: true });
};
