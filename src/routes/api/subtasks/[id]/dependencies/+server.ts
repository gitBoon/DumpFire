/**
 * Session-authenticated sibling of /api/v1/subtasks/:subtaskId/dependencies,
 * for the subtask modal. Same rules; only the auth differs, and the source its
 * activity entries record, `ui`. The work of each is in
 * `$lib/server/work-dependencies`, which both card routes share too (card 2012).
 */
import { json, error } from '@sveltejs/kit';
import { cycleAnswer } from '$lib/server/dependency-refusals';
import { pathId, readBody } from '$lib/server/request-body';
import { requireUser } from '$lib/server/route-guards';
import { addWorkDependency, readWorkDependencies, removeWorkDependency } from '$lib/server/work-dependencies';
import { writeAs } from '$lib/server/write-as';
import type { RequestHandler } from './$types';

export const GET: RequestHandler = async ({ params, locals }) => {
	if (!locals.user) throw error(401, 'Not authenticated');
	const id = pathId(params.id, 'subtask');
	const { cardId, isBlocked, blockedBy, blocks } = readWorkDependencies(locals.user, { kind: 'subtask', id }, {});
	return json({ subtaskId: id, cardId, isBlocked, blockedBy, blocks });
};

export const POST: RequestHandler = async ({ params, request, locals }) => {
	requireUser(locals.user);
	const id = pathId(params.id, 'subtask');
	const body = await readBody(request);
	// The session asked again and who its account is now (card 2253), the
	// subtask, the body's ends, the link, its entry and the answer's list: one
	// transaction.
	const outcome = writeAs(locals, (caller) => {
		const added = addWorkDependency(caller, { kind: 'subtask', id }, body, { source: 'ui' });
		// A link that would close a loop wrote nothing: it is answered 409, with its chain.
		if (added.rejected) return cycleAnswer(added);
		return { subtaskId: id, cardId: added.cardId, isBlocked: added.isBlocked, blockedBy: added.blockedBy, blocks: added.blocks };
	});
	if (outcome instanceof Response) return outcome;
	return json(outcome, { status: 201 });
};

export const DELETE: RequestHandler = async ({ params, request, locals }) => {
	requireUser(locals.user);
	const id = pathId(params.id, 'subtask');
	const body = await readBody(request);
	const { cardId, isBlocked, blockedBy, blocks } = writeAs(locals, (caller) =>
		removeWorkDependency(caller, { kind: 'subtask', id }, body, { source: 'ui' })
	);
	return json({ subtaskId: id, cardId, isBlocked, blockedBy, blocks });
};
