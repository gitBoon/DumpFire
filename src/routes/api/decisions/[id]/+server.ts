import { json } from '@sveltejs/kit';
import { isAdmin } from '$lib/server/board-access';
import { decisionAnswer, optionAnswers, readinessOf, revisionFor } from '$lib/server/decision-authoring';
import { deleteDecision, updateDraft } from '$lib/server/decisions';
import { pathId, readBody } from '$lib/server/request-body';
import { requireUser } from '$lib/server/route-guards';
import { writeAs } from '$lib/server/write-as';
import type { RequestHandler } from './$types';

/**
 * PUT /api/decisions/:id — save a decision's working copy: `revision`, and any
 * of `title`, `closesAt`, `voteMode` and `content` (card 2676, decisions 6 to
 * 10). `updateDraft` in `$lib/server/decisions`; the answer is
 * `{ decision, options, revision, readiness }`, through the one projection
 * (decision 15), with the readability check worked out on the server.
 */
export const PUT: RequestHandler = async ({ params, request, locals }) => {
	requireUser(locals.user);
	const id = pathId(params.id, 'decision');
	const body = await readBody(request);

	// The decision, the caller's access to it, the revision and the save, in
	// one transaction (card 2253); the answer is made from what it wrote.
	const answer = writeAs(locals, (caller) => {
		const { decision, options } = updateDraft(caller, { decisionId: id }, body, { source: 'ui' });
		return { decision: decisionAnswer(decision, isAdmin(caller)), options: optionAnswers(options), revision: revisionFor(decision.id), readiness: readinessOf(decision) };
	});
	return json(answer);
};

/**
 * DELETE /api/decisions/:id — delete a draft or a withdrawn decision, and
 * every row of it (card 2675, plan 4.9): `deleteDecision`, its author's or an
 * administrator's.
 */
export const DELETE: RequestHandler = async ({ params, locals }) => {
	requireUser(locals.user);
	const id = pathId(params.id, 'decision');

	writeAs(locals, (caller) => deleteDecision(caller, { decisionId: id }, null, { source: 'ui' }));
	return json({ success: true });
};
