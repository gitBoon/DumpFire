/**
 * account-fields.ts — what the two routes that write an account take from a
 * request body: POST /api/users and PUT /api/users/[id].
 *
 * Both used to compare `role` with `=== 'admin'` and `=== 'superadmin'` and
 * then bind it as it was sent. `["superadmin"]` is neither of those strings,
 * so it passed both comparisons, and the database driver binds an array of one
 * as the one: an administrator made anyone, themselves included, the
 * superadmin. A field is now shown to be what it is taken for before it is
 * compared with anything or written anywhere.
 *
 *     readAccountFields          each text field that was sent, by its rule
 *     requireAssignableRole      a role that was sent is one the caller may give
 *     requireUnusedAccountFields a username or an email no other account has
 *
 * Three functions and not one, because POST /api/users answers for a missing
 * password before it answers for the role, and has to have its text fields
 * read before either; and a name or an address is looked for among the
 * accounts last, in the transaction that writes it.
 *
 * Both routes hold a username and an email to the same rules (card 2117,
 * decision 14). PUT /api/users/[id] wrote them as they came: untrimmed, of any
 * length, and a duplicate was a 500 from the UNIQUE constraint.
 */
import { error } from '@sveltejs/kit';
import { eq } from 'drizzle-orm';
import { db } from './db';
import { users, type User } from './db/schema';
import { readChoice, readEmail, readText, type RequestBody } from './request-body';
import type { SessionUser } from './auth';

/**
 * The roles a route may write. `superadmin` is not among them: the first
 * account is made one by the setup page, and nothing makes another.
 */
export type AssignableRole = 'user' | 'admin';

/** The account fields of a body, as `readAccountFields` read them. A field not sent is not there. */
export type AccountFields = {
	username?: string;
	email?: string;
	password?: string;
	emoji?: string;
};

/** The fields of a new account, whose username and email are required. */
export type NewAccountFields = AccountFields & { username: string; email: string };

/** What an account holds now, which a change may send back as it is. */
export type StoredAccountFields = Pick<User, 'username' | 'email' | 'emoji'>;

const TEXT_FIELDS = ['username', 'email', 'password', 'emoji'] as const;

const USERNAME_RULE = 'Username must be at least 2 characters';
const EMAIL_RULE = 'Valid email required';

/**
 * The account fields of a request body, each by its rule, or a 400.
 *
 * First, each of `username`, `email`, `password` and `emoji` that was sent is
 * a string, or `<name> must be a string`: one sent as `null`, a number, an
 * array or an object is refused before any field is held to its rule, so the
 * field of the wrong type is the one named. Then:
 *
 *     username  trimmed, at least 2 characters
 *     email     trimmed, an email address (`$lib/server/request-body`'s rule:
 *               something, an @ and something, with no space and none of
 *               `, ; < > " ( )`, which the mailer reads as two addresses)
 *     password  text; its length is the route's to say, by whether mail is set up
 *     emoji     1 to 32 characters
 *
 * A new account (no `stored`) must have a username and an email. On a change,
 * a value equal to the one the account holds is kept as it is, whatever these
 * rules say of it (decision 8). `role` is `requireAssignableRole`'s.
 */
export function readAccountFields(body: RequestBody): NewAccountFields;
export function readAccountFields(body: RequestBody, stored: StoredAccountFields): AccountFields;
export function readAccountFields(body: RequestBody, stored?: StoredAccountFields): AccountFields {
	for (const name of TEXT_FIELDS) readText(body, name, { says: { type: `${name} must be a string` } });

	const required = stored === undefined;
	const username = readText(body, 'username', {
		required,
		trim: true,
		min: 2,
		keep: stored?.username,
		says: { missing: USERNAME_RULE, empty: USERNAME_RULE, invalid: USERNAME_RULE }
	});
	const email = readEmail(body, 'email', { required, keep: stored?.email, says: { missing: EMAIL_RULE, invalid: EMAIL_RULE } });
	const password = readText(body, 'password', {});
	const emoji = readText(body, 'emoji', { min: 1, max: 32, keep: stored?.emoji });

	const fields: AccountFields = {};
	if (username !== undefined) fields.username = username;
	if (email !== undefined) fields.email = email;
	if (password !== undefined) fields.password = password;
	if (emoji !== undefined) fields.emoji = emoji;
	return fields;
}

/** What `role` may be sent as: the two a route gives, and the one it refuses in its own words. */
const ROLES_SENT = ['user', 'admin', 'superadmin'] as const;

/**
 * The role a body asks for, if it is one this caller may give: `undefined`
 * where none was sent.
 *
 *     400  `superadmin`, in the route's own words (`says.superadmin`)
 *     400  anything else that is not exactly the string `user` or `admin`:
 *          another spelling, `null`, a number, an array, an object
 *     403  `admin`, from anyone but the superadmin (`says.promote`)
 *
 * The 403 is asked of the value that passed the two before it, so what is
 * compared is what is written.
 */
export function requireAssignableRole(
	actor: Pick<SessionUser, 'role'>,
	body: RequestBody,
	says: { superadmin: string; promote: string }
): AssignableRole | undefined {
	const role = readChoice(body, 'role', { from: ROLES_SENT, says: 'role must be "user" or "admin"' });
	if (role === undefined) return undefined;

	if (role === 'superadmin') error(400, says.superadmin);

	// Only the superadmin makes an administrator.
	if (role === 'admin' && actor.role !== 'superadmin') error(403, says.promote);
	return role;
}

/**
 * A 409 for a username or an email another account has, in the words of
 * POST /api/users: `Username already taken`, `Email already in use`. An email
 * is looked for in lower case, as it is stored. `except` is the account being
 * changed, whose own username and email are not a clash.
 *
 * Called in the transaction that writes the account. PUT /api/users/[id] did
 * not ask, and a duplicate was a 500 from the database's UNIQUE constraint.
 */
export function requireUnusedAccountFields(fields: Pick<AccountFields, 'username' | 'email'>, except?: number): void {
	if (fields.username !== undefined) {
		const holder = db.select({ id: users.id }).from(users).where(eq(users.username, fields.username)).get();
		if (holder && holder.id !== except) error(409, 'Username already taken');
	}
	if (fields.email !== undefined) {
		const holder = db.select({ id: users.id }).from(users).where(eq(users.email, fields.email.toLowerCase())).get();
		if (holder && holder.id !== except) error(409, 'Email already in use');
	}
}
