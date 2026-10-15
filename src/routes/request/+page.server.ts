import { issueFormToken } from '$lib/server/request-tokens';
import type { PageServerLoad } from './$types';

/**
 * The request form is public. Someone without an account gets a short-lived
 * token with the page, which the form sends back when it lists who a request
 * can go to and when it submits one — so neither can be called without having
 * loaded the form. A signed-in user needs no token; their session is checked.
 */
export const load: PageServerLoad = async ({ locals }) => {
	return {
		formToken: locals.user ? null : issueFormToken(),
		signedIn: !!locals.user
	};
};
