import { json, error } from '@sveltejs/kit';
import { db } from '$lib/server/db';
import { afterCommit } from '$lib/server/db/transaction';
import { users } from '$lib/server/db/schema';
import { eq } from 'drizzle-orm';
import {
	createSession,
	endAccountAccess,
	namingIds,
	replacementStart,
	sessionHashIn,
	setSessionCookie,
	whilePasswordHolds
} from '$lib/server/auth';
import { LONGEST_PASSWORD, PASSWORD_TOO_LONG, makePasswordHash } from '$lib/server/passwords';
import { forgetPendingAdd } from '$lib/server/pending-authenticators';
import { rememberBrowser } from '$lib/server/known-browsers';
import { createLogger } from '$lib/server/logger';
import { readBody, readBoolean, readText } from '$lib/server/request-body';
import { requireUser } from '$lib/server/route-guards';
import { confirmStepUp } from '$lib/server/step-up';
import { writeAs } from '$lib/server/write-as';
import { ENDING_IN_MAIL } from '$lib/server/webhooks';
import type { RequestHandler } from './$types';

const log = createLogger('AUTH');

/**
 * PUT — Change own password. Asks for the current password and a code again
 * (`currentPassword`, `currentCode`: card 2771, D7), through the step-up that
 * every listed action asks with (step-up.ts): the wrong ones counted on the
 * session that sent them, the third ending it. The change also clears the
 * warning that someone else entered the password, which asks for it, and
 * forgets an authenticator being added with the old one (card 2772, D1, D6).
 * It pauses the account's report schedules that are on, always (card 2894),
 * and answers `{ success, apiKeysEnded, webhooksSwitchedOff,
 * reportSchedulesPaused }`.
 */
export const PUT: RequestHandler = async ({ request, locals, cookies, url }) => {
	requireUser(locals.user);

	const body = await readBody(request);

	// The route's own fields, read in the guard, before a password is checked
	// or counted (card 2117): whether the account's API keys end with the
	// change, and the webhooks it set are switched off (kept unless asked: the
	// holder has just proved they hold the password, and ending keys stops
	// every script that uses them; anything but true or false is refused
	// rather than read as one or the other), and the new password, text of 8
	// to 1,024 characters (`LONGEST_PASSWORD`, card 2888: the most the step-up
	// will read of it next time). The guard asks who is asking as their account is now
	// (card 2253); it decides nothing: the transaction that writes asks again,
	// before the session this request came by ends there.
	const SHORT = 'New password must be at least 8 characters';
	const {
		actor: { endApiKeys, newPassword },
		userId,
		hash
	} = await confirmStepUp(locals, cookies, body, 'PUT /api/account/password', (caller) => {
		requireUser(caller);
		const endApiKeys = readBoolean(body, 'endApiKeys', {}) ?? false;
		const newPassword = readText(body, 'newPassword', { required: true, min: 8, says: { missing: SHORT, empty: SHORT, invalid: SHORT } });
		if (newPassword.length > LONGEST_PASSWORD) error(400, PASSWORD_TOO_LONG);
		return { endApiKeys, newPassword };
	});

	// The session the replacement takes the start of: the one the step-up
	// counted on, which it has already asked is there.
	const session = sessionHashIn(locals.credential);
	if (!session) throw error(401, 'Not authenticated');

	// Hashing a password takes about a quarter of a second, on a worker
	// thread, and is awaited, which a transaction cannot do. It is done out
	// here, before it.
	const newHash = await makePasswordHash(newPassword, 'known');

	// One transaction: the password, the sessions that end and the session that
	// replaces them change together. A failure after the first used to leave a
	// new password with the old sessions still good, or with no session at all.
	// It runs only while the stored hash is the one the password was checked
	// against; if another request or an administrator changed it in between,
	// nothing is written and the answer is 409, with no second compare (card
	// 2701's code review, S2). In it, the session is asked again, and the
	// account as it is now is changed: the password check and the hash were
	// awaited, and a session can end meanwhile. Asked before the sessions end
	// below, the session this request came by among them; nothing in this
	// request asks it after that, when it has gone.
	const { accountId, newSession, apiKeysEnded, webhooksSwitchedOff, reportSchedulesPaused } = await whilePasswordHolds(userId, hash, () =>
		writeAs(locals, (caller) => {
			const me = requireUser(caller);
			const userId = me.id;

			// The replacement keeps the start of the session it replaces, so
			// that a password alone does not restart the total limit (card
			// 2775, decision 7). A start that cannot be read, or less than a
			// minute left of the total limit (the code review's CS2), is
			// refused before anything is written, and no session is made.
			const startedAt = replacementStart(session, me.role);
			if (startedAt === null) error(401, 'Not authenticated');

			// Update password. The warning that someone else entered the old one
			// goes with it, all three of its columns (card 2772, D6, A16, and the
			// latest signal's moment, CS1): changing the password is the remedy
			// it asks for.
			db.update(users)
				.set({ passwordHash: newHash, securityBanner: null, securityBannerAt: null, securitySignalLastAt: null })
				.where(eq(users.id, userId))
				.run();
			// An authenticator being added with the old password is forgotten
			// once the change is committed (card 2772, D1, S7).
			afterCommit(() => forgetPendingAdd(userId));

			// Every existing session of this user ends, and every invite not yet
			// used, which would set the password again. The API keys end only if
			// the user asked, and the webhooks they set are switched off with them
			// (card 2168): a change that keeps the keys keeps their webhooks. Their
			// report schedules that are on are paused, always (card 2894, D1): a
			// schedule sends a board's activity whether or not anyone is signed
			// in, and the server cannot tell a routine change from a recovery.
			// The Account page says so before the change; the holder turns back
			// on the ones they recognise through the step-up (card 2751).
			// The cause the log and the boards' owners are told, used only when the keys end (card 2923; S5: the mail names nobody).
			const ended = endAccountAccess(userId, {
				apiKeys: endApiKeys,
				cause: { log: `${me.username} changed their password and ended their API keys`, mail: ENDING_IN_MAIL.ownChange }
			});
			afterCommit(() =>
				log.info(
					`Password changed by user — ended ${ended.sessions} session(s), ${ended.invites} invite(s) and ` +
						`${ended.apiKeys} API key(s), switched off ${ended.webhooks} webhook(s) they set up` +
						`${namingIds(ended.webhookIds)} and paused ${ended.reportSchedules} report schedule(s)` +
						namingIds(ended.reportScheduleIds),
					{
						sessionsEnded: ended.sessions,
						invitesEnded: ended.invites,
						apiKeysEnded: ended.apiKeys,
						webhooksSwitchedOff: ended.webhooks,
						webhookIds: ended.webhookIds,
						reportSchedulesPaused: ended.reportSchedules,
						reportScheduleIds: ended.reportScheduleIds
					},
					{ userId }
				)
			);

			// Create a fresh session so the current user stays logged in, with
			// the start of the one it replaces.
			return {
				accountId: userId,
				newSession: createSession(userId, { startedAt }),
				apiKeysEnded: ended.apiKeys,
				webhooksSwitchedOff: ended.webhooks,
				reportSchedulesPaused: ended.reportSchedules
			};
		}));

	setSessionCookie(cookies, newSession, url);
	// The new hash ended every remembered browser of the account; this one,
	// which made the change, is remembered again (card 2194).
	rememberBrowser(cookies, accountId, newHash, url);

	return json({ success: true, apiKeysEnded, webhooksSwitchedOff, reportSchedulesPaused });
};
