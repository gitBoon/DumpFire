import { json, error } from '@sveltejs/kit';
import { inTransaction } from '$lib/server/db/transaction';
import { isAdmin } from '$lib/server/board-access';
import { issueInvite } from '$lib/server/invites';
import { inviteMailAnswer } from '$lib/server/invite-link';
import { MAIL_PROBLEM_WORDS, NO_LINK_ADDRESS, isSmtpConfigured, linkBaseUrl, smtpPasswordMissing } from '$lib/server/email';
import { sendInviteEmail } from '$lib/server/notifications';
import { requireManagedAccount } from '$lib/server/route-guards';
import { pathId } from '$lib/server/request-body';
import type { RequestHandler } from './$types';

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
 */
export const POST: RequestHandler = async ({ params, locals, url, cookies }) => {
	if (!locals.user || !isAdmin(locals.user)) {
		throw error(403, 'Forbidden');
	}

	const actor = locals.user;
	const userId = pathId(params.id, 'user');

	// Nobody invites themselves, an administrator included: the link would set
	// their password without asking for the one they have.
	if (actor.id === userId) {
		throw error(
			403,
			'An invite sets a password. Change your own password on the Account page, which asks for your current password'
		);
	}

	// One transaction: the user is read and the caller checked in the one that
	// writes the token, so the role that was checked is the role of the account
	// the token is for. The mail is sent once it is committed.
	const issued = inTransaction(() => {
		const target = requireManagedAccount(actor, userId, {
			superadmin: 'Only superadmin can reset superadmin password, which an invite does',
			admin: 'Only superadmin can reset an admin\'s password, which an invite does'
		});

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
		if (smtpPasswordMissing()) {
			throw error(
				400,
				`The invite was not made: ${MAIL_PROBLEM_WORDS['no-password']}. Any earlier invite to this account still works.`
			);
		}

		// The address the link begins with is this server's configuration and
		// never what the request says: see linkBaseUrl. With none there is no
		// link to send, and no token is made for one.
		const baseUrl = linkBaseUrl(url);
		if (baseUrl === null) {
			throw error(503, NO_LINK_ADDRESS);
		}

		// A new invite, and every earlier one that has not been used deleted with
		// it: an account has one invite that works, the one in this mail. The
		// earlier ones used to stay good until they expired, so a leaked mail
		// set the password even after a newer one had been sent and used.
		const token = issueInvite(target.id);

		return { target, token, baseUrl };
	});

	// After the commit, and awaited: an effect never starts inside a
	// transaction, and the answer says whether the mail went.
	const { target, token, baseUrl } = issued;
	const outcome = await sendInviteEmail(target.email, target.username, token, baseUrl);
	const mail = inviteMailAnswer({ outcome, cookies, actorId: actor.id, accountId: target.id, token, baseUrl });
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
