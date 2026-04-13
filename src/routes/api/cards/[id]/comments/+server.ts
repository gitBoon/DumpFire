import { json, error } from '@sveltejs/kit';
import { db } from '$lib/server/db';
import { cardComments, cards, columns, users } from '$lib/server/db/schema';
import { eq, desc } from 'drizzle-orm';
import { getBoardRole } from '$lib/server/board-access';
import { notifyCommentAdded, notifyRequesterProgress } from '$lib/server/notifications';
import { resolveBaseUrl } from '$lib/server/email';
import { processMentions } from '$lib/server/mentions';
import type { RequestHandler } from './$types';

/** GET — List all comments for a card (newest first). */
export const GET: RequestHandler = async ({ params, locals }) => {
	if (!locals.user) throw error(401, 'Not authenticated');

	const cardId = Number(params.id);
	const card = db.select({ columnId: cards.columnId }).from(cards).where(eq(cards.id, cardId)).get();
	if (!card) throw error(404, 'Card not found');

	const col = db.select({ boardId: columns.boardId }).from(columns).where(eq(columns.id, card.columnId)).get();
	if (!col) throw error(404);

	const role = getBoardRole(locals.user, col.boardId);
	if (!role) throw error(403, 'No access');

	const comments = db
		.select({
			id: cardComments.id,
			cardId: cardComments.cardId,
			userId: cardComments.userId,
			content: cardComments.content,
			createdAt: cardComments.createdAt,
			updatedAt: cardComments.updatedAt,
			username: users.username,
			userEmoji: users.emoji
		})
		.from(cardComments)
		.innerJoin(users, eq(cardComments.userId, users.id))
		.where(eq(cardComments.cardId, cardId))
		.orderBy(desc(cardComments.createdAt))
		.all();

	return json(comments);
};

/** POST — Add a comment to a card. */
export const POST: RequestHandler = async ({ params, request, locals, url }) => {
	if (!locals.user) throw error(401, 'Not authenticated');

	const cardId = Number(params.id);
	const { content } = await request.json();
	if (!content?.trim()) throw error(400, 'Comment cannot be empty');

	const card = db.select({ columnId: cards.columnId, title: cards.title }).from(cards).where(eq(cards.id, cardId)).get();
	if (!card) throw error(404, 'Card not found');

	const col = db.select({ boardId: columns.boardId }).from(columns).where(eq(columns.id, card.columnId)).get();
	if (!col) throw error(404);

	const role = getBoardRole(locals.user, col.boardId);
	if (!role || role === 'viewer') throw error(403, 'No edit access');

	const comment = db
		.insert(cardComments)
		.values({ cardId, userId: locals.user.id, content: content.trim() })
		.returning()
		.get();

	// Notify all board members (fire-and-forget)
	const baseUrl = resolveBaseUrl(request, url);
	notifyCommentAdded(col.boardId, cardId, card.title, locals.user.username, content.trim(), locals.user.id, baseUrl);
	processMentions(content.trim(), locals.user.id, locals.user.username, cardId, card.title, col.boardId, baseUrl);

	// Notify the original requester about this comment
	notifyRequesterProgress({
		cardId,
		action: 'comment',
		summary: content.trim(),
		actorName: locals.user.username,
		baseUrl,
		actorUserId: locals.user.id
	});

	// Return with user info
	return json({
		...comment,
		username: locals.user.username,
		userEmoji: locals.user.emoji || '👤'
	}, { status: 201 });
};
