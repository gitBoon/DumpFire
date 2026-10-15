import { json, error } from '@sveltejs/kit';
import {
	readSubtaskDependencies,
	addSubtaskDependency,
	removeSubtaskDependency
} from '$lib/server/subtask-dependencies';
import { cycleAnswer } from '$lib/server/dependency-refusals';
import { pathId, readBody } from '$lib/server/request-body';
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
 */
export const GET: RequestHandler = async ({ params, locals }) => {
	if (!locals.user) throw error(401, 'Not authenticated');
	const id = pathId(params.subtaskId, 'subtask');
	return json(readSubtaskDependencies(locals.user, id));
};

export const POST: RequestHandler = async ({ params, request, locals }) => {
	if (!locals.user) throw error(401, 'Not authenticated');
	const id = pathId(params.subtaskId, 'subtask');
	const body = await readBody(request);
	// The subtask, the body's ends, the link and its entry: one transaction.
	const outcome = addSubtaskDependency(locals.user, id, body, 'api');
	if (outcome.rejected) return cycleAnswer(outcome);
	return json(outcome.state, { status: 201 });
};

export const DELETE: RequestHandler = async ({ params, request, locals }) => {
	if (!locals.user) throw error(401, 'Not authenticated');
	const id = pathId(params.subtaskId, 'subtask');
	const body = await readBody(request);
	return json(removeSubtaskDependency(locals.user, id, body, 'api'));
};
