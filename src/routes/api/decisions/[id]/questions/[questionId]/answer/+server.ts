import { json } from '@sveltejs/kit';
import { answerQuestion } from '$lib/server/decision-question-writes';
import { pathId, readBody } from '$lib/server/request-body';
import { requireUser } from '$lib/server/route-guards';
import { requireSameOriginJson } from '$lib/server/same-origin';
import { writeAs } from '$lib/server/write-as';
import type { RequestHandler } from './$types';

/**
 * POST /api/decisions/:id/questions/:questionId/answer — the author's or the
 * decider's answer to a question: `{ answer }`, or `{ answer, replacesDraft:
 * true }` to put a person's answer in place of an agent's draft (card 2678,
 * decisions 1, 7, 8 and 17). Same-origin JSON only, before anything else.
 * Through the web application, a person's answer; card 2682's API reaches the
 * same service with `source: 'api'`, where it may only draft.
 * `answerQuestion` in `$lib/server/decision-question-writes`; the answer is
 * `{ question }`, the question as its answerer is given it.
 */
export const POST: RequestHandler = async ({ params, request, url, locals }) => {
	requireSameOriginJson({ request, url });
	requireUser(locals.user);
	const decisionId = pathId(params.id, 'decision');
	const questionId = pathId(params.questionId, 'question');
	const body = await readBody(request);

	const answer = writeAs(locals, (caller) => answerQuestion(caller, { decisionId, questionId }, body, { source: 'ui' }));
	return json(answer);
};
