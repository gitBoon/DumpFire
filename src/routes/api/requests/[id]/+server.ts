import { json, error } from '@sveltejs/kit';
import { db } from '$lib/server/db';
import { inTransaction } from '$lib/server/db/transaction';
import { taskRequests, requestMessages, cards, cardAssignees, cardComments, users, type TaskRequest } from '$lib/server/db/schema';
import { eq, asc } from 'drizzle-orm';
import { canViewBoard, isAdmin } from '$lib/server/board-access';
import { requireColumn } from '$lib/server/route-guards';
import { canHandleRequest, canReadRequest, requireRequest } from '$lib/server/request-access';
import { publicRequest, requestTokenMatches } from '$lib/server/request-tokens';
import { notifyUserAssigned, notifyRequesterAccepted, notifyRequesterRejected } from '$lib/server/notifications';
import { announceCardCreated, recordCardCreated } from '$lib/server/card-create';
import { linkBaseUrl } from '$lib/server/email';
import { pathId, readBody, readChoice, readId, readText } from '$lib/server/request-body';
import type { RequestHandler } from './$types';

/**
 * GET — Fetch a single request.
 *
 * For a signed-in user the request is addressed to (or who raised it), or for
 * whoever holds the request's own token — the one in the link emailed to the
 * requester. The requester's email address used to be accepted in its place,
 * and an address is not a secret.
 *
 * A caller with no session and without the link is answered 404, whether the
 * request is there or not (card 2132): it was 403 for one that is there.
 */
