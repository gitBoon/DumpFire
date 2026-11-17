import { fail, redirect } from '@sveltejs/kit';
import type { Actions, PageServerLoad } from './$types';
import { hasAnyUsers } from '$lib/server/auth';
import { CheckNotMade, LONGEST_PASSWORD, PASSWORD_TOO_LONG, PASSWORDS_BUSY, callerHasGone, makePasswordHash } from '$lib/server/passwords';
import { db } from '$lib/server/db';
import { inTransaction } from '$lib/server/db/transaction';
import { users } from '$lib/server/db/schema';
import { currentMfaKey } from '$lib/server/mfa-key';
import { readChallengeToken } from '$lib/server/sign-in-challenges';
import { NO_MFA_KEY, goToSetUp, issueSetUpChallenge } from '$lib/server/second-step';

export const load: PageServerLoad = async () => {
	if (hasAnyUsers()) {
		throw redirect(303, '/');
	}
	return {};
};

export const actions: Actions = {
	default: async ({ request, cookies, platform, url }) => {
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

		// No longer than the step-up will read of it (card 2888).
		if (password.length > LONGEST_PASSWORD) {
			return fail(400, { error: PASSWORD_TOO_LONG, username, email });
		}

		if (password !== confirmPassword) {
			return fail(400, { error: 'Passwords do not match', username, email });
		}

		// The superadmin sets up two-step sign-in next (card 2769), which needs
		// the MFA key: without it, nothing is hashed or made, so that no account
		// is left with no way to finish (decision 28).
		if (currentMfaKey() === null) return fail(503, { error: NO_MFA_KEY, username, email });

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
		// set-up challenge are made together.
		const previousToken = readChallengeToken(request, url);
		const setUp = inTransaction(() => {
			if (hasAnyUsers()) return null;

			// Create the superadmin user. Never with leave to set up two-step
			// sign-in on the password alone (card 2769, decision 9): a set-up
			// left unfinished is recovered with `node scripts/mfa-reset.mjs`.
			const user = db.insert(users)
				.values({
					username,
					email: email.toLowerCase(),
					passwordHash,
					emoji,
					role: 'superadmin',
					mfaPasswordEnrol: 0
				})
				.returning()
				.get();

			// No session: only setting up two-step sign-in signs in (card 2769).
			return issueSetUpChallenge(user.id, passwordHash, previousToken, 'setup');
		});

		// With none, somebody else set the instance up in the meantime, and this
		// is answered as it is whenever a user already exists. With one, the
		// browser goes on to set up two-step sign-in.
		if (!setUp) throw redirect(303, '/');

		goToSetUp(cookies, url, setUp, 'the first-run set-up');
	}
};
