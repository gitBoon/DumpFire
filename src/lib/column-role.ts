/**
 * column-role.ts — what a column means, decided in one place.
 *
 * A column's title is the only thing that says whether cards in it are finished,
 * paused or waiting to be started. That used to be worked out by comparing the title to a word list
 * wherever the answer was needed: about twenty places, with three different
 * lists. The browser accepted only "complete" where the server also accepted
 * "done", and the dashboard counted a "Waiting" column as on hold where the
 * reports did not. So the same card could be complete on one screen and in
 * progress on another, depending on what its column happened to be called.
 *
 * To Do joined them with card 2240: All Tasks' To Do bucket, the list view's
 * opening column and the All To Do page each tested the title for themselves,
 * and the list view and All Tasks did not quite agree on which columns. Card
 * 2474 gave the pages that gather boards together, reports, All Tasks and All
 * To Do, the one wider list of To Do titles (`countsAsToDo`); a board's own
 * To Do role is still the two titles.
 *
 * Everything now asks here. This module has no server imports, so the browser
 * and the server share the one definition.
 *
 * Upstream joined them with milestone 22, and it is the one meaning that is
 * stored rather than read from the title: a column whose `role` is 'options'
 * is the board's Options column, and every column of a board whose `kind` is
 * 'ideas' is upstream too. Cards there are options, not committed work. An
 * Options column is never also To Do, On Hold or Complete, whatever it is
 * called.
 */

/** What a column means for the cards in it. `null` is an ordinary working column. */
export type ColumnRole = 'complete' | 'hold' | 'todo';

/** The roles a column can have stored (`columns.role`); NULL is none, and the title decides. */
export const COLUMN_ROLES = ['options'] as const;
export type StoredColumnRole = (typeof COLUMN_ROLES)[number];

/** The kinds of board (`boards.kind`). Every board was a delivery board before milestone 22. */
export const BOARD_KINDS = ['delivery', 'ideas'] as const;
export type BoardKind = (typeof BOARD_KINDS)[number];

/**
 * The title of every delivery board's Options column, which it always has and
 * keeps (card 2527): no other column of a delivery board is called it, in any
 * case. Made with the board, and by `runBackfills` for a board made before.
 */
export const OPTIONS_TITLE = 'Options';

/** The colour an Options column is made with. */
export const OPTIONS_COLOUR = '#8b5cf6';

/** True if `title` is the Options column's, whatever its case and surrounding space. */
export function isOptionsTitle(title: string | null | undefined): boolean {
	return (title ?? '').trim().toLowerCase() === OPTIONS_TITLE.toLowerCase();
}

/** True if this is a board's Options column: upstream of the commitment point. */
export function isOptionsColumn(column: { role: string | null }): boolean {
	return column.role === 'options';
}

/**
 * What a screen says after a column's title to mark it as the board's Options
 * column: " (Options)", not part of the title. Nothing for any other column,
 * and nothing for an Options column already called Options, which every one
 * is once the start-up step has run (card 2527): "Options (Options)" says it
 * twice.
 */
export function optionsSuffix(column: { title: string | null | undefined; role: string | null }): string {
	return isOptionsColumn(column) && !isOptionsTitle(column.title) ? ' (Options)' : '';
}

/**
 * True if cards in this column are upstream, options rather than committed
 * work: it is the Options column, or its board is an ideas board. Every rule
 * about commitment, discards and what the delivery measures count asks this.
 *
 * Both are required, the column's `role` and its board's kind (the S1a
 * review's R4), so that a caller that forgot to read either is told so by the
 * compiler instead of taking every column for an ordinary one. A board of any
 * kind but 'ideas' is a delivery board here, as in the backfills.
 */
export function isUpstreamColumn(column: { role: string | null }, boardKind: string | null): boolean {
	return isOptionsColumn(column) || boardKind === 'ideas';
}

/**
 * What a column means, its stored role first: an Options column is 'options'
 * whatever its title, and so never To Do, On Hold or Complete on any page.
 * Any other column is what its title says.
 */
export function columnRoleOf(column: { title: string | null | undefined; role: string | null }): 'options' | ColumnRole | null {
	return isOptionsColumn(column) ? 'options' : columnRole(column.title);
}

/** Titles that mean the work is finished. */
const COMPLETE_TITLES: ReadonlySet<string> = new Set(['complete', 'done']);

/**
 * Titles that mean the work is deliberately paused.
 *
 * The union of the three lists that existed: nothing that counted as on hold
 * anywhere stops counting.
 */
const HOLD_TITLES: ReadonlySet<string> = new Set(['on hold', 'hold', 'blocked', 'parked', 'waiting']);

/**
 * Titles that give a column a board's own To Do role (card 2240).
 *
 * Only these two. The role decides where Add Task shows, the list view's
 * opening column, the column Send to To Do and a commit pick, and the titles
 * an ideas board refuses, so it stays this narrow: an ideas board refusing a
 * column called "Ideas" is not wanted. Across boards more titles count as To
 * Do (`WIDER_TODO_TITLES`, `countsAsToDo`).
 */
const TODO_TITLES: ReadonlySet<string> = new Set(['to do', 'todo']);

/**
 * Titles that count as To Do across boards beside `TODO_TITLES` (card 2474):
 * in the reports, in All Tasks' To Do bucket and on the All To Do page, which
 * all ask `countsAsToDo`. Reports always counted these; the two pages now
 * count them as reports do, so a card in a Backlog column is To Do on every
 * page that gathers boards together.
 */
