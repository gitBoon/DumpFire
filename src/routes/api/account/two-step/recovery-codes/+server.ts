import { json } from '@sveltejs/kit';
import { whilePasswordHolds } from '$lib/server/auth';
import { regenerateRecoveryCodes } from '$lib/server/account-two-step';
import { addressOf } from '$lib/server/client-address';
import { readBody } from '$lib/server/request-body';
import { requireUser } from '$lib/server/route-guards';
import { confirmStepUp } from '$lib/server/step-up';
import { writeAs } from '$lib/server/write-as';
import type { RequestHandler } from './$types';

/**
 * POST — A new set of ten recovery codes, in place of every one the caller
 * held (card 2772, D3).
 *
 * Asks for the current password and a code (`currentPassword`,
 * `currentCode`), through the step-up: each recovery code signs in in place of
 * a code. A step-up proved by a recovery code spends it, and the write then
 * replaces it with the rest. The answer, which no cache keeps, holds the ten
 * codes once, written `XXXX-XXXX-XXXX-XXXX`; only their hashes are kept. The
 * owner is mailed.
 */
export const POST: RequestHandler = async ({ request, locals, cookies, getClientAddress }) => {
	requireUser(locals.user);

	const body = await readBody(request);

	const { userId, hash } = await confirmStepUp(locals, cookies, body, 'POST /api/account/two-step/recovery-codes', (caller) => {
		requireUser(caller);
	});
	const address = addressOf({ getClientAddress })?.slice(0, 100) ?? null;

	const codes = await whilePasswordHolds(userId, hash, () =>
		writeAs(locals, (caller) => regenerateRecoveryCodes(requireUser(caller).id, address)));

	return json({ codes }, { headers: { 'Cache-Control': 'no-store' } });
};
