/**
 * card-moves.ts — the one way a card changes column.
 *
 * A card can be moved by dragging it (PUT /api/cards/reorder), from the All
 * Tasks page or the card modal (PUT /api/cards/:id with a `columnId`), and
 * through the API (PUT /api/v1/cards/:id/move). Each route used to carry its
 * own copy of what a move means, and the copies disagreed:
 *
 *   - XP was awarded by two of the three, so completing a card from the modal
 *     earned nothing;
 *   - the activity entry was written by the server and then again by the
 *     browser, the second time with no user id;
 *   - `completedAt` was never cleared by any of them, so a card dragged back
 *     out of Complete went on counting as completed in every report;
 *   - a card moved to another board kept its old board's labels on one route
 *     and lost them on another;
 *   - a card moved out of an On Hold column lost its on-hold note only when
 *     the board page's drop sent a second request to clear it; every route
 *     kept it, and here it is cleared in the move itself (card 2208).
 *
 * Now every route does the same three things, the first two inside one
 * `inTransaction` and in this order:
 *
 *   1. `applyCardMove` for each card. It changes the database and nothing else.
 *   2. `recordUnblockedByMoves`, once, after the last move: the "Unblocked"
 *      notices for whatever those moves left with nothing blocking it.
 *   3. `announceCardMoves`, which tells people. Nothing it sends leaves before
 *      the transaction has committed, and nothing leaves if it rolls back.
 *
 * They are separate so a caller moving several cards can apply them all before
 * a notice is written or anyone is notified of any.
 *
 * A card's sub-boards go with it. So a card is never moved onto one of its own
 * sub-boards, or onto a board beneath one at any depth: the sub-board would
 * then hang beneath itself, a loop with no top, which is on no dashboard and
 * which the board page's breadcrumbs used to follow for ever (cards 2141 and
 * 2142). The two routes that move a card to another board, the v1 move and
 * the card update with a `columnId`, saved such a move; the reorder refuses
 * any move across boards. `applyCardMove` refuses it, 409, before anything is
 * written, for every route at once. And, for the same two routes, a move that
 * would nest the card's sub-boards deeper than sub-boards may be, and deeper
 * than they are now (card 2172).
 *
 * Access is not checked here. The caller establishes, in the same transaction,
 * that the actor may edit both the card's board and the target column's board.
 */
import { and, eq, inArray } from 'drizzle-orm';
import { db } from './db';
import { afterCommit, inTransaction } from './db/transaction';
import {
	boards,
	cardLabels,
	cards,
	categories,
	columns,
	labels,
	milestones,
	userXp,
	type Card,
	type Column
} from './db/schema';
import { columnRole } from '$lib/column-role';
import { stamp } from '$lib/timestamps';
import { getCompletionBlocker } from './card-completion';
import { emit } from './events';
import { ACTIONS, logActivity, type ActivitySource } from './logActivity';
import { logCardLeftGoal } from './milestones';
import { notifyCardMoved, notifyRequesterProgress } from './notifications';
import { announceUnblocked, recordUnblocked, withholdNoticesNaming, withholdUnblockNotices, type UnblockedWork } from './planning';
import { moveTooDeep, tooDeepToMove, wouldLoopAny } from './sub-boards';
import type { SessionUser } from './auth';

/**
 * What one drag and drop (`PUT /api/cards/reorder`) may ask for (card 2209).
 *
 * Two numbers, not one, because entries cost two different things. An entry
 * that only changes a card's position is one write and nothing more. The
 * board page sends every card of the columns a drop touches, the one dropped
 * into and the one the card came from (card 2213; it sent every card of the
 * board), so the cap on entries sits far above any real drop. A card moved to
 * another column writes an activity entry, goes to every webhook of the board
 * and mails its assignees, which is the burst worth bounding, and only a bulk
 * move of selected cards moves more than one. Nothing but the body's size bounded
 * either: about 11,000 entries, and as many cards moved.
 */
