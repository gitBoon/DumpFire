/**
 * board-contents.ts — everything the board page draws, read in one place
 * (card 2280, slice B1 of card 2012's part B).
 *
 * The board page's load called this, and so does `GET
 * /api/boards/[id]/contents`, which the page is to read instead of re-running
 * its whole load after every change. One reader, so the page's first draw and
 * every refresh after it cannot differ: the same access check, the same
 * fields, each as this caller may see it.
 *
 * It answers the board row, the breadcrumbs and the caller's role as well as
 * the work on the board (card 2012, R6): a rename by someone else follows on
 * the next refresh, and so does a role taken away or given.
 *
 * A read, never a write: it takes the caller as they are signed in, and the
 * board page's load and the route's `GET` call it as they are.
 */
import { db } from './db';
import { boards, columns, cards, subtasks, cardLabels, labels, boardMembers, boardTeams, users, cardAssignees, teamMembers, taskRequests, type Board } from './db/schema';
import { eq, inArray, isNull, and } from 'drizzle-orm';
import { error } from '@sveltejs/kit';
import { getAccessibleBoardIds, roleOnBoard, type Actor } from './board-access';
import { getBoardBlockedState, WITHHELD_BOARD_NAME } from './planning';
import { getCardTokenTotals, getBoardTokenTotals } from './tokens';
import { milestonesForBoard } from './milestones';
import { linkableBoards, MAX_SUB_BOARD_DEPTH } from './sub-boards';
import { cardCategoriesFor, hiddenOpenCountsFor, subBoardsFor } from './list-access';
import { subBoardProgress } from './card-completion';
import { SUBTASK_ORDER } from './subtask-order';
import { CARD_ORDER, COLUMN_ORDER } from './card-order';
import type { SessionUser } from './auth';

/** One board above this one, as the page's breadcrumbs show it. */
export type BreadcrumbItem = { label: string; emoji: string; href: string | null; title?: string };

/**
 * The boards above `board`, nearest last, as `user` may be told of them.
 *
 * An ancestor the caller cannot open is shown as "🔒 A board you cannot
 * open", with no link (card 2130): a sub-board can be shared with someone who
 * was never given the board above it, and they were told its name. It stays
 * in the chain, which is how the page knows this is a sub-board and offers
 * Delete Sub-board.
 *
 * Each board once (card 2142). A board can hang beneath one of its own cards:
 * a card moved onto its own sub-board before card 2141, the legacy import or a
 * restored backup. This walk then went round that loop for ever, holding the
 * one Node thread, and the server stopped for every user. Now a loop is shown
 * once round, closing on the board it came back to, so a board in one still
 * reads as the sub-board it is.
 *
 * And at most MAX_SUB_BOARD_DEPTH boards (card 2172). Sub-boards cannot be
 * made, linked or moved deeper than that, but a tree already deeper keeps
 * working: its nearest 20 boards are shown, and above them one crumb "…" with
 * no link says there are more. The walk reads three rows a level, the card,
 * its column and its board, so at most 61 however deep the tree. Whether the
 * caller may open each board is asked of the row already read
 * (`roleOnBoard`): `canViewBoard` read each crumb's board again (card 2172's
 * note). For anyone but an administrator it still reads the membership, team
 * and team-access rows it needs, up to three more a crumb.
 */
export function breadcrumbsFor(user: Actor, board: Board): BreadcrumbItem[] {
	const breadcrumbs: BreadcrumbItem[] = [];
	const MORE_ABOVE: BreadcrumbItem = { label: '…', emoji: '', href: null, title: 'More boards above' };

	const walked = new Set<number>([board.id]);
	let currentBoard = board;
	while (currentBoard.parentCardId) {
		// Find the parent card
		const parentCard = db.select().from(cards).where(eq(cards.id, currentBoard.parentCardId)).get();
		if (!parentCard) break;

		// Twenty shown, and there is a board above the last of them.
		if (breadcrumbs.length === MAX_SUB_BOARD_DEPTH) {
			breadcrumbs.unshift(MORE_ABOVE);
			break;
		}

		// Find the column to get the board
		const parentCol = db.select().from(columns).where(eq(columns.id, parentCard.columnId)).get();
		if (!parentCol) break;

		const parentBoard = db.select().from(boards).where(eq(boards.id, parentCol.boardId)).get();
		if (!parentBoard) break;

		breadcrumbs.unshift(
			roleOnBoard(user, parentBoard) !== null
				? { label: parentBoard.name, emoji: parentBoard.emoji || '📋', href: `/board/${parentBoard.id}` }
				: { label: WITHHELD_BOARD_NAME, emoji: '🔒', href: null }
		);

		// The loop closes here. By id, whoever can open the board.
		if (walked.has(parentBoard.id)) break;
		walked.add(parentBoard.id);
		currentBoard = parentBoard;
	}
	return breadcrumbs;
}

