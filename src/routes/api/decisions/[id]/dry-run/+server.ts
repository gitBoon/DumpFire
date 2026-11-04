import { json } from '@sveltejs/kit';
import { dryRunDecision } from '$lib/server/decisions';
import { pathId, readBody } from '$lib/server/request-body';
import { requireUser } from '$lib/server/route-guards';
import { writeAs } from '$lib/server/write-as';
import type { RequestHandler } from './$types';

/**
 * POST /api/decisions/:id/dry-run — mail the caller a dry run of the
 * decision's working copy, to the address the people directory holds for
 * their account alone: `revision`, required (card 2697, decision 19, Q1,
 * Q26). `dryRunDecision` in `$lib/server/decisions`, its author's or its
 * decider's, limited per caller across decisions (429). The answer is
 * `{ sent: true }`: the mail is queued, and the address is not echoed (Q18).
 */
export const POST: RequestHandler = async ({ params, request, locals }) => {
	requireUser(locals.user);
	const id = pathId(params.id, 'decision');
	const body = await readBody(request);

	writeAs(locals, (caller) => dryRunDecision(caller, { decisionId: id }, body, { source: 'ui' }));
	return json({ sent: true });
};