export const MAX_REORDER_ENTRIES = 5000;
export const MAX_CARDS_MOVED_AT_ONCE = 100;

/** A number as the refusals write it: 5,000. */
const counted = (n: number) => n.toLocaleString('en-GB');

/** The refusal of a reorder that names more than `MAX_REORDER_ENTRIES` cards. It names no card. */
export function reorderTooLarge(n: number): string {
	return `A reorder can name at most ${counted(MAX_REORDER_ENTRIES)} cards, and this names ${counted(n)}. Nothing was moved.`;
}

/** The refusal of a reorder that moves more than `MAX_CARDS_MOVED_AT_ONCE` cards to another column. */
export function tooManyMoved(n: number): string {
	return `At most ${counted(MAX_CARDS_MOVED_AT_ONCE)} cards can be moved to another column at once, and this moves ${counted(n)}. Nothing was moved: move them in groups of ${counted(MAX_CARDS_MOVED_AT_ONCE)} or fewer.`;
}

/** XP for completing a card for the first time, by priority. */
const XP_BY_PRIORITY: Record<string, number> = { low: 50, medium: 100, high: 150, critical: 200 };
const DEFAULT_XP = 100;

/** A move that cannot go ahead. `status` is the HTTP status the route should answer with. */
export class CardMoveError extends Error {
	constructor(
		public readonly status: number,
		message: string
	) {
		super(message);
		this.name = 'CardMoveError';
	}
}

/** What a move did. */
export interface CardMove {
	/** The card as it is after the move. */
	card: Card;
	fromColumn: Column;
	toColumn: Column;
	fromBoardId: number;
	toBoardId: number;
	/** False for a change of position within the same column. */
	changedColumn: boolean;
	crossBoard: boolean;
	/** Entered a Complete column from a column that was not one. */
	completed: boolean;
	/** Left a Complete column for a column that is not one. */
	reopened: boolean;
	/** XP awarded to the actor: non-zero only the first time a card is ever completed. */
	xpAwarded: number;
	/**
	 * The milestone a move to another board took the card out of: one of a
	 * board other than the one it arrived on (card 2155). `ofSourceBoard` is
	 * false for a milestone of a third board, which only data from before the
	 * rule can give. Null for every other move.
	 */
	leftMilestone: { id: number; name: string; ofSourceBoard: boolean } | null;
}

/**
 * The milestone a move took the card out of, as the mover is told it (the
 * review's O3): one of the board the card left, which they could edit and so
 * may read. A third board's, which only older data can give, is not named,
 * as the source board's `card_moved_away` entry does not name it. Null for
 * every other move, and for no move.
 */
export function leftMilestoneOf(move: CardMove | null): { id: number; name: string } | null {
	const left = move?.leftMilestone;
	return left && left.ofSourceBoard ? { id: left.id, name: left.name } : null;
}

export interface MoveRequest {
	cardId: number;
	toColumnId: number;
	/** Position in the target column. Left as it is when omitted. */
	position?: number;
	actor: SessionUser;
	/** Where the move came from; recorded on the activity entry. */
	source: ActivitySource;
}

/**
 * Move a card to a column, and record everything that follows from it.
 *
 * In one transaction, so a failure part way leaves the card exactly where it
 * was: the card's column and position, `completedAt` (set on completion,
 * cleared on reopening), `firstCompletedAt`, the on-hold note (cleared when
 * the card leaves a hold column for one that is not, card 2208, with no entry
 * of its own: the move's entry is the record), labels, a board-owned category
 * and a milestone of a board that cannot follow it to another board (card
 * 2155), the names of finished work in its "Unblocked" notices on such a move
 * (card 2256), and its own name in other cards' notices (card 2261), the
 * actor's XP, and the activity
 * entry — one per move, carrying the actor's id and the source. The card and
 * both columns are read inside that transaction too, so the move is decided on
 * the rows it then writes.
 *
 * A route calls this inside its own `inTransaction`, where it is a savepoint
 * and is committed or rolled back with the rest of the request.
 *
 * Throws `CardMoveError` (404) if the card or the column is missing, (409) if
 * the target column is on one of the card's own sub-boards, at any depth, or
 * would put them deeper than `MAX_SUB_BOARD_DEPTH`, and (409) if the card is
 * being completed while subtasks or sub-boards are still open.
 */
