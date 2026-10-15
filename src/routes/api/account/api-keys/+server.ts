import { json, error } from '@sveltejs/kit';
import { db } from '$lib/server/db';
import { afterCommit, inTransaction } from '$lib/server/db/transaction';
import { apiKeys, users } from '$lib/server/db/schema';
import { eq } from 'drizzle-orm';
import { SESSION_COOKIE_NAME, currentPasswordMatches, generateApiKey, verifyPassword } from '$lib/server/auth';
import { createLogger } from '$lib/server/logger';
import { readBody, readText, readTimestamp } from '$lib/server/request-body';
import type { RequestHandler } from './$types';

const log = createLogger('AUTH');

/** GET — List the current user's API keys (without the secret). */
export const GET: RequestHandler = async ({ locals }) => {
	if (!locals.user) throw error(401, 'Not authenticated');

	const keys = db.select({
		id: apiKeys.id,
		name: apiKeys.name,
		keyPrefix: apiKeys.keyPrefix,
		lastUsedAt: apiKeys.lastUsedAt,
		expiresAt: apiKeys.expiresAt,
		createdAt: apiKeys.createdAt
	})
		.from(apiKeys)
		.where(eq(apiKeys.userId, locals.user.id))
		.all();

	return json(keys);
};

/**
 * POST — Generate a new API key. The plaintext key is returned ONCE.
 *
 * Asks for the current password. A key works until it is revoked, and the
 * holder's own password change keeps it unless they ask otherwise, so a key
 * made on a session alone let whoever held that session for a moment (an
 * unlocked machine, a copied cookie) keep the account after the password was
 * changed.
 */
export const POST: RequestHandler = async ({ request, locals, cookies }) => {
	// The wrong passwords are counted against the session that sent them,
	// which only a session reaches this route with.
	const session = cookies.get(SESSION_COOKIE_NAME);
	if (!locals.user || !session) throw error(401, 'Not authenticated');
	const userId = locals.user.id;

	// Every field is read before a password is checked or counted (card 2117).
	const body = await readBody(request);
	const name = readText(body, 'name', {
		required: true,
		trim: true,
		min: 1,
		max: 100,
		says: { missing: 'Key name is required', empty: 'Key name is required', invalid: 'Key name too long (max 100 chars)' }
	});
	const password = readText(body, 'password', { required: true, min: 1, says: 'Password is required' });
	// A moment yet to come, kept in one form (R13): the expiry is compared with
	// the time as text, and any text was stored, so "banana" never expired and
	// a time written with an offset compared wrongly.
	const expiresAt = readTimestamp(body, 'expiresAt', { future: true, nullable: true }) ?? null;

	/** Limit to 10 keys per user. */
	const requireRoom = () => {
		const existing = db.select({ id: apiKeys.id })
			.from(apiKeys)
			.where(eq(apiKeys.userId, userId))
			.all();
		if (existing.length >= 10) {
			throw error(400, 'Maximum of 10 API keys per user');
		}
	};

	// Looked at first so that a request that will be refused for the limit is
	// not made to wait for a password check, and counted again in the
	// transaction that adds the key.
	requireRoom();

	// Checking a password takes about a quarter of a second, and nothing else
	// can write while a transaction is open, so it is checked out here first.
	// Ten wrong ones in 15 minutes from this session, and it is refused.
	const user = db.select().from(users).where(eq(users.id, userId)).get();
	if (!user) throw error(404, 'User not found');
	if (!currentPasswordMatches(session, userId, password, user.passwordHash, 'POST /api/account/api-keys')) {
		throw error(403, 'Password is incorrect');
	}

	const { plaintextKey, keyHash, keyPrefix } = generateApiKey();

	// One transaction: the password and the limit are checked in the one that
	// adds the key, so a key cannot be made with a password a change has just
	// ended, nor past the limit by two requests at once.
	const record = inTransaction(() => {
		// The password was checked against the row as it was read above. If it
		// has been changed since, by the user or by an administrator, it is
		// checked again against the row as it is now. The same guess, so it is
		// not counted again.
		const current = db.select().from(users).where(eq(users.id, userId)).get();
		if (!current) throw error(404, 'User not found');
		if (current.passwordHash !== user.passwordHash && !verifyPassword(password, current.passwordHash)) {
			throw error(403, 'Password is incorrect');
		}

		requireRoom();

		const row = db.insert(apiKeys)
			.values({
				keyHash,
				keyPrefix,
				name,
				userId,
				expiresAt
			})
			.returning()
			.get();

		// The key's id and its user only. Every administrator reads the system
		// log, and every backup holds it: a key's name and prefix are its
		// holder's, shown on their own Account page.
		afterCommit(() => log.info(`API key ${row.id} created by user ${userId}`, { keyId: row.id }, { userId }));
		return row;
	});

	return json({
		id: record.id,
		name: record.name,
		keyPrefix: record.keyPrefix,
		key: plaintextKey, // Shown ONCE — never stored or returned again
		createdAt: record.createdAt,
		expiresAt: record.expiresAt
	}, { status: 201 });
};
