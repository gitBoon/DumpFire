/**
 * Session-authenticated sibling of /api/v1/subtasks/:subtaskId/dependencies,
 * for the subtask modal. Same rules; only the auth differs.
 */
import { json, error } from '@sveltejs/kit';
import {
	readSubtaskDependencies,
	addSubtaskDependency,
	removeSubtaskDependency
} from '$lib/server/subtask-dependencies';
import type { RequestHandler } from './$types';

export const GET: RequestHandler = async ({ params, locals }) => {
	if (!locals.user) throw error(401, 'Not authenticated');
	const id = Number(params.id);
	if (isNaN(id)) throw error(400, 'Invalid subtask ID');
	return json(readSubtaskDependencies(locals.user, id));
};

export const POST: RequestHandler = async ({ params, request, locals }) => {
	if (!locals.user) throw error(401, 'Not authenticated');
	const id = Number(params.id);
	if (isNaN(id)) throw error(400, 'Invalid subtask ID');
	return json(addSubtaskDependency(locals.user, id, await request.json()), { status: 201 });
};

export const DELETE: RequestHandler = async ({ params, request, locals }) => {
	if (!locals.user) throw error(401, 'Not authenticated');
	const id = Number(params.id);
	if (isNaN(id)) throw error(400, 'Invalid subtask ID');
	return json(removeSubtaskDependency(locals.user, id, await request.json()));
};