export function applyCardMove(request: MoveRequest): CardMove {
	return inTransaction(() => moveCard(request));
}

function moveCard(request: MoveRequest): CardMove {
	const { cardId, toColumnId, actor, source } = request;

	const before = db.select().from(cards).where(eq(cards.id, cardId)).get();
	if (!before) throw new CardMoveError(404, 'Card not found');

	const fromColumn = db.select().from(columns).where(eq(columns.id, before.columnId)).get();
	if (!fromColumn) throw new CardMoveError(404, 'Card not found');

	const toColumn = db.select().from(columns).where(eq(columns.id, toColumnId)).get();
	if (!toColumn) throw new CardMoveError(404, 'Target column not found');

	const changedColumn = fromColumn.id !== toColumn.id;
	const crossBoard = fromColumn.boardId !== toColumn.boardId;
	const position = request.position ?? before.position;

	// First, for a move to another board: onto a board beneath the card, or
	// where its sub-boards would be nested too deep, it is refused whatever else
	// it would do. A move within one board cannot change the tree, so it is not
	// looked at.
	if (crossBoard) {
		const hanging = db.select({ id: boards.id }).from(boards).where(eq(boards.parentCardId, before.id)).all();
		refuseLoop(before, hanging, toColumn.boardId);
		refuseTooDeep(before, hanging, fromColumn.boardId, toColumn.boardId);
	}

	// A change of position within a column is not an edit to the card — nothing
	// about it changed, only its neighbours — so nothing else is touched. The
	// web application's card update sends a changed position here too (card
	// 2288), so a drag, the v1 move and that update record it alike.
	if (!changedColumn) {
		if (position !== before.position) {
			db.update(cards).set({ position }).where(eq(cards.id, cardId)).run();
		}
		return {
			card: { ...before, position },
			fromColumn,
			toColumn,
			fromBoardId: fromColumn.boardId,
			toBoardId: toColumn.boardId,
			changedColumn: false,
			crossBoard: false,
			completed: false,
			reopened: false,
			xpAwarded: 0,
			leftMilestone: null
		};
	}

	const wasComplete = columnRole(fromColumn.title) === 'complete';
	const isComplete = columnRole(toColumn.title) === 'complete';
	const completed = isComplete && !wasComplete;
	const reopened = wasComplete && !isComplete;

	if (completed) {
		const blocker = getCompletionBlocker(cardId, actor);
		if (blocker) throw new CardMoveError(409, blocker);
	}

	const now = stamp();
	// The stamp and the XP by the one rule a creation uses too: see completionOf.
	const completion = completed ? completionOf(before, now) : null;
	const xpAwarded = completion?.xp ?? 0;

	let leftMilestone: CardMove['leftMilestone'] = null;
	/** The goal the card leaves, as its entry names it (card 2381). */
	let leftGoalRow: { id: number; name: string; boardId: number | null } | null = null;
	const update: Partial<typeof cards.$inferInsert> = {
		columnId: toColumn.id,
		position,
		// Moving a card IS an edit, and `updatedAt` has to say so. A card
		// dragged across the board used to keep `updatedAt === createdAt` and
		// was reported as raised and never touched.
		updatedAt: now
	};
	if (completion) Object.assign(update, completion.stamp);
	// A reopened card is not complete. Leaving the date in place kept it in
	// every completion count and average for as long as it lived.
	if (reopened) update.completedAt = null;
	// An on-hold note is the reason a card is paused, and a card that leaves
	// the pause has none (card 2208). Only the board page's drop cleared it,
	// with a second request; every other route kept it, and the activity
	// report went on counting the card as on hold wherever it was. A move
	// between two hold columns, or into one, keeps it: the work is still
	// paused, and the page writes a new note before a move into hold.
	if (columnRole(fromColumn.title) === 'hold' && columnRole(toColumn.title) !== 'hold' && before.onHoldNote) {
		update.onHoldNote = '';
	}

	if (crossBoard) {
		// Labels belong to a board and cannot follow the card off it.
		const sourceLabelIds = db
			.select({ id: labels.id })
			.from(labels)
			.where(eq(labels.boardId, fromColumn.boardId))
			.all()
			.map((l) => l.id);
		if (sourceLabelIds.length > 0) {
			db.delete(cardLabels)
				.where(and(eq(cardLabels.cardId, cardId), inArray(cardLabels.labelId, sourceLabelIds)))
				.run();
		}

		// Nor can a category owned by another board. A shared one (no board)
		// is everybody's and stays.
		if (before.categoryId !== null) {
			const category = db
				.select({ boardId: categories.boardId })
				.from(categories)
				.where(eq(categories.id, before.categoryId))
				.get();
			if (category && category.boardId !== null && category.boardId !== toColumn.boardId) {
				update.categoryId = null;
			}
		}

		// Nor a milestone of another board (card 2155). A milestone of a board
		// holds only that board's cards, as putting one in it already insists
		// (`setCardMilestone`, the bulk attach): its viewers read every card's
		// title and count it in the goal's progress. A goal across boards (no
		// board) keeps its cards, and so does one of the board the card arrives
		// on. Written in the same update of the card, so the move makes no write
		// more than it did.
		if (before.milestoneId !== null) {
			const goal = db
				.select({ id: milestones.id, name: milestones.name, boardId: milestones.boardId })
				.from(milestones)
				.where(eq(milestones.id, before.milestoneId))
				.get();
			if (goal && goal.boardId !== null && goal.boardId !== toColumn.boardId) {
				update.milestoneId = null;
				leftMilestone = { id: goal.id, name: goal.name, ofSourceBoard: goal.boardId === fromColumn.boardId };
				leftGoalRow = goal;
			}
		}

		// Nor the names in its "Unblocked" notices (card 2256). A notice names
		// finished work by its title only when the work is on the card's board,
		// and the comment goes with the card, to readers who may not be able to
		// open the board the work is on. Rewritten to the withheld form here, so
		// a move that fails takes the rewrite back with it. And the card's own
		// name, and its subtasks', in other cards' notices, on every card not on
		// the board it arrives on (card 2261): the notice was written because the
		// card was on theirs.
		withholdUnblockNotices(cardId, toColumn.boardId);
		withholdNoticesNaming(cardId, toColumn.boardId);
	}

	const after = db.update(cards).set(update).where(eq(cards.id, cardId)).returning().get();

	awardXp(actor, xpAwarded);

	const who = { userId: actor.id, userName: actor.username, userEmoji: actor.emoji || '👤', source };
	const route = `${fromColumn.title} → ${toColumn.title}`;

	if (crossBoard) {
		// Leaving one board and arriving on another are two facts, one for
		// each board's history. Neither names the other board (card 2181): an
		// entry is stored once and read by everyone who can open its board,
		// some of whom cannot open the other one. Each entry is on its own
		// board, so the pair still records both, and someone who can open both
		// reads each under its board's name (All Tasks, the audit logs, the
		// board history). The columns stay: they are the route, not the board.
		// Leaving a milestone of the board it left is said on that board's
		// (decision 11 of card 2155): its readers can open the milestone. One
		// of a third board is not named there.
		const leftGoal = leftMilestone
			? leftMilestone.ofSourceBoard
				? ` and out of milestone "${leftMilestone.name}"`
				: ' and out of a milestone of another board'
			: '';
		logActivity({
			...who,
			boardId: fromColumn.boardId,
			cardId,
			action: ACTIONS.cardMovedAway,
			detail: `"${before.title}" moved to another board (${route})${leftGoal}`
		});
		// And the goal's own entry for it, on the board it left, the one it
		// was on while it was in the goal, where the goal's webhooks are (card
		// 2381): `milestone.card_removed`, which a receiver mirroring the goal
		// listens for. It sent only `card.moved`, with the words above.
		if (leftGoalRow) {
			logCardLeftGoal(actor, source, { boardId: fromColumn.boardId, cardId, title: before.title }, leftGoalRow, 'moved to another board');
		}
		logActivity({
			...who,
			boardId: toColumn.boardId,
			cardId,
			action: ACTIONS.cardMovedIn,
			detail: `"${before.title}" moved from another board (${route})`
		});
	}

	// A completion is logged as a completion and a reopening as a reopening,
	// not as moves, so one query over `card_completed` counts every completion
	// however it was made. A plain move between boards is already recorded by
	// the two entries above.
	if (completed || reopened || !crossBoard) {
		logActivity({
			...who,
			boardId: toColumn.boardId,
			cardId,
			action: completed
				? ACTIONS.cardCompleted
				: reopened
					? ACTIONS.cardReopened
					: ACTIONS.cardMoved,
			detail: `"${before.title}": ${route}`
		});
	}

	return {
		card: after,
		fromColumn,
		toColumn,
		fromBoardId: fromColumn.boardId,
		toBoardId: toColumn.boardId,
		changedColumn: true,
		crossBoard,
		completed,
		reopened,
		xpAwarded,
		leftMilestone
	};
}

