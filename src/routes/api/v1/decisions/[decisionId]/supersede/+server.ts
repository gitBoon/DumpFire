import { json } from '$lib/server/v1-json';
import { keyDecisionSaved } from '$lib/server/decision-authoring';
import { supersedeDecision } from '$lib/server/decision-ruling-writes';
import { pathId, readBody } from '$lib/server/request-body';
import { requireUser } from '$lib/server/route-guards';
import { writeAs } from '$lib/server/write-as';
import type { RequestHandler } from './$types';

/**
 * POST /api/v1/decisions/:decisionId/supersede — make a draft that
 * supersedes a ruled decision (card 2682, D17; card 2679, decision 5): its
 * decider's, its board's Product Owner's or an administrator's. `title`,
 * optional. The draft keeps the ruled decision's decider, never one the
 * caller names, and tells nobody. `201 { decision, revision }` in the shape
 * every key is given (D9, D10).
 */
export const POST: RequestHandler = async ({ params, request, locals }) => {
	requireUser(locals.user);
	const id = pathId(params.decisionId, 'decision');
	const body = await readBody(request);

	const answer = writeAs(locals, (caller) => {
		const decision = supersedeDecision(caller, { decisionId: id }, body, { source: 'api' });
		return keyDecisionSaved(decision);
	});
	return json(answer, { status: 201 });
};
