/**
 * sub-boards.ts — the tree boards make by hanging under cards.
 *
 * A board hangs under a card by `boards.parent_card_id`, and the card is on a
 * board of its own, so the boards make a tree. Nothing in the schema stops it
 * being a loop: a board put under a card on one of its own sub-boards, or a
 * card moved onto its own sub-board, makes the tree go round. A loop already
 * in the data is not this module's to undo, but every walk here ends on one,
 * as the shared delete's does (`deletes.ts`): a walk that did not would never
 * end, and would hold the one Node thread until the process died.
 *
 *     wouldLoop(boardId, parentBoardId)   would putting the board under a card
 *                                         on that board make a loop?
 *     wouldLoopAny(boardIds, parentBoardId)
 *                                         the same for several boards, with one
 *                                         walk: a card's sub-boards, as it moves
 *     linkableBoards(user, boardId)       what the board page offers to put
 *                                         under a card on that board
 *     boardsInLoops()                     every board that hangs beneath one of
 *                                         its own cards, for the start-up line
 *
 * Who may link a board is `requireSubBoardLink`'s, in route-guards.ts.
 */
import { and, asc, eq, isNull } from 'drizzle-orm';
import { db, sqlite } from './db';
import { boardMembers, boards } from './db/schema';
import { canEditBoard, isAdmin, type Actor } from './board-access';

/**
 * The board and every board above it: the board its parent card is on, that
 * board's, and so on to the top.
 *
 * Built with `UNION`, which keeps each board once, so it ends on a loop
 * already in the data where `UNION ALL` would follow it for ever. A board
 * whose parent card, or that card's column, is gone has nothing above it.
 */
function boardsAbove(boardId: number): Set<number> {
	const rows = sqlite
		.prepare(
			`WITH RECURSIVE up(id) AS (
				SELECT ?
				UNION
				SELECT col.board_id FROM up
					JOIN boards b ON b.id = up.id
					JOIN cards c ON c.id = b.parent_card_id
					JOIN columns col ON col.id = c.column_id
			)
			SELECT id FROM up`
		)
		.all(boardId) as { id: number }[];
	return new Set(rows.map((row) => row.id));
}

/**
 * True if putting board `boardId` under a card on board `parentBoardId` would
 * make a loop: the card is on the board itself, or on a board beneath it at
 * any depth.
 *
 * It walks up from the parent card's board, and looks for the board being
 * put under it. A loop already above that board, which the board being put
 * under it is not in, is no reason to refuse; and a board that is in a loop
 * is taken out of it by being put somewhere else.
 */
export function wouldLoop(boardId: number, parentBoardId: number): boolean {
	return wouldLoopAny([boardId], parentBoardId);
}

/**
 * True if putting any of `boardIds` under a card on board `parentBoardId`
 * would make a loop: the card is on one of them, or on a board beneath one.
 * `wouldLoop` for several boards at once, as a card moved to another board
 * takes all its sub-boards with it.
 *
 * One walk up from the parent card's board, whatever the number of boards
 * asked about. Asking `wouldLoop` of each in turn walked up from the same
 * board once for each, and a card with thousands of sub-boards moved onto a
 * board thousands deep held the one thread for seconds (card 2141's review).
 */
export function wouldLoopAny(boardIds: readonly number[], parentBoardId: number): boolean {
	if (boardIds.length === 0) return false;
	const above = boardsAbove(parentBoardId);
	return boardIds.some((id) => above.has(id));
}

/** What the board page shows of a board it offers to link. */
type Linkable = { id: number; name: string; emoji: string | null };

/**
 * The boards the board page offers to put under a card on board `boardId`:
 * those `requireSubBoardLink` would let the caller link there.
 *
 * Top-level boards only, as before: a board already under a card can be
 * moved through the API, and the page does not offer it. Of those, the ones
 * the caller owns, by the rule `getBoardRole` gives the role by (the board's
 * creator, or a member stored as owner; a team share never makes one), which
 * is the guard's own rule, and never by `boards.created_by` alone. An
 * administrator owns them all.
 *
 * The owned boards are read in two queries, whatever the number of boards:
 * those the caller created, and those they are a member of stored as owner.
 * Asking `getBoardRole` of every top-level board in turn, as this did, read
 * the database two to four times for each board on every load of a board
 * page.
 *
 * Not this board, nor the top of this board's own chain of parents: either
 * would go under a card on itself or beneath itself, which the server
 * refuses. None at all to a caller who cannot edit this board, which the
 * server asks of whoever hangs a board under one of its cards.
 */
