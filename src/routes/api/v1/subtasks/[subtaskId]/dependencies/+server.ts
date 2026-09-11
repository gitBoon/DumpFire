import { json, error } from '@sveltejs/kit';
import {
	readSubtaskDependencies,
	addSubtaskDependency,
	removeSubtaskDependency
} from '$lib/server/subtask-dependencies';
import type { RequestHandler } from './$types';

/**
 * /api/v1/subtasks/:subtaskId/dependencies — what blocks this subtask and what
 * it blocks.
 *
 * Body for POST and DELETE, exactly one of:
 *   dependsOnCardId / dependsOnSubtaskId  — this subtask waits on it
 *   blocksCardId    / blocksSubtaskId     — it waits on this subtask
 */
export const GET: RequestHandler = async ({ params, locals }) => {
	if (!locals.user) throw error(401, 'Not authenticated');
	const id = Number(params.subtaskId);
	if (isNaN(id)) throw error(400, 'Invalid subtask ID');
	return json(readSubtaskDependencies(locals.user, id));
};

export const POST: RequestHandler = async ({ params, request, locals }) => {
	if (!locals.user) throw error(401, 'Not authenticated');
	const id = Number(params.subtaskId);
	if (isNaN(id)) throw error(400, 'Invalid subtask ID');
	return json(addSubtaskDependency(locals.user, id, await request.json()), { status: 201 });
};

export const DELETE: RequestHandler = async ({ params, request, locals }) => {
	if (!locals.user) throw error(401, 'Not authenticated');
	const id = Number(params.subtaskId);
	if (isNaN(id)) throw error(400, 'Invalid subtask ID');
	return json(removeSubtaskDependency(locals.user, id, await request.json()));
};
