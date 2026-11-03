import { readDecisionPage } from '$lib/server/decision-view';
import type { PageServerLoad } from './$types';

/**
 * A decision's page, for every signed-in account that may view it (card
 * 2677, decisions 3 and 20): from `readDecisionPage`, which guards itself with
 * `requireDecision(…, 'view')`, so a caller who may not view it is 404, as a
 * draft is to anyone but its draft's viewers. A participant whom the decision
 * still reaches through their account is given their part; anyone else the
 * published version and its status. The load writes nothing: having seen it is
 * posted by the page, after the participant's first action (decision 14).
 */
export const load: PageServerLoad = async ({ params, locals }) => {
	return readDecisionPage(locals.user!, Number(params.id));
};
