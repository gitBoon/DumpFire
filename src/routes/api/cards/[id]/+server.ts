import { json, error } from '@sveltejs/kit';
import { db } from '$lib/server/db';
import { inTransaction } from '$lib/server/db/transaction';
import { cards, type Card } from '$lib/server/db/schema';
import { eq } from 'drizzle-orm';
import { emit } from '$lib/server/events';
import { requireCard, requireColumn, requireUser } from '$lib/server/route-guards';
import {
	applyCardMove,
	announceCardMoves,
	recordUnblockedByMoves,
	CardMoveError,
	type CardMove
} from '$lib/server/card-moves';
import { archiveCard, deleteCard } from '$lib/server/deletes';
import { linkBaseUrl } from '$lib/server/email';
import { logUiActivity, actorOf, ACTIONS } from '$lib/server/logActivity';
import { changedFields } from '$lib/server/card-changes';
import { normaliseReportingFields } from '$lib/server/reporting-fields';
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
	readNumber,
	readText
} from '$lib/server/request-body';
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
 */
export const PUT: RequestHandler = async ({ params, request, url, locals }) => {
	const user = requireUser(locals.user);
	const id = pathId(params.id, 'card');

	const body = await readBody(request);
	const baseUrl = linkBaseUrl(url);

	// One transaction: the card is read, checked, moved, updated and logged
	// together, and a failure anywhere leaves it as it was. The move used to
	// commit first, with the other fields and their log entry written after
	// it, so a failure between the two left a card moved with its edits lost.
	// The card is read in here and not before the body was awaited: another
	// request could have changed it in between.
	let updated: Card;
	try {
		updated = inTransaction(() => {
			// The board comes from the card's own row. A `boardId` in the body is
			// ignored: it names the board the caller wants to be judged against, which
			// need not be the one this card is on.
			const { card: existingCard, boardId: currentBoardId } = requireCard(user, id, 'edit');

			// Every field, read against its rule and the value the card holds.
			const updateData: Partial<typeof cards.$inferInsert> = {};
			const title = readText(body, 'title', {
				trim: true,
				min: 1,
				max: 500,
				keep: existingCard.title,
				says: { empty: 'title cannot be empty', invalid: 'Title too long (max 500 chars)' }
			});
			if (title !== undefined) updateData.title = title;
			const description = readText(body, 'description', {
				max: 50000,
				keep: existingCard.description,
				says: { invalid: 'Description too long (max 50000 chars)' }
			});
			if (description !== undefined) updateData.description = description;
			const priority = readChoice(body, 'priority', { from: PRIORITIES, anyCase: true, keep: existingCard.priority });
			if (priority !== undefined) updateData.priority = priority;
			const colorTag = readColour(body, 'colorTag', { allowEmpty: true, keep: existingCard.colorTag });
			if (colorTag !== undefined) updateData.colorTag = colorTag;
			const categoryId = readId(body, 'categoryId', { nullable: true, keep: existingCard.categoryId });
			if (categoryId !== undefined) updateData.categoryId = categoryId;
			const dueDate = readDate(body, 'dueDate', { nullable: true, keep: existingCard.dueDate });
			if (dueDate !== undefined) updateData.dueDate = dueDate;
			const onHoldNote = readText(body, 'onHoldNote', { max: 50000, keep: existingCard.onHoldNote });
			if (onHoldNote !== undefined) updateData.onHoldNote = onHoldNote;
			const businessValue = readText(body, 'businessValue', {
				max: 10000,
				keep: existingCard.businessValue,
				says: { invalid: 'Business value too long (max 10000 chars)' }
			});
			if (businessValue !== undefined) updateData.businessValue = businessValue;
			const pinned = readBoolean(body, 'pinned', { keep: existingCard.pinned });
			if (pinned !== undefined) updateData.pinned = pinned;
			const position = readNumber(body, 'position', { keep: existingCard.position });
			if (position !== undefined) updateData.position = position;
			const coverUrl = readCover(body, 'coverUrl', { nullable: true, keep: existingCard.coverUrl });
			if (coverUrl !== undefined) updateData.coverUrl = coverUrl;
			// Reporting fields carry fixed vocabularies, and answer their own 400. A
			// bad value dropped silently would read as "not recorded", which is a
			// different and misleading answer.
			Object.assign(updateData, normaliseReportingFields(body));
			const columnId = readId(body, 'columnId', { keep: existingCard.columnId, says: 'Invalid column ID' });

			// A change of column is a move, possibly to another board (the All Tasks
			// page does this). The caller needs edit access at both ends: without the
			// check on the target, anyone who could edit one card could push it into a
			// board they cannot open.
			//
			// The move itself goes through the same service as a drag and an API move,
			// so completing a card from here stamps the date, awards the XP and logs
			// the completion exactly as those do. It used to do the first and neither
			// of the others.
			const target = columnId !== undefined && columnId !== existingCard.columnId ? requireColumn(user, columnId, 'edit') : null;
			const boardId = target?.boardId ?? currentBoardId;

			// What else the body names, once every field is known to be sound: a
			// category of the board the card ends on, or a shared one (R3). One
			// the card already holds, sent back, is not looked at again.
			//
			// But on a move to another board, the one it holds sent back is not
			// written: the move decides, and clears one of the old board's, which
			// cannot follow the card. The card window sends the category back on
			// every save, and wrote the old board's over the move's clearing. A
			// different one sent is checked against the board the card ends on.
			if (target && target.boardId !== currentBoardId && categoryId === existingCard.categoryId) {
				delete updateData.categoryId;
			}
			if (categoryId !== undefined && categoryId !== null && categoryId !== existingCard.categoryId) {
				requireCardCategory(categoryId, boardId);
			}

			let move: CardMove | null = null;
			if (target) {
				move = applyCardMove({
					cardId: id,
					toColumnId: target.column.id,
					position: updateData.position,
					actor: user,
					source: 'ui'
				});
				delete updateData.position;
			}

			// A move out of an On Hold column clears the note (card 2208). The note
			// the card held before the move, sent back with it, is not written over
			// the clearing: the move decides, as for the category above. A
			// different note sent with the move is a new reason, and is written.
			if (move && existingCard.onHoldNote && move.card.onHoldNote === '' && onHoldNote === existingCard.onHoldNote) {
				delete updateData.onHoldNote;
			}

			// Only what differs from the card as it now stands is written, named
			// and announced (card 2183): the card window sends every field back on
			// every save. After a move that is the moved row, which may have lost
			// its category or its note. A save that changes nothing writes nothing,
			// records nothing and tells nobody, and is answered with the card.
			let row = move?.card ?? existingCard;
			const fields = changedFields(row, updateData);
			const changed = Object.keys(fields);
			if (changed.length > 0) {
				const written = db
					.update(cards)
					.set({ ...fields, updatedAt: new Date().toISOString() })
					.where(eq(cards.id, id))
					.returning()
					.get();
				if (!written) throw error(404, 'Card not found');
				row = written;

				logUiActivity({
					boardId,
					cardId: id,
					action: ACTIONS.cardUpdated,
					detail: `Updated fields: ${changed.join(', ')} on "${row.title}"`,
					...actorOf(user)
				});
			}

			// Nothing below is sent before the commit, or at all if this rolls back.
			if (move) {
				const unblocked = recordUnblockedByMoves([move], user);
				announceCardMoves([move], unblocked, user, 'ui', baseUrl);
			} else if (changed.length > 0) {
				emit(boardId, 'update', { type: 'card' });
			}

			return row;
		});
	} catch (e) {
		if (e instanceof CardMoveError) throw error(e.status, e.message);
		throw e;
	}

	return json(updated);
};

export const DELETE: RequestHandler = async ({ params, url, locals }) => {
	const id = pathId(params.id, 'card');
	const permanent = url.searchParams.get('permanent') === 'true';

	// One transaction: the card is read and the caller checked in the same one
	// that archives or deletes it. See $lib/server/deletes.ts for what goes
	// with a permanent delete; an archive touches nothing but the card.
	inTransaction(() => {
		const { boardId } = requireCard(locals.user, id, 'edit');
		const user = locals.user!;

		if (permanent) deleteCard(id, user, 'ui');
		else archiveCard(id, user, 'ui');

		emit(boardId, 'update', { type: 'card' });
	});
	return json({ success: true });
};
