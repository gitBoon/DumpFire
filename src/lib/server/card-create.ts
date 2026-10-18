/**
 * card-create.ts — what a new card records and announces, however it was made.
 *
 * A card is created from the card window and by Duplicate (POST /api/cards),
 * through the API (POST /api/v1/boards/:boardId/cards), and by accepting a
 * task request (PATCH /api/requests/:id). Each wrote its own `card_created`
 * entry, or none, and none of them knew about Complete columns: a card created
 * in one was finished on the board and had no `completedAt`, no XP and no
 * `card_completed` entry, so velocity, the dashboard's figures, board metrics,
 * personal stats and the activity report never counted it (card 2134).
 *
 * Now each route inserts its row and then, inside the same transaction:
 *
 *   1. `recordCardCreated`, which writes the `card_created` entry and, in a
 *      Complete column, completes the card by the rule a move uses
 *      (`completionOf` and `awardXp` in `card-moves.ts`), with its
 *      `card_completed` entry;
 *   2. `announceCardCreated`, which tells people. Nothing it sends leaves
 *      before the transaction has committed, and nothing leaves if it rolls
 *      back.
 *
 * A creation is not a move. The check for open subtasks and sub-boards is not
 * made, because a card that did not exist has neither. Nobody is mailed that
 * it moved, and nothing can have been waiting on it.
 *
 * Access is not checked here. The caller establishes, in the same
 * transaction, that the actor may edit the board the column is on.
 */
import { eq } from 'drizzle-orm';
import { db } from './db';
import { afterCommit, inTransaction } from './db/transaction';
import { cards, type Card, type Column } from './db/schema';
import { isCompleteColumnTitle } from '$lib/column-role';
import { stamp } from '$lib/timestamps';
import { awardXp, celebrateCompletions, completionOf } from './card-moves';
import { emit } from './events';
import { ACTIONS, actorOf, logActivity, type ActivitySource } from './logActivity';
import { notifyRequesterProgress } from './notifications';
import type { SessionUser } from './auth';

/** What a creation recorded. */
export interface CardCreation {
	/** The card as it is written: with its completion stamped, when it was completed. */
	card: Card;
	/** The column it was created in. */
	column: Column;
	boardId: number;
	/** Created in a Complete column, and so completed as it was created. */
	completed: boolean;
	/** XP awarded to the creator for that: a new card has never been completed, so its priority's. */
	xpAwarded: number;
}

/**
 * Record that `card`, just inserted into `column` by `actor`, was created.
 *
 * Writes the `card_created` entry, with the title as its detail. In a Complete
 * column the card is completed as it is created, by the rules of a move: the
 * stamp in one UPDATE, the XP to the creator, and a `card_completed` entry,
 * `"<title>": created in <column>`. Both entries carry the actor and `source`,
 * and each queues its webhook, `card.created` and `card.completed`, for the
 * commit.
 *
 * A savepoint inside the route's transaction, so the card, its entries and
 * its XP are saved together or not at all.
 */
export function recordCardCreated(created: {
	card: Card;
	column: Column;
	actor: SessionUser;
	source: ActivitySource;
}): CardCreation {
	return inTransaction(() => record(created));
}

function record({
	card,
	column,
	actor,
	source
}: {
	card: Card;
	column: Column;
	actor: SessionUser;
	source: ActivitySource;
}): CardCreation {
	const who = { ...actorOf(actor), source, boardId: column.boardId, cardId: card.id };

	// Without it there was no way to find work that had been raised and not yet
	// started, and no record of who raised it: `createdBy` answers the second half.
	logActivity({ ...who, action: ACTIONS.cardCreated, detail: card.title });

	if (!isCompleteColumnTitle(column.title)) {
		return { card, column, boardId: column.boardId, completed: false, xpAwarded: 0 };
	}

	const { stamp: completion, xp } = completionOf(card, stamp());
	const written = db.update(cards).set(completion).where(eq(cards.id, card.id)).returning().get();
	awardXp(actor, xp);
	logActivity({ ...who, action: ACTIONS.cardCompleted, detail: `"${card.title}": created in ${column.title}` });

	return { card: written, column, boardId: column.boardId, completed: true, xpAwarded: xp };
}

/**
 * Tell people about a card `recordCardCreated` recorded.
 *
 * The live `created` update to its board, which every creating route sent
 * (and accepting a request did not). For a card completed as it was created,
 * the XP and celebration events a completed move sends, and the requester's
 * "Your request is complete" mail with its report, which goes only when the
 * card is the one an accepted request made.
 *
 * Nothing here is sent until the transaction has committed, and nothing is
 * sent if it rolls back. A failure in it is logged and fails nothing.
 */
export function announceCardCreated(creation: CardCreation, actor: SessionUser, baseUrl: string | null): void {
	afterCommit(() => sendAnnouncements(creation, actor, baseUrl));
}

function sendAnnouncements(creation: CardCreation, actor: SessionUser, baseUrl: string | null): void {
	const { card, column, boardId } = creation;

	emit(boardId, 'update', {
		type: 'card',
		action: 'created',
		cardTitle: card.title,
		userName: actor.username,
		userEmoji: actor.emoji || '👤'
	});

	if (!creation.completed) return;

	celebrateCompletions(boardId, [creation], actor);
	notifyRequesterProgress({
		cardId: card.id,
		action: 'completed',
		summary: `created in ${column.title}`,
		actorName: actor.username,
		baseUrl,
		toColumn: column.title,
		actorUserId: actor.id
	});
}
