import { json } from '@sveltejs/kit';
import { deleteComment, editComment } from '$lib/server/card-comments';
import { pathId, readBody } from '$lib/server/request-body';
import { requireUser } from '$lib/server/route-guards';
import { writeAs } from '$lib/server/write-as';
import type { RequestHandler } from './$types';

/**
 * PUT — Edit own comment, on this card (404 otherwise), on a board the caller
 * can still edit: authorship alone used to be enough, so someone removed from
 * a board could go on editing what they had written there.
 *
 * The work is `editComment` in `$lib/server/card-comments`, which
 * `PUT /api/v1/comments/{id}` shares (card 2012); this route names the card
 * the comment must be on, and answers the row as written.
 */
export const PUT: RequestHandler = async ({ params, request, locals }) => {
	requireUser(locals.user);
	const cardId = pathId(params.id, 'card');
	const commentId = pathId(params.commentId, 'comment');
	const body = await readBody(request);

	// The comment, its card's board and its author are read in the transaction
	// that changes it, once the body has arrived: someone taken off the board
	// while the body was arriving is refused, and so is a session ended then
	// (card 2253). The `comment_edited` entry and the board's live update are
	// the ones `PUT /api/v1/comments/{id}` writes and sends (card 2143): an
	// edit made on screen had neither.
	const updated = writeAs(locals, (caller) => editComment(caller, { commentId, cardId }, body, { source: 'ui' }));

	return json(updated);
};

/** DELETE — Delete own comment (or admin), on this card. The work is `deleteComment` (card 2012). */
export const DELETE: RequestHandler = async ({ params, locals }) => {
	const cardId = pathId(params.id, 'card');
	const commentId = pathId(params.commentId, 'comment');

	// The comment read, the caller checked and the comment deleted in one
	// transaction that asks first whether the session is still open, and who
	// its account is now (card 2253). The check and the delete were two steps
	// with no transaction around them.
	writeAs(locals, (caller) => deleteComment(caller, { cardId, commentId }, null, { source: 'ui' }));
	return json({ success: true });
};
