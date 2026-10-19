import { json, error } from '@sveltejs/kit';
import { db } from '$lib/server/db';
import { afterCommit } from '$lib/server/db/transaction';
import { users } from '$lib/server/db/schema';
import { eq } from 'drizzle-orm';
import { SESSION_COOKIE_NAME, checkCurrentPassword, whilePasswordHolds } from '$lib/server/auth';
import { endUnusedInvites } from '$lib/server/invites';
import { createLogger } from '$lib/server/logger';
import { readBody, readEmail, readText } from '$lib/server/request-body';
import { requireUser } from '$lib/server/route-guards';
import { writeAs } from '$lib/server/write-as';
import type { RequestHandler } from './$types';

const log = createLogger('AUTH');

/**
 * PUT — Change own email. Requires password verification.
 *
 * An invite is mailed to the address the account has when it is sent, so a
 * change of address ends every invite of the account not yet used: the mail
 * may be in a mailbox that is no longer the account's. The address and the
 * invites change in one transaction. Sessions and API keys are not ended: an
 * email change is not a password change.
 */
export const PUT: RequestHandler = async ({ request, locals, cookies }) => {
	// The wrong passwords are counted against the session that sent them,
	// which only a session reaches this route with.
	const session = cookies.get(SESSION_COOKIE_NAME);
	requireUser(locals.user);
	if (!session) throw error(401, 'Not authenticated');

	const body = await readBody(request);

	// Text, or refused before a password is checked or counted. A number used
	// to reach bcrypt, which threw: a 500, and so did an email that was not text.
	const password = readText(body, 'password', { required: true, min: 1, says: 'Password is required' });
	readText(body, 'newEmail', { required: true, trim: true, min: 1, says: { missing: 'Email is required', empty: 'Email is required' } });

	// An address by the readers' rule (none of `, ; < > " ( )`, which the
	// mailer reads as more than one address), with a dot after the @ as it had.
	const typed = readEmail(body, 'newEmail', { required: true, says: 'Invalid email address' });
	if (!/^[^\s@]+@[^\s@]+\.[^\s@]+$/.test(typed)) throw error(400, 'Invalid email address');
	const email = typed.toLowerCase();

	// Who is asking, as their account is now, once the body has come: a session
	// that ended while it arrived is refused here, before a password is checked
	// or counted (card 2253). It decides nothing: the transaction that writes
	// asks again.
	const me = writeAs(locals, (caller) => requireUser(caller));

	// Get full user with password hash
	const user = db.select().from(users).where(eq(users.id, me.id)).get();
	if (!user) throw error(404, 'User not found');

	// Checking a password takes about a quarter of a second, on a worker
	// thread, and is awaited, which a transaction cannot do, so it is checked
	// out here first. Ten wrong ones in 15 minutes from this session, and it
	// is refused.
	const wrong = () => error(403, 'Password is incorrect');
	if (!(await checkCurrentPassword(session, user.id, password, user.passwordHash, 'PUT /api/account/email')).matches) {
		wrong();
	}

	// One transaction: the account is read again, the address checked as free
	// and written, and the invites ended, together. It runs only while the
	// stored hash is the one the password was checked against; if the user or
	// an administrator changed it in between, the password is checked again
	// against the new one, outside, and not counted again: the same guess. In
	// it, the session is asked again, and the account as it is now is changed:
	// the password check was awaited, and a session can end meanwhile.
	await whilePasswordHolds(user.id, password, user.passwordHash, (current) =>
		writeAs(locals, (caller) => {
			const userId = requireUser(caller).id;

			// Check if email is already taken by another user
			const existing = db.select({ id: users.id }).from(users).where(eq(users.email, email)).get();
			if (existing && existing.id !== userId) {
				throw error(409, 'Email is already in use');
			}

			// The same address in another case is not a change: an address is
			// stored in lower case. The invites end before the address is written,
			// as on the users route.
			const changed = email !== current.email.toLowerCase();
			const invitesEnded = changed ? endUnusedInvites(userId) : 0;

			db.update(users).set({ email }).where(eq(users.id, userId)).run();

			if (changed) {
				afterCommit(() =>
					log.info(
						`User ${userId} changed their email address — ended ${invitesEnded} unused invite(s)`,
						{ invitesEnded },
						{ userId }
					)
				);
			}
		}), wrong);

	return json({ success: true, email });
};
