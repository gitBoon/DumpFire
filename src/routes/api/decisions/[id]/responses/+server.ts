import { json } from '@sveltejs/kit';
import { respondToDecision } from '$lib/server/decision-response-writes';
import { pathId, readBody } from '$lib/server/request-body';
import { requireUser } from '$lib/server/route-guards';
import { requireSameOriginJson } from '$lib/server/same-origin';
import { writeAs } from '$lib/server/write-as';
import type { RequestHandler } from './$types';

/**
 * POST /api/decisions/:id/responses — a signed-in participant's response:
 * `versionNumber`, `kind`, and a vote's `optionId` or `scores`, with an
 * optional `comment` and `optionComments` (card 2677, decisions 10 to 13).
 * Same-origin JSON only, before anything else (decision 24). A person's act,
 * through the web application alone. `respondToDecision` in
 * `$lib/server/decision-response-writes`; the answer is `{ response, unchanged }`, the
 * response as `OwnResponse` (D3).
 */
export const POST: RequestHandler = async ({ params, request, url, locals }) => {
	requireSameOriginJson({ request, url });
	requireUser(locals.user);
	const id = pathId(params.id, 'decision');
	const body = await readBody(request);

	const answer = writeAs(locals, (caller) => respondToDecision(caller, { decisionId: id }, body, { source: 'ui' }));
	return json(answer);
};
