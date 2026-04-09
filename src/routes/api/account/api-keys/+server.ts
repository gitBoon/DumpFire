import { json, error } from '@sveltejs/kit';
import { db } from '$lib/server/db';
import { apiKeys } from '$lib/server/db/schema';
import { eq } from 'drizzle-orm';
import { generateApiKey, hashApiKey } from '$lib/server/auth';
import type { RequestHandler } from './$types';

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

/** POST — Generate a new API key. The plaintext key is returned ONCE. */
export const POST: RequestHandler = async ({ request, locals }) => {
	if (!locals.user) throw error(401, 'Not authenticated');

	const body = await request.json();
	const name = (body.name || '').trim();
	if (!name) throw error(400, 'Key name is required');
	if (name.length > 100) throw error(400, 'Key name too long (max 100 chars)');

	// Limit to 10 keys per user
	const existing = db.select({ id: apiKeys.id })
		.from(apiKeys)
		.where(eq(apiKeys.userId, locals.user.id))
		.all();
	if (existing.length >= 10) {
		throw error(400, 'Maximum of 10 API keys per user');
	}

	const { plaintextKey, keyHash, keyPrefix } = generateApiKey();

	const record = db.insert(apiKeys)
		.values({
			keyHash,
			keyPrefix,
			name,
			userId: locals.user.id,
			expiresAt: body.expiresAt || null
		})
		.returning()
		.get();

	return json({
		id: record.id,
		name: record.name,
		keyPrefix: record.keyPrefix,
		key: plaintextKey, // Shown ONCE — never stored or returned again
		createdAt: record.createdAt,
		expiresAt: record.expiresAt
	}, { status: 201 });
};
