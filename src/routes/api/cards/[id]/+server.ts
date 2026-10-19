import { json } from '@sveltejs/kit';
import { requireUser } from '$lib/server/route-guards';
import { removeCard, updateCard } from '$lib/server/cards';
import { linkBaseUrl } from '$lib/server/email';
import { pathId, readBody } from '$lib/server/request-body';
import { writeAs } from '$lib/server/write-as';
import type { RequestHandler } from './$types';

/**
 * PUT /api/cards/:id — change a card, and move it if `columnId` says so.
 *
 * The card is looked for and the caller checked first (404, then 403), then
 * every field is read (400), then what the body names is looked for: the
 * column it moves to (404, 403) and the category (404). A value the card
 * already holds, sent back unchanged, is accepted as it is, whatever the
 * rules say of it (decision 8): the card window sends the stored priority,
 * due date and category back on every save. Card 2117; the fields are read
 * as `PUT /api/v1/cards/:cardId` reads them. `coverUrl` is a colour, one of
 * the preset gradients, or null (`readCover`, card 2010).
 *
 * `recurrenceRule` is not read: nothing acts on a recurrence, and no page
 * sets one, so a request that names it changes nothing (card 2010). The
 * column stays, and every card answer still has it.
 *
 * `completedAt` and `archivedAt` are not read: they record that something
 * happened, so the server stamps them when it happens. A card is archived
 * with DELETE and restored through the restore route.
 *
 * A field sent with the value the card already holds is not a change (card
 * 2183, `card-changes.ts`): the entry names only the fields that changed, and
 * a request that changes nothing writes nothing, records no entry, sends no
 * `card.updated` and no live event, and is answered 200 with the card.
 *
 * The answer is the card with `leftMilestone` beside it: the milestone of the
 * board it left that a move to another board took it out of (card 2155), for
 * All Tasks to tell the mover, and null otherwise (the review's O3).
 *
 * The work is `updateCard` in `$lib/server/cards`, which the v1 update shares
 * (card 2012). This route takes a move (`allowMove`) and answers a body that
 * names nothing 200 with the card, as it always has.
 */
export const PUT: RequestHandler = async ({ params, request, url, locals }) => {
	requireUser(locals.user);
	const id = pathId(params.id, 'card');

	const body = await readBody(request);
	const baseUrl = linkBaseUrl(url);

	// One transaction: the card is read, checked, moved, updated and logged
	// together, and a failure anywhere leaves it as it was. The move used to
	// commit first, with the other fields and their log entry written after
	// it, so a failure between the two left a card moved with its edits lost.
	// The card is read in here and not before the body was awaited: another
	// request could have changed it in between. So is the caller: the session
	// is asked again, and who its account is now (card 2253).
	const updated = writeAs(locals, (caller) => {
		const { card, leftMilestone } = updateCard(caller, { cardId: id }, body, { source: 'ui', baseUrl, allowMove: true });
		return { ...card, leftMilestone };
	});

	return json(updated);
};

export const DELETE: RequestHandler = async ({ params, url, locals }) => {
	const id = pathId(params.id, 'card');
	const permanent = url.searchParams.get('permanent') === 'true';

	// One transaction: the card is read and the caller checked in the same one
	// that archives or deletes it. See $lib/server/deletes.ts for what goes
	// with a permanent delete; an archive touches nothing but the card. It asks
	// first whether the session is still open, and who its account is now
	// (card 2253).
	writeAs(locals, (caller) => removeCard(caller, { cardId: id }, null, { permanent, source: 'ui' }));
	return json({ success: true });
};