const WIDER_TODO_TITLES: readonly string[] = ['to-do', 'backlog', 'inbox', 'not started', 'new', 'planned', 'ideas', 'idea', 'later'];

/** Every title `countsAsToDo` takes: the board's own two and the wider list. */
const CROSS_BOARD_TODO_TITLES: ReadonlySet<string> = new Set([...TODO_TITLES, ...WIDER_TODO_TITLES]);

/**
 * True if a column with this title counts as To Do across boards (card 2474):
 * "To Do" or "Todo", or a title in `WIDER_TODO_TITLES` (Backlog, Inbox,
 * Planned and the like), trimmed and in any case. What reports, All Tasks' To
 * Do bucket and the All To Do page count. Not a board's own To Do role, which
 * is `columnRole` and stays the two. Never asks whether the column is
 * upstream: each caller leaves those out itself, as it already does.
 */
export function countsAsToDo(title: string | null | undefined): boolean {
	return CROSS_BOARD_TODO_TITLES.has((title ?? '').trim().toLowerCase());
}

/**
 * Titles of queues, where committed work waits to be started (milestone 22,
 * the S4a review's H1): the wider To Do titles above, and the usual names of a
 * replenishment queue. Read only by `isQueueColumn`, for the cycle time.
 */
const QUEUE_TITLES: ReadonlySet<string> = new Set([...WIDER_TODO_TITLES, 'ready', 'selected', 'next', 'up next', 'queue', 'queued']);

/**
 * True if work in this column is waiting, not started: a To Do or On Hold
 * column, or one whose title names a queue (Backlog, Ready, Selected, Next
 * and the like). A card committed into one has not started; one committed
 * anywhere else has (the S4a review's H1). The board's first committed
 * column is a queue too, which only the caller, holding the board's
 * columns, can tell.
 */
export function isQueueColumn(column: { title: string | null | undefined; role: string | null }): boolean {
	const role = columnRoleOf(column);
	return role === 'todo' || role === 'hold' || QUEUE_TITLES.has((column.title ?? '').trim().toLowerCase());
}

/** The role a column title implies. Case and surrounding space are ignored. */
export function columnRole(title: string | null | undefined): ColumnRole | null {
	const t = (title ?? '').trim().toLowerCase();
	if (COMPLETE_TITLES.has(t)) return 'complete';
	if (HOLD_TITLES.has(t)) return 'hold';
	if (TODO_TITLES.has(t)) return 'todo';
	return null;
}

/** True if cards in a column with this title are finished. */
export function isCompleteColumnTitle(title: string | null | undefined): boolean {
	return columnRole(title) === 'complete';
}

/**
 * True if cards in a column with this title are deliberately paused.
 *
 * Reports need this separate from "in progress": a board with nine cards on hold
 * and one being worked is not the same as ten in flight, and reading them the
 * same way overstates what is moving.
 */
export function isHoldColumnTitle(title: string | null | undefined): boolean {
	return columnRole(title) === 'hold';
}

/**
 * True if a column with this title has the board's own To Do role (card
 * 2240): "To Do" or "Todo". Where Add Task shows and the list view opens.
 * All Tasks and All To Do count more titles as To Do (`countsAsToDo`).
 */
export function isTodoColumnTitle(title: string | null | undefined): boolean {
	return columnRole(title) === 'todo';
}

/**
 * The first column, by position, that is neither a Complete column nor the
 * Options column, or undefined when there is none.
 *
 * Where new work goes when nobody chose its column. A card created in a
 * Complete column is completed as it is created, with XP and fireworks for
 * whoever made it (card 2134), so a card made for some other reason, the copy
 * of a finished card or a sub-board's parent card, is not put in one when the
 * board has another column.
 *
 * Nor in the Options column (milestone 22): a copy of finished work is not an
 * idea, and would be hidden in a collapsed strip. Every delivery board has one
 * at its far left (card 2527), so it is never taken, not even when the board
 * has no other column that is not Complete: then the answer is undefined, and
 * each caller does what it does for a board with no open column.
 */
export function firstOpenColumn<C extends { title: string; position: number; role: string | null }>(
	columns: readonly C[]
): C | undefined {
	return [...columns].sort((a, b) => a.position - b.position).find((c) => !isOptionsColumn(c) && columnRoleOf(c) !== 'complete');
}

/** The ids of the columns, among these, that mean finished. Never the Options column. */
export function completeColumnIds(columns: readonly { id: number; title: string; role: string | null }[]): Set<number> {
	return new Set(columns.filter((c) => columnRoleOf(c) === 'complete').map((c) => c.id));
}

/** The ids of the columns, among these, that mean paused. Never the Options column. */
export function holdColumnIds(columns: readonly { id: number; title: string; role: string | null }[]): Set<number> {
	return new Set(columns.filter((c) => columnRoleOf(c) === 'hold').map((c) => c.id));
}

/**
 * The ids of the columns, among these, that mean waiting to be started: every one, a board may have two.
 * Never the Options column: an option is not yet work anyone has taken on.
 */
export function todoColumnIds(columns: readonly { id: number; title: string; role: string | null }[]): Set<number> {
	return new Set(columns.filter((c) => columnRoleOf(c) === 'todo').map((c) => c.id));
}
