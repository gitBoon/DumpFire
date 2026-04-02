import { fail, redirect } from '@sveltejs/kit';
import type { Actions, PageServerLoad } from './$types';
import { getUserByUsername, getUserByEmail, verifyPassword, createSession, setSessionCookie } from '$lib/server/auth';

export const load: PageServerLoad = async ({ locals }) => {
	if (locals.user) {
		throw redirect(303, '/');
	}
	return {};
};

export const actions: Actions = {
	default: async ({ request, cookies }) => {
		const data = await request.formData();
		const identity = (data.get('identity') as string)?.trim();
		const password = data.get('password') as string;

		if (!identity) {
			return fail(400, { error: 'Please enter your username or email', identity });
		}

		if (!password) {
			return fail(400, { error: 'Please enter your password', identity });
		}

		// Look up by username or email
		const user = identity.includes('@')
			? getUserByEmail(identity.toLowerCase())
			: getUserByUsername(identity);

		if (!user) {
			return fail(400, { error: 'Invalid username/email or password', identity });
		}

		if (!verifyPassword(password, user.passwordHash)) {
			return fail(400, { error: 'Invalid username/email or password', identity });
		}

		// Create session and set cookie
		const token = createSession(user.id);
		setSessionCookie(cookies, token);

		throw redirect(303, '/');
	}
};
