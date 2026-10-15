import { json, error } from '@sveltejs/kit';
import { db } from '$lib/server/db';
import { afterCommit, inTransaction } from '$lib/server/db/transaction';
import { users } from '$lib/server/db/schema';
import { eq } from 'drizzle-orm';
import {
	SESSION_COOKIE_NAME,
	createSession,
	currentPasswordMatches,
	endAccountAccess,
	hashPassword,
	setSessionCookie,
	verifyPassword
} from '$lib/server/auth';
import { createLogger } from '$lib/server/logger';
import { readBody, readBoolean, readText } from '$lib/server/request-body';
import type { RequestHandler } from './$types';

const log = createLogger('AUTH');

/** PUT — Change own password. Requires current password verification. */
export const PUT: RequestHandler = async ({ request, locals, cookies }) => {
	// The wrong passwords are counted against the session that sent them,
	// which only a session reaches this route with.
	const session = cookies.get(SESSION_COOKIE_NAME);
	if (!locals.user || !session) throw error(401, 'Not authenticated');
	const userId = locals.user.id;

	const body = await readBody(request);

	// Whether the account's API keys end with the change. They are kept unless
	// asked: the holder has just proved they hold the password, and ending keys
	// stops every script that uses them. Anything but true or false is refused
	// before a password is checked or hashed, rather than read as one or the other.
	const endApiKeys = readBoolean(body, 'endApiKeys', {}) ?? false;

	// Text, or refused before it is checked or counted. A number used to reach
	// bcrypt, which threw: a 500, and so did a new password that was not text.
	const currentPassword = readText(body, 'currentPassword', { required: true, min: 1, says: 'Current password is required' });
	const SHORT = 'New password must be at least 8 characters';
	const newPassword = readText(body, 'newPassword', { required: true, min: 8, says: { missing: SHORT, empty: SHORT, invalid: SHORT } });

	// Get full user with password hash
	const user = db.select().from(users).where(eq(users.id, userId)).get();
	if (!user) throw error(404, 'User not found');

	// Verify current password. Ten wrong ones in 15 minutes from this session,
	// and it is refused.
	if (!currentPasswordMatches(session, userId, currentPassword, user.passwordHash, 'PUT /api/account/password')) {
		throw error(403, 'Current password is incorrect');
	}

	// Checking a password and hashing one each take about a quarter of a
	// second, and nothing else can write while a transaction is open. Both are
	// done out here, before it.
	const newHash = hashPassword(newPassword);

	// One transaction: the password, the sessions that end and the session that
	// replaces them change together. A failure after the first used to leave a
	// new password with the old sessions still good, or with no session at all.
	const { newToken, apiKeysEnded } = inTransaction(() => {
		// The password was checked against the row as it was read above. If it
		// has been changed since, by another request or by an administrator, it
		// is checked again against the row as it is now. The same guess, so it
		// is not counted again.
		const current = db.select().from(users).where(eq(users.id, userId)).get();
		if (!current) throw error(404, 'User not found');
		if (current.passwordHash !== user.passwordHash && !verifyPassword(currentPassword, current.passwordHash)) {
			throw error(403, 'Current password is incorrect');
		}

		// Update password
		db.update(users)
			.set({ passwordHash: newHash })
			.where(eq(users.id, userId))
			.run();

		// Every existing session of this user ends, and every invite not yet
		// used, which would set the password again. The API keys end only if
		// the user asked.
		const ended = endAccountAccess(userId, { apiKeys: endApiKeys });
		afterCommit(() =>
			log.info(
				`Password changed by user — ended ${ended.sessions} session(s), ${ended.invites} invite(s) and ` +
					`${ended.apiKeys} API key(s)`,
				{ sessionsEnded: ended.sessions, invitesEnded: ended.invites, apiKeysEnded: ended.apiKeys },
				{ userId }
			)
		);

		// Create a fresh session so the current user stays logged in
		return { newToken: createSession(userId), apiKeysEnded: ended.apiKeys };
	});

	setSessionCookie(cookies, newToken);

	return json({ success: true, apiKeysEnded });
};
