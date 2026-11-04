import { readPreview } from '$lib/server/decision-view';
import type { PageServerLoad } from './$types';

/**
 * A decision previewed as a participant (card 2697, decision 18, Q4 to Q7):
 * the working copy as `DecisionView` draws it, for the participant `?as=`
 * names, or a generic one of `?role=` in `?group=`, from `readPreview`, which
 * guards itself with `requireDecision(…, 'edit')`: 404 for a caller who cannot
 * view the decision, 403 for one who can view it and cannot edit it, which
 * the page's error page shows. It writes nothing, and the page answers with
 * no-store and noindex (`ROUTE_HEADERS`, Q12).
 */
export const load: PageServerLoad = async ({ params, locals, url }) => {
	return readPreview(locals.user!, Number(params.id), url.searchParams);
};
