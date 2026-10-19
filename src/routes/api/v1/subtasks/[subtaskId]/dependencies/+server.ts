import { error } from '@sveltejs/kit';
import { json } from '$lib/server/v1-json';
import { cycleAnswer } from '$lib/server/dependency-refusals';
import { pathId, readBody } from '$lib/server/request-body';
import { requireUser } from '$lib/server/route-guards';
import { addWorkDependency, readWorkDependencies, removeWorkDependency } from '$lib/server/work-dependencies';
import { writeAs } from '$lib/server/write-as';
import type { RequestHandler } from './$types';

/**
 * /api/v1/subtasks/:subtaskId/dependencies — what blocks this subtask and what
 * it blocks.
 *
 * Body for POST and DELETE, exactly one of:
 *   dependsOnCardId / dependsOnSubtaskId  — this subtask waits on it
 *   blocksCardId    / blocksSubtaskId     — it waits on this subtask
 *
 * POST and DELETE write the activity entry the card route writes,
 * `api:dependency_added` or `api:dependency_removed`, from the source `api`.
 * The work of each is in `$lib/server/work-dependencies`, which the internal
 * route and both card routes share (card 2012).
 */
export const GET: RequestHandler = async ({ params, locals }) => {
	if (!locals.user) throw error(401, 'Not authenticated');
	const id = pathId(params.subtaskId, 'subtask');
	const { cardId, isBlocked, blockedBy, blocks } = readWorkDependencies(locals.user, { kind: 'subtask', id }, {});
	return json({ subtaskId: id, cardId, isBlocked, blockedBy, blocks });
};

export const POST: RequestHandler = async ({ params, request, locals }) => {
	requireUser(locals.user);
	const id = pathId(params.subtaskId, 'subtask');
	const body = await readBody(request);
	// The key or session asked again and who its account is now (card 2253),
	// the subtask, the body's ends, the link, its entry and the answer's list:
	// one transaction.
	const outcome = writeAs(locals, (caller) => {
		const added = addWorkDependency(caller, { kind: 'subtask', id }, body, { source: 'api' });
		// A link that would close a loop wrote nothing: it is answered 409, with its chain.
		if (added.rejected) return cycleAnswer(added);
		return { subtaskId: id, cardId: added.cardId, isBlocked: added.isBlocked, blockedBy: added.blockedBy, blocks: added.blocks };
	});
	if (outcome instanceof Response) return outcome;
	return json(outcome, { status: 201 });
};

export const DELETE: RequestHandler = async ({ params, request, locals }) => {
	requireUser(locals.user);
	const id = pathId(params.subtaskId, 'subtask');
	const body = await readBody(request);
	const { cardId, isBlocked, blockedBy, blocks } = writeAs(locals, (caller) =>
		removeWorkDependency(caller, { kind: 'subtask', id }, body, { source: 'api' })
	);
	return json({ subtaskId: id, cardId, isBlocked, blockedBy, blocks });
};
