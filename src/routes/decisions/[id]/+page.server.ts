import { error } from '@sveltejs/kit';
import { readDecisionPage } from '$lib/server/decision-view';
import { readQueryIdOrNone } from '$lib/server/request-body';
import type { PageServerLoad } from './$types';

/**
 * A decision's page, for every signed-in account that may view it (card
 * 2677, decisions 3 and 20): from `readDecisionPage`, which guards itself with
 * `requireDecision(…, 'view')`, so a caller who may not view it is 404, as a
 * draft is to anyone but its draft's viewers. A participant whom the decision
 * still reaches through their account is given their part; anyone else the
 * published version and its status. The load writes nothing: having seen it is
 * posted by the page, after the participant's first action (decision 14).
 *
 * A path that is not a whole number above 0 is 404 before anything is read
 * (card 2680, decision 34, F4): `/decisions/people`, which reaches this route
 * with the id `people`, among them. `requireDecision`'s 400 is for the API.
 */
export const load: PageServerLoad = async ({ params, locals }) => {
	const id = readQueryIdOrNone(params.id);
	if (id === undefined) error(404, 'Decision not found');
	return readDecisionPage(locals.user!, id);
};