export const GET: RequestHandler = async ({ params, url, locals }) => {
	const id = pathId(params.id, 'request');
	const token = url.searchParams.get('token');

	// Being signed in is not enough on its own — it used to be, so any account
	// could read any request.
	const isAuthed = (row: TaskRequest) => !!locals.user && canReadRequest(locals.user, row);
	const request = requireRequest(locals.user, id, (row) => isAuthed(row) || requestTokenMatches(row, token), 'Access denied');

	return json({
		id: request.id,
		title: request.title,
		description: request.description,
		priority: request.priority,
		status: request.status,
		requesterName: request.requesterName,
		requesterEmail: isAuthed(request) ? request.requesterEmail : null, // only expose email to authenticated users
		createdAt: request.createdAt
	});
};
export const PATCH: RequestHandler = async ({ params, request, locals, url }) => {
	if (!locals.user) throw error(401, 'Not authenticated');
	const user = locals.user;

	const id = pathId(params.id, 'request');
	const body = await readBody(request);

	// One transaction: the request is read and checked as still open in the one
	// that resolves it, so it cannot be accepted twice, or accepted and
	// rejected. For an accept, the card, its comments, its assignee and the
	// request's status are written together: a failure part of the way used to
	// leave a card on the board for a request still waiting in the inbox. The
	// mail is worked out in here and sent once it is committed.
	const answer = inTransaction(() => {
		const existing = db.select().from(taskRequests).where(eq(taskRequests.id, id)).get();
		if (!existing) throw error(404, 'Request not found');

		// Only the person or team the request is addressed to decides its fate.
		if (!canHandleRequest(user, existing)) {
			throw error(403, 'This request is not addressed to you');
		}
		if (existing.status !== 'pending') throw error(400, 'Request already resolved');

		// What was asked of it is read once whose it is is settled (card 2117,
		// R1). Its ids are ids: one that was not was looked for as it came.
		const action = readChoice(body, 'action', {
			required: true,
			from: ['accept', 'reject'],
			says: 'Invalid action — must be "accept" or "reject"'
		});

		if (action === 'accept') {
			const REQUIRED = 'Board and column are required to accept';
			const boardId = readId(body, 'boardId', { nullable: true }) ?? error(400, REQUIRED);
			const columnId = readId(body, 'columnId', { nullable: true }) ?? error(400, REQUIRED);
			const assigneeId = readId(body, 'assigneeId', { nullable: true }) ?? null;

			// Accepting creates a card, so it needs edit access to the board the
			// card lands on. There was no check: anyone could turn a request into a
			// card on any board. The board is taken from the column's own row, and
			// has to be the board the caller named.
			const target = requireColumn(user, columnId, 'edit');
			if (target.boardId !== boardId) throw error(400, 'That column is not on that board');

			// Whoever is given the card has to be able to open it.
			if (assigneeId !== null) {
				const assignee = db.select().from(users).where(eq(users.id, assigneeId)).get();
				if (!assignee) throw error(404, 'User not found');
				if (!canViewBoard(assignee, target.boardId)) {
					throw error(400, 'User does not have access to this board');
				}
			}

			// Get max position in the target column
			const colCards = db.select({ position: cards.position })
				.from(cards)
				.where(eq(cards.columnId, columnId))
				.all();
			const maxPos = colCards.length > 0 ? Math.max(...colCards.map(c => c.position)) + 1 : 0;

			// Create the card. Whoever accepts the request raised it, as the
			// other two ways to create a card record.
			const newCard = db.insert(cards).values({
				columnId,
				title: existing.title,
				description: existing.description || '',
				priority: existing.priority,
				position: maxPos,
				colorTag: '',
				pinned: false,
				onHoldNote: '',
				businessValue: existing.businessValue || '',
				createdBy: user.id
			}).returning().get();

			// What every new card records: its `card_created` entry, which this
			// route never wrote, and, accepted into a Complete column, its
			// completion (card 2134).
			const creation = recordCardCreated({ card: newCard, column: target.column, actor: user, source: 'ui' });
			const baseUrl = linkBaseUrl(url);

			// Update request status
			db.update(taskRequests).set({
				status: 'accepted',
				resolvedBy: user.id,
				resolvedCardId: newCard.id,
				resolvedAt: new Date().toISOString()
			}).where(eq(taskRequests.id, id)).run();

			// Copy discussion messages as card comments
			const msgs = db.select().from(requestMessages)
				.where(eq(requestMessages.requestId, id))
				.orderBy(asc(requestMessages.createdAt))
				.all();
			for (const m of msgs) {
				const who = m.senderType === 'admin' ? `🛡️ ${m.senderName}` : `👤 ${m.senderName}`;
				db.insert(cardComments).values({
					cardId: newCard.id,
					userId: user.id,
					content: `**${who} (from request discussion):**\n${m.message}`
				}).run();
			}

			// Assign user if specified
			if (assigneeId !== null) {
				db.insert(cardAssignees).values({
					cardId: newCard.id,
					userId: assigneeId
				}).run();

				// Send assignment email
				const assignee = db.select({ email: users.email, username: users.username })
					.from(users).where(eq(users.id, assigneeId)).get();
				if (assignee) {
					notifyUserAssigned(boardId, newCard.id, existing.title, assignee.email, assignee.username, user.username, baseUrl);
				}
			}

			// Notify requester via email
			if (existing.requesterEmail) {
				notifyRequesterAccepted(existing.requesterEmail, existing.title, user.username);
			}

			// After "Request accepted", so that mail starts first: the live update,
			// and for a card accepted into a Complete column the celebration and
			// the requester's "Your request is complete", which waits for its PDF.
			announceCardCreated(creation, user, baseUrl);

			return { ...publicRequest(existing), status: 'accepted', resolvedCardId: newCard.id };

		} else {
			const rejectReason = readText(body, 'rejectReason', { nullable: true, max: 10000 });
			db.update(taskRequests).set({
				status: 'rejected',
				resolvedBy: user.id,
				rejectReason: rejectReason || null,
				resolvedAt: new Date().toISOString()
			}).where(eq(taskRequests.id, id)).run();

			// Notify requester via email
			if (existing.requesterEmail) {
				notifyRequesterRejected(existing.requesterEmail, existing.title, user.username, rejectReason || undefined);
			}

			return { ...publicRequest(existing), status: 'rejected' };
		}
	});

	return json(answer);
};

/**
 * DELETE — Delete a request (admin only). One that is not there is
 * `404 Request not found`, where it was answered as deleted.
 */
export const DELETE: RequestHandler = async ({ params, locals }) => {
	if (!locals.user) throw error(401, 'Not authenticated');
	if (!isAdmin(locals.user)) throw error(403, 'Admin only');

	const id = pathId(params.id, 'request');
	const { changes } = db.delete(taskRequests).where(eq(taskRequests.id, id)).run();
	if (changes === 0) throw error(404, 'Request not found');
	return json({ ok: true });
};
