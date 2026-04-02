import { json, error } from '@sveltejs/kit';
import { db } from '$lib/server/db';
import { cardAssignees, users, cards, columns } from '$lib/server/db/schema';
import { eq, and } from 'drizzle-orm';
import { getBoardRole } from '$lib/server/board-access';
import { notifyUserAssigned } from '$lib/server/notifications';
import type { RequestHandler } from './$types';

/** POST — Assign a user to a card. */
export const POST: RequestHandler = async ({ params, request, locals, url }) => {
	if (!locals.user) throw error(401, 'Not authenticated');

	const cardId = Number(params.id);
	const { userId } = await request.json();
	if (!userId) throw error(400, 'userId is required');

	// Find the board this card belongs to
	const card = db.select({ columnId: cards.columnId, title: cards.title })
		.from(cards).where(eq(cards.id, cardId)).get();
	if (!card) throw error(404, 'Card not found');

	const col = db.select({ boardId: columns.boardId })
		.from(columns).where(eq(columns.id, card.columnId)).get();
	if (!col) throw error(404, 'Column not found');

	// Check board access (must be editor+)
	const role = getBoardRole(locals.user, col.boardId);
	if (!role || role === 'viewer') throw error(403, 'No edit access');

	// Check user exists
	const user = db.select({ id: users.id, email: users.email, username: users.username })
		.from(users).where(eq(users.id, userId)).get();
	if (!user) throw error(404, 'User not found');

	// Upsert
	const existing = db.select().from(cardAssignees)
		.where(and(eq(cardAssignees.cardId, cardId), eq(cardAssignees.userId, userId)))
		.get();

	if (!existing) {
		db.insert(cardAssignees).values({ cardId, userId }).run();

		// Send notification (fire-and-forget)
		const baseUrl = `${url.protocol}//${url.host}`;
		notifyUserAssigned(col.boardId, cardId, card.title, user.email, user.username, locals.user.username);
	}

	return json({ success: true });
};

/** DELETE — Remove a user from a card. */
export const DELETE: RequestHandler = async ({ params, request, locals }) => {
	if (!locals.user) throw error(401, 'Not authenticated');

	const cardId = Number(params.id);
	const { userId } = await request.json();

	// Find the board for access check
	const card = db.select({ columnId: cards.columnId }).from(cards).where(eq(cards.id, cardId)).get();
	if (!card) throw error(404, 'Card not found');

	const col = db.select({ boardId: columns.boardId }).from(columns).where(eq(columns.id, card.columnId)).get();
	if (!col) throw error(404, 'Column not found');

	const role = getBoardRole(locals.user, col.boardId);
	if (!role || role === 'viewer') throw error(403, 'No edit access');

	db.delete(cardAssignees)
		.where(and(eq(cardAssignees.cardId, cardId), eq(cardAssignees.userId, userId)))
		.run();

	return json({ success: true });
};
