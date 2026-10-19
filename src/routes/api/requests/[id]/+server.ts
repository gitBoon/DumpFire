import { json, error } from '@sveltejs/kit';
import { db } from '$lib/server/db';
import { taskRequests, requestMessages, cards, cardAssignees, cardComments, users, type TaskRequest } from '$lib/server/db/schema';
import { eq, asc } from 'drizzle-orm';
import type { SessionUser } from '$lib/server/auth';
import { canViewBoard } from '$lib/server/board-access';
import { requireAdmin, requireColumn, requireUser } from '$lib/server/route-guards';
import { writeAs } from '$lib/server/write-as';
import { awaitsConfirmation, canHandleRequest, canReadRequest, linkOpens, requesterAddress, requireRequest } from '$lib/server/request-access';
import { publicRequest } from '$lib/server/request-tokens';
import { notifyUserAssigned, notifyRequesterAccepted, notifyRequesterRejected } from '$lib/server/notifications';
import { announceCardCreated, recordCardCreated } from '$lib/server/card-create';
import { linkBaseUrl } from '$lib/server/email';
import { ACTIONS, actorOf, logUiActivity } from '$lib/server/logActivity';
import { pathId, readBody, readChoice, readId, readText } from '$lib/server/request-body';
import { stamp } from '$lib/timestamps';
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
 * request is there or not (card 2132): it was 403 for one that is there. The
 * link of a request nobody confirmed within seven days is answered alike (card
 * 2243), so the requester's thread page shows the link as gone, and no longer
 * offers "Confirm it" for a request the confirm route refuses.
 *
 * The requester's address goes to a signed-in reader only, and it is the one
 * their mail goes to: the account's email as it is now, for a request made
 * signed in (card 2171).
 */
export const GET: RequestHandler = async ({ params, url, locals }) => {
	const id = pathId(params.id, 'request');
	const token = url.searchParams.get('token');

	// Being signed in is not enough on its own — it used to be, so any account
	// could read any request.
	const isAuthed = (row: TaskRequest) => !!locals.user && canReadRequest(locals.user, row);
	const request = requireRequest(locals.user, id, (row) => isAuthed(row) || linkOpens(row, token), 'Access denied');

	return json({
		id: request.id,
		title: request.title,
		description: request.description,
		priority: request.priority,
		status: request.status,
		requesterName: request.requesterName,
		requesterEmail: isAuthed(request) ? requesterAddress(request) : null, // only expose email to authenticated users
		createdAt: request.createdAt
	});
};
export const PATCH: RequestHandler = async ({ params, request, locals, url }) => {
	requireUser(locals.user);

	const id = pathId(params.id, 'request');
	const body = await readBody(request);

	// One transaction: the request is read and checked as still open in the one
	// that resolves it, so it cannot be accepted twice, or accepted and
	// rejected. For an accept, the card, its comments, its assignee and the
	// request's status are written together: a failure part of the way used to
	// leave a card on the board for a request still waiting in the inbox. The
	// mail is worked out in here and sent once it is committed.
	// The request as its answer gives it, with the board it asks for only when
	// the caller can open that board, as the inbox gives it (card 2153, the
	// review's N3): the row's own desiredBoardId went to an addressee who could
	// not. The answer carries no name or emoji of the board.
	const answered = (row: TaskRequest, viewer: SessionUser) => {
		const shown = publicRequest(row);
		const open = row.desiredBoardId !== null && canViewBoard(viewer, row.desiredBoardId);
		return { ...shown, desiredBoardId: open ? row.desiredBoardId : null };
	};

	// It asks first whether the session is still open, and who its account is
	// now, and decides with that (card 2253).
	const answer = writeAs(locals, (caller) => {
		const user = requireUser(caller);
		const existing = db.select().from(taskRequests).where(eq(taskRequests.id, id)).get();
		// One that awaits confirmation is not there for the team (card 2260):
		// it was `400 Request already resolved`, which told them it was.
		if (!existing || awaitsConfirmation(existing)) throw error(404, 'Request not found');

		// Only the person or team the request is addressed to decides its fate.
		if (!canHandleRequest(user, existing)) {
			throw error(403, 'This request is not addressed to you');
		}
		if (existing.status !== 'pending') throw error(400, 'Request already resolved');

		// Where the requester's mail goes, as it is now: the account's email
		// for a request made signed in (card 2171). The answer gives the same
		// address, never the one stored when the request was made.
		const requester = requesterAddress(existing);

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
				resolvedAt: stamp()
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

				// Send assignment email, and record the assignment as assigning
				// someone in the card window records it (card 2143): after the
				// card's own entries, by whoever accepted, from the page. No event
				// of its own: the card's `created` event refreshes the board.
				const assignee = db.select({ email: users.email, username: users.username })
					.from(users).where(eq(users.id, assigneeId)).get();
				if (assignee) {
					logUiActivity({
						boardId: target.boardId,
						cardId: newCard.id,
						action: ACTIONS.assigneeAdded,
						detail: `Assigned ${assignee.username} to "${newCard.title}"`,
						...actorOf(user)
					});
					notifyUserAssigned(boardId, newCard.id, existing.title, assignee.email, assignee.username, user.username, baseUrl);
				}
			}

			// Notify requester via email
			if (requester !== null) {
				notifyRequesterAccepted(requester, existing.title, user.username);
			}

			// After "Request accepted", so that mail starts first: the live update,
			// and for a card accepted into a Complete column the celebration and
			// the requester's "Your request is complete", which waits for its PDF.
			announceCardCreated(creation, user, baseUrl);

			return { ...answered(existing, user), requesterEmail: requester, status: 'accepted', resolvedCardId: newCard.id };

		} else {
			const rejectReason = readText(body, 'rejectReason', { nullable: true, max: 10000 });
			db.update(taskRequests).set({
				status: 'rejected',
				resolvedBy: user.id,
				rejectReason: rejectReason || null,
				resolvedAt: stamp()
			}).where(eq(taskRequests.id, id)).run();

			// Notify requester via email
			if (requester !== null) {
				notifyRequesterRejected(requester, existing.title, user.username, rejectReason || undefined);
			}

			return { ...answered(existing, user), requesterEmail: requester, status: 'rejected' };
		}
	});

	return json(answer);
};

/**
 * DELETE — Delete a request (admin only). One that is not there is
 * `404 Request not found`, where it was answered as deleted.
 */
export const DELETE: RequestHandler = async ({ params, locals }) => {
	requireUser(locals.user);
	requireAdmin(locals.user, 'Admin only');

	const id = pathId(params.id, 'request');
	// Asked first whether the session is still open, and whether its account
	// is an administrator now (card 2253).
	writeAs(locals, (caller) => {
		requireAdmin(requireUser(caller), 'Admin only');
		const { changes } = db.delete(taskRequests).where(eq(taskRequests.id, id)).run();
		if (changes === 0) throw error(404, 'Request not found');
	});
	return json({ ok: true });
};
