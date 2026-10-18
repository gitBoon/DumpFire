import { error } from '@sveltejs/kit';
import { json } from '$lib/server/v1-json';
import { db } from '$lib/server/db';
import { cards, columns, subtasks, cardLabels, cardAssignees, users } from '$lib/server/db/schema';
import { eq } from 'drizzle-orm';
import { canViewBoard, canEditBoard } from '$lib/server/board-access';
import { getCardDependencies } from '$lib/server/planning';
import { inTransaction } from '$lib/server/db/transaction';
import { archiveCard, deleteCard } from '$lib/server/deletes';
import { restoreCard } from '$lib/server/card-restore';
import { emit } from '$lib/server/events';
import { logActivity } from '$lib/server/logActivity';
import { normaliseReportingFields } from '$lib/server/reporting-fields';
import { changedFields } from '$lib/server/card-changes';
import { setCardMilestone, takeCardOutOfMilestone, MilestoneError } from '$lib/server/milestones';
import { PRIORITIES, requireCardCategory } from '$lib/server/card-fields';
import {
	pathId,
	readBody,
	readBoolean,
	readChoice,
	readColour,
	readCover,
	readDate,
	readId,
	readText
} from '$lib/server/request-body';
import { requireUser } from '$lib/server/route-guards';
import { stamp, toStamp } from '$lib/timestamps';
import type { RequestHandler } from './$types';

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

	// Fetch subtasks
	const cardSubtasks = db.select().from(subtasks)
		.where(eq(subtasks.cardId, cardId))
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
 */
