import { fail, redirect } from '@sveltejs/kit';
import type { Actions, PageServerLoad } from './$types';
import { db } from '$lib/server/db';
import { afterCommit, inTransaction } from '$lib/server/db/transaction';
import { apiKeys, inviteTokens, users } from '$lib/server/db/schema';
import { eq, and, gt, count } from 'drizzle-orm';
import { hashPassword, createSession, setSessionCookie, endAccountAccess } from '$lib/server/auth';
import { createLogger } from '$lib/server/logger';

const log = createLogger('AUTH');

/**
 * What whoever holds a link that does not work is told, on the page and from
 * the form. One answer for every reason, because an invite that was replaced
 * or cancelled is deleted, and cannot be told from one that never was. An
 * invite is cancelled by a newer one, and by a change of the account's
 * password, email address or role (`endUnusedInvites`, in invites.ts).
 */
const DEAD_LINK =
	'This invite link no longer works. It has expired, it has already been used, or it was cancelled when a ' +
	"newer invite was sent or the account's password, email address or role was changed. Ask an administrator " +
	'to send you a new one.';

export const load: PageServerLoad = async ({ params }) => {
	// The question the form asks, so that the page and the form agree on which
	// links work.
	const invite = usableInvite(params.token);

	if (!invite) {
		return { valid: false, username: '' };
	}

	const user = db.select({ username: users.username, emoji: users.emoji })
		.from(users)
		.where(eq(users.id, invite.userId))
		.get();

	// Setting a password here ends every API key of the account, and the page
	// says how many before the form is sent.
	const keys = db.select({ count: count() })
		.from(apiKeys)
		.where(eq(apiKeys.userId, invite.userId))
		.get();

	return {
		valid: true,
		username: user?.username || '',
		emoji: user?.emoji || '👤',
		apiKeys: keys?.count ?? 0
	};
};

/**
 * The invite, if it can set a password: it has not been used, it has not
 * expired, and its account is not the superadmin's.
 *
 * Nobody may set the superadmin's password but the superadmin, who does so on
 * the Account page with the current one, and no route issues an invite for
 * that account. One written before that rule would otherwise set the only
 * superadmin's password and end every session and key they have, with no way
 * back but a command on the host. An administrator's invite is not refused:
 * the superadmin sends those.
 */
function usableInvite(token: string) {
	const now = new Date().toISOString();
	const found = db.select({ invite: inviteTokens, role: users.role })
		.from(inviteTokens)
		.innerJoin(users, eq(users.id, inviteTokens.userId))
		.where(and(
			eq(inviteTokens.token, token),
			eq(inviteTokens.used, false),
			gt(inviteTokens.expiresAt, now)
		))
		.get();
	if (!found || found.role === 'superadmin') return undefined;
	return found.invite;
}

export const actions: Actions = {
	default: async ({ params, request, cookies }) => {
		const token = params.token;
		const invalid = () => fail(400, { error: DEAD_LINK });

		// The form is read before the invite is looked at. The invite used to be
		// read first, so two submissions of one link both found it unused while
		// each waited for its form.
		const data = await request.formData();
		const password = data.get('password') as string;
		const confirmPassword = data.get('confirmPassword') as string;

		// Looked at here so that a dead link is answered as one whatever the form
		// holds, and is not hashed for. It is read again where it is used.
		if (!usableInvite(token)) return invalid();

		if (!password || password.length < 8) {
			return fail(400, { error: 'Password must be at least 8 characters.' });
		}

		if (password !== confirmPassword) {
			return fail(400, { error: 'Passwords do not match.' });
		}

		// Hashing takes about a quarter of a second, and nothing else can write
		// while a transaction is open, so it is done before one is.
		const passwordHash = hashPassword(password);

		// One transaction: the invite is read and checked as unused in the one
		// that uses it, so it cannot be used twice, and the password, the invite,
		// what setting a password ends and the session change together.
		const sessionToken = inTransaction(() => {
			const invite = usableInvite(token);
			if (!invite) return null;

			// Update user password
			db.update(users)
				.set({ passwordHash })
				.where(eq(users.id, invite.userId))
				.run();

			// Mark token as used
			db.update(inviteTokens)
				.set({ used: true })
				.where(eq(inviteTokens.token, token))
				.run();

			// An invite is how an account is taken back, so using one ends every
			// session the account had, its other invites and its API keys. This
			// one is marked used first, so it is not among the invites deleted.
			const ended = endAccountAccess(invite.userId, { apiKeys: true });
			afterCommit(() =>
				log.info(
					`Password set with an invite for user ${invite.userId} — ended ${ended.sessions} session(s), ` +
						`${ended.invites} other invite(s) and ${ended.apiKeys} API key(s)`,
					{ sessionsEnded: ended.sessions, invitesEnded: ended.invites, apiKeysEnded: ended.apiKeys },
					{ userId: invite.userId }
				)
			);

			// Create session and log them in
			return createSession(invite.userId);
		});
		if (!sessionToken) return invalid();

		setSessionCookie(cookies, sessionToken);

		throw redirect(303, '/');
	}
};
