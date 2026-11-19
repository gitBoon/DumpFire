import { json, error } from '@sveltejs/kit';
import { issueInvite } from '$lib/server/invites';
import { holdsFactor } from '$lib/server/mfa-store';
import { inviteMailAnswer } from '$lib/server/invite-link';
import { MAIL_PROBLEM_WORDS, NO_LINK_ADDRESS, isSmtpConfigured, linkBaseUrl, linkBaseUrlWithoutAppUrlSetting, mailCannotSendProblem } from '$lib/server/email';
import { settingsSetBy } from '$lib/server/setting-setters';
import { sendInviteEmail } from '$lib/server/notifications';
import { whilePasswordHolds, type SessionUser } from '$lib/server/auth';
import { requireAdmin, requireManagedAccount } from '$lib/server/route-guards';
import { requireEnabledAccount } from '$lib/server/account-disable';
import { pathId, readBody } from '$lib/server/request-body';
import { confirmStepUp } from '$lib/server/step-up';
import { writeAs } from '$lib/server/write-as';
import type { RequestHandler } from './$types';

/**
 * What an invite is refused with where the mail settings or the App URL in force were set by the account itself
 * (card 2922's code review, C15): its invite would go through them.
 */
const OWN_SETTINGS_REFUSAL =
	"The mail settings or the App URL in force were set by this account, so its invite would go through them. Reset the account's " +
	'two-step sign-in first, which holds them for review, then keep or remove the setting under Settings held for review. Nothing was sent.';

/**
 * POST — Resend invite email (generates a new token). Admin only.
 *
 * Whoever holds an invite sets the account's password with it, and is asked
 * for no other. So an invite is a password reset by another way, and is asked
 * what PUT /api/users/[id]/password is asked: the caller's own account is
 * refused, and whose account an administrator may manage is the one rule in
 * route-guards.ts. This used to ask neither, and any administrator could mint
 * an invite for another administrator, for the superadmin or for themselves.
 *
 * The mail is sent once the invite is committed, and waited for (card 2196).
 * The answer is `200` whenever the invite was made, `success` meaning that it
 * exists, with `mailSent` always:
 *
 *     sent       { success, mailSent: true, message: "Invite sent to …" }
 *     not sent   { success, mailSent: false, mailProblem, inviteUrl, message }
 *                the problem in words, never the mail server's; the link for
 *                the caller to pass on by hand; and no-store. `inviteUrl` is
 *                left out when the checks of invite-link.ts no longer hold
 *
 * It used to queue the mail and answer "Invite sent" without waiting, whether
 * or not the mail then went. With no mail host, or a mail user with no
 * password, it is refused before the invite is made: `400`.
 *
 * It asks for the caller's own password again, in `currentPassword` (card
 * 2701, step-up.ts), after every refusal that needs none, the mail's
 * included: so the request has a body.
 */
