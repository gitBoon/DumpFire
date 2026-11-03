import { json } from '@sveltejs/kit';
import { recordSeen } from '$lib/server/decisions';
import { pathId, readBody } from '$lib/server/request-body';
import { requireUser } from '$lib/server/route-guards';
import { requireSameOriginJson } from '$lib/server/same-origin';
import { writeAs } from '$lib/server/write-as';
import type { RequestHandler } from './$types';

/**
 * POST /api/decisions/:id/seen — record that a signed-in participant has seen
 * a version: `versionNumber` and `stage` (card 2677, decision 14). The page
 * sends it after the person's first genuine action, never on load, as mail
 * scanners follow links. Same-origin JSON only, before anything else
 * (decision 24). `recordSeen` in `$lib/server/decisions`; the answer is
 * `{ recorded }`, false when it was already recorded.
 */
export const POST: RequestHandler = async ({ params, request, url, locals }) => {
	requireSameOriginJson({ request, url });
	requireUser(locals.user);
	const id = pathId(params.id, 'decision');
	const body = await readBody(request);

	const answer = writeAs(locals, (caller) => recordSeen(caller, { decisionId: id }, body, { source: 'ui' }));
	return json(answer);
};
