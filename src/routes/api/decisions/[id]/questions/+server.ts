import { json } from '@sveltejs/kit';
import { askQuestion } from '$lib/server/decision-question-writes';
import { pathId, readBody } from '$lib/server/request-body';
import { requireUser } from '$lib/server/route-guards';
import { requireSameOriginJson } from '$lib/server/same-origin';
import { writeAs } from '$lib/server/write-as';
import type { RequestHandler } from './$types';

/**
 * POST /api/decisions/:id/questions — a signed-in participant's clarification
 * question: `{ question }` (card 2678, decisions 1, 4 and 17). Same-origin JSON
 * only, before anything else. Through the web application, a person's own
 * question; card 2682's API reaches the same service with `source: 'api'`.
 * `askQuestion` in `$lib/server/decision-question-writes`; the answer is
 * `{ question }`, its text, the version it was asked about and when, with no
 * id.
 */
export const POST: RequestHandler = async ({ params, request, url, locals }) => {
	requireSameOriginJson({ request, url });
	requireUser(locals.user);
	const id = pathId(params.id, 'decision');
	const body = await readBody(request);

	const answer = writeAs(locals, (caller) => askQuestion(caller, { decisionId: id }, body, { source: 'ui' }));
	return json(answer);
};
