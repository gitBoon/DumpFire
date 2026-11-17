import { json, error } from '@sveltejs/kit';
import { db } from '$lib/server/db';
import { users } from '$lib/server/db/schema';
import { whilePasswordHolds, type SessionUser } from '$lib/server/auth';
import { LONGEST_PASSWORD, PASSWORD_TOO_LONG, makePasswordHash } from '$lib/server/passwords';
import { issueInvite } from '$lib/server/invites';
import { ENROLMENT_LINK_NOT_GIVEN, enrolmentLinkNotGiven, inviteMailAnswer } from '$lib/server/invite-link';
import { afterCommit } from '$lib/server/db/transaction';
import { createLogger } from '$lib/server/logger';
import { sha256Hex } from '$lib/server/mfa-crypto';
import { ENROLMENT_LINK_PATH, issueEnrolmentLink } from '$lib/server/mfa-store';
import { readAccountFields, requireAssignableRole, requireUnusedAccountFields } from '$lib/server/account-fields';
import { readBody } from '$lib/server/request-body';
import { listUsersFor } from '$lib/server/list-access';
import { MAIL_PROBLEM_WORDS, NO_LINK_ADDRESS, isSmtpConfigured, linkBaseUrl, smtpPasswordMissing } from '$lib/server/email';
import { sendInviteEmail } from '$lib/server/notifications';
import { requireAdmin, requireUser } from '$lib/server/route-guards';
import { confirmStepUp } from '$lib/server/step-up';
import { writeAs } from '$lib/server/write-as';
import type { RequestHandler } from './$types';

const log = createLogger('AUTH');

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
 *
 * With a password the administrator chose, the account's set-up link for
 * two-step sign-in is issued in the transaction that makes it (`issued_by`
 * `admin-create`, card 2851) and given once in the answer, never mailed:
 * `enrolmentUrl` and `message`, answered with no-store, or `enrolmentUrl:
 * null` when card 2773's three checks no longer hold once it is committed.
 * With no link address (no App URL, `APP_URL` or `ORIGIN`) every create is
 * refused `503`: the account could get neither an invite nor a set-up link.
 *
 * It asks for the caller's own password again, in `currentPassword` (card
 * 2701, step-up.ts), after every refusal that needs none.
 *
 * Every account made is logged once committed, one `INFO` line under `AUTH`
 * naming it, its role, how it signs in first and who made it, never its
 * address, its password or any link (card 2905).
 */
