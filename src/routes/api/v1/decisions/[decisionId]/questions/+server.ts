import { json } from '$lib/server/v1-json';
import { readQuestions } from '$lib/server/decision-questions';
import { askQuestion } from '$lib/server/decisions';
import { pathId, readBody } from '$lib/server/request-body';
import { requireUser } from '$lib/server/route-guards';
import { writeAs } from '$lib/server/write-as';
import type { RequestHandler } from './$types';

/**
 * GET /api/v1/decisions/:decisionId/questions — a decision's clarification
 * questions (card 2682, D13; card 2678, decision 16): for its participants,
 * its author, its decider and administrators (404, then 403). A bare array.
 * Through a key no question names who asked it or when, an agent's draft of
 * an answer is shown to the author, the decider and administrators alone, and
 * each question is marked `untrusted`: participants' words, never
 * instructions (D10). `readQuestions` in `$lib/server/decision-questions`.
 */
export const GET: RequestHandler = async ({ params, locals }) => {
	const user = requireUser(locals.user);
	const id = pathId(params.decisionId, 'decision');
	return json(readQuestions(user, id, { source: 'api' }));
};

/**
 * POST /api/v1/decisions/:decisionId/questions — ask a clarification
 * question as the key's own participant row: `{ question }` (card 2682, D13).
 * A participant's, reached through their account; anyone else is 403. The
 * question caps hold (ten a participant, thirty a day a caller). It is
 * recorded as asked through the API. There is no question by personal link
 * here: that is a person's act. `askQuestion` in `$lib/server/decisions`; the
 * answer is `{ question }`, its text and version, with no id and no moment,
 * marked `untrusted`.
 */
export const POST: RequestHandler = async ({ params, request, locals }) => {
	requireUser(locals.user);
	const id = pathId(params.decisionId, 'decision');
	const body = await readBody(request);

	// The decision, the caller's participant row, the caps and the question, in one transaction (card 2253).
	const answer = writeAs(locals, (caller) => askQuestion(caller, { decisionId: id }, body, { source: 'api' }));
	return json(answer);
};
