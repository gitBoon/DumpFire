/**
 * cross-board-cards.ts — the cards of every board the caller can open, read
 * once for the pages that list them across boards (card 2240).
 *
 * All Tasks read them in its own load, and each access fix of milestone 17
 * touched that reading. All To Do lists the same cards, only those of the To
 * Do columns, so the reading moved here and both pages call it: one place to
 * keep right, and the two pages agree card for card.
 *
 * What a caller is given is All Tasks' rule, unchanged by the move:
 *   - the boards in `getAccessibleBoardIds()`, every one to an administrator;
 *   - the card categories of `cardCategoriesFor`, a carried one marked, and
 *     the groupings of `boardCategoriesFor` (card 2128);
 *   - each board's place in the tree from `placeBoards`, naming no board above
 *     it that the caller cannot open (card 1990);
 *   - each card's open blockers, one on a board the caller cannot open
 *     withheld (card 2129);
 *   - the names of the cards' milestones the caller may open, and of no
 *     other (card 2257): a card still carries its milestone's id;
 *   - a request origin by the requester's name, never their address.
 */
import { db } from '$lib/server/db';
import { boards, columns, cards, subtasks, labels, cardLabels, cardAssignees, users, taskRequests } from '$lib/server/db/schema';
import { asc, inArray, isNull, and } from 'drizzle-orm';
import { getAccessibleBoardIds, type Actor } from '$lib/server/board-access';
import { boardCategoriesFor, cardCategoriesFor } from '$lib/server/list-access';
import { getBlockedStateForCards } from '$lib/server/planning';
import { milestoneNamesForCards } from '$lib/server/milestones';
import { boardAncestry } from '$lib/server/board-tree';
import { placeBoards } from '$lib/board-tree';
import { SUBTASK_ORDER } from '$lib/server/subtask-order';
import { CARD_ORDER, COLUMN_ORDER } from '$lib/server/card-order';

type ColumnRow = typeof columns.$inferSelect;

export type CrossBoardOptions = {
	/**
	 * Which columns' cards to read; every column's when it is left out. Asked
	 * of the columns before any card is read, so a page that wants one column
	 * of each board reads only those cards.
	 */
	inColumn?: (column: ColumnRow) => boolean;
};