export const POST: RequestHandler = async ({ request, locals, url, cookies }) => {
	requireAdmin(locals.user);

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

	// No longer than the step-up will read of it (card 2888).
	if (password && password.length > LONGEST_PASSWORD) {
		throw error(400, PASSWORD_TOO_LONG);
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
	// Asked of the caller as their account is now: before the password, and
	// again in the transaction that creates the user, which decides (card 2253).
	const roleFor = (caller: SessionUser | null) =>
		requireAssignableRole(requireAdmin(caller), body, {
			superadmin: 'Cannot create additional superadmin accounts',
			promote: 'Only superadmin can create admin users'
		}) ?? 'user';

	// Check uniqueness: one rule, shared with PUT /api/users/[id].
	const requireUnused = () => requireUnusedAccountFields({ username, email });

	// The caller's password, asked for again (card 2701): an account is a
	// credential that outlives the session that made it. The role, the name and
	// address, and an invite's link address are asked first, read only, so that
	// a request that will be refused costs no check and no guess, and is not
	// hashed for. Each is read again in the transaction.
	const { userId, hash } = await confirmStepUp(locals, cookies, body, 'POST /api/users', (caller) => {
		roleFor(caller);
		requireUnused();
		// Every new account needs a link: an invite with no password, a set-up
		// link with one (card 2851). With no address there is neither.
		if (linkBaseUrl(url) === null) throw error(503, NO_LINK_ADDRESS);
	});

	// Hashing takes about a quarter of a second, on a worker thread, and is
	// awaited, which a transaction cannot do, so the hash is made out here,
	// before it, in the first lane: the caller holds a session.
	// If password provided, hash and create fully. Otherwise create with placeholder and invite.
	const passwordHash = password
		? await makePasswordHash(password, 'known')
		: await makePasswordHash(crypto.randomUUID(), 'known'); // Random placeholder — user must set via invite

	// One transaction: the name and address are checked as unused in the one
	// that creates the user, and the user and their invite, or their set-up
	// link (card 2851), are made together.
	// A failure between the two used to leave a user with a password nobody
	// knows and no invite to set one. The mail is sent once it is committed.
	// The hash was awaited, so the session is asked again, and the role
	// decided again by the account as it is now (card 2253). It runs only while
	// the caller's stored hash is the one their password was checked against.
	const created = await whilePasswordHolds(userId, hash, () => writeAs(locals, (caller) => {
		const finalRole = roleFor(caller);
		const actorId = requireUser(caller).id;
		requireUnused();

		// Read again in here, as the name and address are: with no password and
		// no mail there is no invite, and the user could never sign in.
		if (!password && !isSmtpConfigured()) {
			throw error(400, 'Password must be at least 8 characters (SMTP not configured for invite emails)');
		}
		if (!password && smtpPasswordMissing()) {
			throw error(400, NO_MAIL_PASSWORD);
		}

		// An invite and a set-up link are links, and the address they begin with
		// is this server's configuration and never what the request says: see
		// linkBaseUrl. With none the user is not made: with no password they
		// would have one nobody knows and no way to set it; with one, no way to
		// set up two-step sign-in, without which they cannot sign in (card 2851).
		const linkFrom = linkBaseUrl(url);
		if (linkFrom === null) {
			throw error(503, NO_LINK_ADDRESS);
		}

		const account = db.insert(users)
			.values({
				username,
				email: email.toLowerCase(),
				passwordHash,
				emoji: emoji ?? '👤',
				role: finalRole
			})
			.returning({ id: users.id, username: users.username, email: users.email, emoji: users.emoji, role: users.role, createdAt: users.createdAt })
			.get();

		// How the account signs in first: one of the two, never both or neither.
		// If no password was provided and SMTP is ready, an invite, mailed
		// below. A new user has no earlier invite to end, but an invite is issued
		// one way, in invites.ts, so its lifetime and its rule are written once.
		// With a password the administrator chose, the account's set-up link,
		// made with it or not at all (card 2851, D1): since two-step sign-in an
		// account cannot sign in until it has set up an authenticator. Never
		// mailed (card 2773, decision 6): the administrator gives it with the
		// password.
		const first = password
			? { invite: null, enrolToken: issueEnrolmentLink(account.id, 'admin-create') }
			: { invite: { token: issueInvite(account.id), baseUrl: linkFrom }, enrolToken: null };

		// Every account made is said once committed, in one line (card 2905; card
		// 2851's line for a chosen password is this one): naming the account, its
		// role, how it signs in first and who made it, never its address, its
		// password, its invite or its set-up link. The caller's name is read
		// here: the callback's caller is never kept past it (card 2253).
		const actorName = requireUser(caller).username;
		const as = finalRole === 'admin' ? 'an administrator' : 'a user';
		const how = first.enrolToken !== null ? 'with a password they chose; an enrolment link was issued' : 'with an invite to set their password';
		const meta =
			first.enrolToken !== null
				? { accountId: account.id, role: finalRole, firstSignIn: 'set-up-link', issuedBy: 'admin-create' }
				: { accountId: account.id, role: finalRole, firstSignIn: 'invite' };
		afterCommit(() => log.info(`Account ${account.id} ("${account.username}") made by "${actorName}" as ${as}, ${how}`, meta, { userId: actorId }));

		return { account, ...first, actorId, linkFrom };
	}));

	const { account, invite, enrolToken, actorId, linkFrom } = created;
	if (enrolToken !== null) {
		// Card 2773's three checks (decision 15), by reads only, before the link
		// is put in the answer: the caller's session still open and an
		// administrator's, the caller still allowed to manage the account, the
		// link still the account's. One failing, the account stands and the
		// link is withheld.
		const notGiven = enrolmentLinkNotGiven(locals.credential, actorId, account.id, sha256Hex(enrolToken));
		if (notGiven !== null) {
			log.warn(
				`The enrolment link of user ${account.id}, issued when user ${actorId} made the account, was not given to them: ${ENROLMENT_LINK_NOT_GIVEN[notGiven]}`,
				{ accountId: account.id, check: notGiven },
				{ userId: actorId }
			);
			return json(
				{
					...account,
					invited: false,
					enrolmentUrl: null,
					message: `${account.username} was made, but their set-up link cannot be shown to you now. Press 🛡️ on their row to issue a new one.`
				},
				{ status: 201, headers: { 'Cache-Control': 'no-store' } }
			);
		}
		return json(
			{
				...account,
				invited: false,
				enrolmentUrl: `${linkFrom}${ENROLMENT_LINK_PATH}${enrolToken}`,
				message:
					`${account.username} was made. Give them their set-up link yourself, with the password you chose: it is ` +
					'shown once, and works for seven days.'
			},
			// The answer holds a credential: kept by nothing on the way.
			{ status: 201, headers: { 'Cache-Control': 'no-store' } }
		);
	}

	// With no set-up link the account has its invite (`first`, above).
	// After the commit, and awaited: an effect never starts inside a
	// transaction, and the answer says whether the mail went.
	const outcome = await sendInviteEmail(account.email, account.username, invite.token, invite.baseUrl);
	const mail = inviteMailAnswer({ outcome, credential: locals.credential, actorId, accountId: account.id, token: invite.token, baseUrl: invite.baseUrl });

	if (mail.mailSent) return json({ ...account, invited: true, mailSent: true }, { status: 201 });
	if (mail.inviteUrl === null) {
		return json({ ...account, invited: true, mailSent: false, mailProblem: mail.mailProblem }, { status: 201 });
	}
	return json(
		{ ...account, invited: true, mailSent: false, mailProblem: mail.mailProblem, inviteUrl: mail.inviteUrl },
		// The answer holds a credential: kept by nothing on the way (N5).
		{ status: 201, headers: { 'Cache-Control': 'no-store' } }
	);
};

