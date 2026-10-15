import { fail, redirect } from '@sveltejs/kit';
import type { Actions, PageServerLoad } from './$types';
import { hasAnyUsers, hashPassword, createSession, setSessionCookie } from '$lib/server/auth';
import { db } from '$lib/server/db';
import { inTransaction } from '$lib/server/db/transaction';
import { users } from '$lib/server/db/schema';

export const load: PageServerLoad = async () => {
	if (hasAnyUsers()) {
		throw redirect(303, '/');
	}
	return {};
};

export const actions: Actions = {
	default: async ({ request, cookies }) => {
		// The form is read before anything is checked. Whether a user exists used
		// to be checked first, so two submissions both found none while each
		// waited for its form, and both created a superadmin.
		const data = await request.formData();

		// Looked at here so that a set-up instance answers as it did whatever the
		// form holds, and hashes nothing. It is read again where the user is made.
		if (hasAnyUsers()) {
			throw redirect(303, '/');
		}

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

		// Hashing takes about a quarter of a second, and nothing else can write
		// while a transaction is open, so it is done before one is.
		const passwordHash = hashPassword(password);

		// One transaction: that there is no user yet is read in the one that
		// creates the superadmin, so there cannot be two, and the user and their
		// session are made together.
		const token = inTransaction(() => {
			if (hasAnyUsers()) return null;

			// Create the superadmin user
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

			// Create session
			return createSession(user.id);
		});

		// With no token, somebody else set the instance up in the meantime, and
		// this is answered as it is whenever a user already exists.
		if (token) setSessionCookie(cookies, token);

		throw redirect(303, '/');
	}
};
