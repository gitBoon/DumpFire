import { json, error } from '@sveltejs/kit';
import { db } from '$lib/server/db';
import { users } from '$lib/server/db/schema';
import { eq } from 'drizzle-orm';
import { verifyPassword } from '$lib/server/auth';
import type { RequestHandler } from './$types';

/** PUT — Change own email. Requires password verification. */
export const PUT: RequestHandler = async ({ request, locals }) => {
	if (!locals.user) throw error(401, 'Not authenticated');

	const { newEmail, password } = await request.json();

	if (!password) throw error(400, 'Password is required');
	if (!newEmail?.trim()) throw error(400, 'Email is required');

	// Basic email validation
	const emailRegex = /^[^\s@]+@[^\s@]+\.[^\s@]+$/;
	if (!emailRegex.test(newEmail.trim())) throw error(400, 'Invalid email address');

	// Get full user with password hash
	const user = db.select().from(users).where(eq(users.id, locals.user.id)).get();
	if (!user) throw error(404, 'User not found');

	// Verify password
	if (!verifyPassword(password, user.passwordHash)) {
		throw error(403, 'Password is incorrect');
	}

	// Check if email is already taken by another user
	const existing = db.select({ id: users.id }).from(users).where(eq(users.email, newEmail.trim().toLowerCase())).get();
	if (existing && existing.id !== locals.user.id) {
		throw error(409, 'Email is already in use');
	}

	// Update email
	db.update(users)
		.set({ email: newEmail.trim().toLowerCase() })
		.where(eq(users.id, locals.user.id))
		.run();

	return json({ success: true, email: newEmail.trim().toLowerCase() });
};
