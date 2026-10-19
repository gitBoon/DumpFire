import { json, error } from '@sveltejs/kit';
import { addComment, listComments } from '$lib/server/card-comments';
import { linkBaseUrl } from '$lib/server/email';
import { pathId, readBody } from '$lib/server/request-body';
import { requireUser } from '$lib/server/route-guards';
import { writeAs } from '$lib/server/write-as';
import type { RequestHandler } from './$types';

/**
 * GET — List all comments for a card (newest first). The work is
 * `listComments` in `$lib/server/card-comments`, which the v1 list shares
 * (card 2012); this route keeps its words for a caller who cannot open the
 * card's board.
 */
export const GET: RequestHandler = async ({ params, locals }) => {
	if (!locals.user) throw error(401, 'Not authenticated');

	const cardId = pathId(params.id, 'card');
	return json(listComments(locals.user, { cardId }, { says: 'No access' }));
};

/**
 * POST — Add a comment to a card.
 *
 * The card is looked for and the caller checked (404, then 403) before the
 * content is read (400), in the transaction that writes the comment (card
 * 2117, R1). The content was read first, so a caller who could not open the
 * card was told 400 for an empty comment, where they are refused.
 *
 * The work is `addComment` in `$lib/server/card-comments`, which the v1
 * route shares (card 2012). This route keeps its words for a caller who may
 * not edit, its entry's words (`on "<card>"`) and its order: the entry, then
 * the mail.
 */
export const POST: RequestHandler = async ({ params, request, locals, url }) => {
	requireUser(locals.user);

	const cardId = pathId(params.id, 'card');
	const body = await readBody(request);
	const baseUrl = linkBaseUrl(url);

	// One transaction: the card is read and the caller checked in the one that
	// writes the comment and its entry. The mail is worked out in there and
	// sent once it is committed. It asks first whether the session is still
	// open, and who its account is now (card 2253): the answer names the
	// author as they are then.
	const answer = writeAs(locals, (caller) => addComment(caller, { cardId }, body, { source: 'ui', baseUrl, says: 'No edit access' }));

	return json(answer, { status: 201 });
};
