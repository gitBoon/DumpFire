import { readRegister, registerQueryOf } from '$lib/server/decision-register';
import type { PageServerLoad } from './$types';

/**
 * The register of decisions (card 2680, decisions 1 to 8): every decision the
 * caller may view, across boards, exactly as `requireDecision(…, 'view')`
 * lets them through. The filters are read by allow-list first
 * (`registerQueryOf`, page mode: a malformed value is dropped, as if not
 * sent); a board filter naming a board the caller cannot open, and a person
 * filter outside the caller's person-record scope, match nothing. The load
 * writes nothing.
 */
export const load: PageServerLoad = async ({ url, locals }) => {
	return readRegister(locals.user!, registerQueryOf(url.searchParams, 'page'), { source: 'ui' });
};
