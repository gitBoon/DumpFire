import { error } from '@sveltejs/kit';
import { json } from '$lib/server/v1-json';
import { addComment, listComments } from '$lib/server/card-comments';
import { linkBaseUrl } from '$lib/server/email';
import { pathId, readBody } from '$lib/server/request-body';
import { requireUser } from '$lib/server/route-guards';
import { writeAs } from '$lib/server/write-as';
import type { RequestHandler } from './$types';

/**
 * GET /api/v1/cards/:cardId/comments — List all comments on a card (newest
 * first). The work is `listComments` in `$lib/server/card-comments`, which
 * the internal list shares (card 2012).
 */
export const GET: RequestHandler = async ({ params, locals }) => {
	if (!locals.user) throw error(401, 'Not authenticated');

	const cardId = pathId(params.cardId, 'card');
	return json(listComments(locals.user, { cardId }, { says: 'No access to this board' }));
};

/**
 * POST /api/v1/cards/:cardId/comments — Add a comment to a card.
 *
 * The card is looked for and the caller checked (404, then 403) before the
 * content is read (400), in the transaction that writes the comment (card
 * 2117, R1). The content was read first, so a key whose user could not open
 * the card was told 400 for an empty comment, where it is refused.
 *
 * The work is `addComment` in `$lib/server/card-comments`, which the
 * internal route shares (card 2012). This route keeps its entry's words
 * (`Commented on "<card>"`) and its order: the mail, then the entry.
 */
export const POST: RequestHandler = async ({ params, request, locals, url }) => {
	requireUser(locals.user);

	const cardId = pathId(params.cardId, 'card');
	const body = await readBody(request);
	const baseUrl = linkBaseUrl(url);

	// One transaction: the card is read and the caller checked in the one that
	// writes the comment and its entry. The mail is worked out in there and
	// sent once it is committed. It asks first whether the key or session is
	// still open, and who its account is now (card 2253); the answer names the
	// commenter as they are now, so it is made in there too.
	const comment = writeAs(locals, (caller) =>
		addComment(caller, { cardId }, body, { source: 'api', baseUrl, says: 'No edit access', commentedOn: true, mailBeforeEntry: true })
	);

	return json(comment, { status: 201 });
};