/**
 * Refuse, 409, a move of `card` onto board `toBoardId` when that board is one
 * of the card's own sub-boards or beneath one, at any depth.
 *
 * The card's sub-boards go wherever it goes, so they are asked together
 * whether hanging them under a card on the target board would make a loop
 * (`wouldLoopAny`). A card with no sub-board costs one read, of its
 * sub-boards, made once for this and `refuseTooDeep`; one with any, two,
 * however many it has: one walk up from the target, a query that ends
 * on a loop already elsewhere in the data. A move out of a loop, onto a board
 * outside it, is allowed, and is how one is repaired.
 *
 * The message names the card and the target board, both of which the caller
 * has just been found able to edit. "Hangs beneath it" is true at any depth,
 * where "one of its own sub-boards" was not two levels down.
 */
function refuseLoop(card: Card, hanging: { id: number }[], toBoardId: number): void {
	if (wouldLoopAny(hanging.map((board) => board.id), toBoardId)) {
		throw new CardMoveError(409, `Card "${card.title}" cannot go onto "${boardName(toBoardId)}", which hangs beneath it`);
	}
}

/**
 * Refuse, 409, a move of `card`, which carries the sub-boards `hanging`, from
 * board `fromBoardId` onto board `toBoardId` when they would then be nested
 * deeper than sub-boards may be, and deeper than they are now (card 2172). A
 * card with no sub-board costs nothing more; one with any, two reads, and the
 * levels it carries are counted only when the target is the deeper board. A
 * move that lifts a tree already too deep is allowed, and is how it is put
 * right. The message names the card and the target board, as `refuseLoop`'s.
 */
