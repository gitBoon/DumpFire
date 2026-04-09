import { json, error } from '@sveltejs/kit';
import { db } from '$lib/server/db';
import { users, sessions, inviteTokens } from '$lib/server/db/schema';
import { eq } from 'drizzle-orm';
import { hashPassword } from '$lib/server/auth';
import { isSmtpConfigured, resolveBaseUrl } from '$lib/server/email';
import { sendInviteEmail } from '$lib/server/notifications';
import type { RequestHandler } from './$types';

/** GET — List all users (any authenticated user — for sharing/team dropdowns). */
export const GET: RequestHandler = async ({ locals }) => {
	if (!locals.user) throw error(401, 'Not authenticated');

	const allUsers = db.select({
		id: users.id,
		username: users.username,
		email: users.email,
		emoji: users.emoji,
		role: users.role,
		createdAt: users.createdAt
	}).from(users).all();

	return json(allUsers);
};

/** POST — Create a new user (admin only). Password optional if SMTP configured. */
export const POST: RequestHandler = async ({ request, locals, url }) => {
	if (!locals.user || (locals.user.role !== 'admin' && locals.user.role !== 'superadmin')) {
		throw error(403, 'Forbidden');
	}

	const { username, email, password, emoji, role } = await request.json();

	if (!username?.trim() || username.trim().length < 2) {
		throw error(400, 'Username must be at least 2 characters');
	}

	if (!email?.trim() || !email.includes('@')) {
		throw error(400, 'Valid email required');
	}

	const smtpReady = isSmtpConfigured();

	// Password required if SMTP not configured
	if (!smtpReady && (!password || password.length < 8)) {
		throw error(400, 'Password must be at least 8 characters (SMTP not configured for invite emails)');
	}

	if (password && password.length < 8) {
		throw error(400, 'Password must be at least 8 characters');
	}

	// Only superadmin can create admin users
	const finalRole = role || 'user';
	if (finalRole === 'admin' && locals.user.role !== 'superadmin') {
		throw error(403, 'Only superadmin can create admin users');
	}

	if (finalRole === 'superadmin') {
		throw error(400, 'Cannot create additional superadmin accounts');
	}

	// Check uniqueness
	const existingUsername = db.select().from(users).where(eq(users.username, username.trim())).get();
	if (existingUsername) {
		throw error(409, 'Username already taken');
	}

	const existingEmail = db.select().from(users).where(eq(users.email, email.trim().toLowerCase())).get();
	if (existingEmail) {
		throw error(409, 'Email already in use');
	}

	// If password provided, hash and create fully. Otherwise create with placeholder and invite.
	const passwordHash = password
		? hashPassword(password)
		: hashPassword(crypto.randomUUID()); // Random placeholder — user must set via invite

	const user = db.insert(users)
		.values({
			username: username.trim(),
			email: email.trim().toLowerCase(),
			passwordHash,
			emoji: emoji || '👤',
			role: finalRole
		})
		.returning({ id: users.id, username: users.username, email: users.email, emoji: users.emoji, role: users.role, createdAt: users.createdAt })
		.get();

	let invited = false;

	// If no password was provided and SMTP is ready, send invite
	if (!password && smtpReady) {
		const token = crypto.randomUUID();
		const expiresAt = new Date(Date.now() + 7 * 24 * 60 * 60 * 1000).toISOString();

		db.insert(inviteTokens)
			.values({ token, userId: user.id, expiresAt })
			.run();

		const baseUrl = resolveBaseUrl(request, url);
		sendInviteEmail(user.email, user.username, token, baseUrl);
		invited = true;
	}

	return json({ ...user, invited }, { status: 201 });
};

