/**
 * request-access.ts — who may read and act on a task request.
 *
 * A request is addressed to one user or one team. The inbox only ever listed a
 * person's own, but the routes that read, answer, accept and reject a request
 * took any id from any signed-in user, so the address meant nothing once you
 * guessed a number.
 */
import { error } from '@sveltejs/kit';
import { and, eq } from 'drizzle-orm';
import { db } from './db';
import { taskRequests, teamMembers, type TaskRequest } from './db/schema';
import { isAdmin } from './board-access';
import type { SessionUser } from './auth';

/**
 * True if the request is addressed to this user — directly, or through a team
 * they belong to — or they are an administrator.
 *
 * These are the people who may reply to it, accept it or reject it.
 */
export function canHandleRequest(user: SessionUser, request: TaskRequest): boolean {
	if (isAdmin(user)) return true;
	if (request.targetType === 'user') return request.targetId === user.id;

	const membership = db
		.select({ userId: teamMembers.userId })
		.from(teamMembers)
		.where(and(eq(teamMembers.teamId, request.targetId), eq(teamMembers.userId, user.id)))
		.get();
	return !!membership;
}

/** True if this signed-in user is the one who raised the request. */
export function isRequestAuthor(user: SessionUser, request: TaskRequest): boolean {
	return request.requesterUserId !== null && request.requesterUserId === user.id;
}

/** True if this signed-in user may read the request and its thread. */
export function canReadRequest(user: SessionUser, request: TaskRequest): boolean {
	return canHandleRequest(user, request) || isRequestAuthor(user, request);
}

/**
 * The request `id`, if `letIn` lets the caller in: the route's own rule, the
 * link's token or being someone the request is addressed to.
 *
 * A caller with no session is answered `404 Request not found` for a request
 * they are not let into, whatever its state, as for one that is not there
 * (card 2132). Request ids are consecutive, and a `403` for one that is there
 * told anyone on the internet how many requests there are and, with the `400`
 * for a resolved one, when each was dealt with. A signed-in caller is answered
 * as every guard answers: `404` for one that is not there, `403 refusal` for
 * one that is not theirs. Its state is for the route to tell, once the caller
 * is let in.
 */
export function requireRequest(
	user: SessionUser | null,
	id: number,
	letIn: (request: TaskRequest) => boolean,
	refusal: string
): TaskRequest {
	const request = db.select().from(taskRequests).where(eq(taskRequests.id, id)).get();
	if (request && letIn(request)) return request;
	if (!user || !request) throw error(404, 'Request not found');
	throw error(403, refusal);
}
