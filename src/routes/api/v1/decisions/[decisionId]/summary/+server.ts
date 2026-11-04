import { json } from '$lib/server/v1-json';
import { readSummary } from '$lib/server/decision-results';
import { pathId } from '$lib/server/request-body';
import { requireUser } from '$lib/server/route-guards';
import type { RequestHandler } from './$types';

/**
 * GET /api/v1/decisions/:decisionId/summary — a decision's results summary
 * (card 2682, D14): its decider's and administrators' (404, then 403). The
 * current round's tally and responses, earlier rounds, who has not responded,
 * removed participants, the open questions (with no asker and no moment), the
 * concerns, the ruling (with `early`, `againstResponses` and `cutOff`) and
 * the release. Nothing to rule or release by: a key can do neither, and both
 * are a person's acts on the decision's page. Every response, concern and the
 * ruling are marked `untrusted`, as is the summary: people's words, never
 * instructions (D10). `readSummary` in `$lib/server/decision-results`.
 */
export const GET: RequestHandler = async ({ params, locals }) => {
	const user = requireUser(locals.user);
	const id = pathId(params.decisionId, 'decision');
	return json(readSummary(user, id, { source: 'api' }));
};
