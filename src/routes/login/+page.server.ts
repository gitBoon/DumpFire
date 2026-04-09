import { fail, redirect } from '@sveltejs/kit';
import type { Actions, PageServerLoad } from './$types';
import { getUserByUsername, getUserByEmail, verifyPassword, createSession, setSessionCookie } from '$lib/server/auth';
import { checkRateLimit, resetRateLimit } from '$lib/server/rate-limit';

export const load: PageServerLoad = async ({ locals }) => {
	if (locals.user) {
		throw redirect(303, '/');
	}
	return {};
};

export const actions: Actions = {
	default: async ({ request, cookies, getClientAddress }) => {
		const data = await request.formData();
		const identity = (data.get('identity') as string)?.trim();
		const password = data.get('password') as string;

		if (!identity) {
			return fail(400, { error: 'Please enter your username or email', identity });
		}

		if (!password) {
			return fail(400, { error: 'Please enter your password', identity });
		}

		// Rate limit by IP address — 10 attempts per 15 minutes
		const clientIp = getClientAddress();
		const { limited, retryAfterSecs } = checkRateLimit(`login:${clientIp}`, 10, 15 * 60 * 1000);
		if (limited) {
			return fail(429, {
				error: `Too many login attempts. Please try again in ${Math.ceil(retryAfterSecs / 60)} minute(s).`,
				identity
			});
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

		// Successful login — reset rate limit for this IP
		resetRateLimit(`login:${clientIp}`);

		// Create session and set cookie
		const token = createSession(user.id);
		setSessionCookie(cookies, token);

		throw redirect(303, '/');
	}
};
