import { json, error } from '@sveltejs/kit';
import { db } from '$lib/server/db';
import { inTransaction } from '$lib/server/db/transaction';
import { subtasks } from '$lib/server/db/schema';
import { eq } from 'drizzle-orm';
import { emit } from '$lib/server/events';
import { requireCard, requireUser } from '$lib/server/route-guards';
import { logUiActivity, actorOf, ACTIONS } from '$lib/server/logActivity';
import { PRIORITIES } from '$lib/server/card-fields';
import { SUBTASK_ORDER, nextSubtaskPosition } from '$lib/server/subtask-order';
import { readBody, readChoice, readColour, readDate, readId, readQueryId, readText } from '$lib/server/request-body';
import type { RequestHandler } from './$types';

export const GET: RequestHandler = async ({ url, locals }) => {
	if (!locals.user) throw error(401, 'Not authenticated');

	// An id, as an id in the path is read (card 2117): `2.5` and `5abc` were
	// read as another card, or as none.
	const cardId = readQueryId(url.searchParams.get('cardId'), 'card', 'Invalid cardId');
	if (cardId === undefined) return json([]);

	requireCard(locals.user, cardId, 'view');

	const all = db.select().from(subtasks).where(eq(subtasks.cardId, cardId)).orderBy(...SUBTASK_ORDER).all();
	return json(all);
};

/**
 * POST /api/subtasks — add a subtask to a card, after its last one.
 *
 * `cardId` names the row guarded, so it is read first: the card is looked
 * for and the caller checked (404, then 403). Then every field is read (card
 * 2117, R1), as `POST /api/v1/cards/:cardId/subtasks` reads them: `title`
 * text, trimmed, of 1 to 500 characters; `description` at most 50,000;
 * `priority` one of the four; `colorTag` a colour written `#rrggbb` or empty;
 * `dueDate` a date written `YYYY-MM-DD`, or null. A title that was missing
 * gave "New subtask", and every other field was stored as sent.
 */
export const POST: RequestHandler = async ({ request, locals }) => {
	const user = requireUser(locals.user);
	const body = await readBody(request);

	// One transaction: the card is read, the caller checked and the position
	// worked out in the one that creates the subtask and writes its entry.
	const subtask = inTransaction(() => {
		// The board is the parent card's. A `boardId` in the body is ignored.
		const cardId = readId(body, 'cardId', { required: true, says: 'Invalid card ID' });
		const { boardId } = requireCard(user, cardId, 'edit');

		const title = readText(body, 'title', {
			required: true,
			trim: true,
			min: 1,
			max: 500,
			says: { missing: 'title is required', empty: 'title is required', invalid: 'Title too long (max 500 chars)' }
		});
		const description = readText(body, 'description', { max: 50000 });
		const priority = readChoice(body, 'priority', { from: PRIORITIES, anyCase: true });
		const colorTag = readColour(body, 'colorTag', { allowEmpty: true });
		const dueDate = readDate(body, 'dueDate', { nullable: true });

		const subtask = db
			.insert(subtasks)
			.values({
				cardId,
				title,
				description: description ?? '',
				priority: priority ?? 'medium',
				colorTag: colorTag ?? '',
				dueDate: dueDate ?? null,
				position: nextSubtaskPosition(cardId)
			})
			.returning()
			.get();

		logUiActivity({
			boardId,
			cardId,
			action: ACTIONS.subtaskCreated,
			detail: subtask.title,
			...actorOf(user)
		});
		emit(boardId, 'update', { type: 'subtask' });
		return subtask;
	});
	return json(subtask, { status: 201 });
};
