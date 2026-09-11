import { error, redirect } from '@sveltejs/kit';
import { requireMilestone, MilestoneError } from '$lib/server/milestones';
import { getMilestoneSummary } from '$lib/server/planning';
import type { PageServerLoad } from './$types';

export const load: PageServerLoad = async ({ params, locals }) => {
	if (!locals.user) throw redirect(303, '/login');

	const id = Number(params.id);
	if (isNaN(id)) throw error(400, 'Invalid milestone ID');

	try {
		requireMilestone(locals.user, id);
	} catch (e) {
		if (e instanceof MilestoneError) throw error(e.status, e.message);
		throw e;
	}

	// The whole plan is computed server-side in one pass. The page draws it and
	// re-fetches /api/milestones/:id/summary after an edit; it never derives the
	// critical path or the actionable list itself.
	const summary = getMilestoneSummary(id);
	if (!summary) throw error(404, 'Milestone not found');

	return { user: locals.user, summary };
};