export function linkableBoards(user: Actor, boardId: number): Linkable[] {
	if (!canEditBoard(user, boardId)) return [];

	const shown = { id: boards.id, name: boards.name, emoji: boards.emoji };
	let owned: Linkable[];
	if (isAdmin(user)) {
		owned = db.select(shown).from(boards).where(isNull(boards.parentCardId)).orderBy(asc(boards.id)).all();
	} else {
		const created = db
			.select(shown)
			.from(boards)
			.where(and(isNull(boards.parentCardId), eq(boards.createdBy, user.id)))
			.all();
		const sharedAsOwner = db
			.select(shown)
			.from(boardMembers)
			.innerJoin(boards, eq(boards.id, boardMembers.boardId))
			.where(and(isNull(boards.parentCardId), eq(boardMembers.userId, user.id), eq(boardMembers.role, 'owner')))
			.all();
		// The creator is usually a member stored as owner as well: each board once, in the order of the ids.
		const byId = new Map<number, Linkable>();
		for (const board of [...created, ...sharedAsOwner]) byId.set(board.id, board);
		owned = [...byId.values()].sort((a, b) => a.id - b.id);
	}

	const above = boardsAbove(boardId);
	return owned.filter((board) => !above.has(board.id));
}

/** A board in a loop, the card it hangs from, and the board that card is on. */
export type LoopBoard = {
	boardId: number;
	boardName: string;
	cardId: number;
	cardTitle: string;
	/**
	 * Whether the card is archived. All Tasks lists no archived card, so the
	 * start-up line says to restore it from the Archived page first.
	 */
	cardArchived: boolean;
	/** The board the card is on: in the loop too, or the board itself. */
	cardBoardId: number;
};

/**
 * Every board that hangs beneath one of its own cards, at any depth, ordered
 * by id: the boards of every loop in the tree (card 2142). A board below a
 * loop, whose chain of parents runs into one, is not in it.
 *
 * One read, whatever the size of the tree: every board that hangs under a
 * card, with the board that card is on. The loops are then found in memory,
 * and each board is looked at once. From each board not yet settled, the walk
 * follows the parent boards, marking each as on this path, until it reaches a
 * board that is settled or has no parent. If it runs into a board already on
 * the path, that board and every one after it are a loop. Then the whole path
 * is settled. Each step marks a board not marked before, so the walk ends,
 * loop or no loop, in one step a board.
 *
 * It is called by the start-up check, before the server listens. A call of
 * `wouldLoop` for each board, as first planned, walked each chain to its top
 * again for every board in it, and a chain thousands deep, which any
 * signed-in user can make, took seconds at every start.
 *
 * Archived cards count, as they do in `wouldLoop` and in the delete: the tree
 * is the `parent_card_id` links, archived or not. A board whose parent card,
 * or that card's column, is gone has nothing above it.
 */
export function boardsInLoops(): LoopBoard[] {
	const hanging = (
		sqlite
			.prepare(
				`SELECT b.id AS boardId, b.name AS boardName, c.id AS cardId, c.title AS cardTitle,
					c.archived_at IS NOT NULL AS cardArchived, col.board_id AS cardBoardId
				FROM boards b
					JOIN cards c ON c.id = b.parent_card_id
					JOIN columns col ON col.id = c.column_id
				ORDER BY b.id`
			)
			.all() as (Omit<LoopBoard, 'cardArchived'> & { cardArchived: 0 | 1 })[]
	).map((row) => ({ ...row, cardArchived: row.cardArchived === 1 }));

	const parentOf = new Map(hanging.map((row) => [row.boardId, row.cardBoardId]));
	const settled = new Set<number>();
	const looped = new Set<number>();
	for (const { boardId } of hanging) {
		if (settled.has(boardId)) continue;
		// The boards walked from this one, in order, with where each is on the path.
		const path = new Map<number, number>();
		let at: number | undefined = boardId;
		while (at !== undefined && !settled.has(at) && !path.has(at)) {
			path.set(at, path.size);
			at = parentOf.get(at);
		}
		if (at !== undefined && path.has(at)) {
			// The path came back to a board on it: from that board on, it is a loop.
			const from = path.get(at)!;
			for (const [id, place] of path) if (place >= from) looped.add(id);
		}
		for (const id of path.keys()) settled.add(id);
	}
	return hanging.filter((row) => looped.has(row.boardId));
}
