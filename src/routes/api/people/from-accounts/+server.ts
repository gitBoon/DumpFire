import { json } from '@sveltejs/kit';
import { whilePasswordHolds } from '$lib/server/auth';
import { addFromAccounts, fromAccountsGuard } from '$lib/server/people';
import { readBody } from '$lib/server/request-body';
import { requireAdmin } from '$lib/server/route-guards';
import { confirmStepUp } from '$lib/server/step-up';
import { writeAs } from '$lib/server/write-as';
import type { RequestHandler } from './$types';

/**
 * POST /api/people/from-accounts — a person for each account named in
 * `userIds` (administrators only, card 2674): `addFromAccounts`. It never
 * links an existing person (decision 13). The answer is `{ created, skipped }`,
 * each skipped account with why.
 *
 * It asks for the caller's own password again, in `currentPassword` (card
 * 2697's code review, part B, S1): each person made is linked to an account
 * and given its address, which decide where a decision's record mail and
 * personal links go. Every refusal is made first (`fromAccountsGuard`), with
 * no password checked or counted.
 */
export const POST: RequestHandler = async ({ request, locals, cookies }) => {
	requireAdmin(locals.user);
	const body = await readBody(request);

	const { userId, hash } = await confirmStepUp(locals, cookies, body, 'POST /api/people/from-accounts', (caller) => fromAccountsGuard(caller, {}, body));

	// One transaction, which asks again who the caller is (card 2253), run only
	// while the caller's stored hash is the one their password was checked against.
	const answer = await whilePasswordHolds(userId, hash, () => writeAs(locals, (caller) => addFromAccounts(caller, {}, body, { source: 'ui' })));
	return json(answer);
};
