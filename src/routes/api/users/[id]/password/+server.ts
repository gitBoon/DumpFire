import { json, error } from '@sveltejs/kit';
import { db } from '$lib/server/db';
import { afterCommit, inTransaction } from '$lib/server/db/transaction';
import { users } from '$lib/server/db/schema';
import { eq } from 'drizzle-orm';
import { hashPassword, endAccountAccess } from '$lib/server/auth';
import { isAdmin } from '$lib/server/board-access';
import { requireManagedAccount } from '$lib/server/route-guards';
import { pathId, readBody, readText } from '$lib/server/request-body';
import { createLogger } from '$lib/server/logger';
import type { RequestHandler } from './$types';

const log = createLogger('AUTH');

/** PUT — Reset another user's password (admin only). */
export const PUT: RequestHandler = async ({ params, request, locals }) => {
	if (!locals.user) throw error(401, 'Not authenticated');
	const actor = locals.user;

	const userId = pathId(params.id, 'user');

	// Nobody sets their own password here, an administrator included. This
	// route asks for no current password and leaves the caller's other sessions
	// signed in, so whoever held a session of theirs could keep the account.
	// PUT /api/account/password asks for the one they have and ends the others.
	if (actor.id === userId) {
		throw error(403, 'Change your own password on the Account page, which asks for your current password');
	}

	if (!isAdmin(actor)) {
		throw error(403, 'Forbidden');
	}

	const body = await readBody(request);

	/**
	 * The user whose password this is, if the caller may set it: the rule is
	 * the one for changing and deleting an account, in route-guards.ts.
	 */
	const requireTarget = () =>
		requireManagedAccount(actor, userId, {
			superadmin: 'Only superadmin can reset superadmin password',
			admin: 'Only superadmin can reset an admin\'s password'
		});

	// Hashing takes about a quarter of a second, and nothing else can write
	// while a transaction is open, so the hash is made out here, before it. The
	// user is looked at first so that a request that will be refused is not
	// hashed for, and is read again in the transaction. The password is read
	// once the user is found and the caller may set it (card 2117, R1): text,
	// where a number reached bcrypt, which threw, a 500.
	requireTarget();
	const SHORT = 'Password must be at least 8 characters';
	const password = readText(body, 'password', { required: true, min: 8, says: { missing: SHORT, empty: SHORT, invalid: SHORT } });
	const passwordHash = hashPassword(password);

	// One transaction: the user is read and checked in the one that changes the
	// password and ends their sessions. A failure between the two used to leave
	// a reset password with every old session still signed in.
	const ended = inTransaction(() => {
		const target = requireTarget();

		db.update(users).set({ passwordHash }).where(eq(users.id, userId)).run();

		// A reset is meant to take an account back from whoever held its password
		// or a session, so it ends what lets them in as that user: every session,
		// every invite not yet used, which would set the password again, and every
		// API key, which outlived a reset until it was revoked by hand. It does
		// not end all they could have left behind. A webhook has no owner, so the
		// ones registered with the account's keys keep receiving their boards'
		// events, and the account's report schedules keep mailing their
		// recipients. Those are looked over by hand after a reset.
		const access = endAccountAccess(userId, { apiKeys: true });
		afterCommit(() =>
			log.info(
				`Password reset for user ${userId} ("${target.username}") by "${actor.username}" — ended ` +
					`${access.sessions} session(s), ${access.invites} invite(s) and ${access.apiKeys} API key(s)`,
				{
					targetUserId: userId,
					resetBy: actor.id,
					sessionsEnded: access.sessions,
					invitesEnded: access.invites,
					apiKeysEnded: access.apiKeys
				},
				{ userId: actor.id }
			)
		);
		return access;
	});

	return json({ success: true, sessionsEnded: ended.sessions, apiKeysEnded: ended.apiKeys });
};
