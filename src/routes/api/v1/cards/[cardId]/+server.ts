import { error } from '@sveltejs/kit';
import { json } from '$lib/server/v1-json';
import { db } from '$lib/server/db';
import { cards, columns, subtasks, cardLabels, cardAssignees, users } from '$lib/server/db/schema';
import { eq } from 'drizzle-orm';
import { canViewBoard } from '$lib/server/board-access';
import { getCardDependencies } from '$lib/server/planning';
import { removeCard, updateCard } from '$lib/server/cards';
import { SUBTASK_ORDER } from '$lib/server/subtask-order';
import { pathId, readBody } from '$lib/server/request-body';
import { requireUser } from '$lib/server/route-guards';
import { writeAs } from '$lib/server/write-as';
import type { RequestHandler } from './$types';

/**
 * This tree's words for a caller who may not edit the card's board, which it
 * keeps (card 2012, R2): the update and the delete hand them to the service.
 */
const NO_EDIT = "No edit access to this card's board";

/** Resolve the board that a card belongs to. */
function getCardBoardId(cardId: number): number | null {
	const card = db.select({ columnId: cards.columnId }).from(cards).where(eq(cards.id, cardId)).get();
	if (!card) return null;
	const col = db.select({ boardId: columns.boardId }).from(columns).where(eq(columns.id, card.columnId)).get();
	return col?.boardId ?? null;
}

/** GET /api/v1/cards/:cardId — Get a single card with subtasks and assignees. */
export const GET: RequestHandler = async ({ params, locals }) => {
	if (!locals.user) throw error(401, 'Not authenticated');

	const cardId = pathId(params.cardId, 'card');

	const boardId = getCardBoardId(cardId);
	if (!boardId) throw error(404, 'Card not found');

	if (!canViewBoard(locals.user, boardId)) {
		throw error(403, 'No access to this card\'s board');
	}

	const card = db.select().from(cards).where(eq(cards.id, cardId)).get();
	if (!card) throw error(404, 'Card not found');

	// Fetch subtasks, by position and then id (card 2223)
	const cardSubtasks = db.select().from(subtasks)
		.where(eq(subtasks.cardId, cardId))
		.orderBy(...SUBTASK_ORDER)
		.all();

	// Fetch label IDs
	const labelRows = db.select({ labelId: cardLabels.labelId })
		.from(cardLabels)
		.where(eq(cardLabels.cardId, cardId))
		.all();

	// Fetch assignees
	const assigneeRows = db.select({
		id: users.id,
		username: users.username,
		emoji: users.emoji
	})
		.from(cardAssignees)
		.innerJoin(users, eq(cardAssignees.userId, users.id))
		.where(eq(cardAssignees.cardId, cardId))
		.all();

	// Column info
	const col = db.select({ title: columns.title, boardId: columns.boardId })
		.from(columns)
		.where(eq(columns.id, card.columnId))
		.get();

	// Dependency state ships with the card so a planning caller never has to
	// make a second request just to know whether this card is startable. An end
	// on a board the key's user cannot open is withheld (card 2129).
	const deps = getCardDependencies(cardId, locals.user);

	return json({
		...card,
		boardId,
		columnTitle: col?.title || 'Unknown',
		subtasks: cardSubtasks,
		labelIds: labelRows.map(r => r.labelId),
		assignees: assigneeRows,
		isBlocked: deps.isBlocked,
		// `kind` and `parentCardId` matter: without them "#32" is ambiguous between
		// card 32 and subtask 32, and a client cannot link to the right thing.
		blockedBy: deps.blockedBy.map(d => ({
			kind: d.kind, cardId: d.id, parentCardId: d.parentCardId ?? null,
			title: d.title, boardId: d.boardId, boardName: d.boardName,
			columnName: d.columnTitle, resolved: d.isComplete, withheld: d.withheld
		})),
		blocks: deps.blocks.map(d => ({
			kind: d.kind, cardId: d.id, parentCardId: d.parentCardId ?? null,
			title: d.title, boardId: d.boardId, boardName: d.boardName,
			columnName: d.columnTitle, resolved: d.isComplete, withheld: d.withheld
		}))
	});
};

