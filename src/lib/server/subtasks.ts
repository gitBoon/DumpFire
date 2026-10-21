/**
 * subtasks.ts — a card's subtasks listed, one added, one changed or ticked,
 * and one deleted: one function for each, which both API trees call (card
 * 2012, part A, slice A2).
 *
 * `/api/subtasks` and `/api/subtasks/:id` (the card window) and their twins
 * `/api/v1/cards/:cardId/subtasks` and `/api/v1/subtasks/:subtaskId` had the
 * same middle written twice: the guard, the field reads, the row, the entry,
 * the notices and the live event. Each tree keeps its path, its body, its
 * single `writeAs`, its answer and, through its options, what it does
 * differently today: its words for a refusal (`says`), what it accepts
 * (`allowPosition`), the words of its entry, the type of its live event and
 * the order it tells in (R2 of `docs/planning/card-2012-service-layer-and-pages.md`).
 *
 * Each write has the one shape of a service (`ServiceOptions` in
 * `write-as.ts`): `inWrite()` first, then `requireUser(caller)` (401), the
 * guard (404, then 403), then every field read from the body (400); but the
 * page's `createSubtask` reads the card's id from the body before the guard,
 * as the row the guard is asked of, so its `400 Invalid card ID` comes before
 * a 404. Every entry, event and mail waits for the commit. Refusals are kit
 * `error()`s.
 */
import { error } from '@sveltejs/kit';
import { eq } from 'drizzle-orm';
import { db } from './db';
import { subtasks, type Subtask } from './db/schema';
import type { SessionUser } from './auth';
import { requireCard, requireSubtask, requireUser } from './route-guards';
import { emit } from './events';
import { ACTIONS, actorOf, logActivity } from './logActivity';
import { notifyRequesterProgress } from './notifications';
import { announceUnblocked, recordUnblocked, removeWorkNodeEdges } from './planning';
import { PRIORITIES } from './card-fields';
import { changedFields } from './card-changes';
import { SUBTASK_ORDER, nextSubtaskPosition } from './subtask-order';
import { readBoolean, readChoice, readColour, readDate, readId, readNumber, readText, type RequestBody } from './request-body';
import { inWrite, type ServiceOptions } from './write-as';

/** The functions here that only read. Every other export is a write, and starts with `inWrite()`. */
export const READS: readonly string[] = ['listSubtasks'];

/**
 * The live event's `type` each tree sends for a subtask written: `subtask`
 * from the page's routes, `card` through v1 (R2). Nothing on the client reads
 * it; each tree keeps its own.
 */
type SubtaskEvent = { eventType: 'subtask' | 'card' };

/**
 * A card's subtasks, by position and then id (card 2223): `GET
 * /api/subtasks?cardId=` and `GET /api/v1/cards/:cardId/subtasks`. The card is
 * looked for and the caller asked for view access (404, then 403, in the
 * tree's words, `says`).
 */
export function listSubtasks(user: SessionUser | null | undefined, at: { cardId: number }, opts: { says?: string }): Subtask[] {
	requireCard(user, at.cardId, 'view', opts.says);
	return db.select().from(subtasks).where(eq(subtasks.cardId, at.cardId)).orderBy(...SUBTASK_ORDER).all();
}

/** What each tree's new subtask does differently today (R2). */
export type CreateSubtaskOptions = SubtaskEvent & {
	/** `position` is read: a number, or the next one when it is not sent (v1). The page's route always places it after the card's last. */
	allowPosition?: boolean;
	/** The entry says `Created subtask "<title>" on "<card>"` (v1); the page's route names the subtask alone. */
	namesCard?: boolean;
	/** Tell the board before writing the entry (v1); the page's route writes the entry first. */
	tellBeforeEntry?: boolean;
};

/**
 * What `POST /api/subtasks` hands `createSubtask`, and so does a new card's
 * subtask (`createCard`, card 2296): one constant, so the two cannot drift
 * (the card 2296 review). Written out, as every service's options are
 * (tests/check-at-the-write.test.ts).
 */
export const CREATE_SUBTASK_PAGE_OPTIONS = { source: 'ui', eventType: 'subtask' } as const satisfies ServiceOptions & CreateSubtaskOptions;

/**
 * Add a subtask to a card, after its last one unless v1 is sent a
 * `position` (card 2223): `POST /api/subtasks` with the card in its body,
 * read first as the row the guard is asked of, and `POST
 * /api/v1/cards/:cardId/subtasks` with `at.cardId`. A `boardId` in the body
 * is ignored: the board is the card's.
 *
 * The fields (card 2117, R1): `title` text, trimmed, of 1 to 500
 * characters; `description` at most 50,000; `priority` one of the four;
 * `colorTag` a colour written `#rrggbb` or empty; `dueDate` a date written
 * `YYYY-MM-DD`, or null. The answer is the subtask as written.
 */
