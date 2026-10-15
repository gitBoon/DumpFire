import { fail, redirect } from '@sveltejs/kit';
import type { Actions, PageServerLoad } from './$types';
import { hasAnyUsers, createSession, setSessionCookie } from '$lib/server/auth';
import { CheckNotMade, PASSWORDS_BUSY, callerHasGone, makePasswordHash } from '$lib/server/passwords';
import { rememberBrowser } from '$lib/server/known-browsers';
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
	default: async ({ request, cookies, platform }) => {
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

		// Hashing takes about a quarter of a second, on a worker thread, and is
		// awaited, which a transaction cannot do, so it is done before one is.
		// In the second lane: nobody is signed in yet. Two submissions at once
		// each hash; the transaction below makes one superadmin. Not made when
		// too many checks are already waiting, or once the caller has gone.
		let passwordHash: string;
		try {
			passwordHash = await makePasswordHash(password, 'other', { gone: callerHasGone(platform) });
		} catch (err) {
			if (err instanceof CheckNotMade) return fail(503, { error: PASSWORDS_BUSY, username, email });
			throw err;
		}

		// One transaction: that there is no user yet is read in the one that
		// creates the superadmin, so there cannot be two, and the user and their
		// session are made together.
		const signedIn = inTransaction(() => {
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
			return { token: createSession(user.id), userId: user.id };
		});

		// With no token, somebody else set the instance up in the meantime, and
		// this is answered as it is whenever a user already exists. With one,
		// the browser is remembered for the superadmin (card 2194).
		if (signedIn) {
			setSessionCookie(cookies, signedIn.token);
			rememberBrowser(cookies, signedIn.userId, passwordHash);
		}

		throw redirect(303, '/');
	}
};
