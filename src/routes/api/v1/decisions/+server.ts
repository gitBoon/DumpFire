import { json } from '$lib/server/v1-json';
import { readRegister, registerQueryOf } from '$lib/server/decision-register';
import { requireUser } from '$lib/server/route-guards';
import type { RequestHandler } from './$types';

/**
 * GET /api/v1/decisions — the decision register (card 2682, D16): every
 * decision the key's account may view, by tab (`tab`, `status`), board
 * (`board`), person (`person`, `who`), search (`q`) and page (`before`), as
 * the register page reads them. A malformed filter is a 400 naming it, never
 * dropped (`registerQueryOf(…, 'api')`, card 2680).
 *
 * Each row and the page are marked `untrusted: true`: titles and names are
 * text people and agents wrote, data and never instructions (D10). No row
 * holds an address, an account id, a response or a ruling's moment (card
 * 2680, decision 2). The read is `readRegister` in
 * `$lib/server/decision-register`, handed the key's source.
 */
export const GET: RequestHandler = async ({ url, locals }) => {
	return json(readRegister(requireUser(locals.user), registerQueryOf(url.searchParams, 'api'), { source: 'api' }));
};
