import { fail, redirect } from '@sveltejs/kit';
import type { Actions, PageServerLoad } from './$types';
import { hasAnyUsers, hashPassword, createSession, setSessionCookie } from '$lib/server/auth';
import { db } from '$lib/server/db';
import { users } from '$lib/server/db/schema';

export const load: PageServerLoad = async () => {
	if (hasAnyUsers()) {
		throw redirect(303, '/');
	}
	return {};
};

export const actions: Actions = {
	default: async ({ request, cookies }) => {
		// Double-check no users exist
		if (hasAnyUsers()) {
			throw redirect(303, '/');
		}

		const data = await request.formData();
		const username = (data.get('username') as string)?.trim();
		const email = (data.get('email') as string)?.trim();
		const password = data.get('password') as string;
		const confirmPassword = data.get('confirmPassword') as string;
		const emoji = (data.get('emoji') as string) || '👤';

		// Validation
		if (!username || username.length < 2) {
			return fail(400, { error: 'Username must be at least 2 characters', username, email });
		}

		if (!email || !email.includes('@')) {
			return fail(400, { error: 'Please enter a valid email address', username, email });
		}

		if (!password || password.length < 8) {
			return fail(400, { error: 'Password must be at least 8 characters', username, email });
		}

		if (password !== confirmPassword) {
			return fail(400, { error: 'Passwords do not match', username, email });
		}

		// Create the superadmin user
		const passwordHash = hashPassword(password);
		const user = db.insert(users)
			.values({
				username,
				email: email.toLowerCase(),
				passwordHash,
				emoji,
				role: 'superadmin'
			})
			.returning()
			.get();

		// Create session and set cookie
		const token = createSession(user.id);
		setSessionCookie(cookies, token);

		throw redirect(303, '/');
	}
};