/**
 * What the board page draws for `user`, or the load's refusal: 404 for a
 * board that is not there, then 403 for one the caller cannot open.
 */
export function readBoardContents(user: SessionUser, boardId: number) {
	const board = db.select().from(boards).where(eq(boards.id, boardId)).get();
	if (!board) error(404, 'Board not found');

	// Access check — admins and board members/teams can view. Asked of the row
	// just read, as `getBoardRole` would ask it after reading it again.
	const userBoardRole = roleOnBoard(user, board);
	if (!userBoardRole) {
		error(403, 'You do not have access to this board');
	}

	const canEdit = userBoardRole === 'admin' || userBoardRole === 'owner' || userBoardRole === 'editor';
	const canManage = userBoardRole === 'admin' || userBoardRole === 'owner';

	// The boards the caller can open, read once and handed to the sub-boards,
	// the hidden open counts, the card categories, the blockers and the
	// milestones below, each of which read it for itself: five times a load,
	// two for a board with no cards (card 2394). Read after the access check,
	// so a refusal reads no more than it did; nothing between the reads and
	// this one awaits, so it is the same answer.
	const accessible = getAccessibleBoardIds(user);

	const breadcrumbs = breadcrumbsFor(user, board);

	const boardColumns = db
		.select()
		.from(columns)
		.where(eq(columns.boardId, boardId))
		.orderBy(...COLUMN_ORDER)
		.all();

	const columnIds = boardColumns.map((c) => c.id);

	const allCards =
		columnIds.length > 0
			? db
					.select()
					.from(cards)
					.where(and(inArray(cards.columnId, columnIds), isNull(cards.archivedAt)))
					// Ties by id (card 2347).
					.orderBy(...CARD_ORDER)
					.all()
			: [];

	// Get all subtasks for all cards in one query
	const cardIds = allCards.map((c) => c.id);
	const allSubtasks =
		cardIds.length > 0
			? db
					.select()
					.from(subtasks)
					.where(inArray(subtasks.cardId, cardIds))
					.orderBy(...SUBTASK_ORDER)
					.all()
			: [];

	// Get all card-label associations
	const allCardLabels =
		cardIds.length > 0
			? db
					.select()
					.from(cardLabels)
					.where(inArray(cardLabels.cardId, cardIds))
					.all()
			: [];

	// Get sub-board info for cards that have sub-boards: those the caller can
	// open (card 2130). One they were never given is not on its card.
	const subBoards = subBoardsFor(user, cardIds, accessible);

	// Build a map of cardId -> sub-boards (supports multiple per card), each
	// with its progress as the completion check counts it: archived cards left
	// out, as the dashboard and the card context leave them out (card 2205).
	type SubBoardInfo = { id: number; name: string; emoji: string; done: number; total: number };
	const subBoardMap = new Map<number, SubBoardInfo[]>();
	const progress = subBoardProgress(subBoards.map((sb) => sb.id));
	for (const sb of subBoards) {
		if (!sb.parentCardId) continue;
		const { done, total } = progress.get(sb.id)!;
		const entry: SubBoardInfo = { id: sb.id, name: sb.name, emoji: sb.emoji || '🗂️', done, total };
		const existing = subBoardMap.get(sb.parentCardId) || [];
		existing.push(entry);
		subBoardMap.set(sb.parentCardId, existing);
	}
	// And how many cards are open on the sub-boards the caller cannot open, by
	// card, with no name: the server refuses to complete the card while there
	// are any, and the page asks before a drop onto Complete (card 2130's review).
	const hiddenOpen = hiddenOpenCountsFor(user, cardIds, accessible);

	// Get card assignees
	const allAssignees = cardIds.length > 0
		? db.select({
			cardId: cardAssignees.cardId,
			userId: cardAssignees.userId,
			username: users.username,
			emoji: users.emoji
		})
		.from(cardAssignees)
		.innerJoin(users, eq(cardAssignees.userId, users.id))
		.where(inArray(cardAssignees.cardId, cardIds))
		.all()
		: [];

	// Get request origins for cards created from accepted task requests. By
	// the requester's name: the address of someone who often has no account
	// went to every viewer of the board, and no screen reads it (card 2128's review).
	const requestOrigins = cardIds.length > 0
		? db.select({
			resolvedCardId: taskRequests.resolvedCardId,
			requesterName: taskRequests.requesterName,
			title: taskRequests.title
		})
		.from(taskRequests)
		.where(inArray(taskRequests.resolvedCardId, cardIds))
		.all()
		: [];
	const requestOriginMap = new Map(requestOrigins.map(r => [r.resolvedCardId, r]));

	// Group cards by column with their subtasks, labels, sub-board info, and assignees
	const columnsWithCards = boardColumns.map((col) => ({
		...col,
		cards: allCards
			.filter((card) => card.columnId === col.id)
			.map((card) => ({
				...card,
				subtasks: allSubtasks.filter((st) => st.cardId === card.id),
				labelIds: allCardLabels.filter((cl) => cl.cardId === card.id).map((cl) => cl.labelId),
				subBoards: subBoardMap.get(card.id) || [],
				hiddenOpenCount: hiddenOpen.get(card.id) ?? 0,
				assignees: allAssignees
					.filter(a => a.cardId === card.id)
					.map(a => ({ id: a.userId, username: a.username, emoji: a.emoji || '👤' })),
				requestOrigin: (() => {
					const ro = requestOriginMap.get(card.id);
					return ro ? { requesterName: ro.requesterName, requestTitle: ro.title } : null;
				})()
			}))
	}));

	// The categories of the boards the caller can open and the shared ones, and
	// any other a card here carries, marked `carried` (card 2128): every
	// board's was sent to the browser.
	const boardCategories = cardCategoriesFor(user, allCards, accessible);

	const boardLabels = db
		.select()
		.from(labels)
		.where(eq(labels.boardId, boardId))
		.all();

	// Get users who have access to this board (for assignee picker)
	const boardUserIds = new Set<number>();

	// Board creator
	if (board.createdBy) boardUserIds.add(board.createdBy);

	// Direct board members
	const directMembers = db.select({ userId: boardMembers.userId })
		.from(boardMembers)
		.where(eq(boardMembers.boardId, boardId))
		.all();
	directMembers.forEach(m => boardUserIds.add(m.userId));

	// Team-based access — get all team members from teams shared with this board
	const sharedTeams = db.select({ teamId: boardTeams.teamId })
		.from(boardTeams)
		.where(eq(boardTeams.boardId, boardId))
		.all();

	if (sharedTeams.length > 0) {
		const teamUserRows = db.select({ userId: teamMembers.userId })
			.from(teamMembers)
			.where(inArray(teamMembers.teamId, sharedTeams.map(t => t.teamId)))
			.all();
		teamUserRows.forEach(r => boardUserIds.add(r.userId));
	}

	// Admins/superadmins can access any board and should be assignable
	const adminUsers = db.select({ id: users.id })
		.from(users)
		.where(inArray(users.role, ['admin', 'superadmin']))
		.all();
	adminUsers.forEach(a => boardUserIds.add(a.id));

	// By name and emoji: no screen reads an address, and every administrator's
	// went to every viewer of the board (card 2128, R1).
	const boardUsers = boardUserIds.size > 0
		? db.select({ id: users.id, username: users.username, emoji: users.emoji })
			.from(users)
			.where(inArray(users.id, Array.from(boardUserIds)))
			.all()
		: [];

	// Open blockers for every card on the board in one pass, so the "Blocked"
	// chip costs one query for the board rather than one request per card face.
	// A blocker on a board the caller cannot open is withheld (card 2129).
	const blockedState = getBoardBlockedState(boardId, user, accessible);

	// Cost per card, one query for the board rather than one per card face.
	// Cards absent from the map have nothing recorded, which the face renders as
	// nothing at all — never as a zero.
	const cardTotals = getCardTokenTotals(cardIds);
	const cardTokens: Record<number, { tokens: number; costUsd: number | null }> = {};
	for (const [id, t] of cardTotals) {
		if (t.entries > 0) cardTokens[id] = { tokens: t.total, costUsd: t.costUsd };
	}
	// Board-wide total for the header strip. Null, not zero, when unrecorded.
	const boardTokenSummary = getBoardTokenTotals([boardId]).get(boardId) ?? null;

	return {
		board,
		breadcrumbs,
		columns: columnsWithCards,
		categories: boardCategories,
		labels: boardLabels,
		// What "Link existing board" offers: what the server would let this
		// caller put under a card here (`$lib/server/sub-boards.ts`). Boards
		// they own, so only boards they can open, which card 2130 asks of it.
		linkableBoards: linkableBoards(user, boardId),
		canEdit,
		canManage,
		userBoardRole,
		boardUsers,
		blockedState,
		cardTokens,
		boardTokenSummary,
		milestones: milestonesForBoard(user, boardId, accessible)
	};
}

/** What the board page draws, as the server reads it. */
export type BoardContents = ReturnType<typeof readBoardContents>;
