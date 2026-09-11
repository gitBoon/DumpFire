/**
 * Session-authenticated milestone summary — what the planning view renders.
 * Mirrors /api/v1/milestones/:milestoneId/summary.
 */
import { json, error } from '@sveltejs/kit';
import { requireMilestone, MilestoneError } from '$lib/server/milestones';
import { getMilestoneSummary } from '$lib/server/planning';
import type { RequestHandler } from './$types';

export const GET: RequestHandler = async ({ params, locals }) => {
	if (!locals.user) throw error(401, 'Not authenticated');

	const id = Number(params.id);
	if (isNaN(id)) throw error(400, 'Invalid milestone ID');

	try {
		requireMilestone(locals.user, id);
	} catch (e) {
		if (e instanceof MilestoneError) throw error(e.status, e.message);
		throw e;
	}

	const summary = getMilestoneSummary(id);
	if (!summary) throw error(404, 'Milestone not found');
	return json(summary);
};
