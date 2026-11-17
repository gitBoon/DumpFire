/**
 * request-access.ts — who may read and act on a task request, and the address
 * its requester is mailed at.
 *
 * A request is addressed to one user or one team. The inbox only ever listed a
 * person's own, but the routes that read, answer, accept and reject a request
 * took any id from any signed-in user, so the address meant nothing once you
 * guessed a number.
 *
 * A link's token is resolved before the request is read (card 2870, S2):
 * `linkCheck` looks it up by its hash, whatever the id, and only then is the
 * row read, so the time an answer takes says nothing of which requests exist.
 */
import { error } from '@sveltejs/kit';
import { and, eq } from 'drizzle-orm';
import { db } from './db';
import { cards, taskRequests, teamMembers, users, type TaskRequest } from './db/schema';
import { isAdmin } from './board-access';
import type { SessionUser } from './auth';
import { inTransaction } from './db/transaction';
import { issueRequestLink, requestIdOfLink, type RequestLinkSource } from './request-tokens';
import { stamp } from '$lib/timestamps';

/**
 * How long a request may sit unconfirmed. The form clears older ones as it
 * takes a new anonymous request, and a new link is never mailed for one
 * (card 2158, R3): it is treated as not there.
 */
export const UNVERIFIED_LIFETIME_DAYS = 7;

/**
 * The moment before which an unconfirmed request has lapsed, in the stored
 * form, so that it compares as text with `createdAt`.
 */
export function unconfirmedCutoff(now: number = Date.now()): string {
	return stamp(new Date(now - UNVERIFIED_LIFETIME_DAYS * 24 * 60 * 60 * 1000));
}

/**
 * True for a request nobody confirmed within `UNVERIFIED_LIFETIME_DAYS`: one
 * the form clears as it takes the next anonymous request. Until then it is
 * still a row, and every route that takes its link treats it as not there
 * (card 2243): the confirmation link confirmed it, the team was mailed and it
 * entered the inbox however old the link was. Strictly older, as the form's
 * delete reads it. Only an unconfirmed request lapses; when a settled one's
 * links end is `linkEnded`'s (card 2902).
 */
export function hasLapsed(request: Pick<TaskRequest, 'status' | 'createdAt'>, now?: number): boolean {
	return request.status === 'unverified' && request.createdAt < unconfirmedCutoff(now);
}

/**
 * How long a settled request's links go on opening it, in days after it was
 * settled (card 2902): an old mail, forwarded or found in a mailbox years
 * later, no longer opens the thread. A request still open keeps its links.
 */
export const SETTLED_LINK_DAYS = 90;

/** The moment before which a settled request's links have ended, in the stored form. */
export function settledCutoff(now: number = Date.now()): string {
	return stamp(new Date(now - SETTLED_LINK_DAYS * 24 * 60 * 60 * 1000));
}

/**
 * When the request was settled, in the stored form, or null while it is open
 * (card 2902, decision 2). Declined: when it was declined (`resolvedAt`).
 * Accepted: when its card was completed (`completedAt`), and null while the
 * card is open, a card reopened clearing it; with its card gone (deleted, so
 * `resolvedCardId` is null, or a row not found), when it was accepted, the
 * sooner of the two to close. Pending and unconfirmed requests are open.
 */
function settledAt(request: Pick<TaskRequest, 'status' | 'resolvedAt' | 'resolvedCardId'>): string | null {
	if (request.status === 'rejected') return request.resolvedAt;
	if (request.status !== 'accepted') return null;
	if (request.resolvedCardId === null) return request.resolvedAt;
	const card = db.select({ completedAt: cards.completedAt }).from(cards).where(eq(cards.id, request.resolvedCardId)).get();
	return card ? card.completedAt : request.resolvedAt;
}

/**
 * True when a request's links open nothing and no new one is issued for it:
 * an unconfirmed request that has lapsed (`hasLapsed`, card 2243), or one
 * settled more than `SETTLED_LINK_DAYS` ago (card 2902). The one rule for the
 * link check, the new-link ask and the link that ask issues. A link of such a
 * request is answered as one that is not there; its row stays in
 * `request_links` until the request is deleted, opening nothing.
 */
export function linkEnded(
	request: Pick<TaskRequest, 'status' | 'createdAt' | 'resolvedAt' | 'resolvedCardId'>,
	now?: number
): boolean {
	if (hasLapsed(request, now)) return true;
	const settled = settledAt(request);
	return settled !== null && settled < settledCutoff(now);
}

