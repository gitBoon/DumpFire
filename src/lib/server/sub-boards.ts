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
 * And how deep the tree may go (card 2172): a sub-board at most
 * `MAX_SUB_BOARD_DEPTH` levels below a board that hangs under no card.
 *
 *     depthOf(boardId)                    how many levels down a board is
 *     heightOfBoard(boardId, most)        how many levels of sub-boards are
 *     heightUnderCard(cardId, most)       below a board, or a card
 *     tooDeepUnder(card)                  would a new sub-board of this card,
 *     linkTooDeep(boardId, parentBoardId)   this board put under a card there,
 *     moveTooDeep(cardId, from, to)         or this card's sub-boards moved
 *                                           with it, be deeper than the limit?
 *
 * Each of these is one recursive statement that stops one level past the
 * limit, so it ends on a loop and on a tree already deeper, and reads at most
 * that many levels. Made, linked or moved, a board deeper than the limit is
 * refused, 409, in the words of `tooDeepToMake`, `tooDeepToLink` and
 * `tooDeepToMove`; nothing else changes the tree. A tree already deeper is
 * left as it is (a restored backup can hold one): nothing new goes below its
 * deep boards, and a move or a link that leaves it no deeper is allowed, so
 * it can be put right.
 *
 * Who may link a board is `requireSubBoardLink`'s, in route-guards.ts.
 */
import { and, asc, eq, isNull } from 'drizzle-orm';
import { db, sqlite } from './db';
import { boardMembers, boards } from './db/schema';
import { canEditBoard, isAdmin, type Actor } from './board-access';

/**
 * How many levels below a board that hangs under no card a sub-board may be
 * (card 2172). Real trees are a few levels deep. Every load of a board walks
 * up its breadcrumbs, three reads a level, and nothing bounded how deep a
 * signed-in user could nest boards by script; 20 is far past any use and
 * keeps that walk to a few milliseconds.
 */
export const MAX_SUB_BOARD_DEPTH = 20;

/**
 * How deep board `boardId` is: 0 for a board that hangs under no card, or
 * under a card (or a card's column) that is gone, as the breadcrumbs treat it;
 * 1 for a sub-board of a card on such a board; and so on.
 *
 * One past the limit, `MAX_SUB_BOARD_DEPTH + 1`, for anything deeper: the
 * walk up stops there. A board in a loop, or below one, reads that too, so
 * nothing new can be made beneath it. Archived cards count: the tree is the
 * `parent_card_id` links, archived or not.
 */
export function depthOf(boardId: number): number {
	const row = sqlite
		.prepare(
			`WITH RECURSIVE up(id, depth) AS (
				SELECT ?, 0
				UNION
				SELECT col.board_id, up.depth + 1 FROM up
					JOIN boards b ON b.id = up.id
					JOIN cards c ON c.id = b.parent_card_id
					JOIN columns col ON col.id = c.column_id
				WHERE up.depth <= ?
			)
			SELECT MAX(depth) AS depth FROM up`
		)
		.get(boardId, MAX_SUB_BOARD_DEPTH) as { depth: number };
	return row.depth;
}

/**
 * How many levels of sub-boards hang below board `boardId`: 0 for a board
 * whose cards have none, 1 for one whose sub-boards have none, and so on.
 * The walk down stops at `most` levels, which it then answers: a caller asks
 * only whether there is room, and a wide tree or a loop costs no more than
 * that many levels.
 */
export function heightOfBoard(boardId: number, most = MAX_SUB_BOARD_DEPTH + 1): number {
	return levelsBelow(`SELECT ?, 0`, boardId, most);
}

/**
 * How many levels of sub-boards hang below card `cardId`: 0 for a card with
 * none, 1 for one whose sub-boards have none, and so on, stopping at `most`
 * as `heightOfBoard` does.
 */
export function heightUnderCard(cardId: number, most = MAX_SUB_BOARD_DEPTH + 1): number {
	return levelsBelow(`SELECT id, 1 FROM boards WHERE parent_card_id = ?`, cardId, most);
}

