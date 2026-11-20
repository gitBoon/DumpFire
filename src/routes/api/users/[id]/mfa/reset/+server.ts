import { error, json } from '@sveltejs/kit';
import { afterCommit } from '$lib/server/db/transaction';
import { namingIds, whilePasswordHolds, type SessionUser } from '$lib/server/auth';
import { NO_LINK_ADDRESS, isSmtpConfigured, linkBaseUrl, linkBaseUrlWithoutAppUrlSetting, mailCannotSendProblem, mailProblemWords } from '$lib/server/email';
import { ENROLMENT_LINK_NOT_GIVEN, enrolmentLinkNotGiven } from '$lib/server/invite-link';
import { sha256Hex } from '$lib/server/mfa-crypto';
import { ENROLMENT_LINK_PATH, resetTwoStep, twoStepResetMeta } from '$lib/server/mfa-store';
import { sendMfaResetNotice, type NoticeKey, type NoticeWebhook } from '$lib/server/notifications';
import { refuseOwnAccount, requireAdmin, requireManagedAccount, requireUser } from '$lib/server/route-guards';
import { requireEnabledAccount } from '$lib/server/account-disable';
import { liveApiKeysOf, webhooksByIds } from '$lib/server/second-step';
import { settingsSetBy, type SettingsRemoved } from '$lib/server/setting-setters';
import { confirmStepUp } from '$lib/server/step-up';
import { writeAs } from '$lib/server/write-as';
import { pathId, readBody } from '$lib/server/request-body';
import { createLogger } from '$lib/server/logger';
import { ENDING_IN_MAIL } from '$lib/server/webhooks';
import { heldOfOthersWords } from '$lib/api';
import type { RequestHandler } from './$types';

const log = createLogger('AUTH');

/** How many report schedules the reset paused, as the message says it (card 2894, D2): nothing when none was on. */
const pausedWords = (count: number): string =>
	count === 0 ? '' : count === 1 ? ' Their 1 report schedule was paused.' : ` Their ${count} report schedules were paused.`;

/** `2026-11-01`, `2026-11-01 and 2026-11-10`, `2026-11-01, 2026-11-05 and 2026-11-10`: the days things were made. */
function daysInWords(stamps: string[]): string {
	const days = stamps.map((at) => at.slice(0, 10));
	return days.length <= 1 ? (days[0] ?? '') : `${days.slice(0, -1).join(', ')} and ${days[days.length - 1]}`;
}

/**
 * The account's live API keys the reset ended and the webhooks it set that
 * the reset switched off (card 2915, decision 6; card 2894, S14): how many of
 * each and, where the link is given (`linkShown`), the day each was made, and
 * never a key's name, a board's name or a host (the code review's CS2: the
 * administrator may not be able to open the board, and the admin pages never
 * show a key's name). The names are in the notice mailed to the holder, which
 * says so where it went. Where the link is withheld, the counts alone, and
 * nothing where there were none.
 */
function endedWords(ended: { apiKeys: NoticeKey[]; webhooks: NoticeWebhook[] }, mailSent: boolean, linkShown: boolean): string {
	const keys = ended.apiKeys.length;
	const hooks = ended.webhooks.length;
	if (keys === 0 && hooks === 0) return linkShown ? ' They had no API key and no webhook they set up.' : '';
	const madeKeys = linkShown ? ` (made ${daysInWords(ended.apiKeys.map((key) => key.createdAt))})` : '';
	const madeHooks = linkShown ? ` (made ${daysInWords(ended.webhooks.map((hook) => hook.createdAt))})` : '';
	const keyWords = `${keys} API key${keys === 1 ? '' : 's'}${madeKeys} ${keys === 1 ? 'was' : 'were'} ended`;
	const hookWords = `${hooks} webhook${hooks === 1 ? '' : 's'} they set up${madeHooks}`;
	const hookWas = hooks === 1 ? 'was' : 'were';
	const both = keys > 0 && hooks > 0;
	const where = mailSent
		? `; ${both ? 'the lists are' : 'the list is'} in the notice mailed to them.`
		: `; the notice with ${both ? 'the lists' : 'the list'} was not sent: tell them how many ended and the day each was made.`;
	if (!linkShown) {
		if (hooks === 0) return ` Their ${keyWords}.`;
		if (keys === 0) return ` The ${hookWords} ${hookWas} switched off.`;
		return ` Their ${keyWords} and the ${hookWords} switched off.`;
	}
	if (hooks === 0) return ` Their ${keyWords}, and they had no webhook they set up${where}`;
	if (keys === 0) return ` They had no API key, and the ${hookWords} ${hookWas} switched off${where}`;
	return ` Their ${keyWords} and the ${hookWords} switched off${where}`;
}

