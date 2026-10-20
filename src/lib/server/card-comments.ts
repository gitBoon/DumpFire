/**
 * card-comments.ts — a card's comments listed, one added, one edited and one
 * deleted: one function for each, which both API trees call (card 2012, part
 * A, slice A2).
 *
 * `/api/cards/:id/comments` (the card window) and its twins under
 * `/api/v1/cards/:cardId/comments` and `/api/v1/comments/:commentId` had the
 * same middle written twice: the guard, the content read, the row, the entry,
 * the mail and the live event. Each tree keeps its path, its body, its single
 * `writeAs`, its answer and, through its options, what it does differently
 * today: its words for a refusal (`says`), the words of its entry and the
 * order it records and mails in (R2 of
 * `docs/planning/card-2012-service-layer-and-pages.md`). The comment delete is
 * the page's alone; it is here so that the module holds every comment write.
 *
 * Each write has the one shape of a service (`ServiceOptions` in
 * `write-as.ts`): `inWrite()` first, then `requireUser(caller)` (401), the
 * guard (404, then 403), then the content read from the body (400). Every
 * entry, event and mail waits for the commit. Refusals are kit `error()`s.
 */
import { error } from '@sveltejs/kit';
import { desc, eq, sql } from 'drizzle-orm';
import { db } from './db';
import { cardComments, users, type Card, type CardComment } from './db/schema';
import type { SessionUser } from './auth';
import { isAdmin } from './board-access';
import { requireCard, requireUser } from './route-guards';
import { emit } from './events';
import { ACTIONS, actorOf, logActivity } from './logActivity';
import { notifyCommentAdded, notifyRequesterProgress } from './notifications';
import { processMentions } from './mentions';
import { readText, type RequestBody } from './request-body';
import { inWrite, type ServiceOptions } from './write-as';

/** The functions here that only read. Every other export is a write, and starts with `inWrite()`. */
export const READS: readonly string[] = ['listComments'];

/**
 * The live update a change to a card's comments sends its board (card 2282):
 * the card named, so that a card window open on it re-reads its comments
 * and no other window does (`commentsChanged` in `$lib/board/sse`). Every
 * page re-reads on any update that is not `access`, as for any other. The
 * "Unblocked" notice sends the same (`announceUnblocked` in `planning.ts`).
 */
function commentEvent(cardId: number): { type: 'comment'; cardId: number } {
	return { type: 'comment', cardId };
}

/**
 * A card's comments, newest first, each with its author's name and emoji
 * (`GET /api/cards/:id/comments`, `GET /api/v1/cards/:cardId/comments`). The
 * card is looked for and the caller asked for view access (404, then 403, in
 * the tree's words, `says`).
 *
 * `created_at` is to the second, so comments made in the same second (a
 * request's discussion copied on accept, an agent posting several in a row)
 * are put the later first by id, as the activity report puts them (card
 * 2301). An author with no emoji is listed with the placeholder the add and
 * v1's single read answer, as the `Comment` schema's required string says
 * (card 2302).
 */
export function listComments(user: SessionUser | null | undefined, at: { cardId: number }, opts: { says?: string }) {
	requireCard(user, at.cardId, 'view', opts.says);

	const rows = db
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
		.where(eq(cardComments.cardId, at.cardId))
		.orderBy(desc(cardComments.createdAt), desc(cardComments.id))
		.all();
	return rows.map((row) => ({ ...row, userEmoji: row.userEmoji || '👤' }));
}

/** What each tree's new comment does differently today (R2). */
export type AddCommentOptions = {
	/** The entry says `Commented on "<card>"` (v1); the page's route says `on "<card>"`. */
	commentedOn?: boolean;
	/** The mail is queued before the entry, and so before its `comment.added` webhook (v1); the page's route writes the entry first. */
	mailBeforeEntry?: boolean;
};

/**
 * Add a comment to a card (`POST /api/cards/:id/comments`, `POST
 * /api/v1/cards/:cardId/comments`).
 *
 * The card is looked for and the caller checked (404, then 403) before the
 * content is read (400): text of 1 to 50,000 characters once trimmed, as an
 * edit is (card 2117, R1). Then the comment, its entry, the mail to the
 * board's members and to anyone it mentions, and the mail to whoever asked
 * for the card, and last the live event `{ type: 'comment', cardId }` to the
 * card's board, in both trees, so that a card window open on the card
 * re-reads its comments (card 2282). It sent none.
 *
 * The answer is the comment with its author's name and emoji, as they are now.
 */