/** The deepest level below `seed`'s boards, each seed at the height it gives, counted down to `most` and no further. */
function levelsBelow(seed: string, id: number, most: number): number {
	const row = sqlite
		.prepare(
			`WITH RECURSIVE down(id, height) AS (
				${seed}
				UNION
				SELECT b.id, down.height + 1 FROM down
					JOIN columns col ON col.board_id = down.id
					JOIN cards c ON c.column_id = col.id
					JOIN boards b ON b.parent_card_id = c.id
				WHERE down.height < ?
			)
			SELECT COALESCE(MAX(height), 0) AS height FROM down`
		)
		.get(id, most) as { height: number };
	return row.height;
}

/**
 * True if a new sub-board of `card` would be deeper than the limit: the card's
 * board is already at it, past it, or in or below a loop. For the two routes
 * that make a board, after `requireParentCard`, in their transaction.
 */
export function tooDeepUnder(card: { columnId: number }): boolean {
	const column = sqlite.prepare(`SELECT board_id AS boardId FROM columns WHERE id = ?`).get(card.columnId) as
		| { boardId: number }
		| undefined;
	// A card whose column is gone was refused by `requireParentCard`.
	return column !== undefined && depthOf(column.boardId) + 1 > MAX_SUB_BOARD_DEPTH;
}

/**
 * True if putting board `boardId` under a card on board `parentBoardId` would
 * nest it, or a board beneath it, deeper than the limit, and deeper than it is
 * now. A link that leaves a tree already too deep no deeper, or lifts it, is
 * allowed: it is how such a tree is put right. Asked after `wouldLoop`.
 */
export function linkTooDeep(boardId: number, parentBoardId: number): boolean {
	const depth = depthOf(parentBoardId) + 1;
	if (depth <= depthOf(boardId)) return false;
	// Levels of sub-boards it may carry there; below none, the board itself is too deep.
	const room = MAX_SUB_BOARD_DEPTH - depth;
	return room < 0 || heightOfBoard(boardId, room + 1) > room;
}

/**
 * True if moving card `cardId` from board `fromBoardId` to board `toBoardId`
 * would nest its sub-boards deeper than the limit, and deeper than they are
 * now. Only the depth of the board it lands on changes theirs, so the test is
 * on the two boards and the levels the card carries: a card with no sub-board
 * is never refused, and the levels are counted only when the target is the
 * deeper board, down to the room it leaves. Asked after the loop check.
 */
export function moveTooDeep(cardId: number, fromBoardId: number, toBoardId: number): boolean {
	const depth = depthOf(toBoardId);
	if (depth <= depthOf(fromBoardId)) return false;
	// Levels of sub-boards the card may carry there. None on a board at the
	// limit or past it, where any sub-board at all is too deep.
	const room = Math.max(MAX_SUB_BOARD_DEPTH - depth, 0);
	return heightUnderCard(cardId, room + 1) > room;
}

/** The refusal of a new sub-board too deep. It names nothing. */
export function tooDeepToMake(): string {
	return `Sub-boards can be nested at most ${MAX_SUB_BOARD_DEPTH} levels deep, and a board under this card would be deeper.`;
}

/** The refusal of a link too deep: the board's name, which its owner or an administrator has just been found to hold. */
export function tooDeepToLink(boardName: string): string {
	return `Board "${boardName}" cannot go under this card: it and its sub-boards would then be nested more than ${MAX_SUB_BOARD_DEPTH} levels deep.`;
}

/** The refusal of a move too deep: the card and the board, both of which the caller has just been found able to edit. */
export function tooDeepToMove(cardTitle: string, boardName: string): string {
	return `Card "${cardTitle}" cannot go onto "${boardName}": its sub-boards would then be nested more than ${MAX_SUB_BOARD_DEPTH} levels deep.`;
}

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
	// A board put under a card on a board at the limit would be past it
	// (card 2172), and so would one under a board in or below a loop. None is
	// offered, and the walk up below reads at most the limit's levels.
	if (depthOf(boardId) >= MAX_SUB_BOARD_DEPTH) return [];

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
