/**
 * request-access.ts — who may read and act on a task request, and the address
 * its requester is mailed at.
 *
 * A request is addressed to one user or one team. The inbox only ever listed a
 * person's own, but the routes that read, answer, accept and reject a request
 * took any id from any signed-in user, so the address meant nothing once you
 * guessed a number.
 */
import { error } from '@sveltejs/kit';
import { and, eq } from 'drizzle-orm';
import { db } from './db';
import { taskRequests, teamMembers, users, type TaskRequest } from './db/schema';
import { isAdmin } from './board-access';
import type { SessionUser } from './auth';

/**
 * How long a request may sit unconfirmed. The form clears older ones as it
 * takes a new anonymous request, and a new link is never mailed for one
 * (card 2158, R3): it is treated as not there.
 */
export const UNVERIFIED_LIFETIME_DAYS = 7;

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

/**
 * The address a mail to the request's requester goes to, and the one shown to
 * the team (card 2171). For a request made signed in, the account's email as
 * it is now; for one made without an account, the address given, or the one
 * `deleteUser` wrote when the account that made it was deleted. `null` when
 * there is neither, or when the account named is not there (only a restore
 * that reported the row can leave one so), and then nothing is sent.
 *
 * Asked when the mail is worked out, never stored: every mail went to the
 * address stored when the request was made, so after an account's email
 * changed, the team's replies, the acceptance and every progress mail went to
 * an address that may be somebody else's now.
 */
export function requesterAddress(request: Pick<TaskRequest, 'requesterUserId' | 'requesterEmail'>): string | null {
	if (request.requesterUserId === null) return request.requesterEmail || null;
	const account = db.select({ email: users.email }).from(users).where(eq(users.id, request.requesterUserId)).get();
	return account?.email ?? null;
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
