import { json, error } from '@sveltejs/kit';
import { inTransaction } from '$lib/server/db/transaction';
import { isAdmin } from '$lib/server/board-access';
import { issueInvite } from '$lib/server/invites';
import { NO_LINK_ADDRESS, isSmtpConfigured, linkBaseUrl } from '$lib/server/email';
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
 */
export const POST: RequestHandler = async ({ params, locals, url }) => {
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
	const sentTo = inTransaction(() => {
		const target = requireManagedAccount(actor, userId, {
			superadmin: 'Only superadmin can reset superadmin password, which an invite does',
			admin: 'Only superadmin can reset an admin\'s password, which an invite does'
		});

		// Asked after the account rule, so that a caller who may not invite this
		// account is told so whether or not mail is set up.
		if (!isSmtpConfigured()) {
			throw error(400, 'SMTP is not configured');
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

		sendInviteEmail(target.email, target.username, token, baseUrl);

		return target.email;
	});

	return json({ success: true, message: `Invite sent to ${sentTo}. Any earlier invite to this account no longer works.` });
};
