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
import { requireUser } from '$lib/server/route-guards';
import { writeAs } from '$lib/server/write-as';
import type { RequestHandler } from './$types';

export const GET: RequestHandler = async ({ params, locals }) => {
	if (!locals.user) throw error(401, 'Not authenticated');
	const id = pathId(params.id, 'subtask');
	return json(readSubtaskDependencies(locals.user, id));
};

export const POST: RequestHandler = async ({ params, request, locals }) => {
	requireUser(locals.user);
	const id = pathId(params.id, 'subtask');
	const body = await readBody(request);
	// The session asked again and who its account is now (card 2253), the
	// subtask, the body's ends, the link and its entry: one transaction, the
	// service's a savepoint inside it.
	const outcome = writeAs(locals, (caller) => addSubtaskDependency(requireUser(caller), id, body, 'ui'));
	if (outcome.rejected) return cycleAnswer(outcome);
	return json(outcome.state, { status: 201 });
};

export const DELETE: RequestHandler = async ({ params, request, locals }) => {
	requireUser(locals.user);
	const id = pathId(params.id, 'subtask');
	const body = await readBody(request);
	const state = writeAs(locals, (caller) => removeSubtaskDependency(requireUser(caller), id, body, 'ui'));
	return json(state);
};
