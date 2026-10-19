import { error } from '@sveltejs/kit';
import { json } from '$lib/server/v1-json';
import { db } from '$lib/server/db';
import { inTransaction } from '$lib/server/db/transaction';
import { cards, columns, subtasks } from '$lib/server/db/schema';
import { eq } from 'drizzle-orm';
import { canViewBoard, canEditBoard } from '$lib/server/board-access';
import { emit } from '$lib/server/events';
import { logActivity } from '$lib/server/logActivity';
import { PRIORITIES } from '$lib/server/card-fields';
import { SUBTASK_ORDER, nextSubtaskPosition } from '$lib/server/subtask-order';
import { pathId, readBody, readChoice, readColour, readDate, readNumber, readText } from '$lib/server/request-body';
import { requireUser } from '$lib/server/route-guards';
import type { RequestHandler } from './$types';

/** Resolve the board that a card belongs to. */
function getCardBoardId(cardId: number): number | null {
	const card = db.select({ columnId: cards.columnId }).from(cards).where(eq(cards.id, cardId)).get();
	if (!card) return null;
	const col = db.select({ boardId: columns.boardId }).from(columns).where(eq(columns.id, card.columnId)).get();
	return col?.boardId ?? null;
}

/** GET /api/v1/cards/:cardId/subtasks — List all subtasks for a card, by position and then id. */
export const GET: RequestHandler = async ({ params, locals }) => {
	if (!locals.user) throw error(401, 'Not authenticated');

	const cardId = pathId(params.cardId, 'card');

	const boardId = getCardBoardId(cardId);
	if (!boardId) throw error(404, 'Card not found');

	if (!canViewBoard(locals.user, boardId)) {
		throw error(403, 'No access to this card\'s board');
	}

	const cardSubtasks = db.select()
		.from(subtasks)
		.where(eq(subtasks.cardId, cardId))
		.orderBy(...SUBTASK_ORDER)
		.all();

	return json(cardSubtasks);
};

/**
 * POST /api/v1/cards/:cardId/subtasks — Create a new subtask on a card.
 * With no `position` it goes after the card's last one (card 2223).
 *
 * The card is looked for and the caller checked (404, then 403) before any
 * field is read (400).
 */
export const POST: RequestHandler = async ({ params, request, locals }) => {
	const user = requireUser(locals.user);
	const cardId = pathId(params.cardId, 'card');
	const body = await readBody(request);

	// One transaction: the card is read and the caller checked in the one that
	// creates the subtask and writes its entry.
	const subtask = inTransaction(() => {
		const boardId = getCardBoardId(cardId);
		if (!boardId) throw error(404, 'Card not found');

		if (!canEditBoard(user, boardId)) {
			throw error(403, 'No edit access to this card\'s board');
		}

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
		const position = readNumber(body, 'position', {});

		const subtask = db.insert(subtasks)
			.values({
				cardId,
				title,
				description: description ?? '',
				priority: priority ?? 'medium',
				colorTag: colorTag ?? '',
				dueDate: dueDate ?? null,
				// Not sent: after the card's last one, as the web application
				// places it (card 2223). It was 0, so a card filled by a script
				// had every subtask at 0.
				position: position ?? nextSubtaskPosition(cardId)
			})
			.returning()
			.get();

		emit(boardId, 'update', { type: 'card' });

		const card = db.select({ title: cards.title }).from(cards).where(eq(cards.id, cardId)).get();
		logActivity({
			boardId,
			cardId,
			userId: user.id,
			action: 'api:subtask_created',
			detail: `Created subtask "${title}" on "${card?.title || 'Unknown'}"`,
			userName: user.username,
			userEmoji: user.emoji || '👤'
		});

		return subtask;
	});

	return json(subtask, { status: 201 });
};
