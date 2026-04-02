import { json, error } from '@sveltejs/kit';
import { db } from '$lib/server/db';
import { users } from '$lib/server/db/schema';
import { eq } from 'drizzle-orm';
import { hashPassword } from '$lib/server/auth';
import type { RequestHandler } from './$types';

/** PUT — Change/reset a user's password. */
export const PUT: RequestHandler = async ({ params, request, locals }) => {
	if (!locals.user) throw error(401, 'Not authenticated');

	const userId = Number(params.id);

	// Users can change their own password; admins can reset any user's password
	const isSelf = locals.user.id === userId;
	const isAdmin = locals.user.role === 'admin' || locals.user.role === 'superadmin';

	if (!isSelf && !isAdmin) {
		throw error(403, 'Forbidden');
	}

	const { password } = await request.json();
	if (!password || password.length < 8) {
		throw error(400, 'Password must be at least 8 characters');
	}

	const target = db.select().from(users).where(eq(users.id, userId)).get();
	if (!target) throw error(404, 'User not found');

	// Only superadmin can reset another superadmin's password
	if (target.role === 'superadmin' && !isSelf && locals.user.role !== 'superadmin') {
		throw error(403, 'Only superadmin can reset superadmin password');
	}

	const passwordHash = hashPassword(password);
	db.update(users).set({ passwordHash }).where(eq(users.id, userId)).run();

	return json({ success: true });
};
