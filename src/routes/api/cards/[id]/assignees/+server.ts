import { json, error } from '@sveltejs/kit';
import { db } from '$lib/server/db';
import { cardAssignees, users, cards, columns } from '$lib/server/db/schema';
import { eq, and } from 'drizzle-orm';
import { getBoardRole } from '$lib/server/board-access';
import { emit } from '$lib/server/events';
import { ACTIONS, actorOf, logUiActivity } from '$lib/server/logActivity';
import { notifyUserAssigned } from '$lib/server/notifications';
import { linkBaseUrl } from '$lib/server/email';
import { pathId, readBody, readId } from '$lib/server/request-body';
import { requireUser } from '$lib/server/route-guards';
import type { SessionUser } from '$lib/server/auth';
import { writeAs } from '$lib/server/write-as';
import type { RequestHandler } from './$types';

/** The card and the board it is on, if the caller may edit that board: 404, then 403. */
function editableCard(caller: SessionUser, cardId: number): { title: string; boardId: number } {
	const card = db.select({ columnId: cards.columnId, title: cards.title })
		.from(cards).where(eq(cards.id, cardId)).get();
	if (!card) throw error(404, 'Card not found');

	const col = db.select({ boardId: columns.boardId })
		.from(columns).where(eq(columns.id, card.columnId)).get();
	if (!col) throw error(404, 'Column not found');

	// Check board access (must be editor+)
	const role = getBoardRole(caller, col.boardId);
	if (!role || role === 'viewer') throw error(403, 'No edit access');
	return { title: card.title, boardId: col.boardId };
}

/**
 * POST — Assign a user to a card. Body: `{ userId }`, an id (card 2117): `0`,
 * `''` and `false` were `userId is required`, and anything else was looked for.
 *
 * The card is looked for and the caller checked (404, then 403) before
 * `userId` is read (400) and its user looked for (404), all in the
 * transaction that assigns them.
 *
 * It records what `POST /api/v1/cards/{id}/assignees` records (card 2143):
 * an `assignee_added` entry and the mail when someone was added, and the
 * board's open pages are told either way, as that route tells them. Neither
 * was done here, so an assignment made in the card window reached no
 * Activity Log and refreshed no other page.
 */
export const POST: RequestHandler = async ({ params, request, locals, url }) => {
	requireUser(locals.user);
	const cardId = pathId(params.id, 'card');
	const body = await readBody(request);

	// The session is asked again, and who its account is now, in the
	// transaction that assigns (card 2253).
	writeAs(locals, (caller) => {
		const user = requireUser(caller);
		const card = editableCard(user, cardId);

		const userId = readId(body, 'userId', { required: true, says: { missing: 'userId is required' } });

		// Check user exists and has access to this board
		const assignee = db.select({ id: users.id, email: users.email, username: users.username, role: users.role })
			.from(users).where(eq(users.id, userId)).get();
		if (!assignee) throw error(404, 'User not found');

		const targetRole = getBoardRole(assignee, card.boardId);
		if (!targetRole) throw error(400, 'User does not have access to this board');

		// Upsert
		const existing = db.select().from(cardAssignees)
			.where(and(eq(cardAssignees.cardId, cardId), eq(cardAssignees.userId, userId)))
			.get();

		if (!existing) {
			db.insert(cardAssignees).values({ cardId, userId }).run();

			// Send notification (fire-and-forget)
			const baseUrl = linkBaseUrl(url);
			notifyUserAssigned(card.boardId, cardId, card.title, assignee.email, assignee.username, user.username, baseUrl);
		}

		emit(card.boardId, 'update', { type: 'card' });

		if (!existing) {
			logUiActivity({
				boardId: card.boardId,
				cardId,
				action: ACTIONS.assigneeAdded,
				detail: `Assigned ${assignee.username} to "${card.title}"`,
				...actorOf(user)
			});
		}
	});

	return json({ success: true });
};

/**
 * DELETE — Remove a user from a card. Body: `{ userId }`, an id.
 *
 * Removing someone who is not assigned to the card is
 * `404 User is not assigned to this card` (card 2117, decision 9), as the
 * API's route answers it. It was 200, and the card window said it was done.
 *
 * A removal writes the `assignee_removed` entry and tells the board's open
 * pages, as the API's route does (card 2143); a refused one does neither.
 */
export const DELETE: RequestHandler = async ({ params, request, locals }) => {
	requireUser(locals.user);
	const cardId = pathId(params.id, 'card');
	const body = await readBody(request);

	writeAs(locals, (caller) => {
		const user = requireUser(caller);
		const card = editableCard(user, cardId);

		const userId = readId(body, 'userId', { required: true, says: { missing: 'userId is required' } });

		const removed = db.delete(cardAssignees)
			.where(and(eq(cardAssignees.cardId, cardId), eq(cardAssignees.userId, userId)))
			.run();
		if (removed.changes === 0) throw error(404, 'User is not assigned to this card');

		emit(card.boardId, 'update', { type: 'card' });

		const removedUser = db.select({ username: users.username }).from(users).where(eq(users.id, userId)).get();
		logUiActivity({
			boardId: card.boardId,
			cardId,
			action: ACTIONS.assigneeRemoved,
			detail: `Removed ${removedUser?.username || 'user'} from "${card.title}"`,
			...actorOf(user)
		});
	});

	return json({ success: true });
};