function refuseTooDeep(card: Card, hanging: { id: number }[], fromBoardId: number, toBoardId: number): void {
	if (hanging.length === 0) return;
	if (moveTooDeep(card.id, fromBoardId, toBoardId)) {
		throw new CardMoveError(409, tooDeepToMove(card.title, boardName(toBoardId)));
	}
}

/**
 * A board's name, for the two refusals above only: they go to the mover, who
 * has been found able to edit the target board. The move's entries and events
 * name no board (card 2181).
 */
function boardName(boardId: number): string {
	return (
		db.select({ name: boards.name }).from(boards).where(eq(boards.id, boardId)).get()?.name ??
		'Unknown'
	);
}

/** What completing a card writes on it, and the XP it earns. */
export interface Completion {
	/** `completedAt`, and `firstCompletedAt` when the card has never been completed before. */
	stamp: { completedAt: string; firstCompletedAt?: string };
	/** XP for whoever completed it: non-zero only the first time the card is ever completed. */
	xp: number;
}

/**
 * What completing this card at `now` writes on it and earns, without writing
 * anything.
 *
 * The one rule, for a card moved into a Complete column and for one created
 * in one (`card-create.ts`, card 2134), so the two cannot drift apart and the
 * format of the date is set in one place. `completedAt` is `now`. XP goes once
 * per card, ever, by priority: `firstCompletedAt` is the record of that, set
 * only by the first completion. A card completed before that column existed
 * had it backfilled from `completedAt`.
 */
