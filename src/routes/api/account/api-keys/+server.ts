import { json, error } from '@sveltejs/kit';
import { db } from '$lib/server/db';
import { afterCommit } from '$lib/server/db/transaction';
import { apiKeys, users } from '$lib/server/db/schema';
import { eq } from 'drizzle-orm';
import { SESSION_COOKIE_NAME, checkCurrentPassword, generateApiKey, whilePasswordHolds } from '$lib/server/auth';
import { createLogger } from '$lib/server/logger';
import { readBody, readText, readTimestamp } from '$lib/server/request-body';
import { requireUser } from '$lib/server/route-guards';
import { writeAs } from '$lib/server/write-as';
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
	requireUser(locals.user);
	if (!session) throw error(401, 'Not authenticated');

	// Every field is read before a password is checked or counted (card 2117).
	const body = await readBody(request);
	const name = readText(body, 'name', {
		required: true,
		trim: true,
		min: 1,
		max: 100,
		says: { missing: 'Key name is required', empty: 'Key name is required' }
	});
	const password = readText(body, 'password', { required: true, min: 1, says: 'Password is required' });
	// A moment yet to come, kept in the stored form, `YYYY-MM-DD HH:MM:SS` in
	// UTC (R13; card 2095): the expiry is compared with the time as text, and
	// any text was stored, so "banana" never expired and a time written with an
	// offset compared wrongly. `null`, or no field, is no expiry.
	const expiresAt = readTimestamp(body, 'expiresAt', { future: true, nullable: true }) ?? null;

	/** Limit to 10 keys per user. */
	const requireRoom = (userId: number) => {
		const existing = db.select({ id: apiKeys.id })
			.from(apiKeys)
			.where(eq(apiKeys.userId, userId))
			.all();
		if (existing.length >= 10) {
			throw error(400, 'Maximum of 10 API keys per user');
		}
	};

	// Who is asking, as their account is now, once the body has come: a session
	// that ended while it arrived is refused here, before a password is checked
	// or counted (card 2253). It decides nothing: the transaction that adds the
	// key asks again.
	const me = writeAs(locals, (caller) => requireUser(caller));

	// Looked at first so that a request that will be refused for the limit is
	// not made to wait for a password check, and counted again in the
	// transaction that adds the key.
	requireRoom(me.id);

	// Checking a password takes about a quarter of a second, on a worker
	// thread, and is awaited, which a transaction cannot do, so it is checked
	// out here first. Ten wrong ones in 15 minutes from this session, and it
	// is refused.
	const user = db.select().from(users).where(eq(users.id, me.id)).get();
	if (!user) throw error(404, 'User not found');
	const wrong = () => error(403, 'Password is incorrect');
	if (!(await checkCurrentPassword(session, user.id, password, user.passwordHash, 'POST /api/account/api-keys')).matches) {
		wrong();
	}

	const { plaintextKey, keyHash, keyPrefix } = generateApiKey();

	// One transaction: the password and the limit are checked in the one that
	// adds the key, so a key cannot be made with a password a change has just
	// ended, nor past the limit by two requests at once. It runs only while the
	// stored hash is the one the password was checked against; if the user or
	// an administrator changed it in between, the password is checked again
	// against the new one, outside, and not counted again: the same guess. In
	// it, the session is asked again, and the account as it is now adds the
	// key: the password check was awaited, and a session can end meanwhile.
	const record = await whilePasswordHolds(user.id, password, user.passwordHash, () =>
		writeAs(locals, (caller) => {
			const userId = requireUser(caller).id;
			requireRoom(userId);

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
		}), wrong);

	return json({
		id: record.id,
		name: record.name,
		keyPrefix: record.keyPrefix,
		key: plaintextKey, // Shown ONCE — never stored or returned again
		createdAt: record.createdAt,
		expiresAt: record.expiresAt
	}, { status: 201 });
};
