import { json, error } from '@sveltejs/kit';
import { db } from '$lib/server/db';
import { apiKeys } from '$lib/server/db/schema';
import { eq, and } from 'drizzle-orm';
import { pathId } from '$lib/server/request-body';
import { requireUser } from '$lib/server/route-guards';
import { writeAs } from '$lib/server/write-as';
import type { RequestHandler } from './$types';

/** DELETE — Revoke an API key by ID (must belong to the current user). */
export const DELETE: RequestHandler = async ({ params, locals }) => {
	requireUser(locals.user);

	// An id, as every id in a path is read (card 2117): `1.5` and `0` were looked for.
	const id = pathId(params.id, 'key');

	// The key found and revoked in one transaction that asks first whether the
	// session is still open, and who its account is now (card 2253). The read
	// and the delete were two steps with no transaction around them.
	writeAs(locals, (caller) => {
		const user = requireUser(caller);
		const key = db.select()
			.from(apiKeys)
			.where(and(eq(apiKeys.id, id), eq(apiKeys.userId, user.id)))
			.get();

		if (!key) throw error(404, 'API key not found');

		db.delete(apiKeys).where(eq(apiKeys.id, id)).run();
	});

	return json({ success: true });
};