export function createSubtask(
	caller: SessionUser | null,
	at: { cardId?: number },
	body: RequestBody,
	opts: ServiceOptions & CreateSubtaskOptions
): Subtask {
	inWrite();
	const user = requireUser(caller);
	const cardId = at.cardId ?? readId(body, 'cardId', { required: true, says: 'Invalid card ID' });
	const { card, boardId } = requireCard(user, cardId, 'edit', opts.says);

	const title = readText(body, 'title', {
		required: true,
		trim: true,
		min: 1,
		max: 500,
		says: { missing: 'title is required', empty: 'title is required' }
	});
	const description = readText(body, 'description', { max: 50000 });
	const priority = readChoice(body, 'priority', { from: PRIORITIES, anyCase: true });
	const colorTag = readColour(body, 'colorTag', { allowEmpty: true });
	const dueDate = readDate(body, 'dueDate', { nullable: true });
	const position = opts.allowPosition ? readNumber(body, 'position', {}) : undefined;

	const subtask = db
		.insert(subtasks)
		.values({
			cardId,
			title,
			description: description ?? '',
			priority: priority ?? 'medium',
			colorTag: colorTag ?? '',
			dueDate: dueDate ?? null,
			// Not sent: after the card's last one (card 2223).
			position: position ?? nextSubtaskPosition(cardId)
		})
		.returning()
		.get();

	const tell = () => emit(boardId, 'update', { type: opts.eventType });
	if (opts.tellBeforeEntry) tell();
	logActivity({
		boardId,
		cardId,
		action: ACTIONS.subtaskCreated,
		detail: opts.namesCard ? `Created subtask "${title}" on "${card.title || 'Unknown'}"` : subtask.title,
		source: opts.source,
		...actorOf(user)
	});
	if (!opts.tellBeforeEntry) tell();
	return subtask;
}

/** What each tree's subtask change does differently today (R2). */
export type UpdateSubtaskOptions = SubtaskEvent & {
	/**
	 * Tell the board straight after the write: before a completion's entry
	 * and before its notices too (the "Unblocked" mail and its update, and the
	 * requester's mail). The page's route passes it to `updateSubtask`; v1
	 * does not, and tells the board last, after the notices. (On
	 * `createSubtask` it is v1 that passes it, and it moves the event before
	 * the entry, there being no notices.)
	 */
	tellBeforeEntry?: boolean;
};

/**
 * Change a subtask, and tick it off or on (`PUT /api/subtasks/:id`, `PUT
 * /api/v1/subtasks/:subtaskId`). The board is the parent card's; a `boardId`
 * in the body is ignored.
 *
 * The fields (card 2117): `title` text, trimmed, of 1 to 500 characters;
 * `description` at most 50,000; `priority` one of the four; `colorTag` a
 * colour written `#rrggbb` or empty; `dueDate` a date written `YYYY-MM-DD`,
 * or null; `completed` true or false; `position` a number. A value the
 * subtask already holds, sent back unchanged, is accepted as it is (decision
 * 8). Nothing else is written; a body that names none of them is a 400. Only
 * the fields that differ from the subtask as stored are written, and a body
 * that changes nothing writes nothing, records nothing and tells nobody
 * (card 2299).
 *
 * A tick, from open to done, records `subtask_completed` (`<subtask> (on
 * <card>)`), writes the "Unblocked" notices for work it was the last thing
 * blocking, and mails whoever asked for the card; re-ticking a subtask done
 * already does none of it again. An untick records `subtask_updated`
 * (`Reopened <subtask> (on <card>)`), and mails nobody; a change to any
 * other field but `position` records `subtask_updated` too (`Updated
 * <subtask> (on <card>): title, dueDate`), after the tick or untick. The
 * subtask is read in this transaction, so two requests ticking it cannot
 * both find it open. The answer is the row.
 */
