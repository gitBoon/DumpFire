import { json, error } from '@sveltejs/kit';
import { db } from '$lib/server/db';
import { afterCommit } from '$lib/server/db/transaction';
import { apiKeys } from '$lib/server/db/schema';
import { and, eq } from 'drizzle-orm';
import { deadlinePassed, whilePasswordHolds } from '$lib/server/auth';
import { createLogger } from '$lib/server/logger';
import { pathId, readBody } from '$lib/server/request-body';
import { requireUser } from '$lib/server/route-guards';
import { confirmStepUp } from '$lib/server/step-up';
import { writeAs } from '$lib/server/write-as';
import { stamp } from '$lib/timestamps';
import type { RequestHandler } from './$types';

const log = createLogger('AUTH');

/** Keep refused: the key has no deadline to clear. */
const NO_DEADLINE = 'This key has no deadline to clear.';

/** Keep refused: the key's deadline has passed, and it is never revived. */
const DEADLINE_PASSED = 'This key has passed its deadline and no longer works. Generate a new key.';

/**
 * The caller's own key `id` that may be kept now: 404 when it is not theirs
 * (or not there), 409 when it has no deadline, or when its deadline has
 * passed or cannot be read (`deadlinePassed`). Asked by the guard and again
 * by the write, so a deadline that passes while the password is checked is
 * refused at the write.
 */
function keepable(id: number, userId: number): void {
	const key = db.select({ deadlineAt: apiKeys.deadlineAt })
		.from(apiKeys)
		.where(and(eq(apiKeys.id, id), eq(apiKeys.userId, userId)))
		.get();
	if (!key) error(404, 'API key not found');
	if (key.deadlineAt === null) error(409, NO_DEADLINE);
	if (deadlinePassed(key, stamp())) error(409, DEADLINE_PASSED);
}

/**
 * POST — Keep an API key made before two-step sign-in: clear the deadline
 * migration 0069 gave it, so that it goes on working (card 2772, D5).
 *
 * Asks for the current password and a code (`currentPassword`,
 * `currentCode`), through the step-up every listed action asks with: the
 * keys being kept were made on a password alone, and keeping one is what
 * lets it outlive the deadline. Everything that needs neither is refused
 * first, with nothing counted. Only `deadline_at` is written: the key's
 * expiry, hash and prefix are untouched, so the key the holder has goes on
 * working as it is. A key past its deadline is never revived: the holder
 * makes a new one.
 */
export const POST: RequestHandler = async ({ params, request, locals, cookies }) => {
	requireUser(locals.user);

	// An id, as every id in a path is read (card 2117).
	const id = pathId(params.id, 'key');
	const body = await readBody(request);

	const { userId: accountId, hash } = await confirmStepUp(locals, cookies, body, 'POST /api/account/api-keys/[id]/keep', (caller) => {
		keepable(id, requireUser(caller).id);
	});

	// The key asked about again in the transaction that clears its deadline,
	// held to the password checked and to the session still being open: a
	// deadline can pass, and a key be revoked, while the password is checked.
	await whilePasswordHolds(accountId, hash, () =>
		writeAs(locals, (caller) => {
			const userId = requireUser(caller).id;
			keepable(id, userId);
			db.update(apiKeys)
				.set({ deadlineAt: null })
				.where(and(eq(apiKeys.id, id), eq(apiKeys.userId, userId)))
				.run();

			// The key's id and its user only, as when a key is made.
			afterCommit(() => log.info(`API key ${id} kept past its deadline by user ${userId}`, { keyId: id }, { userId }));
		}));

	return json({ success: true });
};
