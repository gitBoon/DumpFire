import { json } from '@sveltejs/kit';
import { isAdmin } from '$lib/server/board-access';
import { decisionAnswer, revisionFor } from '$lib/server/decision-authoring';
import { createDecision } from '$lib/server/decision-authoring-writes';
import { pathId, readBody } from '$lib/server/request-body';
import { requireUser } from '$lib/server/route-guards';
import { writeAs } from '$lib/server/write-as';
import type { RequestHandler } from './$types';

/**
 * POST /api/boards/:id/decisions — make a draft decision on a board the
 * caller can edit: `title` (card 2676, plan 4.3). `createDecision` in
 * `$lib/server/decision-authoring-writes`; `201 { decision, revision }`, the decision through
 * the one projection (decision 15).
 */
export const POST: RequestHandler = async ({ params, request, locals }) => {
	requireUser(locals.user);
	const boardId = pathId(params.id, 'board');
	const body = await readBody(request);

	// The board, the caller's edit access to it and the draft, asked and
	// written in one transaction (card 2253).
	const answer = writeAs(locals, (caller) => {
		const decision = createDecision(caller, { boardId }, body, { source: 'ui' });
		return { decision: decisionAnswer(decision, isAdmin(caller)), revision: revisionFor(decision.id) };
	});
	return json(answer, { status: 201 });
};
