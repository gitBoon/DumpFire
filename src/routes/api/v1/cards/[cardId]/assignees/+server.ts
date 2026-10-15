import { json, error } from '@sveltejs/kit';
import { db } from '$lib/server/db';
import { inTransaction } from '$lib/server/db/transaction';
import { cards, columns, cardAssignees, users } from '$lib/server/db/schema';
import { eq, and } from 'drizzle-orm';
import { canEditBoard, canViewBoard, getBoardRole } from '$lib/server/board-access';
import { emit } from '$lib/server/events';
import { notifyUserAssigned } from '$lib/server/notifications';
import { linkBaseUrl } from '$lib/server/email';
import { logActivity } from '$lib/server/logActivity';
import { pathId, readBody, readId } from '$lib/server/request-body';
import { requireUser } from '$lib/server/route-guards';
import type { RequestHandler } from './$types';

/** Resolve the board and card title that a card belongs to. */
function getCardContext(cardId: number): { boardId: number; cardTitle: string } | null {
	const card = db.select({ columnId: cards.columnId, title: cards.title }).from(cards).where(eq(cards.id, cardId)).get();
	if (!card) return null;
	const col = db.select({ boardId: columns.boardId }).from(columns).where(eq(columns.id, card.columnId)).get();
	if (!col) return null;
	return { boardId: col.boardId, cardTitle: card.title };
}

/** GET /api/v1/cards/:cardId/assignees — List assignees for a card. */
export const GET: RequestHandler = async ({ params, locals }) => {
	if (!locals.user) throw error(401, 'Not authenticated');

	const cardId = pathId(params.cardId, 'card');

	const ctx = getCardContext(cardId);
	if (!ctx) throw error(404, 'Card not found');

	// Who a card is assigned to is part of the card: it is read by whoever may
	// read the card, and answered as GET /api/v1/cards/:cardId answers.
	if (!canViewBoard(locals.user, ctx.boardId)) {
		throw error(403, 'No access to this card\'s board');
	}

	const assignees = db.select({
		id: users.id,
		username: users.username,
		emoji: users.emoji
	})
		.from(cardAssignees)
		.innerJoin(users, eq(cardAssignees.userId, users.id))
		.where(eq(cardAssignees.cardId, cardId))
		.all();

	return json(assignees);
};

/** POST /api/v1/cards/:cardId/assignees — Assign a user to a card. Body: { userId: number } */
export const POST: RequestHandler = async ({ params, request, url, locals }) => {
	const caller = requireUser(locals.user);
	const cardId = pathId(params.cardId, 'card');
	const body = await readBody(request);

	// One transaction: the card is read and the caller checked in the one that
	// assigns the user and writes the entry. Whether the user is already
	// assigned is read in it too, so two requests cannot both find them
	// unassigned. The mail is worked out in here and sent once it is committed.
	const existing = inTransaction(() => {
		const ctx = getCardContext(cardId);
		if (!ctx) throw error(404, 'Card not found');

		if (!canEditBoard(caller, ctx.boardId)) {
			throw error(403, 'No edit access to this card\'s board');
		}

		const userId = readId(body, 'userId', { required: true, says: { missing: 'userId is required' } });

		// Verify the user exists
		const user = db.select().from(users).where(eq(users.id, userId)).get();
		if (!user) throw error(404, 'User not found');

		// Check the target user has access to this board
		const targetRole = getBoardRole(user, ctx.boardId);
		if (!targetRole) throw error(400, 'User does not have access to this board');

		// Upsert — skip if already assigned
		const existing = db.select().from(cardAssignees)
			.where(and(eq(cardAssignees.cardId, cardId), eq(cardAssignees.userId, userId)))
			.get();

		if (!existing) {
			db.insert(cardAssignees).values({ cardId, userId }).run();

			// Send assignment notification email (fire-and-forget)
			const baseUrl = linkBaseUrl(url);
			notifyUserAssigned(ctx.boardId, cardId, ctx.cardTitle, user.email, user.username, caller.username, baseUrl);
		}

		emit(ctx.boardId, 'update', { type: 'card' });

		if (!existing) {
			logActivity({
				boardId: ctx.boardId,
				cardId,
				userId: caller.id,
				action: 'api:assignee_added',
				detail: `Assigned ${user.username} to "${ctx.cardTitle}"`,
				userName: caller.username,
				userEmoji: caller.emoji || '👤'
			});
		}

		return !!existing;
	});

	return json({ success: true, message: existing ? 'User already assigned' : 'User assigned' });
};

/**
 * DELETE /api/v1/cards/:cardId/assignees — Remove a user from a card. Body: { userId: number }
 *
 * Removing someone who is not assigned to the card is 404 (decision 9). It
 * was 200, with an activity entry that said they had been removed.
 */
export const DELETE: RequestHandler = async ({ params, request, locals }) => {
	const caller = requireUser(locals.user);
	const cardId = pathId(params.cardId, 'card');
	const body = await readBody(request);

	// One transaction: the card is read and the caller checked in the one that
	// removes the assignee and writes the entry.
	inTransaction(() => {
		const ctx = getCardContext(cardId);
		if (!ctx) throw error(404, 'Card not found');

		if (!canEditBoard(caller, ctx.boardId)) {
			throw error(403, 'No edit access');
		}

		const userId = readId(body, 'userId', { required: true, says: { missing: 'userId is required' } });

		const removed = db.delete(cardAssignees)
			.where(and(eq(cardAssignees.cardId, cardId), eq(cardAssignees.userId, userId)))
			.run();
		if (removed.changes === 0) throw error(404, 'User is not assigned to this card');

		emit(ctx.boardId, 'update', { type: 'card' });

		const removedUser = db.select({ username: users.username }).from(users).where(eq(users.id, userId)).get();
		logActivity({
			boardId: ctx.boardId,
			cardId,
			userId: caller.id,
			action: 'api:assignee_removed',
			detail: `Removed ${removedUser?.username || 'user'} from "${ctx.cardTitle}"`,
			userName: caller.username,
			userEmoji: caller.emoji || '👤'
		});
	});

	return json({ success: true });
};