export const PUT: RequestHandler = async ({ params, request, locals }) => {
	const user = requireUser(locals.user);
	const cardId = pathId(params.cardId, 'card');
	const body = await readBody(request);

	// One transaction: the card is read and the caller checked in the one that
	// writes the milestone, the other fields and the activity entry, and all of
	// them are saved or none. The card is read in here and not before the body
	// was awaited: another request could have moved or deleted it in between.
	const updated = inTransaction(() => {
		const boardId = getCardBoardId(cardId);
		if (!boardId) throw error(404, 'Card not found');

		if (!canEditBoard(user, boardId)) {
			throw error(403, 'No edit access to this card\'s board');
		}
		const card = db.select().from(cards).where(eq(cards.id, cardId)).get()!;

		// Every field, read against its rule and the value the card holds.
		const updateData: Partial<typeof cards.$inferInsert> = {};
		const title = readText(body, 'title', {
			trim: true,
			min: 1,
			max: 500,
			keep: card.title,
			says: { empty: 'title cannot be empty', invalid: 'Title too long (max 500 chars)' }
		});
		if (title !== undefined) updateData.title = title;
		const description = readText(body, 'description', {
			max: 50000,
			keep: card.description,
			says: { invalid: 'Description too long (max 50000 chars)' }
		});
		if (description !== undefined) updateData.description = description;
		const priority = readChoice(body, 'priority', { from: PRIORITIES, anyCase: true, keep: card.priority });
		if (priority !== undefined) updateData.priority = priority;
		const colorTag = readColour(body, 'colorTag', { allowEmpty: true, keep: card.colorTag });
		if (colorTag !== undefined) updateData.colorTag = colorTag;
		const categoryId = readId(body, 'categoryId', { nullable: true, keep: card.categoryId });
		if (categoryId !== undefined) updateData.categoryId = categoryId;
		const dueDate = readDate(body, 'dueDate', { nullable: true, keep: card.dueDate });
		if (dueDate !== undefined) updateData.dueDate = dueDate;
		const onHoldNote = readText(body, 'onHoldNote', { max: 50000, keep: card.onHoldNote });
		if (onHoldNote !== undefined) updateData.onHoldNote = onHoldNote;
		const businessValue = readText(body, 'businessValue', { max: 10000, keep: card.businessValue });
		if (businessValue !== undefined) updateData.businessValue = businessValue;
		const pinned = readBoolean(body, 'pinned', { keep: card.pinned });
		if (pinned !== undefined) updateData.pinned = pinned;
		// A colour, one of the preset gradients, or null: it is drawn on the board
		// for every viewer, so nothing else is taken (card 2010, decision 14).
		const coverUrl = readCover(body, 'coverUrl', { nullable: true, keep: card.coverUrl });
		if (coverUrl !== undefined) updateData.coverUrl = coverUrl;
		// Reporting fields go through their own vocabularies, with their own 400.
		// A rejected value that reported as "not recorded" would be
		// indistinguishable from never having set one.
		Object.assign(updateData, normaliseReportingFields(body));

		// `archivedAt` restores, and does nothing else (decision 12). The stamp
		// the card already holds, sent back, changes nothing: it is read with
		// `toStamp` (card 2095), so the ISO form this API answers with is the
		// same moment as the stored form the card holds.
		const restoring = 'archivedAt' in body && body.archivedAt === null;
		const sentArchivedAt = restoring ? null : toStamp(body.archivedAt);
		if ('archivedAt' in body && !restoring && (sentArchivedAt === null || sentArchivedAt !== card.archivedAt)) {
			throw error(400, 'archivedAt may only be null, which restores the card. Archive a card with DELETE /cards/{cardId}');
		}

		const milestoneId = readId(body, 'milestoneId', { nullable: true, keep: card.milestoneId });
		if (Object.keys(updateData).length === 0 && milestoneId === undefined && !('archivedAt' in body)) {
			throw error(400, 'No valid fields to update');
		}

		// Decided on what was sent, above; from here on only what differs from
		// the card is written, named and announced (card 2183). The milestone
		// the card is in, sent back, is not a change either, and an
		// `archivedAt` that restores nothing is not named.
		const fields = changedFields(card, updateData);
		const settingMilestone = milestoneId !== undefined && milestoneId !== card.milestoneId;

		// What the body names, once every field is known to be sound: a
		// category of the card's board or a shared one, and the milestone.
		if (categoryId !== undefined && categoryId !== null && categoryId !== card.categoryId) {
			requireCardCategory(categoryId, boardId);
		}

		// Restored before the milestone is set, which refuses an archived card:
		// `archivedAt: null` with a `milestoneId` was refused as archived. A
		// milestone refused rolls the restore back, and its entry, with
		// everything else.
		const restored = restoring && restoreCard(cardId, user, 'api')?.restored === true;

		// A milestone is not a plain field. Joining one needs the caller to be able
		// to see it, and a single-board milestone only takes that board's cards.
		// Leaving one needs edit access to it, as joining does: R5's rule, the
		// same on every route that takes a card out, and on a move from one
		// milestone to another. The milestone the card is already in, sent back,
		// changes nothing.
		if (settingMilestone) {
			try {
				if (milestoneId === null) takeCardOutOfMilestone(user, cardId);
				else setCardMilestone(user, cardId, milestoneId);
			} catch (e) {
				if (e instanceof MilestoneError) throw error(e.status, e.message);
				throw e;
			}
		}

		// Nothing changed: nothing is written, recorded or announced, and the
		// card is answered as it is.
		if (Object.keys(fields).length === 0 && !settingMilestone && !restored) return card;

		const updated = db.update(cards)
			.set({ ...fields, updatedAt: stamp() })
			.where(eq(cards.id, cardId))
			.returning()
			.get();

		if (!updated) throw error(404, 'Card not found');

		emit(boardId, 'update', { type: 'card' });

		// A restore has its own entry, written by `restoreCard`, and is not
		// named here as well.
		const named = [
			...Object.keys(fields),
			...(settingMilestone ? ['milestoneId'] : [])
		].join(', ');
		if (named) {
			logActivity({
				boardId,
				cardId,
				userId: user.id,
				action: 'api:card_updated',
				detail: `Updated fields: ${named} on "${updated.title}"`,
				userName: user.username,
				userEmoji: user.emoji || '👤'
			});
		}

		return updated;
	});

	return json(updated);
};

/** DELETE /api/v1/cards/:cardId — Archive (soft-delete) a card. Use ?permanent=true for hard delete. */
export const DELETE: RequestHandler = async ({ params, url, locals }) => {
	const user = requireUser(locals.user);
	const cardId = pathId(params.cardId, 'card');
	const permanent = url.searchParams.get('permanent') === 'true';

	// One transaction: the card is read and the caller checked in the same one
	// that archives or deletes it. See $lib/server/deletes.ts for what goes
	// with a permanent delete; an archive touches nothing but the card.
	//
	// The permanent delete used to give the activity log the id of the card it
	// had just deleted, which the foreign key refuses: the card was gone and
	// the answer was a 500. The entry is stored with no card id now, and the
	// `card.deleted` webhook carries it.
	inTransaction(() => {
		const boardId = getCardBoardId(cardId);
		if (!boardId) throw error(404, 'Card not found');

		if (!canEditBoard(user, boardId)) {
			throw error(403, 'No edit access to this card\'s board');
		}

		if (permanent) deleteCard(cardId, user, 'api');
		else archiveCard(cardId, user, 'api');

		emit(boardId, 'update', { type: 'card' });
	});

	return json({ success: true });
};
