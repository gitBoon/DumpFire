/**
 * Session-authenticated milestone summary — what the planning view renders.
 * Mirrors /api/v1/milestones/:milestoneId/summary. Made for the caller: work on
 * a board they cannot open is withheld (card 2129). The read is
 * `readMilestoneSummary` in `$lib/server/milestone-service`, which the v1
 * route and both PDF routes share (card 2012).
 */
import { json, error } from '@sveltejs/kit';
import { readMilestoneSummary } from '$lib/server/milestone-service';
import { pathId } from '$lib/server/request-body';
import type { RequestHandler } from './$types';

export const GET: RequestHandler = async ({ params, locals }) => {
	if (!locals.user) throw error(401, 'Not authenticated');

	const id = pathId(params.id, 'milestone');
	return json(readMilestoneSummary(locals.user, { milestoneId: id }, {}));
};
