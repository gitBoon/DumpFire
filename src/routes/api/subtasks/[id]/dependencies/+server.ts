/**
 * Session-authenticated sibling of /api/v1/subtasks/:subtaskId/dependencies,
 * for the subtask modal. Same rules; only the auth differs, and the source its
 * activity entries record, `ui`.
 */
import { json, error } from '@sveltejs/kit';
import {
	readSubtaskDependencies,
	addSubtaskDependency,
	removeSubtaskDependency
} from '$lib/server/subtask-dependencies';
import { cycleAnswer } from '$lib/server/dependency-refusals';
import { pathId, readBody } from '$lib/server/request-body';
import type { RequestHandler } from './$types';

export const GET: RequestHandler = async ({ params, locals }) => {
	if (!locals.user) throw error(401, 'Not authenticated');
	const id = pathId(params.id, 'subtask');
	return json(readSubtaskDependencies(locals.user, id));
};

export const POST: RequestHandler = async ({ params, request, locals }) => {
	if (!locals.user) throw error(401, 'Not authenticated');
	const id = pathId(params.id, 'subtask');
	const body = await readBody(request);
	// The subtask, the body's ends, the link and its entry: one transaction.
	const outcome = addSubtaskDependency(locals.user, id, body, 'ui');
	if (outcome.rejected) return cycleAnswer(outcome);
	return json(outcome.state, { status: 201 });
};

export const DELETE: RequestHandler = async ({ params, request, locals }) => {
	if (!locals.user) throw error(401, 'Not authenticated');
	const id = pathId(params.id, 'subtask');
	const body = await readBody(request);
	return json(removeSubtaskDependency(locals.user, id, body, 'ui'));
};
