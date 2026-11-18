import { json, error } from '@sveltejs/kit';
import { db } from '$lib/server/db';
import { afterCommit } from '$lib/server/db/transaction';
import { apiKeys } from '$lib/server/db/schema';
import { eq } from 'drizzle-orm';
import { webhooksStoppedByRevoke } from '$lib/server/webhooks';
import { generateApiKey, whilePasswordHolds } from '$lib/server/auth';
import { createLogger } from '$lib/server/logger';
import { readBody, readText, readTimestamp } from '$lib/server/request-body';
import { requireUser } from '$lib/server/route-guards';
import { confirmStepUp } from '$lib/server/step-up';
import { writeAs } from '$lib/server/write-as';
import type { RequestHandler } from './$types';

const log = createLogger('AUTH');

/**
 * GET — List the current user's API keys (without the secret). `deadlineAt`
 * is the deadline a key made before two-step sign-in has until it is kept
 * (migration 0069, card 2772), as stored; null when it has none.
 * `webhooks` is how many webhooks revoking the key would switch off now (card
 * 2893, D5, S13; the code review's CS4, `webhooksStoppedByRevoke`): those that
 * are on and record it, and, for the account's last working key made before
 * keys were recorded, the account's webhooks from before then that are still
 * sent. The Account page says so before the revoke. A count, never which: the
 * boards may be ones the holder can no longer open.
 */
export const GET: RequestHandler = async ({ locals }) => {
	if (!locals.user) throw error(401, 'Not authenticated');

	const keys = db.select({
		id: apiKeys.id,
		name: apiKeys.name,
		keyPrefix: apiKeys.keyPrefix,
		lastUsedAt: apiKeys.lastUsedAt,
		expiresAt: apiKeys.expiresAt,
		createdAt: apiKeys.createdAt,
		deadlineAt: apiKeys.deadlineAt
	})
		.from(apiKeys)
		.where(eq(apiKeys.userId, locals.user.id))
		.all();
	const stopped = webhooksStoppedByRevoke(locals.user.id);

	return json(keys.map((key) => ({ ...key, webhooks: stopped.get(key.id) ?? 0 })));
};

/**
 * POST — Generate a new API key. The plaintext key is returned ONCE.
 *
 * Asks for the current password and a code (`currentPassword`,
 * `currentCode`: card 2771, D7), through the step-up that every listed action
 * asks with (step-up.ts). A key works until it is revoked, and the holder's
 * own password change keeps it unless they ask otherwise, so a key made on a
 * session alone let whoever held that session for a moment (an unlocked
 * machine, a copied cookie) keep the account after the password was changed.
 */
export const POST: RequestHandler = async ({ request, locals, cookies }) => {
	requireUser(locals.user);

	const body = await readBody(request);

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

	// Every field is read in the guard, before a password is checked or
	// counted (card 2117): the name; the expiry, a moment yet to come, kept in
	// the stored form, `YYYY-MM-DD HH:MM:SS` in UTC (R13; card 2095: the
	// expiry is compared with the time as text, and any text was stored, so
	// "banana" never expired and a time written with an offset compared
	// wrongly; `null`, or no field, is no expiry); and the limit, looked at
	// first so that a request that will be refused for it is not made to wait
	// for a password check, and counted again in the transaction that adds
	// the key. The guard asks who is asking as their account is now (card
	// 2253); it decides nothing: the transaction asks again.
	const {
		actor: { name, expiresAt },
		userId: accountId,
		hash
	} = await confirmStepUp(locals, cookies, body, 'POST /api/account/api-keys', (caller) => {
		const me = requireUser(caller);
		const name = readText(body, 'name', {
			required: true,
			trim: true,
			min: 1,
			max: 100,
			says: { missing: 'Key name is required', empty: 'Key name is required' }
		});
		const expiresAt = readTimestamp(body, 'expiresAt', { future: true, nullable: true }) ?? null;
		requireRoom(me.id);
		return { name, expiresAt };
	});

	const { plaintextKey, keyHash, keyPrefix } = generateApiKey();

	// One transaction: the password and the limit are checked in the one that
	// adds the key, so a key cannot be made with a password a change has just
	// ended, nor past the limit by two requests at once. It runs only while the
	// stored hash is the one the password was checked against; if the user or
	// an administrator changed it in between, nothing is written and the
	// answer is 409, with no second compare (card 2701's code review, S2). In
	// it, the session is asked again, and the account as it is now adds the
	// key: the password check was awaited, and a session can end meanwhile.
	const record = await whilePasswordHolds(accountId, hash, () =>
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
		}));

	return json({
		id: record.id,
		name: record.name,
		keyPrefix: record.keyPrefix,
		key: plaintextKey, // Shown ONCE — never stored or returned again
		createdAt: record.createdAt,
		expiresAt: record.expiresAt
	}, { status: 201 });
};
