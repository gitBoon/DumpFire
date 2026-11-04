import { json } from '$lib/server/v1-json';
import { keyDecisionSaved } from '$lib/server/decision-authoring';
import { createDecision } from '$lib/server/decisions';
import { pathId, readBody } from '$lib/server/request-body';
import { requireUser } from '$lib/server/route-guards';
import { writeAs } from '$lib/server/write-as';
import type { RequestHandler } from './$types';

/**
 * POST /api/v1/boards/:boardId/decisions — make a draft decision on a board
 * the key's account can edit: `title` (card 2682, D2). `createDecision` in
 * `$lib/server/decisions`; `201 { decision, revision }`, the decision in the
 * shape every key is given (`keyDecisionSaved`: no reviewer's account id,
 * marked `untrusted`, D9, D10), and the revision the next write must send
 * (D28). The draft tells nobody: no mail, activity entry or live event.
 *
 * A key prepares a decision; a person opens it on the decision's page (D3).
 */
export const POST: RequestHandler = async ({ params, request, locals }) => {
	requireUser(locals.user);
	const boardId = pathId(params.boardId, 'board');
	const body = await readBody(request);

	// The board, the caller's edit access to it and the draft, asked and written in one transaction (card 2253).
	const answer = writeAs(locals, (caller) => {
		const decision = createDecision(caller, { boardId }, body, { source: 'api' });
		return keyDecisionSaved(decision);
	});
	return json(answer, { status: 201 });
};
