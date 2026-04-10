import { json, error } from '@sveltejs/kit';
import { db } from '$lib/server/db';
import { cards, columns, cardAssignees, users } from '$lib/server/db/schema';
import { eq, and } from 'drizzle-orm';
import { canEditBoard, getBoardRole } from '$lib/server/board-access';
import { emit } from '$lib/server/events';
import { notifyUserAssigned } from '$lib/server/notifications';
import { resolveBaseUrl } from '$lib/server/email';
import { logActivity } from '$lib/server/logActivity';
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

	const cardId = Number(params.cardId);
	if (isNaN(cardId)) throw error(400, 'Invalid card ID');

	const ctx = getCardContext(cardId);
	if (!ctx) throw error(404, 'Card not found');

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
	if (!locals.user) throw error(401, 'Not authenticated');

	const cardId = Number(params.cardId);
	if (isNaN(cardId)) throw error(400, 'Invalid card ID');

	const ctx = getCardContext(cardId);
	if (!ctx) throw error(404, 'Card not found');

	if (!canEditBoard(locals.user, ctx.boardId)) {
		throw error(403, 'No edit access to this card\'s board');
	}

	const { userId } = await request.json();
	if (!userId) throw error(400, 'userId is required');

	// Verify the user exists
	const user = db.select().from(users).where(eq(users.id, userId)).get();
	if (!user) throw error(404, 'User not found');

	// Check the target user has access to this board
	const targetRole = getBoardRole(
		{ id: user.id, username: user.username, email: user.email, emoji: user.emoji || '👤', role: user.role },
		ctx.boardId
	);
	if (!targetRole) throw error(400, 'User does not have access to this board');

	// Upsert — skip if already assigned
	const existing = db.select().from(cardAssignees)
		.where(and(eq(cardAssignees.cardId, cardId), eq(cardAssignees.userId, userId)))
		.get();

	if (!existing) {
		db.insert(cardAssignees).values({ cardId, userId }).run();

		// Send assignment notification email (fire-and-forget)
		const baseUrl = resolveBaseUrl(request, url);
		notifyUserAssigned(ctx.boardId, cardId, ctx.cardTitle, user.email, user.username, locals.user.username, baseUrl);
	}

	emit(ctx.boardId, 'update', { type: 'card' });

	if (!existing) {
		logActivity({
			boardId: ctx.boardId,
			cardId,
			userId: locals.user.id,
			action: 'api:assignee_added',
			detail: `Assigned ${user.username} to "${ctx.cardTitle}"`,
			userName: locals.user.username,
			userEmoji: locals.user.emoji || '👤'
		});
	}

	return json({ success: true, message: existing ? 'User already assigned' : 'User assigned' });
};

/** DELETE /api/v1/cards/:cardId/assignees — Remove a user from a card. Body: { userId: number } */
export const DELETE: RequestHandler = async ({ params, request, locals }) => {
	if (!locals.user) throw error(401, 'Not authenticated');

	const cardId = Number(params.cardId);
	if (isNaN(cardId)) throw error(400, 'Invalid card ID');

	const ctx = getCardContext(cardId);
	if (!ctx) throw error(404, 'Card not found');

	if (!canEditBoard(locals.user, ctx.boardId)) {
		throw error(403, 'No edit access');
	}

	const { userId } = await request.json();
	if (!userId) throw error(400, 'userId is required');

	db.delete(cardAssignees)
		.where(and(eq(cardAssignees.cardId, cardId), eq(cardAssignees.userId, userId)))
		.run();

	emit(ctx.boardId, 'update', { type: 'card' });

	const removedUser = db.select({ username: users.username }).from(users).where(eq(users.id, userId)).get();
	logActivity({
		boardId: ctx.boardId,
		cardId,
		userId: locals.user.id,
		action: 'api:assignee_removed',
		detail: `Removed ${removedUser?.username || 'user'} from "${ctx.cardTitle}"`,
		userName: locals.user.username,
		userEmoji: locals.user.emoji || '👤'
	});

	return json({ success: true });
};
