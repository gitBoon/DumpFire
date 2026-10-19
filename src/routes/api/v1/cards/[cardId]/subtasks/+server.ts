import { error } from '@sveltejs/kit';
import { json } from '$lib/server/v1-json';
import { createSubtask, listSubtasks } from '$lib/server/subtasks';
import { pathId, readBody } from '$lib/server/request-body';
import { requireUser } from '$lib/server/route-guards';
import { writeAs } from '$lib/server/write-as';
import type { RequestHandler } from './$types';

/**
 * GET /api/v1/cards/:cardId/subtasks — List all subtasks for a card, by
 * position and then id. The work is `listSubtasks` in `$lib/server/subtasks`,
 * which the internal list shares (card 2012).
 */
export const GET: RequestHandler = async ({ params, locals }) => {
	if (!locals.user) throw error(401, 'Not authenticated');

	const cardId = pathId(params.cardId, 'card');
	return json(listSubtasks(locals.user, { cardId }, { says: "No access to this card's board" }));
};

/**
 * POST /api/v1/cards/:cardId/subtasks — Create a new subtask on a card.
 * With no `position` it goes after the card's last one (card 2223): it was
 * 0, so a card filled by a script had every subtask at 0.
 *
 * The card is looked for and the caller checked (404, then 403) before any
 * field is read (400). The work is `createSubtask` in `$lib/server/subtasks`,
 * which the internal route shares (card 2012). This route takes `position`,
 * names the card in its entry, and sends `card` as its live event's type,
 * before the entry.
 */
export const POST: RequestHandler = async ({ params, request, locals }) => {
	requireUser(locals.user);
	const cardId = pathId(params.cardId, 'card');
	const body = await readBody(request);

	// One transaction: the card is read and the caller checked in the one that
	// creates the subtask and writes its entry, which asks first whether the
	// key or session is still open, and who its account is now (card 2253).
	const subtask = writeAs(locals, (caller) =>
		createSubtask(caller, { cardId }, body, {
			source: 'api',
			says: "No edit access to this card's board",
			allowPosition: true,
			namesCard: true,
			tellBeforeEntry: true,
			eventType: 'card'
		})
	);

	return json(subtask, { status: 201 });
};
