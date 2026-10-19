/**
 * milestone-service.ts — a milestone made, read, changed and deleted, its
 * plan read, and a card put in it or taken out: one function for each, which
 * both API trees call (card 2012, part A, slice A3).
 *
 * `/api/milestones` and `/api/milestones/:id` (the planning view and the
 * card window) and their twins under `/api/v1/milestones` had the same middle
 * written twice: the guard, the field reads, the write, the entry for a
 * milestone made, and the live update for a card put in or taken out, which
 * was sent after the transaction. Each tree keeps its path, its body, its
 * single `writeAs`, its answer and, through its options, what it does
 * differently today: the page's `PATCH` also puts a card in or takes one out
 * (`allowCard`), which v1 does at `/api/v1/milestones/:milestoneId/cards`, and
 * v1's read of one milestone adds its cards (`withCards`). R2 of
 * `docs/planning/card-2012-service-layer-and-pages.md`.
 *
 * The rules themselves stay in `milestones.ts` (`requireMilestone`,
 * `createMilestone`, `updateMilestone`, `deleteMilestone`, `setCardMilestone`,
 * `takeCardOutOfMilestone`), which other callers use and which is no service;
 * their own transactions are savepoints inside the caller's. Each write here
 * has the one shape of a service (`ServiceOptions` in `write-as.ts`):
 * `inWrite()` first, then `requireUser(caller)` (401), the guard (404, then
 * 403), then every field read from the body (400), and the write. A new
 * milestone's guard is its board, read from the body first, as the row the
 * guard is asked of. A `MilestoneError` is turned into the kit `error()` of
 * its status and words, as every route turned it.
 */

import { error } from '@sveltejs/kit';
import { and, eq, isNull } from 'drizzle-orm';
import { db } from './db';
import { cards, columns } from './db/schema';
import type { SessionUser } from './auth';
import { emit } from './events';
import { ACTIONS, actorOf, logActivity } from './logActivity';
import {
	createMilestone,
	deleteMilestone,
	MilestoneError,
	requireMilestone,
	requireMilestoneBoard,
	setCardMilestone,
	takeCardOutOfMilestone,
	updateMilestone,
	type MilestoneRow
} from './milestones';
import { boardsOpenTo, getMilestoneSummary, WITHHELD_CARD_TITLE } from './planning';
import { readBoolean, readChoice, readDate, readId, readText, type RequestBody } from './request-body';
import { requireUser } from './route-guards';
import { inWrite, type ServiceOptions } from './write-as';

/** The functions here that only read. Every other export is a write, and starts with `inWrite()`. */
export const READS: readonly string[] = ['readMilestone', 'readMilestoneSummary'];

/** What a milestone's `status` may be. */
const STATUSES = ['open', 'closed'] as const;

/** A `MilestoneError` as the status and words it carries, as each route turned it; anything else as it is. */
function refused(e: unknown): never {
	if (e instanceof MilestoneError) throw error(e.status, e.message);
	throw e;
}

/**
 * Put a card in the milestone, or take it out (`attach` false), and tell the
 * card's board once it has committed. Putting a card in replaces whatever
 * milestone it was in; an archived card is refused (decision 15). Taking it
 * out is `takeCardOutOfMilestone`'s rule (R5): the card must be in this
 * milestone, `404 Card is not in this milestone`.
 */
function cardInOrOut(user: SessionUser, milestoneId: number, cardId: number, attach: boolean) {
	const moved = attach ? setCardMilestone(user, cardId, milestoneId) : takeCardOutOfMilestone(user, cardId, milestoneId);
	emit(moved.boardId, 'update', { type: 'card' });
	return moved;
}

/**
 * One milestone: `GET /api/milestones/:id`, and `GET
 * /api/v1/milestones/:milestoneId` with `withCards`. The caller must be able
 * to read it (404, then 403).
 *
 * With its cards, a card on a board the caller cannot open is listed
 * withheld, as the summary lists it (card 2129): its id, with `withheld:
 * true`, "A card on a board you cannot open" for its title, an empty column
 * title, and null for its priority, column and board. A card moved off a board
 * used to keep that board's milestone, so a viewer of the board was given the
 * title and board of a card on another. A move takes it out now, and migration
 * 0057 took out those already moved (card 2155); a milestone is given to
 * another board only when all its cards are there, and the backfill after
 * every restore takes out any an older backup brings back (card 2179). This
 * stays as the guard for a row made any other way.
 */