export const POST: RequestHandler = async ({ params, request, locals, url, cookies }) => {
	requireAdmin(locals.user);

	const userId = pathId(params.id, 'user');
	const body = await readBody(request);

	/**
	 * Every refusal of the invite, read only: the caller as their account is
	 * now, their own account, whose account they may invite, the mail host and
	 * its password, and the link's address. Asked before the password, and
	 * again in the transaction that writes the token.
	 */
	const refusals = (caller: SessionUser | null) => {
		const actor = requireAdmin(caller);

		// Nobody invites themselves, an administrator included: the link would set
		// their password without asking for the one they have.
		if (actor.id === userId) {
			throw error(
				403,
				'An invite sets a password. Change your own password on the Account page, which asks for your current password'
			);
		}

		const target = requireManagedAccount(actor, userId, {
			superadmin: 'Only superadmin can reset superadmin password, which an invite does',
			admin: 'Only superadmin can reset an admin\'s password, which an invite does'
		});
		// A disabled account is not invited (card 2671, D18): enable it first.
		requireEnabledAccount(target);

		// An account that holds a second factor is not invited (card 2773,
		// decision 9): the invite would not work (`usableInvite`), and its holder
		// needs their authenticator as well as a password. Asked after the account
		// rule and before the mail, so that the caller is told what to do first.
		if (holdsFactor(target.id)) {
			throw error(409, 'This account uses two-step sign-in. Reset it first, then send the invite.');
		}

		// Not through the mail settings, or with a link from the App URL, that the
		// account itself set and that are in force (card 2922's code review, C15):
		// an intruder who held it would read the invite that takes it back. Its
		// two-step reset holds them first, or they are kept or removed.
		const set = settingsSetBy(target.id).get(target.id) ?? null;
		if (set !== null && (set.mail || set.appUrl)) throw error(409, OWN_SETTINGS_REFUSAL);

		// Asked after the account rule, so that a caller who may not invite this
		// account is told so whether or not mail is set up.
		if (!isSmtpConfigured()) {
			throw error(400, 'SMTP is not configured');
		}

		// A mail user with no password, as a restore leaves the settings (card
		// 2169): every mail would fail, and that is known before the invite is
		// made. So it is refused here, as no mail host is, and the account's
		// earlier invite is not ended for a mail that cannot go, nor a link put
		// on screen for it (the review-fix pass's item 2, decision 8).
		// Or the mail settings held for the superadmin's review (card 2922, R12): `mailCannotSendProblem`.
		const cannot = mailCannotSendProblem();
		if (cannot !== null) {
			throw error(
				400,
				`The invite was not made: ${MAIL_PROBLEM_WORDS[cannot]}. Any earlier invite to this account still works.`
			);
		}

		// The address the link begins with is this server's configuration and
		// never what the request says: see linkBaseUrl. With none there is no
		// link to send, and no token is made for one.
		// Never an App URL the account set (C15): what the server would answer
		// without it. The refusal above leaves none such here; this is the second wall.
		const baseUrl = set !== null && set.appUrl ? linkBaseUrlWithoutAppUrlSetting(url) : linkBaseUrl(url);
		if (baseUrl === null) {
			throw error(503, NO_LINK_ADDRESS);
		}

		return { actor, target, baseUrl };
	};

	// The caller's password, asked for again (card 2701): an invite sets the
	// account's password. Every refusal that needs none is made first.
	const { userId: callerId, hash } = await confirmStepUp(locals, cookies, body, 'POST /api/users/[id]/invite', (caller) =>
		refusals(caller)
	);

	// One transaction: the user is read and the caller checked in the one that
	// writes the token, so the role that was checked is the role of the account
	// the token is for. The mail is sent once it is committed. It asks first
	// whether the session is still open, and who its account is now (card
	// 2253), and runs only while the caller's stored hash is the one their
	// password was checked against.
	const issued = await whilePasswordHolds(callerId, hash, () =>
		writeAs(locals, (caller) => {
			const { actor, target, baseUrl } = refusals(caller);

			// A new invite, and every earlier one that has not been used deleted with
			// it: an account has one invite that works, the one in this mail. The
			// earlier ones used to stay good until they expired, so a leaked mail
			// set the password even after a newer one had been sent and used.
			const token = issueInvite(target.id);

			return { target, token, baseUrl, actorId: actor.id };
		}));

	// After the commit, and awaited: an effect never starts inside a
	// transaction, and the answer says whether the mail went.
	const { target, token, baseUrl, actorId } = issued;
	const outcome = await sendInviteEmail(target.email, target.username, token, baseUrl);
	const mail = inviteMailAnswer({ outcome, credential: locals.credential, actorId, accountId: target.id, token, baseUrl });
	const earlier = 'Any earlier invite to this account no longer works.';

	if (mail.mailSent) {
		return json({ success: true, mailSent: true, message: `Invite sent to ${target.email}. ${earlier}` });
	}
	if (mail.inviteUrl === null) {
		return json({
			success: true,
			mailSent: false,
			mailProblem: mail.mailProblem,
			message:
				'The invite was made, but its mail could not be sent, and its link cannot be shown to you now. ' +
				'Send a new invite with 📧 once mail works.'
		});
	}
	return json(
		{
			success: true,
			mailSent: false,
			mailProblem: mail.mailProblem,
			inviteUrl: mail.inviteUrl,
			message:
				`The invite was made, but its mail to ${target.email} could not be sent: ${mail.mailProblem}. ` +
				`Give ${target.username} the link yourself. ${earlier}`
		},
		// The answer holds a credential: kept by nothing on the way (N5).
		{ headers: { 'Cache-Control': 'no-store' } }
	);
};
