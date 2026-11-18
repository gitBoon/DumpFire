import { error, json } from '@sveltejs/kit';
import { afterCommit } from '$lib/server/db/transaction';
import { namingIds, whilePasswordHolds, type SessionUser } from '$lib/server/auth';
import { MAIL_PROBLEM_WORDS, NO_LINK_ADDRESS, isSmtpConfigured, linkBaseUrl, smtpPasswordMissing } from '$lib/server/email';
import { ENROLMENT_LINK_NOT_GIVEN, enrolmentLinkNotGiven } from '$lib/server/invite-link';
import { sha256Hex } from '$lib/server/mfa-crypto';
import { ENROLMENT_LINK_PATH, resetTwoStep, twoStepResetMeta } from '$lib/server/mfa-store';
import { sendMfaResetNotice, type NoticeKey, type NoticeWebhook } from '$lib/server/notifications';
import { refuseOwnAccount, requireAdmin, requireManagedAccount, requireUser } from '$lib/server/route-guards';
import { requireEnabledAccount } from '$lib/server/account-disable';
import { keysAndWebhooksOf } from '$lib/server/second-step';
import { confirmStepUp } from '$lib/server/step-up';
import { writeAs } from '$lib/server/write-as';
import { pathId, readBody } from '$lib/server/request-body';
import { createLogger } from '$lib/server/logger';
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
 * The account's live API keys and the webhooks it set that are on, which the
 * reset kept (card 2894, S14): how many of each and the day each was made,
 * and never a key's name, a board's name or a host (the code review's CS2:
 * the administrator may not be able to open the board, and the admin pages
 * never show a key's name). The names are in the notice mailed to the holder,
 * which says so where it went.
 */
function keptWords(kept: { apiKeys: NoticeKey[]; webhooks: NoticeWebhook[] }, mailSent: boolean): string {
	const keys = kept.apiKeys;
	const hooks = kept.webhooks;
	if (keys.length === 0 && hooks.length === 0) return ' They have no API key and no webhook they set up.';
	const keyWords =
		keys.length === 0
			? 'no API key'
			: `${keys.length} API key${keys.length === 1 ? '' : 's'} (made ${daysInWords(keys.map((key) => key.createdAt))})`;
	const hookWords =
		hooks.length === 0
			? 'no webhook they set up'
			: `${hooks.length} webhook${hooks.length === 1 ? '' : 's'} they set up (made ${daysInWords(hooks.map((hook) => hook.createdAt))})`;
	const where = mailSent
		? 'the lists are in the notice mailed to them'
		: 'the notice with the lists was not sent: ask them to look over their keys and webhooks';
	return ` They keep ${keyWords} and ${hookWords}; ${where}. A password reset ends them.`;
}

/**
 * POST — Reset another account's two-step sign-in (card 2773): its
 * authenticators and recovery codes are removed, its wrong-code counts set
 * back, its sessions, unused invites, pending sign-ins and enrolment links
 * ended, its report schedules that are on paused (card 2894, D2), and one new
 * enrolment link issued (`resetTwoStep`, decision 11). Its password, API keys
 * and webhooks are kept: the holder lost a device, not the password. The
 * message says how many schedules were paused, and, where it gives the link,
 * how many live keys the account has and webhooks it set that are on, with
 * the day each was made, never their names (S14; the code review's CS2: the
 * mailed notice names them): they are what someone who held the password may
 * have left behind,
 * and the administrator is the one channel sure to reach the holder (S16).
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
 * that holds no link (decision 7), with the same count and lists, once the
 * reset is committed, and awaited;
 * then three things are read again before the link is put in the answer
 * (decision 15, `enrolmentLinkNotGiven` in invite-link.ts, shared with the
 * create's link since card 2851): the caller's session is still open
 * and an administrator's, the caller may still manage the account, and the
 * link is still the account's. If one fails the reset stands, the link is
 * withheld, and the answer says to run the reset again.
 *
 *     { success, enrolmentUrl | null, mailSent, mailProblem?, factorsRemoved,
 *       recoveryCodesRemoved, sessionsEnded, challengesEnded, invitesEnded,
 *       reportSchedulesPaused, message }
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
		// way to set up a new authenticator (decision 5).
		const baseUrl = linkBaseUrl(url);
		if (baseUrl === null) {
			throw error(503, NO_LINK_ADDRESS);
		}

		return { actor, target, baseUrl };
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
			const { actor, target, baseUrl } = refusals(caller);
			const reset = resetTwoStep(target.id, 'admin-reset');
			// What the reset kept, read in the write that reset it (S14).
			const kept = keysAndWebhooksOf(target.id, Date.now());

			// The counts and the two accounts, and never the token or the link.
			// scripts/mfa-reset.mjs writes the same meta (S15, `twoStepResetMeta`).
			afterCommit(() =>
				log.critical(
					`Two-step sign-in reset for user ${target.id} ("${target.username}") by "${actor.username}": removed ` +
						`${reset.factors} factor(s) and ${reset.recoveryCodes} recovery code(s), ended ${reset.sessions} ` +
						`session(s), ${reset.challenges} pending sign-in(s) and ${reset.invites} invite(s), and paused ` +
						`${reset.reportSchedules} report schedule(s)${namingIds(reset.reportScheduleIds)}; an enrolment link was issued`,
					twoStepResetMeta(target.id, actor.id, reset),
					{ userId: actor.id }
				)
			);
			return { actor, target, baseUrl, reset, kept };
		})
	);

	// After the commit, and awaited: an effect never starts inside a
	// transaction. Not attempted where mail is not set up, or its password is
	// missing, as a restore leaves it (card 2169): the reset stands either way.
	const { actor, target, baseUrl, reset, kept } = done;
	let mailSent = false;
	let mailProblem: string | undefined;
	if (isSmtpConfigured()) {
		if (smtpPasswordMissing()) {
			mailProblem = MAIL_PROBLEM_WORDS['no-password'];
		} else {
			// Whether it had an authenticator picks what the notice says was lost (card 2773's review); the
			// schedules paused and the keys and webhooks kept are said as the message says them (card 2894, S14).
			const outcome = await sendMfaResetNotice(target.email, target.username, actor.username, reset.factors > 0, {
				schedulesPaused: reset.reportSchedules,
				apiKeys: kept.apiKeys,
				webhooks: kept.webhooks
			});
			if (outcome.sent) mailSent = true;
			else mailProblem = MAIL_PROBLEM_WORDS[outcome.problem];
		}
	}

	const counts = {
		factorsRemoved: reset.factors,
		recoveryCodesRemoved: reset.recoveryCodes,
		sessionsEnded: reset.sessions,
		challengesEnded: reset.challenges,
		invitesEnded: reset.invites,
		reportSchedulesPaused: reset.reportSchedules
	};
	// The schedules paused are said in both of the message's branches (card 2894, E24): the reset stands
	// either way. What it kept only where the link is given: the caller who may no longer manage the
	// account, or whose session has ended, is told nothing more of it (the code review's CS2).
	const pausedSaid = pausedWords(reset.reportSchedules);
	const keptSaid = `${pausedSaid}${keptWords(kept, mailSent)}`;
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
					`reset again to issue a new one.${pausedSaid}${told}`
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
				`works for seven days.${keptSaid}${told}`
		},
		// The answer holds a credential: kept by nothing on the way.
		{ headers: { 'Cache-Control': 'no-store' } }
	);
};
