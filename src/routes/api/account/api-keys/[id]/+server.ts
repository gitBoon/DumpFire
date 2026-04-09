import { json, error } from '@sveltejs/kit';
import { db } from '$lib/server/db';
import { apiKeys } from '$lib/server/db/schema';
import { eq, and } from 'drizzle-orm';
import type { RequestHandler } from './$types';

/** DELETE — Revoke an API key by ID (must belong to the current user). */
export const DELETE: RequestHandler = async ({ params, locals }) => {
	if (!locals.user) throw error(401, 'Not authenticated');

	const id = Number(params.id);
	if (isNaN(id)) throw error(400, 'Invalid key ID');

	const key = db.select()
		.from(apiKeys)
		.where(and(eq(apiKeys.id, id), eq(apiKeys.userId, locals.user.id)))
		.get();

	if (!key) throw error(404, 'API key not found');

	db.delete(apiKeys).where(eq(apiKeys.id, id)).run();

	return json({ success: true });
};