export function updateSubtask(
	caller: SessionUser | null,
	at: { subtaskId: number },
	body: RequestBody,
	opts: ServiceOptions & UpdateSubtaskOptions
): Subtask {
	inWrite();
	const user = requireUser(caller);
	const { subtaskId } = at;
	const { subtask: existing, card, boardId } = requireSubtask(user, subtaskId, 'edit', opts.says);

	// Every field, read against its rule and the value the subtask holds.
	const updateData: Partial<typeof subtasks.$inferInsert> = {};
	const title = readText(body, 'title', {
		trim: true,
		min: 1,
		max: 500,
		keep: existing.title,
		says: { empty: 'title cannot be empty' }
	});
	if (title !== undefined) updateData.title = title;
	const description = readText(body, 'description', { max: 50000, keep: existing.description });
	if (description !== undefined) updateData.description = description;
	const priority = readChoice(body, 'priority', { from: PRIORITIES, anyCase: true, keep: existing.priority });
	if (priority !== undefined) updateData.priority = priority;
	const colorTag = readColour(body, 'colorTag', { allowEmpty: true, keep: existing.colorTag });
	if (colorTag !== undefined) updateData.colorTag = colorTag;
	const dueDate = readDate(body, 'dueDate', { nullable: true, keep: existing.dueDate });
	if (dueDate !== undefined) updateData.dueDate = dueDate;
	const completed = readBoolean(body, 'completed', { keep: existing.completed });
	if (completed !== undefined) updateData.completed = completed;
	const position = readNumber(body, 'position', { keep: existing.position });
	if (position !== undefined) updateData.position = position;

	if (Object.keys(updateData).length === 0) throw error(400, 'No valid fields to update');

	// Only what differs from the subtask as stored (card 2183's rule, card
	// 2299). A save that changes nothing writes nothing, records nothing and
	// tells nobody, and is answered with the subtask as it is: the subtask
	// window sends every field on every save.
	const changed = changedFields(existing, updateData);
	if (Object.keys(changed).length === 0) return existing;

	const row = db.update(subtasks).set(changed).where(eq(subtasks.id, subtaskId)).returning().get();
	if (!row) throw error(404, 'Subtask not found');

	const tell = () => emit(boardId, 'update', { type: opts.eventType });
	if (opts.tellBeforeEntry) tell();

	// One entry per kind of change, each in `<subtask> (on <card>)`: the tick
	// (`subtask_completed`) or the untick, then the other fields, named in the
	// order they are read. A change of position alone is not recorded, as a
	// card's position within its column is not.
	// Each `action` is written out, so that the label test can read it.
	const where = `${row.title} (on ${card.title})`;
	const on = { boardId, cardId: row.cardId, source: opts.source, ...actorOf(user) };
	const ticked = changed.completed === true;
	if (changed.completed !== undefined) {
		logActivity({
			...on,
			action: ticked ? ACTIONS.subtaskCompleted : ACTIONS.subtaskUpdated,
			detail: ticked ? where : `Reopened ${where}`
		});
	}
	const named = Object.keys(changed).filter((field) => field !== 'completed' && field !== 'position');
	if (named.length > 0) logActivity({ ...on, action: ACTIONS.subtaskUpdated, detail: `Updated ${where}: ${named.join(', ')}` });

	// Only a tick from open to done, as `changed` holds `completed` only when
	// it differs, so re-ticking a subtask already complete writes none of this.
	if (ticked) {
		// A subtask can be the last thing blocking other work. The notices are
		// the last write; the mail and the refresh for them wait for the commit.
		announceUnblocked(recordUnblocked([{ kind: 'subtask', id: subtaskId }], user.id), user, opts.baseUrl ?? null);

		// Whoever asked for the card is told, once the tick is committed.
		notifyRequesterProgress({
			cardId: row.cardId,
			action: 'subtask_completed',
			summary: row.title,
			actorName: user.username,
			baseUrl: opts.baseUrl ?? null,
			actorUserId: user.id
		});
	}

	if (!opts.tellBeforeEntry) tell();
	return row;
}

/**
 * Delete a subtask for good (`DELETE /api/subtasks/:id`, `DELETE
 * /api/v1/subtasks/:subtaskId`), with its dependency links: work dependency
 * ids carry no foreign key, so nothing cascades, and the graph would keep
 * pointing at work that is gone. The links, the subtask and the
 * `subtask_deleted` entry go together or not at all. There is no body.
 */
export function deleteSubtask(
	caller: SessionUser | null,
	at: { subtaskId: number },
	body: null,
	opts: ServiceOptions & SubtaskEvent
): void {
	inWrite();
	const user = requireUser(caller);
	const { subtaskId } = at;
	const { subtask: doomed, boardId } = requireSubtask(user, subtaskId, 'edit', opts.says);

	removeWorkNodeEdges('subtask', subtaskId);
	db.delete(subtasks).where(eq(subtasks.id, subtaskId)).run();

	logActivity({
		boardId,
		cardId: doomed.cardId,
		action: ACTIONS.subtaskDeleted,
		detail: `"${doomed.title}"`,
		source: opts.source,
		...actorOf(user)
	});
	emit(boardId, 'update', { type: opts.eventType });
}
