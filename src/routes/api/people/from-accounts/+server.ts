import { json } from '@sveltejs/kit';
import { addFromAccounts } from '$lib/server/people';
import { readBody } from '$lib/server/request-body';
import { requireAdmin } from '$lib/server/route-guards';
import { writeAs } from '$lib/server/write-as';
import type { RequestHandler } from './$types';

/**
 * POST /api/people/from-accounts — a person for each account named in
 * `userIds` (administrators only, card 2674): `addFromAccounts`. It never
 * links an existing person (decision 13). The answer is `{ created, skipped }`,
 * each skipped account with why.
 */
export const POST: RequestHandler = async ({ request, locals }) => {
	requireAdmin(locals.user);
	const body = await readBody(request);

	// One transaction, which asks again who the caller is (card 2253).
	const answer = writeAs(locals, (caller) => addFromAccounts(caller, {}, body, { source: 'ui' }));
	return json(answer);
};