export function readCrossBoardCards(user: Actor, options: CrossBoardOptions = {}) {
	// Get board IDs this user can access (null = admin, sees all). Read once
	// and handed to the card categories, the groupings and the blockers below,
	// each of which read it again for itself: four times a load (card 2394).
	const accessibleIds = getAccessibleBoardIds(user);

	let allBoards: (typeof boards.$inferSelect)[];
	if (accessibleIds === null) {
		allBoards = db.select().from(boards).all();
	} else if (accessibleIds.length === 0) {
		allBoards = [];
	} else {
		// Only the caller's, in the order of their ids, as the table gave them
		// (card 2399): the whole table was read, and each board looked for in
		// the list.
		allBoards = db.select().from(boards).where(inArray(boards.id, accessibleIds)).orderBy(asc(boards.id)).all();
	}

	const accessibleBoardIds = allBoards.map(b => b.id);
	const allColumns = accessibleBoardIds.length > 0
		? db.select().from(columns).where(inArray(columns.boardId, accessibleBoardIds)).orderBy(...COLUMN_ORDER).all()
		: [];

	// The columns whose cards are read: every one, or those the page asked for.
	const { inColumn } = options;
	const columnIds = (inColumn ? allColumns.filter(inColumn) : allColumns).map(c => c.id);
	// By position, ties by id (card 2347): a page's bucket takes in a column of
	// every board, and a tie came by the column it was in.
	const allCards = columnIds.length > 0
		? db.select().from(cards).where(and(inArray(cards.columnId, columnIds), isNull(cards.archivedAt))).orderBy(...CARD_ORDER).all()
		: [];

	const cardIds = allCards.map(c => c.id);
	const allSubtasks = cardIds.length > 0
		? db.select().from(subtasks).where(inArray(subtasks.cardId, cardIds)).orderBy(...SUBTASK_ORDER).all()
		: [];

	const allCardLabels = cardIds.length > 0
		? db.select().from(cardLabels).where(inArray(cardLabels.cardId, cardIds)).all()
		: [];

	// Fetch assignees for all cards
	const allAssignments = cardIds.length > 0
		? db.select().from(cardAssignees).where(inArray(cardAssignees.cardId, cardIds)).all()
		: [];
	const allUsers = db.select({ id: users.id, username: users.username, emoji: users.emoji }).from(users).all();
	const userMap = new Map(allUsers.map(u => [u.id, u]));

	// The categories of the boards the caller can open and the shared ones, and
	// any other a card here carries, marked `carried` (card 2128).
	const allCategories = cardCategoriesFor(user, allCards, accessibleIds);

	// Get request origins for cards created from accepted task requests, by the
	// requester's name and not their address, which no screen reads (card 2128's review).
	const requestOrigins = cardIds.length > 0
		? db.select({
			resolvedCardId: taskRequests.resolvedCardId,
			requesterName: taskRequests.requesterName,
			title: taskRequests.title
		}).from(taskRequests).where(inArray(taskRequests.resolvedCardId, cardIds)).all()
		: [];
	const requestOriginMap = new Map(requestOrigins.map(r => [r.resolvedCardId, r]));

	const allLabels = accessibleBoardIds.length > 0
		? db.select().from(labels).where(inArray(labels.boardId, accessibleBoardIds)).all()
		: [];

	// Build a map of column id -> column info (with board name)
	const columnMap = new Map<number, { title: string; boardId: number }>();
	for (const col of allColumns) {
		columnMap.set(col.id, { title: col.title, boardId: col.boardId });
	}

	// The groupings the caller is listed (card 2128), and a lookup map. Every
	// board here is one they can open, so its grouping is among them.
	const allBoardCategories = boardCategoriesFor(user, accessibleIds);
	const boardCatMap = new Map(allBoardCategories.map(bc => [bc.id, bc]));

	const boardMap = new Map<number, { name: string; emoji: string; categoryId: number | null }>();
	for (const b of allBoards) {
		boardMap.set(b.id, { name: b.name, emoji: b.emoji || '📋', categoryId: b.categoryId });
	}

	// Where each board sits in the tree (card 1990): the nearest board above it
	// that the caller can open, whether boards they cannot open come between,
	// and the category the filter counts it in, its own or that of the nearest
	// board above it the caller can open, and none for a category since
	// deleted. The page builds each board's path from these. Choosing a board
	// or a category then takes in its sub-boards, and a card's tag names the
	// boards its board hangs beneath.
	const places = placeBoards(allBoards, boardAncestry(accessibleBoardIds), allBoardCategories.map((c) => c.id));

	// Build enriched cards with board info
	const enrichedCards = allCards.map(card => {
		const colInfo = columnMap.get(card.columnId);
		const boardInfo = colInfo ? boardMap.get(colInfo.boardId) : null;
		const assignees = allAssignments
			.filter(a => a.cardId === card.id)
			.map(a => userMap.get(a.userId))
			.filter(Boolean) as { id: number; username: string; emoji: string | null }[];
		const boardCat = boardInfo?.categoryId ? boardCatMap.get(boardInfo.categoryId) : null;
		const ro = requestOriginMap.get(card.id);
		return {
			...card,
			subtasks: allSubtasks.filter(st => st.cardId === card.id),
			labelIds: allCardLabels.filter(cl => cl.cardId === card.id).map(cl => cl.labelId),
			assignees,
			requestOrigin: ro ? { requesterName: ro.requesterName, requestTitle: ro.title } : null,
			boardName: boardInfo?.name || 'Unknown',
			boardEmoji: boardInfo?.emoji || '📋',
			boardId: colInfo?.boardId || 0,
			boardCategoryName: boardCat?.name || null,
			boardCategoryColor: boardCat?.color || null,
			columnTitle: colInfo?.title || 'Unknown'
		};
	});

	// Blocked state and milestone names for every card read, in one pass each.
	// These pages span every accessible board and can run to thousands of
	// cards, so a per-card lookup is not an option: these take the ids already
	// loaded. A blocker on a board the caller cannot open is withheld (card 2129),
	// and a milestone the caller cannot open is not named (card 2257).
	const blockedState = getBlockedStateForCards(cardIds, user, accessibleIds);
	const milestoneNames = milestoneNamesForCards(user, cardIds);

	return {
		// What a page reads of each board and no more: not its parent card,
		// which is on a board the caller may not be able to open, nor its
		// maker, category or dates (card 1990's review).
		boards: allBoards.map(b => {
			const { name, emoji } = boardMap.get(b.id)!;
			return { id: b.id, name, emoji, ...places.get(b.id)! };
		}),
		/** Every column of those boards, by position, whichever `inColumn` let through. */
		columns: allColumns,
		cards: enrichedCards,
		labels: allLabels,
		categories: allCategories,
		boardCategories: allBoardCategories,
		/** Every user, by id, name and emoji as stored (null when none was chosen). */
		users: allUsers,
		blockedState,
		milestoneNames
	};
}
