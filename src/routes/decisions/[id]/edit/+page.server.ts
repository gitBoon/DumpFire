import { readEditPage } from '$lib/server/decision-authoring';
import type { PageServerLoad } from './$types';

/**
 * A decision's editor (card 2676, decisions 15 to 17): everything it draws,
 * from `readEditPage`, which guards itself with `requireDecision(…, 'edit')`.
 * 404 for a caller who cannot view the decision (a board editor and a draft
 * not theirs among them), 403 for one who can view it and cannot edit it,
 * which the page's error page shows. Every answer is the one projection's: no
 * participant's address or account to a caller who is not an administrator.
 */
export const load: PageServerLoad = async ({ params, locals }) => {
	return readEditPage(locals.user!, Number(params.id));
};
