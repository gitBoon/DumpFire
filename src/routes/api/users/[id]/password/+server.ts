import { error, json } from '@sveltejs/kit';
import { db } from '$lib/server/db';
import { afterCommit } from '$lib/server/db/transaction';
import { users } from '$lib/server/db/schema';
import { eq } from 'drizzle-orm';
import { endAccountAccess, namingIds, whilePasswordHolds, type SessionUser } from '$lib/server/auth';
import { requireEnabledAccount } from '$lib/server/account-disable';
import { LONGEST_PASSWORD, PASSWORD_TOO_LONG, makePasswordHash } from '$lib/server/passwords';
import { refuseOwnAccount, requireAdmin, requireManagedAccount, requireUser } from '$lib/server/route-guards';
import { confirmStepUp } from '$lib/server/step-up';
import { writeAs } from '$lib/server/write-as';
import { pathId, readBody, readText } from '$lib/server/request-body';
import { ENDING_IN_MAIL } from '$lib/server/webhooks';
import { createLogger } from '$lib/server/logger';
import type { RequestHandler } from './$types';

const log = createLogger('AUTH');

/**
 * PUT — Reset another user's password (admin only). The new one is
 * `password`; the caller's own is asked for again in `currentPassword` (card
 * 2701, step-up.ts), after every refusal that needs none.
 */
export const PUT: RequestHandler = async ({ params, request, locals, cookies }) => {
	requireUser(locals.user);

	const userId = pathId(params.id, 'user');

	// Nobody sets their own password here, an administrator included. This
	// route asks for no current password and leaves the caller's other sessions
	// signed in, so whoever held a session of theirs could keep the account.
	// PUT /api/account/password asks for the one they have and ends the others.
	const OWN = 'Change your own password on the Account page, which asks for your current password';
	refuseOwnAccount(locals.user, userId, OWN);
	requireAdmin(locals.user);

	const body = await readBody(request);

	/**
	 * The user whose password this is, if the caller may set it: the rule is
	 * the one for changing and deleting an account, in route-guards.ts. Asked
	 * of the caller as their account is now, after their own account and their
	 * role are asked again (card 2253); answered with the caller too.
	 */
	const requireTarget = (caller: SessionUser | null) => {
		const actor = requireUser(caller);
		refuseOwnAccount(actor, userId, OWN);
		const target = requireManagedAccount(actor, userId, {
			superadmin: 'Only superadmin can reset superadmin password',
			admin: 'Only superadmin can reset an admin\'s password'
		});
		// A disabled account's password is not set (card 2671, D18): enable it first.
		requireEnabledAccount(target);
		return { actor, target };
	};

	// Hashing takes about a quarter of a second, on a worker thread, and is
	// awaited, which a transaction cannot do, so the hash is made out here,
	// before it, in the first lane: the caller holds a session. The
	// user is looked at first, by the caller as their account is now, so that
	// a request that will be refused is not hashed for, and is read again in
	// the transaction. The password is read once the user is found and the
	// caller may set it (card 2117, R1): text, where a number reached bcrypt,
	// which threw, a 500.
	requireTarget(writeAs(locals, (caller) => requireUser(caller)));
	const SHORT = 'Password must be at least 8 characters';
	const password = readText(body, 'password', { required: true, min: 8, says: { missing: SHORT, empty: SHORT, invalid: SHORT } });
	// No longer than the step-up will read of it (card 2888).
	if (password.length > LONGEST_PASSWORD) throw error(400, PASSWORD_TOO_LONG);

	// The caller's own password, asked for again (card 2701): setting another
	// account's is a takeover. The account is asked again first, read only, so
	// that a request that will be refused costs no check and no guess; then the
	// new password is hashed.
	const { userId: callerId, hash } = await confirmStepUp(
		locals,
		cookies,
		body,
		'PUT /api/users/[id]/password',
		(caller) => requireTarget(caller)
	);
	const passwordHash = await makePasswordHash(password, 'known');

	// One transaction: the user is read and checked in the one that changes the
	// password and ends their sessions. A failure between the two used to leave
	// a reset password with every old session still signed in. The hash was
	// awaited, so the session is asked again, and the caller decided again by
	// the account as it is now (card 2253). It runs only while the caller's
	// stored hash is the one their password was checked against.
	const ended = await whilePasswordHolds(callerId, hash, () => writeAs(locals, (caller) => {
		const { actor, target } = requireTarget(caller);

		db.update(users).set({ passwordHash }).where(eq(users.id, userId)).run();

		// A reset is meant to take an account back from whoever held its password
		// or a session, so it ends what lets them in as that user: every session,
		// every invite not yet used, which would set the password again, and every
		// API key, which outlived a reset until it was revoked by hand. It also
		// stops what they could have left sending things out (card 2168): every
		// webhook the account set is switched off, and every report schedule of
		// it paused. A webhook nobody is recorded as having set, one made before
		// that was recorded, is left on, and is looked over by hand after a reset.
		const access = endAccountAccess(userId, {
			apiKeys: true,
			cause: { log: `${target.username}'s password was reset by ${actor.username}`, mail: ENDING_IN_MAIL.passwordReset }
		});
		afterCommit(() =>
			log.info(
				`Password reset for user ${userId} ("${target.username}") by "${actor.username}" — ended ` +
					`${access.sessions} session(s), ${access.invites} invite(s) and ${access.apiKeys} API key(s), ` +
					`switched off ${access.webhooks} webhook(s) they set up${namingIds(access.webhookIds)} and ` +
					`paused ${access.reportSchedules} report schedule(s)${namingIds(access.reportScheduleIds)}`,
				{
					targetUserId: userId,
					resetBy: actor.id,
					sessionsEnded: access.sessions,
					invitesEnded: access.invites,
					apiKeysEnded: access.apiKeys,
					webhooksSwitchedOff: access.webhooks,
					webhookIds: access.webhookIds,
					reportSchedulesPaused: access.reportSchedules,
					reportScheduleIds: access.reportScheduleIds
				},
				{ userId: actor.id }
			)
		);
		return access;
	}));

	return json({
		success: true,
		sessionsEnded: ended.sessions,
		apiKeysEnded: ended.apiKeys,
		webhooksSwitchedOff: ended.webhooks,
		reportSchedulesPaused: ended.reportSchedules
	});
};
