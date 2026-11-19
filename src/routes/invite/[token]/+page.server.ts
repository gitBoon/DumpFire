import { fail } from '@sveltejs/kit';
import type { Actions, PageServerLoad } from './$types';
import { db } from '$lib/server/db';
import { afterCommit, inTransaction } from '$lib/server/db/transaction';
import { apiKeys, inviteTokens, reportSchedules, users, webhooks } from '$lib/server/db/schema';
import { and, eq, count, isNull } from 'drizzle-orm';
import { endAccountAccess, namingIds } from '$lib/server/auth';
import { ENDING_IN_MAIL, webhooksReadableBy } from '$lib/server/webhooks';
import { settingsSetBy } from '$lib/server/setting-setters';
import { CheckNotMade, LONGEST_PASSWORD, PASSWORD_TOO_LONG, PASSWORDS_BUSY, callerHasGone, makePasswordHash } from '$lib/server/passwords';
import { createLogger } from '$lib/server/logger';
import { usableInvite } from '$lib/server/invites';
import { currentMfaKey } from '$lib/server/mfa-key';
import { readChallengeToken } from '$lib/server/sign-in-challenges';
import { NO_MFA_KEY, goToSetUp, issueSetUpChallenge } from '$lib/server/second-step';

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

	// Setting a password here ends every API key of the account, switches off
	// every webhook it set that is on and pauses every report schedule of it
	// that is on (card 2168), and the page says how many of each before the
	// form is sent.
	const keys = db.select({ count: count() })
		.from(apiKeys)
		.where(eq(apiKeys.userId, invite.userId))
		.get();
	const hooks = db.select({ count: count() })
		.from(webhooks)
		.where(and(eq(webhooks.setBy, invite.userId), eq(webhooks.active, true)))
		.get();
	const schedules = db.select({ count: count() })
		.from(reportSchedules)
		.where(and(eq(reportSchedules.userId, invite.userId), eq(reportSchedules.enabled, true)))
		.get();
	// And those it set that are already switched off with no hold, which setting a password holds, and whose
	// boards' owners it mails (card 2923's code review, E9 and S7): the page says so where none is on.
	const alreadyOff = db.select({ count: count() })
		.from(webhooks)
		.where(and(eq(webhooks.setBy, invite.userId), eq(webhooks.active, false), isNull(webhooks.heldBecause)))
		.get();

	// Whether setting a password here holds webhooks of others whose secret the account could read (card 2935, P8):
	// said in words, never a number, and only where it provably read nothing is not so (P1).
	const holdsReadable = webhooksReadableBy(invite.userId) > 0;
	// Whether the account set anything in force (card 2922): setting a password here holds it for the superadmin's
	// review. A yes or no alone, never its names, to whoever holds the link (the code review's C10).
	const holdsSettings = settingsSetBy(invite.userId).has(invite.userId);

	return {
		valid: true,
		holdsReadable,
		holdsSettings,
		username: user?.username || '',
		emoji: user?.emoji || '👤',
		apiKeys: keys?.count ?? 0,
		webhooks: hooks?.count ?? 0,
		webhooksAlreadyOff: alreadyOff?.count ?? 0,
		reportSchedules: schedules?.count ?? 0
	};
};

export const actions: Actions = {
	default: async ({ params, request, cookies, platform, url }) => {
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

		// Using the invite leads on to setting up two-step sign-in (card 2769),
		// which needs the MFA key: without it, nothing is hashed or set, so that
		// no account is left with a new password and no way to finish
		// (decision 28).
		if (currentMfaKey() === null) return fail(503, { error: NO_MFA_KEY });

		if (!password || password.length < 8) {
			return fail(400, { error: 'Password must be at least 8 characters.' });
		}

		// No longer than the step-up will read of it (card 2888).
		if (password.length > LONGEST_PASSWORD) {
			return fail(400, { error: `${PASSWORD_TOO_LONG}.` });
		}

		if (password !== confirmPassword) {
			return fail(400, { error: 'Passwords do not match.' });
		}

		// Hashing takes about a quarter of a second, on a worker thread, and is
		// awaited, which a transaction cannot do, so it is done before one is.
		// In the second lane, as a sign-in's check is: whoever holds the link is
		// not yet known to the server. Two submissions at once each hash; the
		// transaction below lets one in. Not made when too many checks are
		// already waiting, or once the caller has gone.
		let passwordHash: string;
		try {
			passwordHash = await makePasswordHash(password, 'other', { gone: callerHasGone(platform) });
		} catch (err) {
			if (err instanceof CheckNotMade) return fail(503, { error: PASSWORDS_BUSY });
			throw err;
		}

		// One transaction: the invite is read and checked as unused in the one
		// that uses it, so it cannot be used twice, and the password, the invite,
		// what setting a password ends and the set-up challenge change together.
		const previousToken = readChallengeToken(request, url);
		const setUp = inTransaction(() => {
			const invite = usableInvite(token);
			if (!invite) return null;

			// Update user password
			db.update(users)
				.set({ passwordHash })
				.where(eq(users.id, invite.userId))
				.run();

			// Mark this invite used: the row read above, by its hash.
			db.update(inviteTokens)
				.set({ used: true })
				.where(eq(inviteTokens.tokenHash, invite.tokenHash))
				.run();

			// An invite is how an account is taken back, so using one ends every
			// session the account had, its other invites and its API keys, switches
			// off the webhooks it set and pauses its report schedules (card 2168).
			// This one is marked used first, so it is not among the invites deleted.
			// The account's name, for the cause the boards' owners are told (card 2923): one read, no write.
			const username = db.select({ username: users.username }).from(users).where(eq(users.id, invite.userId)).get()?.username ?? `user ${invite.userId}`;
			// The invite being used is left out of whether the account may have read a secret (card 2935, P1).
			const ended = endAccountAccess(invite.userId, {
				apiKeys: true,
				cause: { log: `${username} set their password with an invite`, mail: ENDING_IN_MAIL.invite },
				exceptInvite: invite.tokenHash
			});
			afterCommit(() =>
				log.info(
					`Password set with an invite for user ${invite.userId} — ended ${ended.sessions} session(s), ` +
						`${ended.invites} other invite(s) and ${ended.apiKeys} API key(s), switched off ` +
						`${ended.webhooks} webhook(s) they set up${namingIds(ended.webhookIds)} and paused ` +
						`${ended.reportSchedules} report schedule(s)${namingIds(ended.reportScheduleIds)}`,
					{
						sessionsEnded: ended.sessions,
						invitesEnded: ended.invites,
						apiKeysEnded: ended.apiKeys,
						webhooksSwitchedOff: ended.webhooks,
						webhookIds: ended.webhookIds,
						reportSchedulesPaused: ended.reportSchedules,
						reportScheduleIds: ended.reportScheduleIds
					},
					{ userId: invite.userId }
				)
			);

			// No session: the invite leads on to setting up two-step sign-in
			// (card 2769), and only that signs in. The challenge is issued
			// after what setting a password ends, which ends pending sign-ins.
			return issueSetUpChallenge(invite.userId, passwordHash, previousToken, 'invite');
		});
		if (!setUp) return invalid();

		goToSetUp(cookies, url, setUp, 'an invite');
	}
};
