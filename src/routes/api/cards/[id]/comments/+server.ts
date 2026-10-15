import { json, error } from '@sveltejs/kit';
import { db } from '$lib/server/db';
import { inTransaction } from '$lib/server/db/transaction';
import { cardComments, cards, columns, users } from '$lib/server/db/schema';
import { eq, desc } from 'drizzle-orm';
import { getBoardRole } from '$lib/server/board-access';
import { notifyCommentAdded, notifyRequesterProgress } from '$lib/server/notifications';
import { linkBaseUrl } from '$lib/server/email';
import { processMentions } from '$lib/server/mentions';
import { pathId, readBody, readText } from '$lib/server/request-body';
import { logUiActivity, actorOf, ACTIONS } from '$lib/server/logActivity';
import type { RequestHandler } from './$types';

/** GET — List all comments for a card (newest first). */
export const GET: RequestHandler = async ({ params, locals }) => {
	if (!locals.user) throw error(401, 'Not authenticated');

	const cardId = pathId(params.id, 'card');
	const card = db.select({ columnId: cards.columnId }).from(cards).where(eq(cards.id, cardId)).get();
	if (!card) throw error(404, 'Card not found');

	const col = db.select({ boardId: columns.boardId }).from(columns).where(eq(columns.id, card.columnId)).get();
	if (!col) throw error(404, 'Column not found');

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

/**
 * POST — Add a comment to a card.
 *
 * The card is looked for and the caller checked (404, then 403) before the
 * content is read (400), in the transaction that writes the comment (card
 * 2117, R1). The content was read first, so a caller who could not open the
 * card was told 400 for an empty comment, where they are refused.
 */
export const POST: RequestHandler = async ({ params, request, locals, url }) => {
	if (!locals.user) throw error(401, 'Not authenticated');
	const user = locals.user;

	const cardId = pathId(params.id, 'card');
	const body = await readBody(request);

	// One transaction: the card is read and the caller checked in the one that
	// writes the comment and its entry. The mail below is worked out in here
	// and sent once it is committed.
	const comment = inTransaction(() => {
		const card = db.select({ columnId: cards.columnId, title: cards.title }).from(cards).where(eq(cards.id, cardId)).get();
		if (!card) throw error(404, 'Card not found');

		const col = db.select({ boardId: columns.boardId }).from(columns).where(eq(columns.id, card.columnId)).get();
		if (!col) throw error(404, 'Column not found');

		const role = getBoardRole(user, col.boardId);
		if (!role || role === 'viewer') throw error(403, 'No edit access');

		// Text of 1 to 50,000 characters once trimmed, as an edit is. A new comment
		// had no limit, and one that was not text was a 500.
		const content = readText(body, 'content', {
			required: true,
			trim: true,
			min: 1,
			max: 50000,
			says: { missing: 'Comment cannot be empty', empty: 'Comment cannot be empty' }
		});

		const comment = db
			.insert(cardComments)
			.values({ cardId, userId: user.id, content })
			.returning()
			.get();

		logUiActivity({
			boardId: col.boardId,
			cardId,
			action: ACTIONS.commentAdded,
			detail: `on "${card.title}"`,
			...actorOf(user)
		});

		// Notify all board members (fire-and-forget)
		const baseUrl = linkBaseUrl(url);
		notifyCommentAdded(col.boardId, cardId, card.title, user.username, content, user.id, baseUrl);
		processMentions(content, user.id, user.username, cardId, card.title, col.boardId, baseUrl);

		// Notify the original requester about this comment
		notifyRequesterProgress({
			cardId,
			action: 'comment',
			summary: content,
			actorName: user.username,
			baseUrl,
			actorUserId: user.id
		});

		return comment;
	});

	// Return with user info
	return json({
		...comment,
		username: user.username,
		userEmoji: user.emoji || '👤'
	}, { status: 201 });
};
