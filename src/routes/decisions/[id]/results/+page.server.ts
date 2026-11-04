import { readResults } from '$lib/server/decision-results';
import type { PageServerLoad } from './$types';

/**
 * A decision's results, for its decider and DumpFire's administrators alone
 * (card 2679, decisions 1, 15 and 16): from `readResults`, which guards itself
 * with `requireDecision(…, 'results')`, so a caller who may not view the
 * decision is 404 and one who may and is neither is 403, which the page's
 * error page shows. It writes nothing, and the page answers with no-store and
 * noindex (`ROUTE_HEADERS`, decision 6): it names each participant beside
 * their response. As the page's (`source: 'ui'`), its open questions carry
 * who asked and when (card 2678, code review S1).
 */
export const load: PageServerLoad = async ({ params, locals }) => {
	return readResults(locals.user!, Number(params.id), { source: 'ui' });
};
