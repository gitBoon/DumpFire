import { json, error } from '@sveltejs/kit';
import { db } from '$lib/server/db';
import { users, sessions } from '$lib/server/db/schema';
import { eq } from 'drizzle-orm';
import type { RequestHandler } from './$types';

/** PUT — Update user role/details (admin only). */
export const PUT: RequestHandler = async ({ params, request, locals }) => {
	if (!locals.user || (locals.user.role !== 'admin' && locals.user.role !== 'superadmin')) {
		throw error(403, 'Forbidden');
	}

	const userId = Number(params.id);
	const data = await request.json();

	const target = db.select().from(users).where(eq(users.id, userId)).get();
	if (!target) throw error(404, 'User not found');

	// Protect superadmin from demotion
	if (target.role === 'superadmin' && locals.user.id !== target.id) {
		throw error(403, 'Cannot modify superadmin account');
	}

	// Only superadmin can promote to admin
	if (data.role === 'admin' && locals.user.role !== 'superadmin') {
		throw error(403, 'Only superadmin can assign admin role');
	}

	if (data.role === 'superadmin') {
		throw error(400, 'Cannot assign superadmin role');
	}

	const updates: Record<string, unknown> = {};
	if (data.emoji) updates.emoji = data.emoji;
	if (data.role && target.role !== 'superadmin') updates.role = data.role;
	if (data.username) updates.username = data.username;
	if (data.email) updates.email = data.email.toLowerCase();

	if (Object.keys(updates).length === 0) {
		return json(target);
	}

	const updated = db.update(users)
		.set(updates)
		.where(eq(users.id, userId))
		.returning({ id: users.id, username: users.username, email: users.email, emoji: users.emoji, role: users.role, createdAt: users.createdAt })
		.get();

	return json(updated);
};

/** DELETE — Delete a user (admin only). */
export const DELETE: RequestHandler = async ({ params, locals }) => {
	if (!locals.user || (locals.user.role !== 'admin' && locals.user.role !== 'superadmin')) {
		throw error(403, 'Forbidden');
	}

	const userId = Number(params.id);

	// Can't delete yourself
	if (userId === locals.user.id) {
		throw error(400, 'Cannot delete your own account');
	}

	const target = db.select().from(users).where(eq(users.id, userId)).get();
	if (!target) throw error(404, 'User not found');

	// Can't delete superadmin
	if (target.role === 'superadmin') {
		throw error(403, 'Cannot delete superadmin account');
	}

	// Only superadmin can delete admins
	if (target.role === 'admin' && locals.user.role !== 'superadmin') {
		throw error(403, 'Only superadmin can delete admin users');
	}

	// Delete user (sessions cascade)
	db.delete(users).where(eq(users.id, userId)).run();

	return json({ success: true });
};