/**
 * The webhooks of others whose secret the account could read that the reset switched off or held (card 2935's code
 * review, C4), as the reset and disable toasts say them (`heldOfOthersWords` in $lib/api.ts): nothing for none.
 */
function readableHeldWords(n: number): string {
	return n > 0 ? ` ${heldOfOthersWords(n)}.` : '';
}

/**
 * What the reset is refused with where the App URL the account set is the
 * only address this server has for the link (card 2922, its plan's R8): the
 * reset would hold it for review and leave no address, so it is refused
 * before anything is held or ended, and the words give the step to take now.
 */
const APP_URL_HELD_NO_ADDRESS =
	"The App URL this account set is the only address this server has for the set-up link, and the reset would hold it for review. " +
	'Disable the account, or reset its password, now. Then set APP_URL on the host, or save the App URL yourself, and reset its two-step sign-in. Nothing was changed.';

/**
 * The settings the account set that were in force, as their removal would
 * read them (`settingsSetBy`; card 2915, S1), which the reset holds for the
 * superadmin's review (card 2922): the mail settings, how many backup
 * destinations, never their names, and the App URL. Said only where the link
 * is given, as what the account kept is (the code review's CS2).
 */
function settingsWords(set: SettingsRemoved | null): string {
	if (set === null) return '';
	const count = set.destinations.length;
	const parts = [
		set.mail ? 'the mail settings' : null,
		count === 0 ? null : `${count} backup destination${count === 1 ? '' : 's'}`,
		set.appUrl ? 'the App URL' : null
	].filter((part) => part !== null);
	if (parts.length === 0) return '';
	const listed = parts.length === 1 ? parts[0] : `${parts.slice(0, -1).join(', ')} and ${parts[parts.length - 1]}`;
	// One App URL or one destination alone is "it"; the mail settings, or more than one, "them".
	const one = parts.length === 1 && !set.mail && (set.appUrl || count === 1);
	return (
		` ${listed.charAt(0).toUpperCase()}${listed.slice(1)} they set ${one ? 'is' : 'are'} held for review: nothing is sent to ` +
		`${one ? 'it' : 'them'} until you keep or remove ${one ? 'it' : 'them'} under Settings held for review on the admin page.`
	);
}

/**
 * POST — Reset another account's two-step sign-in (card 2773): its
 * authenticators and recovery codes are removed, its wrong-code counts set
 * back, its sessions, unused invites, pending sign-ins and enrolment links
 * ended, its report schedules that are on paused (card 2894, D2), its API
 * keys ended and the webhooks it set that are on switched off, with the hold
 * 'setter access ended' (card 2915, decision 1: always, with no box, as an
 * administrator's password reset), and one new enrolment link issued
 * (`resetTwoStep`, decision 11). Its password is kept: the holder lost a
 * device, not the password; but a key skips the second factor, so one made by
 * whoever took the device would outlive the reset. The message says how many
 * schedules were paused, and how many live keys ended and webhooks were
 * switched off; where it gives the link, with the day each was made, never
 * their names (S14; the code review's CS2: the mailed notice names them), and
 * what settings the account set, to review (card 2915, S1): the administrator
 * is the one channel sure to reach the holder (S16).
 * For an account with no factor it issues a fresh link (decision 4).
 *
 * Shaped as PUT /api/users/[id]/password is: the caller's own account is
 * refused, whose account they may reset is the one rule in route-guards.ts,
 * and the caller's own password is asked for again in `currentPassword`
 * (card 2701, step-up.ts), after every refusal that needs none. The
 * superadmin's two-step sign-in is reset only on the host (decision 10).
 *
 * The link is given to the caller, once, in the answer, never mailed
 * (decision 6): whoever stole the phone may know the password and have
 * changed the account's address. The account's address is sent a notice
 * that holds no link (decision 7), with the same count and the lists of what
 * ended, once the reset is committed, and awaited;
 * then three things are read again before the link is put in the answer
 * (decision 15, `enrolmentLinkNotGiven` in invite-link.ts, shared with the
 * create's link since card 2851): the caller's session is still open
 * and an administrator's, the caller may still manage the account, and the
 * link is still the account's. If one fails the reset stands, the link is
 * withheld, and the answer says to run the reset again.
 *
 *     { success, enrolmentUrl | null, mailSent, mailProblem?, factorsRemoved,
 *       recoveryCodesRemoved, sessionsEnded, challengesEnded, invitesEnded,
 *       apiKeysEnded, webhooksSwitchedOff, readableWebhooksHeld, reportSchedulesPaused, settingsHeld, message }
 *
 * `settingsHeld` (card 2922): the mail settings, App URL and backup
 * destinations the account set that the reset held for the superadmin's
 * review, `{ mail, appUrl, destinations }`, or null for none. The message says
 * them by count where the link is given. A reset whose hold of the account's
 * App URL would leave no address for the link is refused 503 before the
 * password, and nothing is held or ended (its plan's R8).
 *
 * `readableWebhooksHeld` (card 2935) counts the webhooks of others whose
 * secret the account could read, switched off or held; the message says how
 * many in both its branches where there were any (its code review, C4).
 *
 * `apiKeysEnded` counts every key row ended, one already ended included, as
 * the password reset's does; the message counts the live ones (card 2915).
 *
 * answered with no-store: it holds a credential.
 */
