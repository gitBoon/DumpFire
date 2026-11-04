import { json } from '@sveltejs/kit';
import { raiseConcern } from '$lib/server/decisions';
import { pathId, readBody } from '$lib/server/request-body';
import { requireUser } from '$lib/server/route-guards';
import { requireSameOriginJson } from '$lib/server/same-origin';
import { writeAs } from '$lib/server/write-as';
import type { RequestHandler } from './$types';

/**
 * POST /api/decisions/:id/concerns — a signed-in participant's concern about
 * a ruling: `{ comment }` (card 2679, decision 4). Same-origin JSON only,
 * before anything else. A person's act, through the web application alone.
 * `raiseConcern` in `$lib/server/decisions`; the answer is `{ concern }`, its
 * text and when, with no id.
 */
export const POST: RequestHandler = async ({ params, request, url, locals }) => {
	requireSameOriginJson({ request, url });
	requireUser(locals.user);
	const id = pathId(params.id, 'decision');
	const body = await readBody(request);

	const answer = writeAs(locals, (caller) => raiseConcern(caller, { decisionId: id }, body, { source: 'ui' }));
	return json(answer);
};
