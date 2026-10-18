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
import { and, eq, gt } from 'drizzle-orm';
import { db, sqlite } from './db';
import { inviteTokens, users } from './db/schema';
import { stamp, toStamp } from '$lib/timestamps';

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

/**
 * The invite, if it can set a password: it has not been used, it has not
 * expired (and its expiry names a moment), and its account is not the
 * superadmin's.
 *
 * Nobody may set the superadmin's password but the superadmin, who does so on
 * the Account page with the current one, and no route issues an invite for
 * that account. One written before that rule would otherwise set the only
 * superadmin's password and end every session and key they have, with no way
 * back but a command on the host. An administrator's invite is not refused:
 * the superadmin sends those.
 *
 * The invite page asks it, its form too, so that the page and the form agree
 * on which links work; and an invite route asks it before it hands the link
 * of an invite whose mail did not go to the administrator who issued it
 * (card 2196, R-S1): a newer invite sent meanwhile has deleted this one.
 */
export function usableInvite(token: string) {
	// The stored form, as `issueInvite` writes the expiry (card 2095).
	const now = stamp();
	const found = db.select({ invite: inviteTokens, role: users.role })
		.from(inviteTokens)
		.innerJoin(users, eq(users.id, inviteTokens.userId))
		.where(and(
			eq(inviteTokens.token, token),
			eq(inviteTokens.used, false),
			gt(inviteTokens.expiresAt, now)
		))
		.get();
	if (!found || found.role === 'superadmin') return undefined;
	// The query compares text, which lets through an expiry that names no
	// moment (`zzz` sorts after every stamp) and ISO with its `T` on the day
	// itself; so the expiry is read as the moment it names as well, and one
	// that names none has passed (the P6 review, S2).
	const expires = toStamp(found.invite.expiresAt);
	if (expires === null || expires <= now) return undefined;
	return found.invite;
}
