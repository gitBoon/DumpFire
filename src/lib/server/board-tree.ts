/**
 * board-tree.ts — which boards each board hangs beneath, for a page that
 * lists boards from every level of the tree at once (All Tasks, card 1990).
 *
 *     boardAncestry(boardIds)   for each board, the ids of the boards above
 *                               it, from the top level down to its parent
 *
 * Ids only: what a caller is shown of those boards, and which of them they
 * may be shown at all, is `placeBoards`' in `src/lib/board-tree.ts`.
 */
import { sqlite } from './db';

/**
 * For each of `boardIds`, the boards above it: the board its parent card is
 * on, that board's, and so on to the top, written from the top down. Empty
 * for a top-level board, and for one whose parent card, or that card's
 * column, is gone.
 *
 * The parent card is followed whether it is archived or not, as the board
 * page's breadcrumbs follow it: the tree is the `parent_card_id` links, and
 * All Tasks loads no archived card, so the path cannot be read from the
 * cards it holds.
 *
 * One read, whatever the depth: every board that hangs under a card, with the
 * board that card is on. The walk is then in memory, and each step marks a
 * board not marked before, so it ends on a loop in the tree (card 2142). A
 * loop is shown once round, closing on the board it came back to, as the
 * breadcrumbs show it: a board under one of its own cards has itself above
 * it. Each board is walked to its top, so the steps are the boards times
 * their depth, as `deepestFirst()`'s in `deletes.ts` are; card 2172's limit
 * on how deep boards nest is what bounds both.
 */
export function boardAncestry(boardIds: readonly number[]): Map<number, number[]> {
	const ancestry = new Map<number, number[]>();
	if (boardIds.length === 0) return ancestry;

	const parentOf = new Map(
		(
			sqlite
				.prepare(
					`SELECT b.id AS boardId, col.board_id AS parentBoardId
					FROM boards b
						JOIN cards c ON c.id = b.parent_card_id
						JOIN columns col ON col.id = c.column_id`
				)
				.all() as { boardId: number; parentBoardId: number }[]
		).map((row) => [row.boardId, row.parentBoardId])
	);

	for (const boardId of boardIds) {
		const above: number[] = [];
		const walked = new Set<number>([boardId]);
		let at = parentOf.get(boardId);
		while (at !== undefined) {
			above.push(at);
			// The loop closes here.
			if (walked.has(at)) break;
			walked.add(at);
			at = parentOf.get(at);
		}
		ancestry.set(boardId, above.reverse());
	}
	return ancestry;
}