/**
 * The check a request link's token passes, resolved at once (card 2870,
 * decision 6): the token is looked up by its hash now, before the caller
 * reads the request, whether or not that request exists. The check it gives
 * back is true if the token is a live link to that request and the link still
 * opens it: the link of a lapsed request, or of one settled more than 90 days
 * ago (`linkEnded`, card 2902), opens nothing, and is answered as one that is
 * not there (card 2243). One request's link opens no other.
 */
export function linkCheck(token: unknown): (request: TaskRequest) => boolean {
	const linked = requestIdOfLink(token);
	return (request) => linked === request.id && !linkEnded(request);
}

/**
 * True for a request made without an account that its requester has not
 * confirmed yet (card 2260). Until it is confirmed it is not the team's: only
 * its own link opens it.
 */
export function awaitsConfirmation(request: Pick<TaskRequest, 'status'>): boolean {
	return request.status === 'unverified';
}

/**
 * True if the request is addressed to this user — directly, or through a team
 * they belong to — or they are an administrator.
 *
 * These are the people who may reply to it, accept it or reject it. Nobody,
 * an administrator included, may do any of it to a request that awaits
 * confirmation (card 2260): the inbox never listed one, but the person or team
 * it was addressed to, and every administrator, could read it by its id, with
 * the requester's address, before the requester had stood behind it.
 */
export function canHandleRequest(user: SessionUser, request: TaskRequest): boolean {
	if (awaitsConfirmation(request)) return false;
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

/** A link issued by `issueRequestLinkFor`, with what its mail needs, as read in the transaction that wrote it. */
export interface IssuedRequestLink {
	token: string;
	/** `requesterAddress` as it was read then: where the mail goes. */
	address: string;
	title: string;
	/** True for a request not yet confirmed: the mail carries the confirmation link. */
	unconfirmed: boolean;
}

/**
 * A new link to request `requestId`, for a mail to `expectedAddress` that
 * goes some time after the address was matched (card 2870, the code review's
 * CS1): the new-link ask matches the address before its answer and mails
 * after it, and a restore or an account's new email committed in between
 * could otherwise hand the asker a link to a thread that is no longer theirs.
 *
 * In one transaction of its own (`inTransaction`), the request is read again
 * by its id, and the link is written (`issueRequestLink`) only if it is still
 * there, its links have not ended (`linkEnded`: lapsed, or settled more than
 * 90 days ago, card 2902), and `requesterAddress` of it is still
 * `expectedAddress`, case and surrounding spaces ignored, as the ask compares
 * them. Otherwise nothing is written and it returns null: no link, so no mail.
 * What the mail says, its address, title and kind, is taken from that read.
 */
export function issueRequestLinkFor(requestId: number, expectedAddress: string, source: RequestLinkSource): IssuedRequestLink | null {
	const comparable = (address: string) => address.trim().toLowerCase();
	return inTransaction(() => {
		const request = db.select().from(taskRequests).where(eq(taskRequests.id, requestId)).get();
		if (!request || linkEnded(request)) return null;
		const address = requesterAddress(request);
		if (address === null || comparable(address) !== comparable(expectedAddress)) return null;
		return {
			token: issueRequestLink(request.id, source),
			address,
			title: request.title,
			unconfirmed: awaitsConfirmation(request)
		};
	});
}

/** True if this signed-in user is the one who raised the request. */
export function isRequestAuthor(user: SessionUser, request: TaskRequest): boolean {
	return request.requesterUserId !== null && request.requesterUserId === user.id;
}

/**
 * True if this signed-in user may read the request and its thread. Never for
 * one that awaits confirmation (card 2260), refused here as well as by
 * `canHandleRequest`, so that the author rule can never let one in.
 */
export function canReadRequest(user: SessionUser, request: TaskRequest): boolean {
	if (awaitsConfirmation(request)) return false;
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
 *
 * A request that awaits confirmation is `404` to every caller it does not let
 * in, signed in or not (card 2260): to the team it is not there until its
 * requester confirms it, and a `403` to an outsider would tell them it exists
 * while the people it is addressed to are told it does not. Its own link still
 * opens it.
 */
export function requireRequest(
	user: SessionUser | null,
	id: number,
	letIn: (request: TaskRequest) => boolean,
	refusal: string
): TaskRequest {
	const request = db.select().from(taskRequests).where(eq(taskRequests.id, id)).get();
	if (request && letIn(request)) return request;
	if (!user || !request || awaitsConfirmation(request)) throw error(404, 'Request not found');
	throw error(403, refusal);
}
