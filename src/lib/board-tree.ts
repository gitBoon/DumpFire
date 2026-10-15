/**
 * Sub-boards on All Tasks, worked out with no DOM (card 1990).
 *
 * All Tasks lists the cards of every board the caller can open, sub-boards at
 * every depth among them. What it shows of the tree they make is decided
 * here, so that `tests/all-tasks.test.ts` can call it: a page cannot be run
 * there.
 *
 *     placeBoards(visible, ancestry, categoryIds)
 *                                      on the server: the nearest board above
 *                                      each that the caller can open, and the
 *                                      category it is filtered under
 *     boardPlaces(boards)              in the browser: each board's path, built
 *                                      from what placeBoards sent
 *     inBoardFilter(boardId, filter, places)
 *                                      whether the board filter lets a board's
 *                                      cards in
 *     boardOptions(boards)             the board filter's options, each
 *                                      sub-board straight after its parent
 *     boardOptionLabel(board, depth)   an option's text, indented
 *     boardPathText(path, own)         the board tag on a card
 *
 * The load sends each board's nearest parent, not its path: a path is as long
 * as the board is deep, so sending every board's made the answer grow with
 * the square of the depth (4.3 MB for a chain 400 deep). The browser builds
 * the paths from the parents.
 *
 * A sub-board does not inherit access from the board above it (card 2004): a
 * caller may open a sub-board and not its parent. A board they cannot open is
 * never named here, by name or by id; it is a `null` in a path, and lends
 * nothing to the boards beneath it.
 */

/** A board above another, as the caller is shown it. */
export type BoardStep = { id: number; name: string; emoji: string };

/** Where a board sits in the tree, as the caller is shown it. */
export type BoardPlace = {
	/**
	 * The boards above it, from the top level down to its parent: each one the
	 * caller can open by name, and a run of boards they cannot open as one
	 * `null`. Empty for a top-level board. A loop is shown once round, closing
	 * on the board it came back to, as the board page's breadcrumbs show it.
	 */
	path: (BoardStep | null)[];
	/**
	 * The category the category filter counts it in: its own if it has one;
	 * otherwise that of the nearest board above it that the caller can open
	 * and that has one; otherwise none. Sub-boards are made with no category,
	 * so without this every one sat under "Uncategorized".
	 */
	filterCategoryId: number | null;
};

/**
 * Where a board hangs, as the load sends it: a size that does not grow with
 * how deep the board is.
 */
export type BoardLink = {
	/**
	 * The nearest board above it that the caller can open, or `null` when
	 * there is none. In a loop it can be the board itself.
	 */
	parentId: number | null;
	/** Whether there are boards the caller cannot open between it and `parentId` (above it, when that is `null`). */
	hiddenAbove: boolean;
	/** As `BoardPlace`'s. */
	filterCategoryId: number | null;
};

/** What `placeBoards` reads of a board the caller can open. */
export type VisibleBoard = { id: number; name: string; emoji: string | null; categoryId: number | null };

/**
 * Each of `visible`, the boards the caller can open, linked into the tree:
 * `ancestry` is `boardAncestry`'s (`src/lib/server/board-tree.ts`), the ids
 * of every board above each, whether the caller can open it or not. Only the
 * boards in `visible` are named; a run of the rest is `hiddenAbove`, so the
 * page does not say how many there are.
 *
 * `categoryIds` are the caller's board categories. A board whose category is
 * not among them, because it was deleted and the board still points at it,
 * counts as having none: it and the sub-boards beneath it are listed under
 * Uncategorized, not in a group the filter does not have.
 */
export function placeBoards(
	visible: readonly VisibleBoard[],
	ancestry: ReadonlyMap<number, readonly number[]>,
	categoryIds: Iterable<number>
): Map<number, BoardLink> {
	const byId = new Map(visible.map((b) => [b.id, b]));
	const listed = new Set(categoryIds);
	const categoryOf = (b: VisibleBoard) => (b.categoryId !== null && listed.has(b.categoryId) ? b.categoryId : null);
	const links = new Map<number, BoardLink>();
	for (const board of visible) {
		const above = ancestry.get(board.id) ?? [];
		let parentId: number | null = null;
		let hiddenAbove = false;
		// The nearest board above it that the caller can open and that has a category.
		let filterCategoryId = categoryOf(board);
		for (let i = above.length - 1; i >= 0; i--) {
			const at = byId.get(above[i]);
			if (!at) {
				if (parentId === null) hiddenAbove = true;
				continue;
			}
			if (parentId === null) parentId = at.id;
			if (filterCategoryId === null) filterCategoryId = categoryOf(at);
			if (filterCategoryId !== null) break;
		}
		links.set(board.id, { parentId, hiddenAbove, filterCategoryId });
	}
	return links;
}

/** A board as the load sends it. */
export type LinkedBoard = BoardLink & { id: number; name: string; emoji: string };

/**
 * Each board's place, its path built from the parents `placeBoards` sent:
 * its parent, that board's, and so on to the top, each run of boards the
 * caller cannot open one `null`. A loop is shown once round, closing on the
 * first board the walk comes back to, as the board page's breadcrumbs show it.
 */