export function readMilestone(user: SessionUser, at: { milestoneId: number }, opts: { withCards?: boolean }) {
	try {
		const milestone = requireMilestone(user, at.milestoneId);
		if (!opts.withCards) return milestone;

		const memberCards = db
			.select({
				id: cards.id,
				title: cards.title,
				priority: cards.priority,
				columnId: cards.columnId,
				columnTitle: columns.title,
				boardId: columns.boardId
			})
			.from(cards)
			.innerJoin(columns, eq(cards.columnId, columns.id))
			.where(and(eq(cards.milestoneId, at.milestoneId), isNull(cards.archivedAt)))
			.all();
		const opens = boardsOpenTo(user);
		const shown = memberCards.map((card) =>
			opens(card.boardId)
				? { ...card, withheld: false }
				: { id: card.id, title: WITHHELD_CARD_TITLE, priority: null, columnId: null, columnTitle: '', boardId: null, withheld: true }
		);

		return { ...milestone, cards: shown };
	} catch (e) {
		refused(e);
	}
}

/**
 * A milestone's whole plan, made for the caller: work on a board they cannot
 * open is withheld (card 2129). `GET .../summary` and `GET .../pdf` of both
 * trees. Exporting a plan is reading it, so it is governed by the same rule:
 * the caller must be able to read the milestone (404, then 403).
 */
export function readMilestoneSummary(user: SessionUser, at: { milestoneId: number }, opts: Record<string, never>) {
	try {
		requireMilestone(user, at.milestoneId);
	} catch (e) {
		refused(e);
	}

	const summary = getMilestoneSummary(at.milestoneId, user);
	if (!summary) throw error(404, 'Milestone not found');
	return summary;
}

/**
 * Make a milestone: `POST /api/milestones` and `POST /api/v1/milestones`.
 *
 * `boardId` is read first, because it says whose milestone this is: the
 * board is looked for and the caller checked (404, then 403), and then the
 * other fields are read (card 2117, R1). A milestone of no board has nothing
 * to guard. `name` is text, trimmed, of 1 to 200 characters; `description`
 * text of at most 50,000; `targetDate` a date written `YYYY-MM-DD`, or null.
 *
 * The `milestone_created` entry goes on the milestone's board, from
 * `opts.source` (card 2143); one that belongs to no board has no board's log
 * to go in.
 */
export function createMilestoneFor(caller: SessionUser | null, at: Record<string, never>, body: RequestBody, opts: ServiceOptions): MilestoneRow {
	inWrite();
	try {
		const user = requireUser(caller);
		const boardId = readId(body, 'boardId', { nullable: true }) ?? null;
		if (boardId !== null) requireMilestoneBoard(user, boardId);

		const name = readText(body, 'name', {
			required: true,
			trim: true,
			min: 1,
			max: 200,
			says: { missing: 'name is required', empty: 'name is required' }
		});
		const description = readText(body, 'description', { max: 50000 });
		const targetDate = readDate(body, 'targetDate', { nullable: true });

		const created = createMilestone(user, { name, boardId, description, targetDate });

		if (created.boardId !== null) {
			logActivity({
				boardId: created.boardId,
				action: ACTIONS.milestoneCreated,
				detail: `Created milestone "${created.name}"`,
				source: opts.source,
				...actorOf(user)
			});
		}

		return created;
	} catch (e) {
		refused(e);
	}
}

/** What each tree's milestone change does differently today (R2). */
export type ChangeMilestoneOptions = ServiceOptions & {
	/**
	 * `cardId` in the body puts that card in the milestone, or with `attach:
	 * false` takes it out, in place of a change to the milestone (the page's
	 * `PATCH`, which the card window and the planning view both send). v1 does
	 * this at `/api/v1/milestones/:milestoneId/cards`.
	 */
	allowCard?: boolean;
};