/**
 * PUT /api/v1/cards/:cardId — Update card fields.
 *
 * The card is looked for and the caller checked first (404, then 403), then
 * every field is read (400), then what the body names is looked for: the
 * category (404) and the milestone. A value the card already holds, sent back
 * unchanged, is accepted as it is, whatever the rules say of it (decision 8).
 *
 * `archivedAt: null` restores an archived card, which is how the tracking
 * workflow restores one. Any other value is refused: a card is archived with
 * `DELETE /cards/{cardId}`, which a timestamp sent here only pretended to do.
 *
 * A restore is recorded as one: `api:card_restored`, as the page's restore
 * writes `card_restored` (card 2108, R2). It was `api:card_updated` naming
 * `archivedAt`. The `api:card_updated` entry is written for the other fields,
 * when there are any.
 *
 * A field sent with the value the card already holds is not a change (card
 * 2183, `card-changes.ts`): the entry names only the fields that changed. An
 * `archivedAt` that changes nothing, `null` on a card that is not archived or
 * the stamp the card holds, is not named; it was. A request that changes
 * nothing writes nothing, records no entry, sends no `card.updated` and no
 * live event, and is answered 200 with the card. `{}` is still a 400.
 *
 * The work is `updateCard` in `$lib/server/cards`, which the internal update
 * shares (card 2012). This route takes `milestoneId` and `archivedAt`, takes
 * no move, refuses a body that names nothing, and keeps its own words for a
 * caller who may not edit.
 *
 * No move (card 2287): `columnId` is taken only as the column the card is in,
 * so a card read with GET can be sent back whole, and any other is a 400 that
 * names `PUT /cards/{cardId}/move`, where the other fields were saved and it
 * was ignored. `position` is ignored here, whatever is sent: a drag renumbers
 * the columns it touches, so a card read a minute ago is often sent back with
 * an old one. Reorder with the move route.
 */
export const PUT: RequestHandler = async ({ params, request, locals }) => {
	requireUser(locals.user);
	const cardId = pathId(params.cardId, 'card');
	const body = await readBody(request);

	// One transaction: the card is read and the caller checked in the one that
	// writes the milestone, the other fields and the activity entry, and all of
	// them are saved or none. The card is read in here and not before the body
	// was awaited: another request could have moved or deleted it in between.
	// It asks first whether the key or session is still open, and who its
	// account is now (card 2253). It tells the board before it writes its
	// entry, as this tree always has.
	const updated = writeAs(
		locals,
		(caller) =>
			updateCard(caller, { cardId }, body, {
				source: 'api',
				allowMilestone: true,
				allowRestore: true,
				refuseMove: true,
				refuseEmpty: true,
				tellBeforeEntry: true,
				says: NO_EDIT
			}).card
	);

	return json(updated);
};

/** DELETE /api/v1/cards/:cardId — Archive (soft-delete) a card. Use ?permanent=true for hard delete. */
export const DELETE: RequestHandler = async ({ params, url, locals }) => {
	requireUser(locals.user);
	const cardId = pathId(params.cardId, 'card');
	const permanent = url.searchParams.get('permanent') === 'true';

	// One transaction: the card is read and the caller checked in the same one
	// that archives or deletes it, which asks first whether the key or session
	// is still open, and who its account is now (card 2253). See
	// $lib/server/deletes.ts for what goes with a permanent delete; an archive
	// touches nothing but the card.
	//
	// The permanent delete used to give the activity log the id of the card it
	// had just deleted, which the foreign key refuses: the card was gone and
	// the answer was a 500. The entry is stored with no card id now, and the
	// `card.deleted` webhook carries it. The work is `removeCard` in
	// $lib/server/cards, which the internal delete shares (card 2012).
	writeAs(locals, (caller) => removeCard(caller, { cardId }, null, { permanent, source: 'api', says: NO_EDIT }));

	return json({ success: true });
};
