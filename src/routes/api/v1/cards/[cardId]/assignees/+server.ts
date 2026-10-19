import { error } from '@sveltejs/kit';
import { json } from '$lib/server/v1-json';
import { db } from '$lib/server/db';
import { cards, columns, cardAssignees, users } from '$lib/server/db/schema';
import { eq } from 'drizzle-orm';
import { canViewBoard } from '$lib/server/board-access';
import { assignToCard, unassignFromCard } from '$lib/server/card-assignees';
import { linkBaseUrl } from '$lib/server/email';
import { pathId, readBody } from '$lib/server/request-body';
import { requireUser } from '$lib/server/route-guards';
import { writeAs } from '$lib/server/write-as';
import type { RequestHandler } from './$types';

/** This route's words for a caller who may not edit the card's board when assigning, which it keeps (card 2012, R2). */
const NO_EDIT_TO_ASSIGN = "No edit access to this card's board";

/** And when taking someone off the card. */
const NO_EDIT_TO_UNASSIGN = 'No edit access';

/** Resolve the board and card title that a card belongs to. */
function getCardContext(cardId: number): { boardId: number; cardTitle: string } | null {
	const card = db.select({ columnId: cards.columnId, title: cards.title }).from(cards).where(eq(cards.id, cardId)).get();
	if (!card) return null;
	const col = db.select({ boardId: columns.boardId }).from(columns).where(eq(columns.id, card.columnId)).get();
	if (!col) return null;
	return { boardId: col.boardId, cardTitle: card.title };
}

/** GET /api/v1/cards/:cardId/assignees — List assignees for a card. */
export const GET: RequestHandler = async ({ params, locals }) => {
	if (!locals.user) throw error(401, 'Not authenticated');

	const cardId = pathId(params.cardId, 'card');

	const ctx = getCardContext(cardId);
	if (!ctx) throw error(404, 'Card not found');

	// Who a card is assigned to is part of the card: it is read by whoever may
	// read the card, and answered as GET /api/v1/cards/:cardId answers.
	if (!canViewBoard(locals.user, ctx.boardId)) {
		throw error(403, 'No access to this card\'s board');
	}

	const assignees = db.select({
		id: users.id,
		username: users.username,
		emoji: users.emoji
	})
		.from(cardAssignees)
		.innerJoin(users, eq(cardAssignees.userId, users.id))
		.where(eq(cardAssignees.cardId, cardId))
		.all();

	return json(assignees);
};

/**
 * POST /api/v1/cards/:cardId/assignees — Assign a user to a card. Body: { userId: number }
 *
 * The work is `assignToCard` in `$lib/server/card-assignees`, which the
 * internal route shares (card 2012).
 */
export const POST: RequestHandler = async ({ params, request, url, locals }) => {
	requireUser(locals.user);
	const cardId = pathId(params.cardId, 'card');
	const body = await readBody(request);
	const baseUrl = linkBaseUrl(url);

	// One transaction: the card is read and the caller checked in the one that
	// assigns the user and writes the entry. Whether the user is already
	// assigned is read in it too, so two requests cannot both find them
	// unassigned. The mail is worked out in here and sent once it is committed.
	// It asks first whether the key or session is still open, and who its
	// account is now (card 2253).
	const { already } = writeAs(locals, (caller) =>
		assignToCard(caller, { cardId }, body, { source: 'api', baseUrl, says: NO_EDIT_TO_ASSIGN })
	);

	return json({ success: true, message: already ? 'User already assigned' : 'User assigned' });
};

/**
 * DELETE /api/v1/cards/:cardId/assignees — Remove a user from a card. Body: { userId: number }
 *
 * Removing someone who is not assigned to the card is 404 (decision 9). It
 * was 200, with an activity entry that said they had been removed.
 */
export const DELETE: RequestHandler = async ({ params, request, locals }) => {
	requireUser(locals.user);
	const cardId = pathId(params.cardId, 'card');
	const body = await readBody(request);

	// One transaction: the card is read and the caller checked in the one that
	// removes the assignee and writes the entry, which asks first whether the
	// key or session is still open, and who its account is now (card 2253).
	// The work is `unassignFromCard`, which the internal route shares (card 2012).
	writeAs(locals, (caller) => unassignFromCard(caller, { cardId }, body, { source: 'api', says: NO_EDIT_TO_UNASSIGN }));

	return json({ success: true });
};
