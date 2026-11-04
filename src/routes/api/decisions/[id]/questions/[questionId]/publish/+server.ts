import { json } from '@sveltejs/kit';
import { publishAnswer } from '$lib/server/decisions';
import { pathId } from '$lib/server/request-body';
import { requireUser } from '$lib/server/route-guards';
import { requireSameOriginJson } from '$lib/server/same-origin';
import { writeAs } from '$lib/server/write-as';
import type { RequestHandler } from './$types';

/**
 * POST /api/decisions/:id/questions/:questionId/publish — the author or the
 * decider publishes an agent's draft of an answer, unchanged (card 2678,
 * decisions 1, 8 and 17): the review, after which every participant sees it
 * with its label, and the asker is told. Same-origin JSON only, before
 * anything else; the body is not read, as publishing changes no text. A
 * person's act, through the web application alone: card 2682 gives it no v1
 * route. `publishAnswer` in `$lib/server/decisions`; the answer is
 * `{ question }`, the question as its answerer is given it.
 */
export const POST: RequestHandler = async ({ params, request, url, locals }) => {
	requireSameOriginJson({ request, url });
	requireUser(locals.user);
	const decisionId = pathId(params.id, 'decision');
	const questionId = pathId(params.questionId, 'question');

	const answer = writeAs(locals, (caller) => publishAnswer(caller, { decisionId, questionId }, null, { source: 'ui' }));
	return json(answer);
};
