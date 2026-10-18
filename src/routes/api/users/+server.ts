import { json, error } from '@sveltejs/kit';
import { db } from '$lib/server/db';
import { inTransaction } from '$lib/server/db/transaction';
import { users } from '$lib/server/db/schema';
import { makePasswordHash } from '$lib/server/passwords';
import { issueInvite } from '$lib/server/invites';
import { inviteMailAnswer } from '$lib/server/invite-link';
import { readAccountFields, requireAssignableRole, requireUnusedAccountFields } from '$lib/server/account-fields';
import { readBody } from '$lib/server/request-body';
import { listUsersFor } from '$lib/server/list-access';
import { MAIL_PROBLEM_WORDS, NO_LINK_ADDRESS, isSmtpConfigured, linkBaseUrl, smtpPasswordMissing } from '$lib/server/email';
import { sendInviteEmail } from '$lib/server/notifications';
import type { RequestHandler } from './$types';

/**
 * GET — every user, for the share dialog's picker: `id`, `username` and
 * `emoji` to anyone signed in, and `email`, `role` and `createdAt` to an
 * administrator as well (card 2128, `listUsersFor`). Every address and role
 * was given to every signed-in caller.
 */
export const GET: RequestHandler = async ({ locals }) => {
	if (!locals.user) throw error(401, 'Not authenticated');

	return json(listUsersFor(locals.user));
};

/** What a user with no password is refused with while the mail settings name a user and hold no password. */
const NO_MAIL_PASSWORD = `Password must be at least 8 characters (${MAIL_PROBLEM_WORDS['no-password']})`;

/**
 * POST — Create a new user (admin only). Password optional if SMTP configured.
 *
 * `201`, the user, and `invited`. With no password an invite is issued and
 * its mail sent once the user is committed, and waited for (card 2196): the
 * answer adds `mailSent`, and when that is false, `mailProblem` (in words)
 * and `inviteUrl`, the link for the caller to pass on by hand, left out when
 * the checks of invite-link.ts no longer hold. `invited` used to be the whole
 * answer, and the page said "invite email sent!" whether or not it went.
 */
export const POST: RequestHandler = async ({ request, locals, url, cookies }) => {
	if (!locals.user || (locals.user.role !== 'admin' && locals.user.role !== 'superadmin')) {
		throw error(403, 'Forbidden');
	}

	const actor = locals.user;

	// Each text field that was sent is a string, and the username and email
	// are there and held to their rules, or this is a 400: see
	// account-fields.ts. `role` is looked at below, where it always was.
	const body = await readBody(request);
	const { username, email, password, emoji } = readAccountFields(body);

	const smtpReady = isSmtpConfigured();

	// Password required if SMTP not configured
	if (!smtpReady && (!password || password.length < 8)) {
		throw error(400, 'Password must be at least 8 characters (SMTP not configured for invite emails)');
	}

	if (password && password.length < 8) {
		throw error(400, 'Password must be at least 8 characters');
	}

	// A mail user with no password, as a restore leaves the settings (card
	// 2169): an invite's mail would fail, and that is known before the user is
	// made, so it is refused as no mail host is (the review-fix pass's item 2).
	if (!password && smtpPasswordMissing()) {
		throw error(400, NO_MAIL_PASSWORD);
	}

	// A role is exactly `user` or `admin`, and only the superadmin makes an
	// administrator. What passes is what is written: it used to be compared as
	// it was sent and then bound, and `["superadmin"]` is bound as `superadmin`.
	const finalRole =
		requireAssignableRole(actor, body, {
			superadmin: 'Cannot create additional superadmin accounts',
			promote: 'Only superadmin can create admin users'
		}) ?? 'user';

	// Check uniqueness: one rule, shared with PUT /api/users/[id].
	const requireUnused = () => requireUnusedAccountFields({ username, email });

	// Hashing takes about a quarter of a second, on a worker thread, and is
	// awaited, which a transaction cannot do, so the hash is made out here,
	// before it, in the first lane: the caller holds a session. The
	// name and address are looked at first so that a request that will be
	// refused is not hashed for, and are read again in the transaction.
	requireUnused();

	// If password provided, hash and create fully. Otherwise create with placeholder and invite.
	const passwordHash = password
		? await makePasswordHash(password, 'known')
		: await makePasswordHash(crypto.randomUUID(), 'known'); // Random placeholder — user must set via invite

	// One transaction: the name and address are checked as unused in the one
	// that creates the user, and the user and their invite are made together.
	// A failure between the two used to leave a user with a password nobody
	// knows and no invite to set one. The mail is sent once it is committed.
	const created = inTransaction(() => {
		requireUnused();

		// Read again in here, as the name and address are: with no password and
		// no mail there is no invite, and the user could never sign in.
		if (!password && !isSmtpConfigured()) {
			throw error(400, 'Password must be at least 8 characters (SMTP not configured for invite emails)');
		}
		if (!password && smtpPasswordMissing()) {
			throw error(400, NO_MAIL_PASSWORD);
		}

		// An invite is a link, and the address it begins with is this server's
		// configuration and never what the request says: see linkBaseUrl. With
		// none there is no invite to send, and the user is not made: they would
		// have a password nobody knows and no way to set one.
		const inviteFrom = password ? null : linkBaseUrl(url);
		if (!password && inviteFrom === null) {
			throw error(503, NO_LINK_ADDRESS);
		}

		const user = db.insert(users)
			.values({
				username,
				email: email.toLowerCase(),
				passwordHash,
				emoji: emoji ?? '👤',
				role: finalRole
			})
			.returning({ id: users.id, username: users.username, email: users.email, emoji: users.emoji, role: users.role, createdAt: users.createdAt })
			.get();

		// If no password was provided and SMTP is ready, issue an invite, mailed
		// below. A new user has no earlier invite to end, but an invite is issued
		// one way, in invites.ts, so its lifetime and its rule are written once.
		const invite = inviteFrom !== null ? { token: issueInvite(user.id), baseUrl: inviteFrom } : null;

		return { user, invite };
	});

	const { user, invite } = created;
	if (invite === null) return json({ ...user, invited: false }, { status: 201 });

	// After the commit, and awaited: an effect never starts inside a
	// transaction, and the answer says whether the mail went.
	const outcome = await sendInviteEmail(user.email, user.username, invite.token, invite.baseUrl);
	const mail = inviteMailAnswer({ outcome, cookies, actorId: actor.id, accountId: user.id, token: invite.token, baseUrl: invite.baseUrl });

	if (mail.mailSent) return json({ ...user, invited: true, mailSent: true }, { status: 201 });
	if (mail.inviteUrl === null) {
		return json({ ...user, invited: true, mailSent: false, mailProblem: mail.mailProblem }, { status: 201 });
	}
	return json(
		{ ...user, invited: true, mailSent: false, mailProblem: mail.mailProblem, inviteUrl: mail.inviteUrl },
		// The answer holds a credential: kept by nothing on the way (N5).
		{ status: 201, headers: { 'Cache-Control': 'no-store' } }
	);
};

