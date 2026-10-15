import { json, error } from '@sveltejs/kit';
import { db } from '$lib/server/db';
import { inTransaction } from '$lib/server/db/transaction';
import { cardAssignees, users, cards, columns } from '$lib/server/db/schema';
import { eq, and } from 'drizzle-orm';
import { getBoardRole } from '$lib/server/board-access';
import { notifyUserAssigned } from '$lib/server/notifications';
import { linkBaseUrl } from '$lib/server/email';
import { pathId, readBody, readId } from '$lib/server/request-body';
import { requireUser } from '$lib/server/route-guards';
import type { SessionUser } from '$lib/server/auth';
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
 */
export const POST: RequestHandler = async ({ params, request, locals, url }) => {
	const caller = requireUser(locals.user);
	const cardId = pathId(params.id, 'card');
	const body = await readBody(request);

	inTransaction(() => {
		const card = editableCard(caller, cardId);

		const userId = readId(body, 'userId', { required: true, says: { missing: 'userId is required' } });

		// Check user exists and has access to this board
		const user = db.select({ id: users.id, email: users.email, username: users.username, role: users.role })
			.from(users).where(eq(users.id, userId)).get();
		if (!user) throw error(404, 'User not found');

		const targetRole = getBoardRole(user, card.boardId);
		if (!targetRole) throw error(400, 'User does not have access to this board');

		// Upsert
		const existing = db.select().from(cardAssignees)
			.where(and(eq(cardAssignees.cardId, cardId), eq(cardAssignees.userId, userId)))
			.get();

		if (!existing) {
			db.insert(cardAssignees).values({ cardId, userId }).run();

			// Send notification (fire-and-forget)
			const baseUrl = linkBaseUrl(url);
			notifyUserAssigned(card.boardId, cardId, card.title, user.email, user.username, caller.username, baseUrl);
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
 */
export const DELETE: RequestHandler = async ({ params, request, locals }) => {
	const caller = requireUser(locals.user);
	const cardId = pathId(params.id, 'card');
	const body = await readBody(request);

	inTransaction(() => {
		editableCard(caller, cardId);

		const userId = readId(body, 'userId', { required: true, says: { missing: 'userId is required' } });

		const removed = db.delete(cardAssignees)
			.where(and(eq(cardAssignees.cardId, cardId), eq(cardAssignees.userId, userId)))
			.run();
		if (removed.changes === 0) throw error(404, 'User is not assigned to this card');
	});

	return json({ success: true });
};
