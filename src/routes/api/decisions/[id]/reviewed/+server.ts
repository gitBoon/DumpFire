import { json } from '@sveltejs/kit';
import { isAdmin } from '$lib/server/board-access';
import { decisionAnswer, revisionFor } from '$lib/server/decision-authoring';
import { markReviewed } from '$lib/server/decision-authoring-writes';
import { pathId, readBody } from '$lib/server/request-body';
import { requireUser } from '$lib/server/route-guards';
import { writeAs } from '$lib/server/write-as';
import type { RequestHandler } from './$types';

/**
 * POST /api/decisions/:id/reviewed — mark text an agent drafted reviewed:
 * `sections`, a list of section keys or `'all'`, and `revision` (card 2676,
 * decision 9, R7). A person's act, through the web application alone.
 * `markReviewed` in `$lib/server/decision-authoring-writes`; the answer is
 * `{ decision, revision }`, through the one projection (decision 15).
 */
export const POST: RequestHandler = async ({ params, request, locals }) => {
	requireUser(locals.user);
	const id = pathId(params.id, 'decision');
	const body = await readBody(request);

	const answer = writeAs(locals, (caller) => {
		const decision = markReviewed(caller, { decisionId: id }, body, { source: 'ui' });
		return { decision: decisionAnswer(decision, isAdmin(caller)), revision: revisionFor(decision.id) };
	});
	return json(answer);
};
