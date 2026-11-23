import { json } from '@sveltejs/kit';
import { replyToFlag } from '$lib/server/decision-flag-writes';
import { pathId, readBody } from '$lib/server/request-body';
import { requireUser } from '$lib/server/route-guards';
import { requireSameOriginJson } from '$lib/server/same-origin';
import { writeAs } from '$lib/server/write-as';
import type { RequestHandler } from './$types';

/**
 * POST /api/decisions/:id/flags/:flagId/reply — the decider's answer to an
 * objection, or the outcome of a request to talk: `{ reply }` (card 2684,
 * R7). Same-origin JSON only, before anything else. The current decider's
 * act alone, through the web application: no API v1 route replies, and the
 * service refuses an API key. `replyToFlag` in
 * `$lib/server/decision-flag-writes`; the answer is `{ flag }`, the flag as
 * the results page gives it.
 */
export const POST: RequestHandler = async ({ params, request, url, locals }) => {
	requireSameOriginJson({ request, url });
	requireUser(locals.user);
	const decisionId = pathId(params.id, 'decision');
	const flagId = pathId(params.flagId, 'flag');
	const body = await readBody(request);

	const answer = writeAs(locals, (caller) => replyToFlag(caller, { decisionId, flagId }, body, { source: 'ui' }));
	return json(answer);
};
