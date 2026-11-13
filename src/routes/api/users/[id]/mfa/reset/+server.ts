import { error, json, type Cookies } from '@sveltejs/kit';
import { and, eq, gt } from 'drizzle-orm';
import { db } from '$lib/server/db';
import { afterCommit } from '$lib/server/db/transaction';
import { enrolmentLinks } from '$lib/server/db/schema';
import { whilePasswordHolds, type SessionUser } from '$lib/server/auth';
import { MAIL_PROBLEM_WORDS, NO_LINK_ADDRESS, isSmtpConfigured, linkBaseUrl, smtpPasswordMissing } from '$lib/server/email';
import { CALLER_NOT_GIVEN, callerStillManages } from '$lib/server/invite-link';
import { sha256Hex } from '$lib/server/mfa-crypto';
import { ENROLMENT_LINK_PATH, resetTwoStep } from '$lib/server/mfa-store';
import { sendMfaResetNotice } from '$lib/server/notifications';
import { refuseOwnAccount, requireAdmin, requireManagedAccount, requireUser } from '$lib/server/route-guards';
import { confirmStepUp } from '$lib/server/step-up';
import { writeAs } from '$lib/server/write-as';
import { pathId, readBody } from '$lib/server/request-body';
import { createLogger } from '$lib/server/logger';
import { stamp } from '$lib/timestamps';
import type { RequestHandler } from './$types';

const log = createLogger('AUTH');

/** Why the link was withheld from the answer, by the check of decision 15 that failed. */
const NOT_GIVEN = {
	...CALLER_NOT_GIVEN,
	link: "the link is no longer the account's"
} as const;

/**
 * POST — Reset another account's two-step sign-in (card 2773): its
 * authenticators and recovery codes are removed, its wrong-code counts set
 * back, its sessions, unused invites, pending sign-ins and enrolment links
 * ended, and one new enrolment link issued (`resetTwoStep`, decision 11). Its
 * password, API keys, webhooks and report schedules are kept: the holder lost
 * a device, not the password. For an account with no factor it issues a
 * fresh link (decision 4).
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
 * that holds no link (decision 7), once the reset is committed, and awaited;
 * then three things are read again before the link is put in the answer
 * (decision 15, as invite-link.ts does): the caller's session is still open
 * and an administrator's, the caller may still manage the account, and the
 * link is still the account's. If one fails the reset stands, the link is
 * withheld, and the answer says to run the reset again.
 *
 *     { success, enrolmentUrl | null, mailSent, mailProblem?, factorsRemoved,
 *       recoveryCodesRemoved, sessionsEnded, challengesEnded, invitesEnded,
 *       message }
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

			// The counts and the two accounts, and never the token or the link.
			afterCommit(() =>
				log.critical(
					`Two-step sign-in reset for user ${target.id} ("${target.username}") by "${actor.username}": removed ` +
						`${reset.factors} factor(s) and ${reset.recoveryCodes} recovery code(s), ended ${reset.sessions} ` +
						`session(s), ${reset.challenges} pending sign-in(s) and ${reset.invites} invite(s); an enrolment ` +
						'link was issued',
					{
						targetUserId: target.id,
						resetBy: actor.id,
						factorsRemoved: reset.factors,
						recoveryCodesRemoved: reset.recoveryCodes,
						sessionsEnded: reset.sessions,
						challengesEnded: reset.challenges,
						invitesEnded: reset.invites
					},
					{ userId: actor.id }
				)
			);
			return { actor, target, baseUrl, reset };
		})
	);

	// After the commit, and awaited: an effect never starts inside a
	// transaction. Not attempted where mail is not set up, or its password is
	// missing, as a restore leaves it (card 2169): the reset stands either way.
	const { actor, target, baseUrl, reset } = done;
	let mailSent = false;
	let mailProblem: string | undefined;
	if (isSmtpConfigured()) {
		if (smtpPasswordMissing()) {
			mailProblem = MAIL_PROBLEM_WORDS['no-password'];
		} else {
			// Whether it had an authenticator picks what the notice says was lost (card 2773's review).
			const outcome = await sendMfaResetNotice(target.email, target.username, actor.username, reset.factors > 0);
			if (outcome.sent) mailSent = true;
			else mailProblem = MAIL_PROBLEM_WORDS[outcome.problem];
		}
	}

	const counts = {
		factorsRemoved: reset.factors,
		recoveryCodesRemoved: reset.recoveryCodes,
		sessionsEnded: reset.sessions,
		challengesEnded: reset.challenges,
		invitesEnded: reset.invites
	};
	const told = mailSent ? ` ${target.username} was sent a notice that holds no link.` : '';
	const notGiven = whyNotGiven(cookies, actor.id, target.id, sha256Hex(reset.token));

	if (notGiven !== null) {
		log.warn(
			`The enrolment link of user ${target.id}, issued by user ${actor.id}'s reset, was not given to them: ${NOT_GIVEN[notGiven]}`,
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
					`reset again to issue a new one.${told}`
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
				`works for seven days.${told}`
		},
		// The answer holds a credential: kept by nothing on the way.
		{ headers: { 'Cache-Control': 'no-store' } }
	);
};

/**
 * The first of decision 15's checks that fails, or null when all three hold,
 * by reads only. The first two are invite-link.ts's own, shared (card 2773's
 * review, C-I1); the third, of the enrolment link, is this route's.
 */
function whyNotGiven(cookies: Cookies, actorId: number, accountId: number, tokenHash: string): keyof typeof NOT_GIVEN | null {
	const callerCheck = callerStillManages(cookies, actorId, accountId);
	if (callerCheck !== null) return callerCheck;

	const link = db
		.select({ userId: enrolmentLinks.userId })
		.from(enrolmentLinks)
		.where(and(eq(enrolmentLinks.tokenHash, tokenHash), gt(enrolmentLinks.expiresAt, stamp())))
		.get();
	if (!link || link.userId !== accountId) return 'link';

	return null;
}
