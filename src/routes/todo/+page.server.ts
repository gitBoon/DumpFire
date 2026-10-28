/**
 * All To Do (card 2240): the cards in the To Do column of every board the
 * caller can open, as one table.
 *
 * The cards are read as All Tasks reads them, through `readCrossBoardCards`,
 * so the two pages give the same caller the same boards, the same cards and
 * the same withheld blockers; this page asks only for the columns whose title
 * counts as To Do as reports count it (`countsAsToDo`, card 2474: To Do,
 * Todo, Backlog, Inbox, Planned and the like), every such column of a board,
 * and so lists exactly the cards of All Tasks' To Do bucket. A board with no
 * such column has nothing listed: it is not given a column under a name it
 * does not have, where reports fall back to its first open column. It is
 * still sent, with `hasTodo: false`, so the page can count it and name the
 * boards above a sub-board.
 *
 * Filters and sort are the page's, kept in the address (`src/lib/todo-table.ts`).
 * This load reads no query parameter, so a filter change re-runs nothing and
 * every address of the page loads the same answer.
 */
import { readCrossBoardCards } from '$lib/server/cross-board-cards';
import { countsAsToDo, isUpstreamColumn } from '$lib/column-role';
import type { PageServerLoad } from './$types';

export const load: PageServerLoad = async ({ locals }) => {
	const user = locals.user!;
	// Never an upstream column, whatever it is called (milestone 22, the S5a
	// review's L1): an ideas board has no To Do column, and an idea is not work
	// waiting to be started. An ideas board's column may be called "Ideas",
	// which `countsAsToDo` takes, so this is the guard that keeps it out.
	const read = readCrossBoardCards(user, { inColumn: (column, kind) => countsAsToDo(column.title) && !isUpstreamColumn(column, kind) });

	const withTodo = new Set(read.columns.filter((c) => countsAsToDo(c.title) && !read.upstreamColumnIds.has(c.id)).map((c) => c.boardId));

	return {
		boards: read.boards.map((b) => ({ ...b, hasTodo: withTodo.has(b.id) })),
		cards: read.cards,
		blockedState: read.blockedState,
		milestoneNames: read.milestoneNames,
		categories: read.categories,
		boardCategories: read.boardCategories,
		labels: read.labels,
		// Every user by name and emoji, as All Tasks sends them (card 2128, decision 1).
		allUsers: read.users.map((u) => ({ id: u.id, username: u.username, emoji: u.emoji || '👤' }))
	};
};
