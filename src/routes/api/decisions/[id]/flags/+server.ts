import { json } from '@sveltejs/kit';
import { raiseFlag } from '$lib/server/decision-flag-writes';
import { pathId, readBody } from '$lib/server/request-body';
import { requireUser } from '$lib/server/route-guards';
import { requireSameOriginJson } from '$lib/server/same-origin';
import { writeAs } from '$lib/server/write-as';
import type { RequestHandler } from './$types';

/**
 * POST /api/decisions/:id/flags — a signed-in participant's objection or
 * request to talk to the decider: `{ kind: 'objection' | 'talk', reason }`
 * (card 2684, R3, R4). Same-origin JSON only, before anything else. A
 * person's act, through the web application alone: no API v1 route raises
 * one, and the service refuses an API key. `raiseFlag` in
 * `$lib/server/decision-flag-writes`; the answer is `{ flag }`, its kind,
 * reason, moment and version, with no id.
 */
export const POST: RequestHandler = async ({ params, request, url, locals }) => {
	requireSameOriginJson({ request, url });
	requireUser(locals.user);
	const id = pathId(params.id, 'decision');
	const body = await readBody(request);

	const answer = writeAs(locals, (caller) => raiseFlag(caller, { decisionId: id }, body, { source: 'ui' }));
	return json(answer);
};