export function addComment(
	caller: SessionUser | null,
	at: { cardId: number },
	body: RequestBody,
	opts: ServiceOptions & AddCommentOptions
): CardComment & { username: string; userEmoji: string } {
	inWrite();
	const user = requireUser(caller);
	const { cardId } = at;
	const { card, boardId } = requireCard(user, cardId, 'edit', opts.says);

	const content = readText(body, 'content', {
		required: true,
		trim: true,
		min: 1,
		max: 50000,
		says: { missing: 'Comment cannot be empty', empty: 'Comment cannot be empty' }
	});

	const comment = db.insert(cardComments).values({ cardId, userId: user.id, content }).returning().get();

	const record = () =>
		logActivity({
			boardId,
			cardId,
			action: ACTIONS.commentAdded,
			detail: opts.commentedOn ? `Commented on "${card.title}"` : `on "${card.title}"`,
			source: opts.source,
			...actorOf(user)
		});
	if (!opts.mailBeforeEntry) record();

	// The board's members, anyone mentioned, and whoever asked for the card,
	// each once the comment is committed.
	const baseUrl = opts.baseUrl ?? null;
	notifyCommentAdded(boardId, cardId, card.title, user.username, content, user.id, baseUrl);
	processMentions(content, user.id, user.username, cardId, card.title, boardId, baseUrl);
	notifyRequesterProgress({
		cardId,
		action: 'comment',
		summary: content,
		actorName: user.username,
		baseUrl,
		actorUserId: user.id
	});

	if (opts.mailBeforeEntry) record();

	emit(boardId, 'update', commentEvent(cardId));

	return { ...comment, username: user.username, userEmoji: user.emoji || '👤' };
}

/**
 * The comment, if it is on a board the caller can still edit and theirs to
 * change (or the caller is an administrator), with its card and that card's
 * board. Authorship alone used to be enough, so someone removed from a board
 * could go on changing what they had written there. With `cardId`, the
 * page's routes, the comment must be on that card (404 otherwise).
 */
function requireOwnComment(
	user: SessionUser,
	commentId: number,
	cardId: number | undefined,
	verb: string
): { comment: CardComment; card: Card; boardId: number } {
	const comment = db.select().from(cardComments).where(eq(cardComments.id, commentId)).get();
	if (!comment || (cardId !== undefined && comment.cardId !== cardId)) throw error(404, 'Comment not found');

	const { card, boardId } = requireCard(user, comment.cardId, 'edit');

	if (comment.userId !== user.id && !isAdmin(user)) {
		throw error(403, `You can only ${verb} your own comments`);
	}
	return { comment, card, boardId };
}

/**
 * Edit a comment's text (`PUT /api/cards/:id/comments/:commentId` with
 * `at.cardId`, `PUT /api/v1/comments/:commentId` without). Its author or an
 * administrator, and the author only while they can edit the board it is on:
 * what posting one asks for. The text is read after the comment is looked for
 * and the caller checked, as a new one's is, and stored trimmed; the text it
 * holds, sent back, is accepted as it is.
 *
 * Text that is the comment's own once both are trimmed changes nothing: no
 * write, no new `updatedAt` (which the window shows as "(edited)"), no entry
 * and no live event, and the comment is answered as it is stored, its outer
 * spaces kept (card 2284; card 2183's rule for cards). The guard is asked
 * first, so a caller who may not edit it is refused whatever they send.
 *
 * The answer is the row as written; v1 adds the author (its handler).
 */
export function editComment(
	caller: SessionUser | null,
	at: { commentId: number; cardId?: number },
	body: RequestBody,
	opts: ServiceOptions
): CardComment {
	inWrite();
	const user = requireUser(caller);
	const { comment, card, boardId } = requireOwnComment(user, at.commentId, at.cardId, 'edit');

	const content = readText(body, 'content', {
		required: true,
		trim: true,
		min: 1,
		max: 50000,
		keep: comment.content,
		says: { missing: 'Comment cannot be empty', empty: 'Comment cannot be empty' }
	});
	if (content.trim() === comment.content.trim()) return comment;

	const row = db
		.update(cardComments)
		.set({ content, updatedAt: sql`(datetime('now'))` })
		.where(eq(cardComments.id, at.commentId))
		.returning()
		.get();
	if (!row) throw error(404, 'Comment not found');

	logActivity({
		boardId,
		cardId: comment.cardId,
		action: ACTIONS.commentEdited,
		detail: `Edited a comment on "${card.title}"`,
		source: opts.source,
		...actorOf(user)
	});

	emit(boardId, 'update', commentEvent(comment.cardId));

	return row;
}

/**
 * Delete a comment (`DELETE /api/cards/:id/comments/:commentId`; v1 has no
 * comment delete). Its author's or an administrator's, on a board the caller
 * can still edit, and on the card in the path. Nothing is recorded and nobody
 * told (found nearby F2, its own card). There is no body.
 */
export function deleteComment(
	caller: SessionUser | null,
	at: { cardId: number; commentId: number },
	body: null,
	opts: ServiceOptions
): void {
	inWrite();
	const user = requireUser(caller);
	requireOwnComment(user, at.commentId, at.cardId, 'delete');
	db.delete(cardComments).where(eq(cardComments.id, at.commentId)).run();
}
