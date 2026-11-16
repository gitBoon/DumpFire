/**
 * invites.ts — the one way an invite is issued.
 *
 * Whoever holds an invite sets the account's password with it, and is led on
 * to setting up two-step sign-in, with no session until that is done (card
 * 2769): the invite is the whole of what is asked of them before their
 * authenticator is theirs. So an account has at most one invite that works:
 * the newest. Issuing one deletes every invite of the account that has
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
 *
 * An invite's token is kept only as its SHA-256, the digest's 32 bytes as a
 * BLOB (card 2849), and looked up by that hash: whoever reads the database
 * file reads no link that works. The column is still declared TEXT, and an
 * image from before the card compares it with the address, which is text:
 * SQLite never takes a BLOB to equal text, so a stored hash is no link on that
 * image either. The token itself is only in the mail and, when the mail
 * fails, in the link the issuing administrator is given once. Migration 0068
 * ended every unused invite held in plain at the release and replaced the
 * token of every used one, and `endPlainInvites` (startup-checks.ts) does
 * both, at every start, to any an older image writes after going back.
 */
import { createHash } from 'node:crypto';
import { and, eq, gt, sql } from 'drizzle-orm';
import { db, sqlite } from './db';
import { inviteTokens, users } from './db/schema';
import { stamp, toStamp } from '$lib/timestamps';

/** How long an invite works for once it is issued: seven days. */
export const INVITE_LIFETIME_MS = 7 * 24 * 60 * 60 * 1000;

/**
 * The form an invite's token is kept in: its SHA-256, the 32 bytes of the
 * digest and not hex (card 2849; the code review, CR1), so that the stored
 * value is a BLOB and no text, an address included, is ever equal to it. The
 * token itself is only in the mail and, when the mail fails, the issuing
 * administrator's one-time link.
 */
export function inviteTokenHash(token: string): Buffer {
	return createHash('sha256').update(token).digest();
}

/** Whether a value read from `invite_tokens.token` is in the form `inviteTokenHash` gives. */
export function inHashForm(value: unknown): value is Buffer {
	return Buffer.isBuffer(value) && value.length === 32;
}

/**
 * The rows held in some other form: an invite whose token is not a BLOB of 32
 * bytes was written by an image from before card 2849, which kept the token
 * as text. The type is asked first: text of 32 characters is not a hash. SQL,
 * for the start-up sweep and the restore to share.
 */
export const NOT_IN_HASH_FORM = "(typeof(token) <> 'blob' OR length(token) <> 32)";

/**
 * Every used invite held in plain given the form migration 0068 gives one: 32
 * random bytes, the form of a hash and the hash of nothing. A row already in
 * hash form is left as it is. Run by the restore over an older backup's rows,
 * after they are copied, and by the start-up sweep over an older image's.
 */
export const REPLACE_PLAIN_USED_INVITES = `UPDATE invite_tokens SET token = randomblob(32) WHERE used <> 0 AND ${NOT_IN_HASH_FORM}`;

/**
 * Issue an invite for the account: delete its invites that have not been used,
 * write a new one that expires in `INVITE_LIFETIME_MS`, and return its token,
 * which is what the mail's link carries. Only the token's hash is written
 * (`inviteTokenHash`): the token is returned, and kept nowhere. An invite that
 * was used is left: it is spent, and `used` is how the page and the backup
 * tell it from a waiting one.
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
	db.insert(inviteTokens).values({ tokenHash: inviteTokenHash(token), userId, expiresAt }).run();

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
 *
 * Nor does an invite work for an account that holds a second factor (card
 * 2773, decision 9): it would set the password of an account whose holder
 * also needs their authenticator, and an administrator who means to give the
 * account back resets its two-step sign-in first. Asked in the one query, so
 * the page, its form before hashing and its transaction all refuse it.
 *
 * `token` is the token as it is in the address, and its hash is looked up
 * exactly (card 2849, decision 5): nothing is trimmed or case-folded, as the
 * text comparison it replaced did neither. The row returned carries the hash,
 * as `tokenHash`, and never the token.
 */
export function usableInvite(token: string) {
	// The stored form, as `issueInvite` writes the expiry (card 2095).
	const now = stamp();
	const found = db.select({ invite: inviteTokens, role: users.role })
		.from(inviteTokens)
		.innerJoin(users, eq(users.id, inviteTokens.userId))
		.where(and(
			eq(inviteTokens.tokenHash, inviteTokenHash(token)),
			eq(inviteTokens.used, false),
			gt(inviteTokens.expiresAt, now),
			// Written out with the table names: Drizzle writes a column of a query
			// on one table without its table's name, and inside the sub-select a
			// bare "user_id" would be the factor's own.
			sql`NOT EXISTS (SELECT 1 FROM "mfa_factors" WHERE "mfa_factors"."user_id" = "invite_tokens"."user_id")`
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
