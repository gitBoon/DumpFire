import { json, error } from '@sveltejs/kit';
import { db } from '$lib/server/db';
import { users } from '$lib/server/db/schema';
import { eq } from 'drizzle-orm';
import { hashPassword, verifyPassword } from '$lib/server/auth';
import type { RequestHandler } from './$types';

/** PUT — Change own password. Requires current password verification. */
export const PUT: RequestHandler = async ({ request, locals }) => {
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

	return json({ success: true });
};