export const POST: RequestHandler = async ({ params, request, locals, url, cookies }) => {
	requireUser(locals.user);

	const userId = pathId(params.id, 'user');

	// Nobody resets their own two-step sign-in here, an administrator included:
	// this asks for no second factor, and would hand whoever held the caller's
	// session and password a link to enrol their own.
	const OWN = 'Manage your own two-step sign-in on the Account page';
	refuseOwnAccount(locals.user, userId, OWN);
	requireAdmin(locals.user);

	const body = await readBody(request);

	/**
	 * Every refusal of the reset, read only: the caller as their account is
	 * now, their own account, whose account they may reset, and the link's
	 * address. Asked before the password, and again in the transaction that
	 * resets.
	 */
	const refusals = (caller: SessionUser | null) => {
		const actor = requireAdmin(caller);
		refuseOwnAccount(actor, userId, OWN);
		const target = requireManagedAccount(actor, userId, {
			superadmin: "Only the server's host can reset the superadmin's two-step sign-in, with scripts/mfa-reset.mjs",
			admin: "Only superadmin can reset an admin's two-step sign-in"
		});
		// A disabled account's two-step sign-in is not reset (card 2671, D18): enable it first.
		requireEnabledAccount(target);

		// The address the link begins with is this server's configuration and
		// never what the request says: see linkBaseUrl. With none there is no
		// link to give, and a reset with no link would leave the account with no
		// way to set up a new authenticator (decision 5). The reset holds the App
		// URL the account set (card 2922), so the address is the one left once it
		// is held, asked here, before the password, so that a reset that would
		// leave none is refused before anything is held or ended (its plan's R8).
		const set = settingsSetBy(target.id).get(target.id) ?? null;
		const holdsAppUrl = set !== null && set.appUrl;
		const baseUrl = holdsAppUrl ? linkBaseUrlWithoutAppUrlSetting(url) : linkBaseUrl(url);
		if (baseUrl === null) {
			throw error(503, holdsAppUrl ? APP_URL_HELD_NO_ADDRESS : NO_LINK_ADDRESS);
		}

		return { actor, target, baseUrl, set };
	};

	// The caller's password, asked for again (card 2701): a reset hands them a
	// link that sets up another account's second factor.
	const { userId: callerId, hash } = await confirmStepUp(locals, cookies, body, 'POST /api/users/[id]/mfa/reset', (caller) =>
		refusals(caller)
	);

	// One transaction: the account is read and the caller checked in the one
	// that resets it, so the role that was checked is the role of the account
	// the link is for. It asks first whether the session is still open, and
	// who its account is now (card 2253), and runs only while the caller's
	// stored hash is the one their password was checked against.
	const done = await whilePasswordHolds(callerId, hash, () =>
		writeAs(locals, (caller) => {
			const { actor, target, set } = refusals(caller);
			// The live keys, read before the reset deletes them (card 2915): the message counts them, and
			// the notice names them.
			const ending = liveApiKeysOf(target.id, Date.now());
			// `set`: the settings the account set that are in force, read as their removal would read them (card 2915,
			// S1), which the reset now holds for the superadmin's review (card 2922): the message names them.
			const reset = resetTwoStep(target.id, 'admin-reset', {
				cause: { log: `${target.username}'s two-step sign-in was reset by ${actor.username}`, mail: ENDING_IN_MAIL.twoStepReset }
			});
			// The link's address asked again once the hold is written, as every link reads it (R8): none, and the
			// reset is rolled back whole.
			const baseUrl = linkBaseUrl(url);
			if (baseUrl === null) throw error(503, set !== null && set.appUrl ? APP_URL_HELD_NO_ADDRESS : NO_LINK_ADDRESS);
			// The webhooks, read after, by the switch-off's own ids (S5): the list is exactly what was
			// switched off, which the switch-off leaves in place to be read.
			const switchedOff = webhooksByIds(reset.webhookIds);

			// The counts and the two accounts, and never the token or the link.
			// scripts/mfa-reset.mjs writes the same meta (S15, `twoStepResetMeta`).
			afterCommit(() =>
				log.critical(
					`Two-step sign-in reset for user ${target.id} ("${target.username}") by "${actor.username}": removed ` +
						`${reset.factors} factor(s) and ${reset.recoveryCodes} recovery code(s), ended ${reset.sessions} ` +
						`session(s), ${reset.challenges} pending sign-in(s), ${reset.invites} invite(s) and ${reset.apiKeys} ` +
						`API key(s), switched off ${reset.webhooks} webhook(s) they set up${namingIds(reset.webhookIds)}, and paused ` +
						`${reset.reportSchedules} report schedule(s)${namingIds(reset.reportScheduleIds)}; an enrolment link was issued`,
					twoStepResetMeta(target.id, actor.id, reset),
					{ userId: actor.id }
				)
			);
			return { actor, target, baseUrl, reset, ended: { apiKeys: ending, webhooks: switchedOff }, set };
		})
	);

	// After the commit, and awaited: an effect never starts inside a
	// transaction. Not attempted where mail is not set up, or its password is
	// missing, as a restore leaves it (card 2169): the reset stands either way.
	const { actor, target, baseUrl, reset, ended, set } = done;
	let mailSent = false;
	let mailProblem: string | undefined;
	if (isSmtpConfigured()) {
		// Held for the superadmin's review too (card 2922, R12), as the reset itself may have held them.
		const cannot = mailCannotSendProblem();
		if (cannot !== null) {
			mailProblem = mailProblemWords(cannot);
		} else {
			// Whether it had an authenticator picks what the notice says was lost (card 2773's review); the
			// schedules paused (card 2894, S14) and the keys and webhooks ended (card 2915) are said as the message
			// says them, each named.
			const outcome = await sendMfaResetNotice(target.email, target.username, actor.username, reset.factors > 0, {
				schedulesPaused: reset.reportSchedules,
				apiKeysEnded: ended.apiKeys,
				webhooksSwitchedOff: ended.webhooks
			});
			if (outcome.sent) mailSent = true;
			else mailProblem = mailProblemWords(outcome.problem);
		}
	}

	const counts = {
		factorsRemoved: reset.factors,
		recoveryCodesRemoved: reset.recoveryCodes,
		sessionsEnded: reset.sessions,
		challengesEnded: reset.challenges,
		invitesEnded: reset.invites,
		apiKeysEnded: reset.apiKeys,
		webhooksSwitchedOff: reset.webhooks,
		// Card 2935: the webhooks of others whose secret the account could read, switched off or held.
		readableWebhooksHeld: reset.readableWebhooks,
		reportSchedulesPaused: reset.reportSchedules,
		// Card 2922: what the account set that the reset held for review, or null for nothing.
		settingsHeld: set
	};
	// The schedules paused and the keys and webhooks ended are said in both of the message's branches (card
	// 2894, E24; card 2915): the reset stands either way. When each was made, and the settings the account
	// set, only where the link is given: the caller who may no longer manage the account, or whose session
	// has ended, is told nothing more of it than the counts (the code review's CS2).
	const pausedSaid = pausedWords(reset.reportSchedules);
	// The webhooks of others whose secret they could read, by count, in both branches (card 2935's code review, C4).
	const readableSaid = readableHeldWords(reset.readableWebhooks);
	const shownSaid = `${pausedSaid}${endedWords(ended, mailSent, true)}${readableSaid}${settingsWords(set)}`;
	const withheldSaid = `${pausedSaid}${endedWords(ended, mailSent, false)}${readableSaid}`;
	const told = mailSent ? ` ${target.username} was sent a notice that holds no link.` : '';
	const notGiven = enrolmentLinkNotGiven(locals.credential, actor.id, target.id, sha256Hex(reset.token));

	if (notGiven !== null) {
		log.warn(
			`The enrolment link of user ${target.id}, issued by user ${actor.id}'s reset, was not given to them: ${ENROLMENT_LINK_NOT_GIVEN[notGiven]}`,
			{ accountId: target.id, check: notGiven },
			{ userId: actor.id }
		);
		return json(
			{
				success: true,
				enrolmentUrl: null,
				mailSent,
				...(mailProblem === undefined ? {} : { mailProblem }),
				...counts,
				message:
					`${target.username}'s two-step sign-in was reset, but its link cannot be shown to you now. Run the ` +
					`reset again to issue a new one.${withheldSaid}${told}`
			},
			{ headers: { 'Cache-Control': 'no-store' } }
		);
	}

	return json(
		{
			success: true,
			enrolmentUrl: `${baseUrl}${ENROLMENT_LINK_PATH}${reset.token}`,
			mailSent,
			...(mailProblem === undefined ? {} : { mailProblem }),
			...counts,
			message:
				`${target.username}'s two-step sign-in was reset. Give them the link yourself: it is shown once, and ` +
				`works for seven days.${shownSaid}${told}`
		},
		// The answer holds a credential: kept by nothing on the way.
		{ headers: { 'Cache-Control': 'no-store' } }
	);
};
