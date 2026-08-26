import { json, error } from '@sveltejs/kit';
import { db } from '$lib/server/db';
import { cardComments, cards, columns, users } from '$lib/server/db/schema';
import { eq, sql } from 'drizzle-orm';
import { getBoardRole } from '$lib/server/board-access';
import { emit } from '$lib/server/events';
import { logActivity } from '$lib/server/logActivity';
import type { RequestHandler } from './$types';

/** Resolve a comment together with the card and board it belongs to. */
function loadComment(commentId: number) {
	const comment = db.select().from(cardComments).where(eq(cardComments.id, commentId)).get();
	if (!comment) return null;
	const card = db.select({ columnId: cards.columnId, title: cards.title }).from(cards).where(eq(cards.id, comment.cardId)).get();
	if (!card) return null;
	const col = db.select({ boardId: columns.boardId }).from(columns).where(eq(columns.id, card.columnId)).get();
	if (!col) return null;
	return { comment, cardTitle: card.title, boardId: col.boardId };
}

/** Shape a comment the same way the list endpoint does (author name + emoji). */
function withAuthor(comment: typeof cardComments.$inferSelect) {
	const author = db.select({ username: users.username, emoji: users.emoji }).from(users).where(eq(users.id, comment.userId)).get();
	return { ...comment, username: author?.username ?? 'Unknown', userEmoji: author?.emoji || '👤' };
}

/** GET /api/v1/comments/:commentId — Fetch a single comment. */
export const GET: RequestHandler = async ({ params, locals }) => {
	if (!locals.user) throw error(401, 'Not authenticated');

	const commentId = Number(params.commentId);
	if (isNaN(commentId)) throw error(400, 'Invalid comment ID');

	const ctx = loadComment(commentId);
	if (!ctx) throw error(404, 'Comment not found');

	if (!getBoardRole(locals.user, ctx.boardId)) throw error(403, 'No access to this board');

	return json(withAuthor(ctx.comment));
};

/**
 * PUT /api/v1/comments/:commentId — Edit a comment's text.
 *
 * Same rule as the web UI: only the comment's author or an admin may edit.
 * Body: { "content": "..." }. The text is stored exactly as sent — an edit
 * replaces the whole comment, so the caller owns any tag prefix.
 */
export const PUT: RequestHandler = async ({ params, request, locals }) => {
	if (!locals.user) throw error(401, 'Not authenticated');

	const commentId = Number(params.commentId);
	if (isNaN(commentId)) throw error(400, 'Invalid comment ID');

	const { content } = await request.json();
	if (typeof content !== 'string' || !content.trim()) throw error(400, 'Comment cannot be empty');
	if (content.length > 50000) throw error(400, 'Comment too long (max 50000 chars)');

	const ctx = loadComment(commentId);
	if (!ctx) throw error(404, 'Comment not found');

	const isAdmin = locals.user.role === 'admin' || locals.user.role === 'superadmin';
	if (ctx.comment.userId !== locals.user.id && !isAdmin) {
		throw error(403, 'You can only edit your own comments');
	}

	const updated = db.update(cardComments)
		.set({ content: content.trim(), updatedAt: sql`(datetime('now'))` })
		.where(eq(cardComments.id, commentId))
		.returning()
		.get();
	if (!updated) throw error(404, 'Comment not found');

	logActivity({
		boardId: ctx.boardId,
		cardId: ctx.comment.cardId,
		userId: locals.user.id,
		action: 'api:comment_edited',
		detail: `Edited a comment on "${ctx.cardTitle}"`,
		userName: locals.user.username,
		userEmoji: locals.user.emoji || '👤'
	});

	emit(ctx.boardId, 'update', { type: 'card' });

	return json(withAuthor(updated));
};
