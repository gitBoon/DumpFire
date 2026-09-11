import { json, error } from '@sveltejs/kit';
import { requireMilestone, MilestoneError } from '$lib/server/milestones';
import { getMilestoneSummary } from '$lib/server/planning';
import type { RequestHandler } from './$types';

/**
 * GET /api/v1/milestones/:milestoneId/summary — the whole plan in one payload.
 *
 * This is the endpoint to call when the question is "what should I work on next
 * for milestone X". It is deliberately complete enough to answer that without a
 * second request:
 *
 *   progress       — cards by column, done/total, open subtasks, boards touched
 *   graph          — nodes, edges and topological layers for drawing the plan
 *   criticalPath   — ordered card ids: the longest chain of open dependencies
 *   nextActionable — startable today, most-unblocking first
 *   blocked        — what is waiting, and on what
 *
 * `?compact=true` drops the graph (nodes/edges/layers), which is the bulky part
 * and is only needed for drawing. Everything a planner reasons about stays.
 */
export const GET: RequestHandler = async ({ params, url, locals }) => {
	if (!locals.user) throw error(401, 'Not authenticated');

	const id = Number(params.milestoneId);
	if (isNaN(id)) throw error(400, 'Invalid milestone ID');

	try {
		requireMilestone(locals.user, id);
	} catch (e) {
		if (e instanceof MilestoneError) throw error(e.status, e.message);
		throw e;
	}

	const summary = getMilestoneSummary(id);
	if (!summary) throw error(404, 'Milestone not found');

	if (url.searchParams.get('compact') === 'true') {
		const { graph, ...rest } = summary;
		return json({
			...rest,
			// Keep the titles the ids refer to, or a compact response is unreadable.
			cardTitles: Object.fromEntries(graph.nodes.map((n) => [n.id, n.title]))
		});
	}

	return json(summary);
};
