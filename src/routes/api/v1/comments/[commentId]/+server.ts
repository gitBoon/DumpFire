import { error } from '@sveltejs/kit';
import { json } from '$lib/server/v1-json';
import { db } from '$lib/server/db';
import { cardComments, cards, columns, users } from '$lib/server/db/schema';
import { eq } from 'drizzle-orm';
import { getBoardRole } from '$lib/server/board-access';
import { editComment } from '$lib/server/card-comments';
import { pathId, readBody } from '$lib/server/request-body';
import { requireUser } from '$lib/server/route-guards';
import { writeAs } from '$lib/server/write-as';
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
	requireUser(locals.user);
	const commentId = pathId(params.commentId, 'comment');
	const body = await readBody(request);

	// One transaction: the comment is read and the caller checked in the one
	// that changes it and writes the entry, which asks first whether the key or
	// session is still open, and who its account is now (card 2253). Having
	// written a comment is not access to the board it is on: edit access, as
	// for posting one and as the session route asks (view access was asked for
	// here, and an author made a viewer could rewrite through this route what
	// the other refused them). The work is `editComment` in
	// `$lib/server/card-comments`, which the session route shares (card 2012);
	// the author is added to the answer in here, as the account is now.
	const edited = writeAs(locals, (caller) => withAuthor(editComment(caller, { commentId }, body, { source: 'api' })));

	return json(edited);
};
