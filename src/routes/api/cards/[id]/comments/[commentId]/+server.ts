import { json, error } from '@sveltejs/kit';
import { db } from '$lib/server/db';
import { cardComments, type Card, type CardComment } from '$lib/server/db/schema';
import { eq, sql } from 'drizzle-orm';
import { isAdmin } from '$lib/server/board-access';
import { inTransaction } from '$lib/server/db/transaction';
import { emit } from '$lib/server/events';
import { ACTIONS, actorOf, logUiActivity } from '$lib/server/logActivity';
import { pathId, readBody, readText } from '$lib/server/request-body';
import { requireCard, requireUser } from '$lib/server/route-guards';
import type { SessionUser } from '$lib/server/auth';
import type { RequestHandler } from './$types';

/**
 * The comment, if it is on this card, on a board the caller can still edit,
 * and theirs to change.
 *
 * Authorship alone used to be enough, so someone removed from a board could go
 * on editing what they had written there. Commenting needs edit access to the
 * board, and so does changing a comment.
 *
 * With it, the card and the board it is on, which an edit's entry names.
 */
function requireOwnComment(
	user: SessionUser | null,
	cardId: number,
	commentId: number,
	verb: string
): { comment: CardComment; card: Card; boardId: number } {
	const caller = requireUser(user);

	const comment = db.select().from(cardComments).where(eq(cardComments.id, commentId)).get();
	if (!comment || comment.cardId !== cardId) throw error(404, 'Comment not found');

	const { card, boardId } = requireCard(caller, comment.cardId, 'edit');

	if (comment.userId !== caller.id && !isAdmin(caller)) {
		throw error(403, `You can only ${verb} your own comments`);
	}
	return { comment, card, boardId };
}

/** PUT — Edit own comment. */
export const PUT: RequestHandler = async ({ params, request, locals }) => {
	const user = requireUser(locals.user);
	const cardId = pathId(params.id, 'card');
	const commentId = pathId(params.commentId, 'comment');
	const body = await readBody(request);

	// The comment, its card's board and its author are read in the transaction
	// that changes it, once the body has arrived: someone taken off the board
	// while the body was arriving is refused. The `comment_edited` entry and
	// the board's live update are the ones `PUT /api/v1/comments/{id}` writes
	// and sends (card 2143): an edit made on screen had neither.
	const updated = inTransaction(() => {
		const { comment, card, boardId } = requireOwnComment(user, cardId, commentId, 'edit');

		const content = readText(body, 'content', {
			required: true,
			trim: true,
			min: 1,
			max: 50000,
			keep: comment.content,
			says: { missing: 'Comment cannot be empty', empty: 'Comment cannot be empty' }
		});

		const row = db
			.update(cardComments)
			.set({ content, updatedAt: sql`(datetime('now'))` })
			.where(eq(cardComments.id, commentId))
			.returning()
			.get();

		logUiActivity({
			boardId,
			cardId: comment.cardId,
			action: ACTIONS.commentEdited,
			detail: `Edited a comment on "${card.title}"`,
			...actorOf(user)
		});

		emit(boardId, 'update', { type: 'card' });

		return row;
	});

	return json(updated);
};

/** DELETE — Delete own comment (or admin). */
export const DELETE: RequestHandler = async ({ params, locals }) => {
	const cardId = pathId(params.id, 'card');
	const commentId = pathId(params.commentId, 'comment');
	requireOwnComment(locals.user, cardId, commentId, 'delete');

	db.delete(cardComments).where(eq(cardComments.id, commentId)).run();
	return json({ success: true });
};
