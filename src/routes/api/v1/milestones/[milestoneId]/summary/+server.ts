import { error } from '@sveltejs/kit';
import { json } from '$lib/server/v1-json';
import { readMilestoneSummary } from '$lib/server/milestone-service';
import { pathId } from '$lib/server/request-body';
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
 * and is only needed for drawing. Everything a planner reasons about stays,
 * with the titles the ids refer to: `cardTitles` by card id and
 * `subtaskTitles` by subtask id. Both were in `cardTitles`, by the bare id, so
 * card 32 and subtask 32 took one key between them.
 *
 * Made for the key's user: work on a board they cannot open is in it withheld,
 * its title replaced in the nodes and so in both lists of titles, and its
 * board counted in one entry of `progress.boards` with no id (card 2129).
 *
 * The read is `readMilestoneSummary` in `$lib/server/milestone-service`, which
 * the internal route shares (card 2012); `compact` is this route's.
 */
export const GET: RequestHandler = async ({ params, url, locals }) => {
	if (!locals.user) throw error(401, 'Not authenticated');

	const id = pathId(params.milestoneId, 'milestone');

	const summary = readMilestoneSummary(locals.user, { milestoneId: id }, {});

	if (url.searchParams.get('compact') === 'true') {
		const { graph, ...rest } = summary;
		const titles = (kind: 'card' | 'subtask') =>
			Object.fromEntries(graph.nodes.filter((n) => n.kind === kind).map((n) => [n.id, n.title]));
		return json({
			...rest,
			// Keep the titles the ids refer to, or a compact response is unreadable.
			cardTitles: titles('card'),
			subtaskTitles: titles('subtask')
		});
	}

	return json(summary);
};
