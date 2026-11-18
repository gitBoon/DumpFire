import { json, error } from '@sveltejs/kit';
import { db } from '$lib/server/db';
import { apiKeys } from '$lib/server/db/schema';
import { eq, and } from 'drizzle-orm';
import { pathId } from '$lib/server/request-body';
import { requireUser } from '$lib/server/route-guards';
import { writeAs } from '$lib/server/write-as';
import { switchOffLostWebhooks } from '$lib/server/webhooks';
import type { RequestHandler } from './$types';

/**
 * DELETE — Revoke an API key by ID (must belong to the current user).
 *
 * The webhooks the key set up are switched off for good in the same write
 * (card 2893, D5, S10): the key deleted (its webhooks' `set_by_key` emptied by
 * the foreign key, which `holdOf` reads as a key that ended), then the
 * account's webhooks swept (`{ setters }`), which also finds one set up
 * before keys were recorded whose setter has just lost their last key from
 * then. The boards' owners, and the account itself where it can still open
 * the board, are mailed after the commit. Answers how many were switched off
 * (`webhooksSwitchedOff`); the Account page said how many first, from the
 * list's `webhooks`.
 */
export const DELETE: RequestHandler = async ({ params, locals }) => {
	requireUser(locals.user);

	// An id, as every id in a path is read (card 2117): `1.5` and `0` were looked for.
	const id = pathId(params.id, 'key');

	// The key found and revoked in one transaction that asks first whether the
	// session is still open, and who its account is now (card 2253). The read
	// and the delete were two steps with no transaction around them.
	const webhooksSwitchedOff = writeAs(locals, (caller) => {
		const user = requireUser(caller);
		const key = db.select()
			.from(apiKeys)
			.where(and(eq(apiKeys.id, id), eq(apiKeys.userId, user.id)))
			.get();

		if (!key) throw error(404, 'API key not found');

		db.delete(apiKeys).where(eq(apiKeys.id, id)).run();
		// The key by its id, never its name: the cause goes to the system log, which
		// every administrator reads, and to the boards' owners (the ruling on S1's
		// departure 9, as the create keeps a key's name out of the log).
		return switchOffLostWebhooks({ setters: [user.id] }, `API key #${key.id} was revoked by ${user.username}`).length;
	});

	return json({ success: true, webhooksSwitchedOff });
};