export function completionOf(card: Pick<Card, 'priority' | 'firstCompletedAt'>, now: string): Completion {
	if (card.firstCompletedAt) return { stamp: { completedAt: now }, xp: 0 };
	return {
		stamp: { completedAt: now, firstCompletedAt: now },
		xp: XP_BY_PRIORITY[card.priority] ?? DEFAULT_XP
	};
}

/**
 * Add `xp` to the actor's total, which is kept by username. Nothing for 0.
 *
 * Written where it is called, inside the caller's transaction: the XP is saved
 * with the completion that earned it or not at all.
 */
export function awardXp(actor: Pick<SessionUser, 'username' | 'emoji'>, xp: number): void {
	if (xp <= 0) return;
	const existing = db.select().from(userXp).where(eq(userXp.name, actor.username)).get();
	if (existing) {
		db.update(userXp)
			.set({ xp: existing.xp + xp, emoji: actor.emoji || existing.emoji })
			.where(eq(userXp.name, actor.username))
			.run();
	} else {
		db.insert(userXp)
			.values({ name: actor.username, xp, emoji: actor.emoji || '👤' })
			.run();
	}
}

/**
 * Write the "Unblocked" notices for the cards these moves completed.
 *
 * Inside the request's transaction, once, after its last move and as the last
 * write of its body: see `recordUnblocked`. A card that an earlier move of the
 * same drop unblocked and a later one completed gets no notice. The result
 * goes to `announceCardMoves`.
 */
export function recordUnblockedByMoves(moves: CardMove[], actor: SessionUser): UnblockedWork[] {
	return recordUnblocked(
		moves.filter((m) => m.completed).map((m) => m.card.id),
		actor.id
	);
}

/**
 * Tell people about moves that have been applied.
 *
 * Live updates to every board touched, the XP and celebration events, email to
 * the card's assignees and to whoever requested the work, and the "you are no
 * longer blocked" mail and refresh for the notices in `unblocked`, which is
 * what `recordUnblockedByMoves` returned.
 *
 * Nothing here is sent until the transaction that made the moves has
 * committed, and nothing is sent if it rolls back. So it may be called inside
 * that transaction or after it. A failure in it is logged and fails nothing:
 * the moves are saved.
 *
 * Assignees are emailed for a move made in the web UI, and for a completion
 * however it was made (card 2134): a card being finished is news to the people
 * on it whichever way it went. A plain move through the API is not mailed. A
 * script working a board through the API moves cards all day, and mailing
 * each of those moves would bury the people on it. Whoever made the move is
 * never mailed about it, and nor is an assignee who cannot open the board the
 * card is on now (card 2180).
 */
export function announceCardMoves(
	moves: CardMove[],
	unblocked: UnblockedWork[],
	actor: SessionUser,
	source: ActivitySource,
	baseUrl: string | null
): void {
	afterCommit(() => sendAnnouncements(moves, unblocked, actor, source, baseUrl));
}