/**
 * Change a milestone: `PATCH /api/milestones/:id` and `PATCH
 * /api/v1/milestones/:milestoneId`. The milestone is looked for and the
 * caller checked first (404, then 403), and then every field is read (card
 * 2117, R1).
 *
 * With `allowCard`, `cardId` in the body puts that card in, or with `attach:
 * false` takes it out (`attach` is true or false: `"false"` put the card in),
 * and answers `{ moved }`. Otherwise `name` is text, trimmed, of 1 to 200
 * characters; `description` text of at most 50,000; `targetDate` a date
 * written `YYYY-MM-DD`, or null; `status` `open` or `closed`; `boardId` an id,
 * or null for a goal across boards. A value the milestone already holds, sent
 * back unchanged, is accepted as it is. A board sent must be there (404),
 * editable (403), and hold every card of the milestone (400):
 * `updateMilestone`. Answers `{ changed }`.
 */
export function changeMilestone(caller: SessionUser | null, at: { milestoneId: number }, body: RequestBody, opts: ChangeMilestoneOptions) {
	inWrite();
	try {
		const user = requireUser(caller);
		const milestone = requireMilestone(user, at.milestoneId, true);

		if (opts.allowCard && body.cardId !== undefined) {
			const cardId = readId(body, 'cardId', { required: true });
			const attach = readBoolean(body, 'attach', {}) ?? true;
			return { moved: cardInOrOut(user, at.milestoneId, cardId, attach) };
		}

		const name = readText(body, 'name', {
			trim: true,
			min: 1,
			max: 200,
			keep: milestone.name,
			says: { empty: 'name cannot be empty' }
		});
		const description = readText(body, 'description', { max: 50000, keep: milestone.description });
		const targetDate = readDate(body, 'targetDate', { nullable: true, keep: milestone.targetDate });
		const status = readChoice(body, 'status', { from: STATUSES, keep: milestone.status, says: 'status must be open or closed' });
		const boardId = readId(body, 'boardId', { nullable: true, keep: milestone.boardId });

		return { changed: updateMilestone(user, at.milestoneId, { name, description, targetDate, status, boardId }) };
	} catch (e) {
		refused(e);
	}
}

/**
 * Delete the goal and keep the work: its cards are released back to having
 * no milestone, never deleted (`deleteMilestone`). Answers how many were.
 */
export function deleteMilestoneFor(
	caller: SessionUser | null,
	at: { milestoneId: number },
	body: null,
	opts: ServiceOptions
): { released: number } {
	inWrite();
	try {
		return deleteMilestone(requireUser(caller), at.milestoneId);
	} catch (e) {
		refused(e);
	}
}

/**
 * Put a card in the milestone: `POST /api/v1/milestones/:milestoneId/cards`,
 * body `{ cardId }`. The milestone is looked for and the caller checked (404,
 * then 403), then `cardId` is read (400), then the card is looked for. The
 * card's board is told once it has committed.
 */
export function attachCardToMilestone(caller: SessionUser | null, at: { milestoneId: number }, body: RequestBody, opts: ServiceOptions) {
	inWrite();
	try {
		const user = requireUser(caller);
		requireMilestone(user, at.milestoneId, true);
		const cardId = readId(body, 'cardId', { required: true, says: { missing: 'cardId is required' } });
		return cardInOrOut(user, at.milestoneId, cardId, true);
	} catch (e) {
		refused(e);
	}
}

/**
 * Take a card out of the milestone: `DELETE
 * /api/v1/milestones/:milestoneId/cards`, body `{ cardId }`. The card itself
 * is untouched. The milestone must be there and the caller able to change it,
 * and the card must be in it. The card's board is told once it has committed.
 */
export function detachCardFromMilestone(caller: SessionUser | null, at: { milestoneId: number }, body: RequestBody, opts: ServiceOptions) {
	inWrite();
	try {
		const user = requireUser(caller);
		requireMilestone(user, at.milestoneId, true);
		const cardId = readId(body, 'cardId', { required: true, says: { missing: 'cardId is required' } });
		return cardInOrOut(user, at.milestoneId, cardId, false);
	} catch (e) {
		refused(e);
	}
}
