import { error, redirect } from '@sveltejs/kit';
import { canEditMilestone, requireMilestone, MilestoneError } from '$lib/server/milestones';
import { getMilestoneSummary, planSubtasks } from '$lib/server/planning';
import type { PageServerLoad } from './$types';

export const load: PageServerLoad = async ({ params, locals }) => {
	if (!locals.user) throw redirect(303, '/login');

	const id = Number(params.id);
	if (isNaN(id)) throw error(400, 'Invalid milestone ID');

	let row;
	try {
		row = requireMilestone(locals.user, id);
	} catch (e) {
		if (e instanceof MilestoneError) throw error(e.status, e.message);
		throw e;
	}

	// The whole plan is computed server-side in one pass. The page draws it, and
	// an edit, or closing the card window, re-runs this load (invalidateAll); it
	// never derives the critical path or the actionable list itself. Work on a
	// board the caller cannot open is in it withheld (card 2129).
	const summary = getMilestoneSummary(id, locals.user);
	if (!summary) throw error(404, 'Milestone not found');

	// Every subtask of each card the caller can open, for the work table to
	// open a card to (card 2221). Beside the summary, not in it: the summary
	// is also what the API answers, and this is only drawn here.
	// Whether the header offers the rename (card 2472): the rule the PATCH
	// itself asks (`requireMilestone(user, id, true)`), so a button is shown
	// only to someone whose rename would be taken.
	return { user: locals.user, summary, subtasks: planSubtasks(summary), canRename: canEditMilestone(locals.user, row) };
};
