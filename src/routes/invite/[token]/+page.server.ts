import { fail, redirect } from '@sveltejs/kit';
import type { Actions, PageServerLoad } from './$types';
import { db } from '$lib/server/db';
import { inviteTokens, users } from '$lib/server/db/schema';
import { eq, and, gt } from 'drizzle-orm';
import { hashPassword, createSession, setSessionCookie } from '$lib/server/auth';

export const load: PageServerLoad = async ({ params }) => {
	const token = params.token;
	const now = new Date().toISOString();

	const invite = db.select()
		.from(inviteTokens)
		.where(and(
			eq(inviteTokens.token, token),
			eq(inviteTokens.used, false),
			gt(inviteTokens.expiresAt, now)
		))
		.get();

	if (!invite) {
		return { valid: false, username: '' };
	}

	const user = db.select({ username: users.username, emoji: users.emoji })
		.from(users)
		.where(eq(users.id, invite.userId))
		.get();

	return {
		valid: true,
		username: user?.username || '',
		emoji: user?.emoji || '👤'
	};
};

export const actions: Actions = {
	default: async ({ params, request, cookies }) => {
		const token = params.token;
		const now = new Date().toISOString();

		const invite = db.select()
			.from(inviteTokens)
			.where(and(
				eq(inviteTokens.token, token),
				eq(inviteTokens.used, false),
				gt(inviteTokens.expiresAt, now)
			))
			.get();

		if (!invite) {
			return fail(400, { error: 'This invite link is invalid or has expired.' });
		}

		const data = await request.formData();
		const password = data.get('password') as string;
		const confirmPassword = data.get('confirmPassword') as string;

		if (!password || password.length < 8) {
			return fail(400, { error: 'Password must be at least 8 characters.' });
		}

		if (password !== confirmPassword) {
			return fail(400, { error: 'Passwords do not match.' });
		}

		// Update user password
		const passwordHash = hashPassword(password);
		db.update(users)
			.set({ passwordHash })
			.where(eq(users.id, invite.userId))
			.run();

		// Mark token as used
		db.update(inviteTokens)
			.set({ used: true })
			.where(eq(inviteTokens.token, token))
			.run();

		// Create session and log them in
		const sessionToken = createSession(invite.userId);
		setSessionCookie(cookies, sessionToken);

		throw redirect(303, '/');
	}
};