export function boardPlaces(boards: readonly LinkedBoard[]): Map<number, BoardPlace> {
	const byId = new Map(boards.map((b) => [b.id, b]));
	const places = new Map<number, BoardPlace>();
	for (const board of boards) {
		// From the board up; reversed at the end.
		const path: (BoardStep | null)[] = [];
		const walked = new Set<number>([board.id]);
		let at: LinkedBoard | undefined = board;
		while (at) {
			if (at.hiddenAbove) path.push(null);
			const up: LinkedBoard | undefined = at.parentId === null ? undefined : byId.get(at.parentId);
			if (!up) break;
			path.push({ id: up.id, name: up.name, emoji: up.emoji || '📋' });
			// The loop closes here.
			if (walked.has(up.id)) break;
			walked.add(up.id);
			at = up;
		}
		places.set(board.id, { path: path.reverse(), filterCategoryId: board.filterCategoryId });
	}
	return places;
}

/**
 * Whether the board filter lets in the cards of board `boardId`. `filter` is
 * the filter's value: `all`; `cat:N`, every board counted in category N
 * (`filterCategoryId`); or a board's id, which lets in that board and every
 * sub-board beneath it, at any depth, that the caller can open. A board's id
 * that has become a number is taken as it is: a select bound to a number
 * option gives one, and `startsWith` on it threw.
 */
export function inBoardFilter(boardId: number, filter: string | number, places: ReadonlyMap<number, BoardPlace>): boolean {
	const value = String(filter);
	if (value === 'all') return true;
	const place = places.get(boardId);
	if (value.startsWith('cat:')) return place?.filterCategoryId === Number(value.slice(4));
	const chosen = Number(value);
	return boardId === chosen || (place?.path.some((step) => step?.id === chosen) ?? false);
}

/**
 * The board the filter has chosen, or 0 for all boards or a category: what
 * the Planning, Export to CSV and Statistics links take, which cover that
 * board alone (card 1990's decision 8). Takes a number as `inBoardFilter` does.
 */
export function chosenBoardId(filter: string | number): number {
	const value = String(filter);
	return value === 'all' || value.startsWith('cat:') ? 0 : Number(value) || 0;
}

/**
 * The boards of one group of the board filter, in the order the filter lists
 * them, each with how deep to indent it: a board whose parent is in `boards`
 * comes straight after that parent (after the parent's own sub-boards made
 * before it), one level deeper. Every other board is at the top level of the
 * group, in the order given: a top-level board, a sub-board whose parent the
 * caller cannot open, and one whose parent is counted in another category.
 * The boards of a loop, which has no top, are listed from the first of them.
 */
export function boardOptions<B extends { id: number; parentId: number | null; hiddenAbove: boolean }>(boards: readonly B[]): { board: B; depth: number }[] {
	const inGroup = new Set(boards.map((b) => b.id));
	// Its parent, when that is a board the caller can open and is in the group.
	const parentOf = (b: B) => (!b.hiddenAbove && b.parentId !== null && b.parentId !== b.id && inGroup.has(b.parentId) ? b.parentId : null);
	const children = new Map<number, B[]>();
	for (const b of boards) {
		const parent = parentOf(b);
		if (parent !== null) children.set(parent, [...(children.get(parent) ?? []), b]);
	}

	const listed: { board: B; depth: number }[] = [];
	const done = new Set<number>();
	// Depth first, without recursion: a chain thousands deep would overflow the stack.
	const list = (top: B) => {
		const stack = [{ board: top, depth: 0 }];
		while (stack.length > 0) {
			const next = stack.pop()!;
			if (done.has(next.board.id)) continue;
			done.add(next.board.id);
			listed.push(next);
			const under = children.get(next.board.id) ?? [];
			for (let i = under.length - 1; i >= 0; i--) stack.push({ board: under[i], depth: next.depth + 1 });
		}
	};
	for (const b of boards) if (parentOf(b) === null) list(b);
	// Left over: the boards of a loop and those beneath them.
	for (const b of boards) list(b);
	return listed;
}

/** How many levels the board filter indents before it stops and says the depth instead. */
export const MAX_OPTION_INDENT = 8;

/**
 * An option's text in the board filter: a sub-board as "↳" after spaces the
 * select does not collapse, three to a level. Past `MAX_OPTION_INDENT` levels
 * the indent stops growing and the arrow says how deep it is ("↳ 12"), so a
 * deep board's name is not pushed out of the dropdown.
 */
export function boardOptionLabel(board: { emoji: string; name: string }, depth: number): string {
	const own = `${board.emoji} ${board.name}`;
	if (depth <= 0) return own;
	const indent = '   '.repeat(Math.min(depth, MAX_OPTION_INDENT) - 1);
	return depth > MAX_OPTION_INDENT ? `${indent}↳ ${depth} ${own}` : `${indent}↳ ${own}`;
}

/**
 * A card's board tag: each board above its board, then its board, by emoji
 * and name, from the top level down ("📋 DumpFire › 🗂️ Search fixes"). A
 * board the caller cannot open is "…".
 */
export function boardPathText(path: readonly (BoardStep | null)[], own: { emoji: string; name: string }): string {
	return [...path.map((step) => (step ? `${step.emoji} ${step.name}` : '…')), `${own.emoji} ${own.name}`].join(' › ');
}
