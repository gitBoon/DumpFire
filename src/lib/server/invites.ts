/**
 * invites.ts — the one way an invite is issued.
 *
 * Whoever holds an invite sets the account's password with it and is signed
 * in, and is asked for nothing else. So an account has at most one invite that
 * works: the newest. Issuing one deletes every invite of the account that has
 * not been used, expired or not. The invite page tells whoever holds an older
 * link that it no longer works.
 *
 * Both routes that issue an invite call `issueInvite`, so the rule and the
 * lifetime are written here once: POST /api/users/[id]/invite, and POST
 * /api/users with no password.
 *
 * An invite is addressed to an account as it was when it was sent. So every
 * invite of the account that has not been used also ends when its password
 * is set (`endAccountAccess`, in auth.ts) and when its email address or its
 * role is changed (PUT /api/users/[id] and PUT /api/account/email): the mail
 * may have gone to an address the account no longer has, or been sent before
 * the account was made an administrator. All of them end through
 * `endUnusedInvites`, so "an invite that has not been used" is written once.
 */
import { and, eq } from 'drizzle-orm';
import { db, sqlite } from './db';
import { inviteTokens } from './db/schema';
import { stamp } from '$lib/timestamps';

/** How long an invite works for once it is issued: seven days. */
export const INVITE_LIFETIME_MS = 7 * 24 * 60 * 60 * 1000;

/**
 * Issue an invite for the account: delete its invites that have not been used,
 * write a new one that expires in `INVITE_LIFETIME_MS`, and return its token,
 * which is what the mail's link carries. An invite that was used is left: it
 * is spent, and `used` is how the page and the backup tell it from a waiting
 * one.
 *
 * Inside the caller's transaction, the one that checked the account may be
 * invited, and with the mail sent once it is committed. It throws if no
 * transaction is open.
 */
export function issueInvite(userId: number): string {
	if (!sqlite.inTransaction) {
		throw new Error(
			'issueInvite must be called inside the transaction that checks the account may be invited: wrap ' +
				'the check and this call in inTransaction.'
		);
	}

	endUnusedInvites(userId);

	const token = crypto.randomUUID();
	const expiresAt = stamp(new Date(Date.now() + INVITE_LIFETIME_MS));
	db.insert(inviteTokens).values({ token, userId, expiresAt }).run();

	return token;
}

/**
 * Delete every invite of the account that has not been used, expired or not,
 * and return how many there were. One that was used is left, marked used.
 *
 * Inside the caller's transaction, the one that makes the change the invites
 * end with. It throws if no transaction is open. `issueInvite` and
 * `endAccountAccess` check for one themselves first, so that the error names
 * the function their caller called.
 */
export function endUnusedInvites(userId: number): number {
	if (!sqlite.inTransaction) {
		throw new Error(
			'endUnusedInvites must be called inside the transaction that changes the account: wrap the change ' +
				'and this call in inTransaction.'
		);
	}

	return db
		.delete(inviteTokens)
		.where(and(eq(inviteTokens.userId, userId), eq(inviteTokens.used, false)))
		.run().changes;
}
