import { json, error } from '@sveltejs/kit';
import { db } from '$lib/server/db';
import { inTransaction } from '$lib/server/db/transaction';
import { cardComments, cards, columns, users } from '$lib/server/db/schema';
import { eq, sql } from 'drizzle-orm';
import { canEditBoard, getBoardRole } from '$lib/server/board-access';
import { emit } from '$lib/server/events';
import { logActivity } from '$lib/server/logActivity';
import { pathId, readBody, readText } from '$lib/server/request-body';
import { requireUser } from '$lib/server/route-guards';
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

	const commentId = pathId(params.commentId, 'comment');

	const ctx = loadComment(commentId);
	if (!ctx) throw error(404, 'Comment not found');

	if (!getBoardRole(locals.user, ctx.boardId)) throw error(403, 'No access to this board');

	return json(withAuthor(ctx.comment));
};

/**
 * PUT /api/v1/comments/:commentId — Edit a comment's text.
 *
 * Only the comment's author or an admin may edit, and the author only while
 * they can still edit the board the comment is on: what posting a comment
 * asks for, and what PUT /api/cards/[id]/comments/[commentId] asks for.
 * Body: { "content": "..." }. The text is stored trimmed — an edit replaces
 * the whole comment, so the caller owns any tag prefix. It is text of 1 to
 * 50,000 characters once trimmed, read after the comment is looked for and
 * the caller checked, as the session route reads it.
 */
export const PUT: RequestHandler = async ({ params, request, locals }) => {
	const user = requireUser(locals.user);
	const commentId = pathId(params.commentId, 'comment');
	const body = await readBody(request);

	// One transaction: the comment is read and the caller checked in the one
	// that changes it and writes the entry.
	const edited = inTransaction(() => {
		const ctx = loadComment(commentId);
		if (!ctx) throw error(404, 'Comment not found');

		// Having written a comment is not access to the board it is on. Someone
		// taken off a board could go on rewriting what they had written there.
		// Edit access, as for posting one and as the session route asks: view
		// access was asked for here, and an author made a viewer could rewrite
		// through this route what the other refused them, and could post nothing.
		if (!canEditBoard(user, ctx.boardId)) throw error(403, 'No edit access to this board');

		const isAdmin = user.role === 'admin' || user.role === 'superadmin';
		if (ctx.comment.userId !== user.id && !isAdmin) {
			throw error(403, 'You can only edit your own comments');
		}

		const content = readText(body, 'content', {
			required: true,
			trim: true,
			min: 1,
			max: 50000,
			keep: ctx.comment.content,
			says: { missing: 'Comment cannot be empty', empty: 'Comment cannot be empty', invalid: 'Comment too long (max 50000 chars)' }
		});

		const updated = db.update(cardComments)
			.set({ content, updatedAt: sql`(datetime('now'))` })
			.where(eq(cardComments.id, commentId))
			.returning()
			.get();
		if (!updated) throw error(404, 'Comment not found');

		logActivity({
			boardId: ctx.boardId,
			cardId: ctx.comment.cardId,
			userId: user.id,
			action: 'api:comment_edited',
			detail: `Edited a comment on "${ctx.cardTitle}"`,
			userName: user.username,
			userEmoji: user.emoji || '👤'
		});

		emit(ctx.boardId, 'update', { type: 'card' });

		return withAuthor(updated);
	});

	return json(edited);
};
