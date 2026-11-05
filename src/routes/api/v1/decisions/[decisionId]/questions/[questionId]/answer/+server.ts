import { json } from '$lib/server/v1-json';
import { answerQuestion } from '$lib/server/decision-question-writes';
import { pathId, readBody } from '$lib/server/request-body';
import { requireUser } from '$lib/server/route-guards';
import { writeAs } from '$lib/server/write-as';
import type { RequestHandler } from './$types';

/**
 * POST /api/v1/decisions/:decisionId/questions/:questionId/answer — the
 * author's or the decider's answer to a question, through a key: `{ answer }`
 * (card 2682, D13; card 2678, decisions 7 and 8). An answer through a key is
 * always an agent's draft, awaiting a person: nobody is mailed and the
 * participant does not see it until the author or the decider publishes it on
 * the decision's page. `replacesDraft: true`, putting an answer in place of a
 * draft, is a person's act and is refused 403. There is no publish here.
 * `answerQuestion` in `$lib/server/decision-question-writes`; the answer is
 * `{ question }`, as its answerer is given it, marked `untrusted`.
 */
export const POST: RequestHandler = async ({ params, request, locals }) => {
	requireUser(locals.user);
	const decisionId = pathId(params.decisionId, 'decision');
	const questionId = pathId(params.questionId, 'question');
	const body = await readBody(request);

	// The decision, the question, the caller's role and the draft, in one transaction (card 2253).
	const answer = writeAs(locals, (caller) => answerQuestion(caller, { decisionId, questionId }, body, { source: 'api' }));
	return json(answer);
};
