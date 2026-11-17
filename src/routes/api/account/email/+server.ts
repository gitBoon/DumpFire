import { json, error } from '@sveltejs/kit';
import { db } from '$lib/server/db';
import { afterCommit } from '$lib/server/db/transaction';
import { users } from '$lib/server/db/schema';
import { eq } from 'drizzle-orm';
import { whilePasswordHolds } from '$lib/server/auth';
import { endUnusedInvites } from '$lib/server/invites';
import { createLogger } from '$lib/server/logger';
import { endPendingSignIns } from '$lib/server/mfa-store';
import { readBody, readEmail, readText } from '$lib/server/request-body';
import { requireUser } from '$lib/server/route-guards';
import { confirmStepUp } from '$lib/server/step-up';
import { writeAs } from '$lib/server/write-as';
import type { RequestHandler } from './$types';

const log = createLogger('AUTH');

/**
 * PUT — Change own email. Asks for the current password and a code again
 * (`currentPassword`, `currentCode`: card 2771, D7), through the step-up that
 * every listed action asks with (step-up.ts).
 *
 * An invite is mailed to the address the account has when it is sent, so a
 * change of address ends every invite of the account not yet used: the mail
 * may be in a mailbox that is no longer the account's. So does every pending
 * sign-in and enrolment link of the account (card 2768). The address, the
 * invites and those change in one transaction. Sessions and API keys are not
 * ended: an email change is not a password change.
 */
export const PUT: RequestHandler = async ({ request, locals, cookies }) => {
	requireUser(locals.user);

	const body = await readBody(request);

	// The address, read in the guard, before a password is checked or counted
	// (card 2117): text, by the readers' rule (none of `, ; < > " ( )`, which
	// the mailer reads as more than one address), with a dot after the @ as it
	// had. Whether another account holds it is not asked here: asked before the
	// password, it would tell any session which addresses are taken, uncounted
	// (card 2771's code review, CS1). It is asked once, in the write, after the
	// password and the code; a taken address then leaves the code spent (S4).
	// The guard asks who is asking as their account is now (card 2253); it
	// decides nothing: the transaction that writes asks again.
	const {
		actor: email,
		userId: accountId,
		hash
	} = await confirmStepUp(locals, cookies, body, 'PUT /api/account/email', (caller) => {
		requireUser(caller);
		readText(body, 'newEmail', { required: true, trim: true, min: 1, says: { missing: 'Email is required', empty: 'Email is required' } });
		const typed = readEmail(body, 'newEmail', { required: true, says: 'Invalid email address' });
		if (!/^[^\s@]+@[^\s@]+\.[^\s@]+$/.test(typed)) throw error(400, 'Invalid email address');
		return typed.toLowerCase();
	});

	// One transaction: the account is read again, the address checked as free
	// and written, and the invites ended, together. It runs only while the
	// stored hash is the one the password was checked against; if the user or
	// an administrator changed it in between, nothing is written and the
	// answer is 409, with no second compare (card 2701's code review, S2). In
	// it, the session is asked again, and the account as it is now is changed:
	// the password check was awaited, and a session can end meanwhile.
	await whilePasswordHolds(accountId, hash, (current) =>
		writeAs(locals, (caller) => {
			const userId = requireUser(caller).id;

			// Refused 409 when another account holds the address: the only look,
			// after the password and the code (CS1).
			const existing = db.select({ id: users.id }).from(users).where(eq(users.email, email)).get();
			if (existing && existing.id !== userId) {
				throw error(409, 'Email is already in use');
			}

			// The same address in another case is not a change: an address is
			// stored in lower case. The invites, the pending sign-ins and the
			// enrolment links end before the address is written, as on the users
			// route.
			const changed = email !== current.email.toLowerCase();
			const invitesEnded = changed ? endUnusedInvites(userId) : 0;
			if (changed) endPendingSignIns(userId);

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
		}));

	return json({ success: true, email });
};
