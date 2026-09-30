import { json, error } from '@sveltejs/kit';
import { getBurndown, parseBurndownQuery, BurndownError } from '$lib/server/burndown';
import type { RequestHandler } from './$types';

/**
 * GET /api/burndown — burndown data for the signed-in user.
 *
 * Same parameters and response as GET /api/v1/burndown; this is the
 * session-cookie twin the board stats panel and milestone page fetch from.
 * See `$lib/server/burndown` for the rules.
 */
export const GET: RequestHandler = async ({ url, locals }) => {
	if (!locals.user) throw error(401, 'Not authenticated');
	try {
		return json(getBurndown(locals.user, parseBurndownQuery(url.searchParams, locals.user)));
	} catch (e) {
		if (e instanceof BurndownError) throw error(e.status, e.message);
		throw e;
	}
};