function sendAnnouncements(
	moves: CardMove[],
	unblocked: UnblockedWork[],
	actor: SessionUser,
	source: ActivitySource,
	baseUrl: string | null
): void {
	const moved = moves.filter((m) => m.changedColumn);
	const userName = actor.username;
	const userEmoji = actor.emoji || '👤';
	const unblockedBy = (cardId: number) =>
		unblocked.filter((u) => u.completed.kind === 'card' && u.completed.id === cardId);

	for (const move of moved) {
		const route = `${move.fromColumn.title} → ${move.toColumn.title}`;

		// Every page move, and a completion by any route: see announceCardMoves.
		if (source === 'ui' || move.completed) {
			notifyCardMoved(
				move.toBoardId,
				move.card.id,
				move.card.title,
				userName,
				move.fromColumn.title,
				move.toColumn.title,
				actor.id,
				baseUrl
			);
		}
		notifyRequesterProgress({
			cardId: move.card.id,
			action: move.completed ? 'completed' : 'moved',
			summary: route,
			actorName: userName,
			baseUrl,
			fromColumn: move.fromColumn.title,
			toColumn: move.toColumn.title,
			actorUserId: actor.id
		});

		// Anything that was waiting on this card may now be startable.
		if (move.completed) announceUnblocked(unblockedBy(move.card.id), actor, baseUrl);

		// Neither event names the other board (card 2181): each goes to every
		// listener of its board, and an event that only makes a page re-read
		// names nothing more than it needs.
		if (move.crossBoard) {
			emit(move.fromBoardId, 'update', {
				type: 'card',
				action: 'moved_away',
				cardTitle: move.card.title,
				fromColumn: move.fromColumn.title,
				toColumn: move.toColumn.title,
				userName,
				userEmoji
			});
			emit(move.toBoardId, 'update', {
				type: 'card',
				action: 'moved_in',
				cardTitle: move.card.title,
				fromColumn: move.fromColumn.title,
				toColumn: move.toColumn.title,
				userName,
				userEmoji
			});
		}
	}

	// One live update per board for the moves that stayed on it, naming the last
	// card moved — a drop that shifts thirty positions is one event, not thirty.
	const sameBoard = new Map<number, CardMove | null>();
	for (const move of moves) {
		if (move.crossBoard) continue;
		const last = sameBoard.get(move.toBoardId) ?? null;
		sameBoard.set(move.toBoardId, move.changedColumn ? move : last);
	}
	for (const [boardId, last] of sameBoard) {
		emit(boardId, 'update', {
			type: 'card',
			action: last ? 'moved' : 'reorder',
			cardTitle: last?.card.title,
			fromColumn: last?.fromColumn.title,
			toColumn: last?.toColumn.title,
			userName,
			userEmoji
		});
	}

	const completions = moved.filter((m) => m.completed);
	const lastCompleted = completions.at(-1);
	if (lastCompleted) celebrateCompletions(lastCompleted.toBoardId, completions, actor);
}

/**
 * The XP and celebration events for cards just completed, on `boardId`:
 * `xp-update` when any XP was earned, then one `celebrate`, naming the last
 * card completed and the XP for all of them. Nothing for none.
 *
 * Sent for the completions of a move and for a card created in a Complete
 * column (`card-create.ts`). Each `emit` waits for the commit when it is
 * called inside a transaction.
 */
export function celebrateCompletions(
	boardId: number,
	completions: readonly { card: Pick<Card, 'title'>; xpAwarded: number }[],
	actor: SessionUser
): void {
	const last = completions.at(-1);
	if (!last) return;
	const xpGained = completions.reduce((sum, c) => sum + c.xpAwarded, 0);
	if (xpGained > 0) emit(boardId, 'xp-update', {});
	emit(boardId, 'celebrate', {
		type: 'complete',
		cardTitle: last.card.title,
		userName: actor.username,
		userEmoji: actor.emoji || '👤',
		xpGained
	});
}
