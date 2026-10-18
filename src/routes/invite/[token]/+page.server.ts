import { fail, redirect } from '@sveltejs/kit';
import type { Actions, PageServerLoad } from './$types';
import { db } from '$lib/server/db';
import { afterCommit, inTransaction } from '$lib/server/db/transaction';
import { apiKeys, inviteTokens, reportSchedules, users, webhooks } from '$lib/server/db/schema';
import { and, eq, count } from 'drizzle-orm';
import { createSession, setSessionCookie, endAccountAccess, namingIds } from '$lib/server/auth';
import { CheckNotMade, PASSWORDS_BUSY, callerHasGone, makePasswordHash } from '$lib/server/passwords';
import { rememberBrowser } from '$lib/server/known-browsers';
import { createLogger } from '$lib/server/logger';
import { usableInvite } from '$lib/server/invites';

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

	return {
		valid: true,
		username: user?.username || '',
		emoji: user?.emoji || '👤',
		apiKeys: keys?.count ?? 0,
		webhooks: hooks?.count ?? 0,
		reportSchedules: schedules?.count ?? 0
	};
};

export const actions: Actions = {
	default: async ({ params, request, cookies, platform }) => {
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
		// what setting a password ends and the session change together.
		const signedIn = inTransaction(() => {
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
			// session the account had, its other invites and its API keys, switches
			// off the webhooks it set and pauses its report schedules (card 2168).
			// This one is marked used first, so it is not among the invites deleted.
			const ended = endAccountAccess(invite.userId, { apiKeys: true, reportSchedules: true });
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

			// Create session and log them in
			return { sessionToken: createSession(invite.userId), userId: invite.userId };
		});
		if (!signedIn) return invalid();

		setSessionCookie(cookies, signedIn.sessionToken);
		// The new password ended every remembered browser of the account; this
		// one is remembered for it (card 2194).
		rememberBrowser(cookies, signedIn.userId, passwordHash);

		throw redirect(303, '/');
	}
};
